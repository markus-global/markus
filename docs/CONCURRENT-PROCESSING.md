# Concurrent Processing（并发处理）

> Status: **implemented** · Last updated: 2026-09-11
> Scope: how a single agent processes **multiple mailbox items / sessions at once**
> through a pool of isolated workers, while preserving factual consistency.
> Design origin: [`CONCURRENT-PROCESSING-DESIGN.md`](./CONCURRENT-PROCESSING-DESIGN.md) (the original design memo — rationale, alternatives, phase plan).

Related docs: [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) (queue, priority, attention),
[ARCHITECTURE.md](./ARCHITECTURE.md) (runtime overview),
[STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) (streaming, stop / reattach),
[COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) (attention & cognition),
[STATE-MACHINES.md](./STATE-MACHINES.md) (task/requirement FSM).

---

## 1. Overview

By default Markus models an agent as a **single-threaded cognitive entity**: every
stimulus flows through one mailbox and the attention controller focuses on one item at a
time. That serialisation is deliberate — it is what keeps the agent's beliefs about the
world consistent.

**Concurrent processing** relaxes *where* the serialisation happens, not *whether* it
happens. When enabled, an agent runs a **pool of N worker loops**, each a full but
independent consumer of the same mailbox:

- Workers run in **parallel across different entities** (different task, requirement,
  conversation, or user).
- Within any single entity, processing is still **strictly serial** — enforced by an
  *entity-affinity lock* in the mailbox.
- Workers do not share mutable session state: each mounts its own
  [`SessionWorkspace`](../packages/core/src/session-workspace.ts) via `AsyncLocalStorage`.
- Worker activity is made visible to every other worker through a persistent
  **concurrent handoff log**, injected into the system prompt.

The invariant is simple to state:

> **Concurrency only ever happens *between* entities. A single entity is never
> processed by two workers at the same time.**

`maxWorkers = 1` reproduces the pre-concurrency behaviour exactly — that is the
compatibility floor and the regression contract.

---

## 2. Configuration

Stored under the `agent` section of `~/.markus/markus.json` and surfaced in
**Settings → Concurrent Processing** (see `packages/web-ui/src/pages/Settings.tsx`).

```jsonc
{
  "agent": {
    "concurrent": {
      "enabled": true,          // master switch — DEFAULT ON (maxWorkers=3)
      "maxWorkers": 3,          // 1 = serial (identical to legacy); 1–10
      "conflictPolicy": "auto"  // auto = requeue & retry; report = emit conflict event
    }
  }
}
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | boolean | **`true`** | Master switch. `false` forces serial mode (worker count 1). |
| `maxWorkers` | number | **`3`** | Worker count, clamped to `[1, 10]`. `1` = serial. |

### Unified concurrency gate (one knob, two limits)

`maxWorkers` is the **single source of truth** for how much concurrency an agent has.
It drives *both* limits, which used to be two independent and mutually contradicting
knobs (`maxWorkers` vs `profile.maxConcurrentTasks`, defaulting to 1):

| Limit | Derived value | Where |
|---|---|---|
| Attention worker count | `enabled ? clamp(maxWorkers, 1, 10) : 1` | `AttentionController.setWorkerCount` |
| Task-execution concurrency | `min(worker count, profile.maxConcurrentTasks ?? worker count)` | `TaskExecutor → TaskQueue` |

Consequences:

- **No more drift.** `Agent.applyConcurrency()` is the one entry point (constructor and
  the live `AgentManager.concurrentConfig` hot-update both call it), so the worker pool
  and the task queue can never disagree.
- **`min`, never `max`.** Task concurrency can never exceed worker concurrency, so
  `maxWorkers = 1` still implies fully serial task execution (the equivalence contract
  holds without a special case).
- **`profile.maxConcurrentTasks` is now a ceiling, not the gate.** It can only make task
  concurrency *tighter*. Leaving it unset means task concurrency follows `maxWorkers`
  (previously it silently stayed at 1, so three workers would pick up three task items
  while the queue admitted one — the other two workers blocked, and task throughput was
  pinned at 1).
- **Turning concurrency off really turns it off.** Previously the live-update path only
  applied `enabled: true`, so unchecking the switch left running agents at their old
  worker count until a restart.
| `conflictPolicy` | `'auto' \| 'report'` | `'auto'` | Behaviour when a worker meets a locked entity. |

**Default-value note.** The runtime default is *enabled with 3 workers*. The type
declaration (`packages/shared/src/types/agent.ts` → `AgentConcurrentConfig`), the
settings API (`packages/org-manager/src/api-server.ts`), and the Settings UI all agree on
this. To run serially, explicitly set `"enabled": false` (or `maxWorkers: 1`).

Changing the setting at runtime calls `AttentionController.setWorkerCount(n)`, which
restarts the worker pool to apply the new count — no agent restart required.

---

## 3. Architecture

```
                     ┌────────────────────────────────────────────┐
 AgentMailbox ──────►│        AttentionWorkerPool (N workers)      │
 (priority queue,    │                                            │
  entity locks)      │  worker 1 ── dequeueAsync() ──► item A      │
                     │  worker 2 ── dequeueAsync() ──► item B      │
                     │  worker 3 ── dequeueAsync() ──► item C      │
                     └───────────────┬────────────────────────────┘
                                     │ each worker runs an isolated
                                     │ SessionWorkspace (AsyncLocalStorage)
                                     ▼
                    processFocusedItem(item)  — unchanged state machine
                                     │
             ┌───────────────────────┼────────────────────────┐
        entity lock            handoff log             tool write lock
     (mailbox, per entity)  (JSONL, per agent)     (agent-level FIFO)
```

### 3.1 Worker pool — `packages/core/src/attention.ts`

Serial mode launches one `runLoop` (`workerCount === 1`). Concurrent mode launches
`launchWorkerPool()`, spawning one `concurrentWorkerLoop(workerId, gen)` per worker.

Each `concurrentWorkerLoop` is a **pure consumer**:

```
while (running) {
  item = await mailbox.dequeueAsync();          // one item, never repeats
  keys = mailbox.entityKeysOf(item);            // ≥1 key; falls back to system:{agentId}
  if (!mailbox.lockEntities(keys, item.id)) {   // multi-key, all-or-nothing
      mailbox.putBack(item);                    // busy → back off & retry
      await sleep(250 + min(retryCount,8)*250);
      continue;
  }
  const ws = delegate.getWorkerWorkspace(workerId);
  await sessionWorkspaceStore.run(ws, () => processFocusedItem(item));
  mailbox.unlockEntities(keys, item.id);
}
```

<!-- verified-against-code: 2026-09-11, packages/core/src/attention.ts:798-806, packages/core/src/mailbox.ts:437-489 -->

Design choice — **"concurrency without interruption" (Scheme A)**: the worker loop
deliberately does **not** run triage, LLM deliberation, or interrupt/preempt logic.
Those remain the serial `runLoop`'s job. This keeps the concurrent path small and
predictable: a worker only ever dequeues, locks, processes, unlocks, and loops.

- `workerCount === 1` → the original `runLoop` is used verbatim (no behavioural drift).
- Worker state (current focus, processing start time, in-flight user cancel) is held
  per worker in `workerStates: Map<number, AttentionWorkerState>`.
- `gen` (loop generation) guards against stale loops: bumping the generation makes the
  old pool drain and exit before a new pool starts.
- Aggregate status: any worker non-idle ⇒ agent not idle (`activeWorkerCount()`,
  `getStatus()`).

### 3.2 Session state isolation — `packages/core/src/session-workspace.ts`

Every mutable field that used to be a **single value on the Agent instance** is moved
into a per-worker `SessionWorkspace`:

| Workspace field | Replaces (agent-level single value) |
|---|---|
| `workerId` | — (new; worker identity) |
| `currentSessionId` | `Agent.currentSessionId` |
| `currentTaskId` | `Agent.currentTaskId` |
| `currentInteractingUserId` | `Agent.currentInteractingUserId` |
| `activeScenario` | `Agent.activeScenario` |
| `pendingInjections` | `Agent.pendingInjections` |
| `activeStreamToken` | `Agent.activeStreamToken` |
| `currentActivity` | `AgentState.currentActivity` |
| `processingMailboxItemId` | `Agent.processingMailboxItemId` |
| `lastInjectedActivityType` | dedup hint for injected activities |
| `turnModelOverride` | per-turn model pick |
| `volatileState` / `pendingDeliberationResult` | per-turn transient state |
| `toolSticky` | `Agent.toolSticky` (recent/activated tool schema names) |
| `activatedSkills` | `Agent.activatedSkillInstructions` (skill instruction bodies) |

The last two rows were found the hard way (2026-09-16). Both were **keyed by session but
stored on the Agent instance** — an incoherent combination: with N workers handling N
sessions, all workers share one object, so every session switch reset it. Consequences:
the emitted `tools` schema drifted call-to-call (a cache-prefix break, since tool schemas
serialise ahead of the system prompt), and a `discover_tools` activation could vanish
mid-session — the documented `discover_tools → think → discover_tools` spiral. The skill
map additionally leaked in **serial** mode, since it was neither keyed nor reset: a skill
body activated in session A stayed in every later session's system prompt.

**Rule:** assembly state that is keyed by session must also be stored per worker. The
session key is retained (not dropped) so that, in serial mode with one root workspace,
switching sessions still drops the previous session's state instead of leaking it.

Guard test: `agent-worker-scoped-state.test.ts` — two workspaces on different sessions must
not clobber each other's sticky tools in either order, and a skill activated in session A
must be absent from session B in both serial and concurrent modes.

The workspace is bound to the async call chain via a process-level
`AsyncLocalStorage` (`sessionWorkspaceStore`). Code that previously read
`this.currentSessionId` now reads `this.workspace.currentSessionId`, so awaited
continuations inside a worker always see *their own* state.

- **Serial mode**: all processing shares `rootWorkspace` — semantically identical to the
  old instance-level fields.
- **Concurrent mode**: each worker mounts a distinct workspace; `currentActivity` no
  longer overwrites across workers, and live activities are aggregated by
  `Agent.getLiveActivities()`.

### 3.3 Mailbox changes — `packages/core/src/mailbox.ts`

Two additions make the queue safe for multiple consumers:

1. **Broadcast wake-up.** `dequeueAsync()` parks waiters in `idleWaiters: Set<() => void>`
   instead of a single resolver; `wakeIdleLoop()` wakes *all* of them. Each woken worker
   re-runs `dequeue()`, and the `shift()`-style splice gives mutual exclusion — exactly
   one worker wins each item. The arm-before-recheck pattern prevents lost wakeups.

2. **Entity-affinity locks.** `entityKeysOf(item)` → `lockEntities(keys, holder)` /
   `unlockEntities(keys, holder)`. The worker locks **every** entity dimension of an item
   at once (all-or-nothing), and `dequeue()` skips any item that shares a locked key, so
   two workers can never hold the same entity:

   ```
   entityKeysOf(item):            // ≥1 key, never empty
     task:{taskId}                 ← payload.taskId / metadata.taskId
     req:{requirementId}           ← payload.requirementId
     conv:{dbSessionId|sessionId}  ← metadata.dbSessionId / metadata.sessionId
     user:{senderId}               ← metadata.senderId
     channel:{channelKey}          ← payload.extra.channelKey (a2a_message)
     system:{agentId}              ← fallback when no concrete entity resolves
   ```

   The per-type scope list is **declarative** — `MAILBOX_TYPE_REGISTRY[type].entityScopes`
   in `@markus/shared`, resolved by `resolveEntityKeys` — so no item type is left unkeyed:
   `a2a_message` locks its channel, and `heartbeat` / group chats fall back to
   `system:{agentId}` (serial within one agent). The key convention matches the
   pre-existing `consolidateByEntity` merge logic. (`entityKeyOf()` / `lockEntity()` /
   `unlockEntity()` survive as single-key conveniences for logging / handoff, but locking
   always goes through the multi-key API.)

   <!-- verified-against-code: 2026-09-11, packages/core/src/mailbox.ts:437-489, packages/shared/src/types/mailbox.ts:102-118 -->

## 4. Consistency model

Concurrency is safe only if every worker can reason about what the others are doing.
Three mechanisms provide that.

### 4.1 Concurrent handoff log — `packages/core/src/concurrent-handoff.ts`

A lightweight, ordered, append-only log. Each worker writes one line at key lifecycle
points:

| `kind` | When | Purpose |
|---|---|---|
| `declared` | worker starts an item | declares intent → prevents duplicate work |
| `fact` | worker establishes a global fact | makes side effects visible |
| `done` | worker finishes / fails | summary of result + leftovers |
| `conflict` | worker meets a locked entity | surfaces contention |

- Storage: in-memory ring buffer (last `HANDOFF_MAX_KEEP = 64`) **plus** JSONL
  persistence under the agent's data dir. `O_APPEND` single writes make concurrent
  appends atomic — no interleaving, and history survives restart.
- `inFlight()` reconstructs "who is doing what right now" from `declared`/`fact`
  records that have no matching `done`/`conflict`, paired by **(worker, entity)** — a
  worker serving several entities keeps *all* of them visible (keying by `workerId`
  alone silently dropped all but the last).
- The JSONL file **compacts** once `HANDOFF_COMPACT_THRESHOLD = 512` lines accumulate:
  the in-memory ring buffer is rewritten wholesale, so the file is bounded by
  `HANDOFF_MAX_KEEP + threshold` instead of growing without limit for the process
  lifetime. Records `id`s combine `Date.now()` + an instance token + a process-monotonic
  counter, so ids stay unique across instances *and* within a single millisecond.
- `clear()` **truncates** the file (`writeFileSync(path, '')`). The previous
  `appendFileSync(path, '')` wrote zero bytes without truncating, so `load()` after a
  restart resurrected records that had been "cleared".
- The log's lifetime is synced to the worker count: `applyConcurrency()` calls
  `syncHandoffLog()` (create + `load()` when crossing into worker > 1, drop when falling
  back to serial). Previously a hot-update from serial → concurrent never created the
  log, so `getConcurrentContext()` silently returned nothing.

### 4.2 Prompt injection — `packages/core/src/context-engine.ts`

`buildSystemPrompt` appends a **`## Concurrency Context（并发上下文）`** block when
concurrency is active and more than one worker is running. It contains:

- the current worker id and total worker count;
- other workers' in-flight intents;
- the most recent handoff records (`HANDOFF_CONTEXT_LIMIT = 8`, own records filtered);
- three consistency rules — *do not assume exclusive cognition*, *never process an
  entity another worker holds*, *report conflicts instead of overwriting*.

The block is injected into the **volatile** segment only, so the stable prompt prefix
(and its cache) is untouched. This is precisely the owner's requirement: a worker knows
it is one of several, knows what others finished, and can avoid contradictory or
duplicate actions.

### 4.3 Tool write lock — `packages/core/src/agent.ts` + `packages/core/src/resource-locks.ts`

> **History:** this section previously described `withToolWriteLock(fn)` as an
> "agent-level FIFO promise chain". That was replaced by **resource-domain locks**;
> the text below is the current truth.

`Agent.executeTool` gates every write-semantic tool through
`ResourceLockRegistry.withLocks()` (`resourceLocks.ts`). Read-only tools do not take a
lock. The lock is released on the throw path too (no leak).

**Domain table** — `Agent.WRITE_TOOL_DOMAINS` is the single source of truth
(`agent.ts`). Each entry maps a tool to a mutual-exclusion domain, optionally keyed by an
argument so that *different* resources run in parallel:

| Domain | Keyed by | Examples |
|---|---|---|
| `'*'` | — (global exclusive) | `shell_execute`, `apply_patch`, `package_install`, `hub_install`, `background_exec`, `process` |
| `fs` | normalized path | `file_write`, `file_edit`, `generate_image`, `office_generate` |
| `task` / `requirement` / `workflow` / `project` / `deliverable` | entity id | `task_update`, `requirement_update_status`, `workflow_run`, `deliverable_update` |
| `terminal` / `browser` | terminal id / page id | `exec_terminal`, `click`, `navigate_page` |
| `a2a-out` | target agent / channel | `agent_send_message`, `feishu_send_message` |
| `memory`, `notebook`, `working-memory`, `session`, `session-tools`, `schedule`, `llm-config`, `org`, `ui`, `deliberation`, `mailbox-admin`, `notify` | single resource or item id | `memory_save`, `session`, `discover_tools`, `team_update` |

**Classification is closed and test-enforced.** `Agent.isWriteTool` is *default-deny*:

1. name ∈ `WRITE_TOOL_DOMAINS` → write (fine-grained domain);
2. name ∈ `TOOL_LOCK_FREE` → **never locked** (pure readers; see below);
3. otherwise → write with domain `tool:<name>`.

Two important subtleties:

- **`TOOL_LOCK_FREE` must stay exempt.** `request_user_input` / `request_user_approval`
  **block on a human**, and `spawn_subagent(s)` run for minutes. If they took `'*'`, the
  entire agent's writes would freeze for the whole wait. This is asserted by a test.
- **Unknown tools get `tool:<name>`, not `'*'`.** MCP/skill/dynamically-registered tools
  are capability-unknown, but serialising *all* of them against *all* writes would break
  the platform's "multiple tool calls in one turn run in parallel" contract and stall the
  20 MCP tool families we ship. Per-name mutual exclusion keeps two concurrent calls to
  the *same* tool serialised (the common intra-tool race) while different tools stay
  parallel. The residual (an unknown tool writing the *same file* as a concurrent
  `file_write` is not mutually excluded) is listed in §7.
- **Nesting is fail-fast, not deadlock.** `LockNestingConflictError` is thrown when a
  call chain requests a lock conflicting with one it already holds (`resource-locks.ts`).
  The old `pump()` counted the chain's *own* locks as conflicts and would **hang
  forever**; granting instead would silently weaken `'*'` exclusivity (another chain's
  locks are not rolled back). A loud error is the only safe of the three.

**Session persistence under concurrency.** `MemoryStore.saveDebounce` is keyed by
`session.id` (`memory/store.ts`). A single instance-level timer meant worker B's save
cancelled worker A's pending write, silently dropping A's session from disk until the
next save. Session files, by contrast, are per-session (`sessions/<id>.json`), so
cross-session writes do not race; `knowledge.md` writes are synchronous
read-modify-write, which is atomic w.r.t. other in-process code.

## 5. Cancellation & streaming (Scheme B — directed cancel)

In serial mode, stopping a stream could target "the agent". Under concurrency that is
ambiguous — the wrong worker could be cancelled. The fix is a **directed cancel**:

- `cancelActiveStream(target?)` where `target = { itemId?, sessionId? }`.
- The caller (HTTP thread, which has **no** AsyncLocalStorage context of its own)
  resolves the owning worker via
  `AttentionController.findWorkerByItemId()` / `findWorkerBySessionId()`.
- Cancellation then runs *inside that worker's own workspace context* via
  `sessionWorkspaceStore.run(ws, () => cancelActiveStreamCore())`, so only the intended
  worker's stream is aborted.
- Frontend **stop** and **retry** paths pass a stable `sessionId` target so a stop in one
  session tab never touches another tab's in-flight stream.

See [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) for the stream lifecycle.

## 6. Serial-mode equivalence (the regression contract)

`maxWorkers = 1` must be byte-for-byte equivalent to the pre-concurrency runtime:

| Concern | Serial (worker = 1) | Concurrent (worker > 1) |
|---|---|---|
| Loop | original `runLoop` | `concurrentWorkerLoop` × N |
| Workspace | shared `rootWorkspace` | one per worker |
| Attention/triage/deliberation | full pipeline | not run in worker loops |
| Entity lock | no-op (no contention) | enforced |
| Handoff log | written on lifecycle (harmless) | injected into prompts |
| Status | instance-level | aggregated across workers |

This equivalence is the reason the refactor could land incrementally (state isolation
first, workers second) and is asserted by the existing serial test suites.

## 7. Known limitations

These are deliberate trade-offs, documented rather than hidden:

1. **Entity-key coverage is per-entity, not global.** `entityKeysOf` covers `task:` /
   `req:` / `conv:` / `user:` / `channel:` and always returns ≥1 key — unresolved items
   (`heartbeat`, group chats without a channel) fall back to `system:{agentId}` — so
   `a2a_message`, `heartbeat`, and group chats **are** entity-locked. The remaining gap is
   the *shared* surface: two workers on **different** entities can still run multi-step
   read-modify-write flows across the same *shared* files or global memory concurrently,
   guarded only by the *soft* signal in the handoff log, not a hard lock. Extending
   coverage to a global write arbiter is an architecture-level follow-up.

   <!-- verified-against-code: 2026-09-11, packages/core/src/mailbox.ts:437-451, packages/shared/src/types/mailbox.ts:83-118 -->

2. **Tool write lock granularity.** `withToolWriteLock` serialises a *single tool call*,
   not an entire task/flow. It narrows but does not eliminate cross-tool interleaving.
   Two further residuals are explicit:
   - **Dynamic tools are capability-unknown.** A tool outside the builtin registry gets
     domain `tool:<name>` (§4.3), so it is not mutually excluded from `file_write` /
     `shell_execute` even if it mutates the same resources. Builtins are safe because a
     test asserts every one of them is classified.
   - **`background_exec` / `process` are protected at *dispatch*, not for the job's
     lifetime.** The lock covers registering the job in the process table; the spawned
     process then runs outside the lock and may write files concurrently with other
     workers. Treat long background jobs as a handoff-log *fact*, not as lock-covered.

3. **Write-lock nesting is fail-fast.** A call chain that requests a lock conflicting
   with one it already holds raises `LockNestingConflictError` (§4.3) instead of
   deadlocking. Channel that error into the model's tool result; do not retry the
   identical call.

4. **Backstop timeout cancellation is best-effort.** When `processFocusedItem`'s backstop
   timeout fires, it cancels the in-flight stream and requeues the item. If the underlying
   transport has already detached, an orphaned turn could still complete side effects
   before the requeued item runs — a small double-side-effect window. (Noted in the code
   comment in `attention.ts`.)

5. **Conflict back-off.** Under `conflictPolicy: 'auto'`, a worker that loses the entity
   lock backs off for `250ms × (1 + min(retryCount, 8))` before retrying, instead of
   busy-waiting. `report` additionally emits an `agent:entity-conflict` event.

6. **Cost.** N workers can mean up to N concurrent LLM calls. `maxWorkers` (default 3)
   is the cost ceiling; low-value items can still be aggregated/merged by the mailbox.

## 8. Testing

Concurrency-specific suites under `packages/core/test/`:

| File | Covers |
|---|---|
| `attention-concurrent.test.ts` | worker pool start/stop, directed cancel, conflict policy |
| `mailbox-concurrent.test.ts` | broadcast wake-up, entity lock/unlock, key derivation |
| `agent-concurrent-activity.test.ts` | per-worker `currentActivity` isolation |
| `agent-write-lock.test.ts` | domain-lock serialisation, per-path/per-entity parallelism, no-leak on throw, **write-tool classification totality**, lock-free HITL tools, unknown-tool per-name domain |
| `resource-locks.test.ts` | domain conflict matrix, FIFO fairness, reentrancy |
| `resource-locks-chain.test.ts` | **nested conflicting acquisition fails fast (no self-deadlock)**, cross-chain exclusion not weakened, parallel siblings still serialised |
| `concurrent-handoff.test.ts` | **`clear()` truncates disk**, `inFlight()` pairs by (worker, entity), **file compaction bound**, id uniqueness across instances, corrupt-line tolerance |
| `memory-session-debounce.test.ts` | **per-session debounce isolation** (two workers' sessions both persist) |
| `attention-directed-cancel.test.ts` | `cancelActiveStream(target)` routing |

`worker = 1` equivalence is covered by the pre-existing attention/mailbox suites, which
continue to pass unchanged.

**Gap:** there is no end-to-end mock test that drives *two workers through two complete
session message chains in parallel*, nor a full regression for "two items of the same
entity arriving concurrently". Adding one is the recommended next hardening step.

---

> This document describes the system **as built**. For the original rationale,
> alternatives considered, and phase plan, see the design memo.
