# Markus Agent Runtime

> Single source of truth for **Context Economics + Learning Loop**.
> Spec language: **MUST** / **SHOULD** / **MUST NOT**. Test IDs map to plan Wave A/B/C.
> Related: [prompt-engineering.md](./prompt-engineering.md), [tool-system.md](./tool-system.md),
> [memory-system.md](./memory-system.md), [learning-loop.md](./learning-loop.md),
> [state-machines.md](./state-machines.md).
> **State ownership contract**: see **Appendix A** of this file (merged from `state-ownership.md` on
> 2026-11-15 — 状态归属就是执行模型的一部分，分开维护会出现两处各自漂移).

**Formula**: `Agent = LLM + Harness + Learning Loop`.
**Hard constraint**: the Context Surface keeps cold-start fixed prefix cheap while skills/experience grow unbounded.

---

## §1 Invariants

### §1.1 Fixed-prefix budget

MUST: Every LLM call's fixed prefix `systemTokens + toolDefTokens` MUST fit the active scenario pack budget (see §3) before history is considered.

MUST: When `promptAffordTokens` is known and
`systemTokens + toolDefTokens + PROMPT_AFFORD_OUTPUT_RESERVE + safetyMargin > promptAffordTokens`,
the runtime MUST downgrade once to the `reflex` pack+profile and re-pack; if still over, it MUST NOT call the provider (`prompt_pack_rejected`).

MUST (§Afford.S1): The same afford gate MUST run on **every** LLM entry that calls
`prepareMessages` before the provider — including `handleMessage` **and**
`handleMessageStream` (and task streams that share prepare). Shared helper
`ensureAffordablePromptPack` MUST be used so stream/non-stream cannot drift.

MUST NOT: Shrink only `messageBudget` while shipping a fixed prefix that already exceeds afford.

Test IDs: `A-afford-downgrade`, `A-afford-heartbeat-fail`, `A-budget-contract-converse`,
`A-budget-contract-reflex`, `S-stream-afford-reject`, `S-stream-afford-downgrade`.

### §1.2 Unlimited capability, limited visibility

MUST: Skill full bodies and deferred tool schemas MUST enter context only via `discover_tools` (or equivalent L1 load). Cold start exposes L0 catalog (name + short description) only.

MUST NOT: Inject full SKILL.md bodies at spawn into the system prompt.

Test IDs: `A-skill-l0-only`.

### §1.3 Execute ≠ learn

MUST: Task execution MUST NOT write new team skills. Distillation runs after **`completed`**
(including rejection→revision→approval) via the Learning Loop hook with **`scenario: distillation`**
([learning-loop.md](./learning-loop.md) §2) — MUST NOT reuse Dream's `memory_consolidation`.
MUST NOT: Distill on `failed`.

Test IDs: `B-hook-skip-trivial`, `B-hook-fire-complex`, `B-hook-skip-failed`,
`B-distill-uses-distillation-scenario`.

### §1.4 Human gate for evolution

MUST: High-impact (or impact-omitted) skill installs require human approve via HITL
([learning-loop.md](./learning-loop.md) §8.3). Low-impact skill installs MAY proceed without HITL.
Optional `.pending/` staging (§3) remains a helper path.

MUST NOT: Couple skill usage/success metrics to trust score.

Test IDs: `B-approve-install`, `B-reject-feedback`, `B-stats-reject-feedback`.

---

## §2 Scenario Capability Packs

### §2.1 Pack definitions

The pack table is defined once, in [`tool-system.md §1.0`](./tool-system.md). It is not repeated
here: on 2026-11-15 the two copies had already drifted (this file and `tool-system.md` disagreed
about whether `heartbeat` belongs to `reflex` or `converse`). Budgets and the scenario list live
in that one table; this section only states the runtime obligation.

MUST: `selectTools` / allowlists MUST resolve through the pack for the active scenario.

### §2.2 Reflex core tools

MUST: `reflex` tool set MUST be a subset of:

`task_list`, `task_get`, `memory_save`, `memory_search`, `notify_user`, `request_user_input`,
`schedule_wakeup`, `cancel_wakeup`, `set_heartbeat_interval`, `discover_tools`,
`check_mailbox`, `file_read`, `agent_send_message`, `notebook_upsert`,
and for managers additionally `team_status`.

MUST NOT: Include `package_install`, `package_list`, `goal_create`, `goal_update`, `goal_status`,
`spawn_subagent`, `spawn_subagents`, `deliverable_create`, `requirement_propose`,
`memory_update_longterm` in the default reflex allowlist (reachable only via `discover_tools`).

### §2.2.1 Distillation allowlist extras

MUST: When `scenario: distillation`, the runtime MAY widen the allowlist with:
`memory_update`, `memory_update_longterm`, `file_write`, `file_edit`,
`package_list`, `package_install` (plus reflex core, which already includes `request_user_input`).
MUST NOT: Add `hub_install` on the distillation turn.
MUST: Skill `package_install` follows Learning Habits impact/HITL
([learning-loop.md](./learning-loop.md) §2.2 / §8.3) — high/omitted impact asks first.
MUST: Inject Learning Habits for `distillation`; MUST NOT inject them for `memory_consolidation`.

Test IDs: `A-pack-reflex-tools`, `B-hb-no-evolution-essay`, `B-distill-package-install-allowed`,
`B-distill-habits-injected`, `B-dream-no-habits`.

### §2.3 Converse / execute / govern

MUST: Default `converse` MUST NOT include `spawn_subagents` or `deliverable_create` (discover only).

MUST: `execute` MUST include code/shell/coding groups (or equivalent) needed for task work.

MUST: Keyword matching and `recentToolNames` MAY accelerate loading; selection only ever adds to the face — no budget eviction exists (§5).

Test IDs: `A-pack-converse-no-spawn`, `A-pack-execute-has-code`.

---

## §3 Budgets

| Constant | Value | Purpose |
|----------|-------|---------|
| `ROLE_PROMPT_MAX_TOKENS` | 6_000 | ROLE soft size metric (warn only; never truncate) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS` | 1_500 | knowledge.md injection (`execute`/`govern`) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS_CONVERSE` | 1_200 | knowledge.md injection (`converse`) |
| `KNOWLEDGE_PROMPT_MAX_TOKENS_REFLEX` | 0 | reflex: no full knowledge dump |
| ~~`STATE_PROMPT_MAX_LINES_REFLEX`~~ | — | **removed 2026-09-16**: retired with the state.md store — situational state now rides in the notebook's `system` tier |
| ~~`STATE_TTL_DAYS`~~ | — | **removed 2026-09-16**: replaced by the notebook's per-tier TTL (`NOTEBOOK_TTL_MS_*`) |
| `COLD_CONVERSE_FIXED_MAX` | 28_000 | Acceptance: system+tools |
| `COLD_REFLEX_FIXED_MAX` | 8_000 | Acceptance: system+tools |
| `SYSTEM_PROMPT_BUDGET_CONVERSE` | 16_000 | Soft size metric for converse system (observe/warn; never truncate ROLE/L0) |
| `SYSTEM_ANNOUNCEMENTS_CHARS_CONVERSE` | 400 | Team announcements body cap (converse) |
| `SYSTEM_NORMS_CHARS_CONVERSE` | 400 | Team norms body cap (converse) |
| `SYSTEM_ANNOUNCEMENTS_CHARS` | 2_000 | Team announcements body cap (execute/govern) |
| `SYSTEM_NORMS_CHARS` | 2_000 | Team norms body cap (execute/govern) |
| `SYSTEM_WORKFLOWS_MAX_CONVERSE` | 3 | Available-workflow lines in converse |
| `SYSTEM_DYNAMIC_CONTEXT_CHARS_CONVERSE` | 800 | Caller `dynamicContext` blob cap (converse) |
| `DEEP_SLEEP_IDLE_HEARTBEATS` | 3 | Consecutive idle before skip LLM |
| `SUBTASK_SOFT_CAP` | 8 | Warn at/above this count |

Constants live in `@markus/shared` `limits.ts`.

---

## §4 Prompt Profiles

### §4.1 Profile → sections

| Section | reflex | converse | execute/govern |
|---------|--------|----------|----------------|
| ROLE (full; soft warn metric) | yes | yes | yes |
| L0 + Collaboration Rules | yes (complete, concise) | yes (complete, concise) | yes (complete, concise) |
| Identity (roster) | manager + ≤3 active | capped (existing max) | capped |
| knowledge.md | no | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS_CONVERSE`) | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS`) |
| ~~state.md~~ | — | retired 2026-09-16 → notebook `system` tier | — |
| Skill L0 catalog | yes | yes | yes |
| Skill full bodies | discover only | discover only | discover only |
| L3 checklists (quality/git/error recovery) | no | **no** (incl. `comment_response`) | yes |
| Team announcements / norms | capped | capped (400 chars) | capped (2000 chars) |
| Available workflows | as needed | ≤3 short lines | full list |
| Channel history / shared deliverables | no | optional short | as needed |
| Task board detail | counts + top blocked/failed | only when non-empty | existing caps (empty stub ok) |
| Date / locale / Interaction Mode | yes | **always** (never trimmed) | yes |

MUST: `buildSystemPrompt` MUST accept `promptProfile` derived from scenario pack.

MUST: Size control is **progressive disclosure**, not truncation of always-on text:
- Always-on (never truncated): ROLE.md (persona only — **not** HANDBOOK.md), L0 capability
  rules, **`## Markus Collaboration Rules`** (distilled from HANDBOOK.md), Interaction Mode,
  date/locale.
- Collaboration Rules MUST encode **Conversation-first + Task-when-needed**: chat may
  pair-build; tasks for async/delegation/formal review; STOP only after `task_create`
  for that work. Managers are player-coach (ROLE may build; Position routes when useful).
- Progressive at assemble: knowledge digest (demote `##`→`###`, deprioritize stale
  fault/transcript sections), announcements/norms, workflows, CONTEXT.md
  (full content on disk / via tools). HANDBOOK.md long-form is the **AGENT HANDBOOK** —
  a single source of truth (`templates/roles/HANDBOOK.md`) that ships with the build and
  upgrades on rebuild/release; it is **NOT injected** and **NOT copied per-agent**. The
  `## Platform Handbook (on demand)` section injects the **resolved absolute path**
  (via `AgentManager.resolveHandbookPath`), so agents `file_read` the handbook directly
  without searching it.
- Progressive at tool layer: Markus core schemas LIVE; skill/MCP schemas only after
  `discover_tools` (boot MUST register without activate; sticky/recent MUST NOT
  re-activate skill/MCP). Activated skill/MCP MAY LRU-defer under toolDef budget;
  CORE_KEEP + HITL + discover never defer.
- Heartbeat MUST skip/defer LLM turns while `human_chat` is focused or queued.
- Team Status SHOULD label stopped agents as `stopped` (not scary `offline`); when
  all listed teammates are stopped, hint `agent_start` and that Owner chat work may continue.
- Work-context-bound tools (`task_submit_review`, subtasks, `task_note`, …) MUST appear
  LIVE only in **entity-bound sessions**: `execute` / `govern`, or converse scenarios
  `comment_response` / `requirement_action` / `workflow_action`. MUST NOT sticky into
  free `chat` / `a2a` / `group_chat` / reflex. `task_submit_review` resolves `task_id`
  from ALS/`activeTasks` when present; otherwise the agent MUST pass `task_id`
  (no board guessing).

MUST (§Afford.S3): `SYSTEM_PROMPT_BUDGET_CONVERSE` is an observe/warn metric only.
MUST NOT: Runtime-truncate ROLE, L0, or Collaboration Rules to fit that metric.
Provider afford guard handles hard limits (downgrade/reject).

Test IDs: `A-profile-reflex-omits`, `A-profile-role-full`, `A-collab-rules-always-on`,
`A-role-no-shared-append`, `A-knowledge-cap`, `A-profile-converse-no-l3`,
`S-converse-keeps-essentials`, `S-converse-keeps-date`, `S-tool-mcp-progressive`.

---

## §5 ToolDef budget eviction (Hermes Tool Search style)

MUST: Skill/MCP tool schemas (`feishu_*`, `*__*`, `chrome-devtools*`) MUST NOT enter
the LIVE tool list except via explicit `discover_tools` activation.
MUST: Markus core tools (`TOOL_DEF_CORE_KEEP`: shell/file/task/memory/…) +
`discover_tools` + HITL MUST stay LIVE for converse/execute/govern.
MUST NOT: Shrink the tool face to fit a token budget — no eviction mechanism exists
(Owner 2026-11-20, PR #471). External skill/MCP schemas enter only via `discover_tools`
activation (progressive disclosure); activation is sticky for the session. Context
pressure compresses history, never the face.

Test IDs: `S-tool-mcp-progressive`, `S-discover-activated-protected`.

MUST: After `discover_tools` activates tool names, the runtime MUST rebuild the LLM
`tools` schema list before the next provider call (stream / chat / task / session
continuations). Activations are sticky for the session; nothing is evicted.
MUST NOT: Reuse a stale pre-discover `llmTools` array across tool-loop iterations —
that makes activation a no-op and causes discover_tools death spirals.
MUST: Consecutive `discover_tools` calls (any args) ≥ 5 MUST be treated as a
critical loop and break the tool loop.

Test IDs: `S-discover-activated-protected`, `S-discover-tools-spin`.

### §5.1 max_tokens reservation clamp (§Afford.S4)

MUST: On OpenRouter reservation 402 (`requested up to N … can only afford M`), retry with
`max_tokens = min(M, max(512, M - safety))`.

MUST: When `lastPromptAffordTokens` is known, **first** request MUST also clamp
`max_tokens ≤ promptAfford - estimatedPrompt - margin` so the client does not send a
doomed high reservation (e.g. 13156) before failing.

Test IDs: `S-max-tokens-clamp-remaining`.

---

## §6 Memory taxonomy

MUST: Persistent semantic storage MUST use:

| File | Role |
|------|------|
| `knowledge.md` | Permanent curated knowledge |
| ~~`state.md`~~ | Retired 2026-09-16 — folded into the notebook's `system` tier via a one-time migration (key `legacy-state`). See [memory-system.md](./memory-system.md) §2 |
| `NOTEBOOK.md` | Situational workspace |
| observations buffer | Raw insights; never fully injected |

MUST: On first load, migrate legacy `MEMORY.md` (heuristic: dated/silent/current → state; else knowledge).

Details: [memory-system.md](./memory-system.md).

Test IDs: `A-knowledge-cap`, `C-dream-state-ttl`.

---

## §7 Learning Loop (summary)

State machine: `task completed → DistillationHook → Habits encode (memory / skill+HITL) → stats → DreamLibrarian → fanout`.

Also: platform **Learning Habits** L0 (look-back / encode-where / skill impact) and user-initiated
**Remember-from-message** → child evolution session (user↔agent DM only).

Details and MUST rules: [learning-loop.md](./learning-loop.md) §2–§9.

Test IDs (habits / remember): `B-prompt-learning-habits-*`, `B-skill-install-*`,
`B-self-evolution-skill-retired`, `B-evolve-*`, `B-recall-chat-session-*`, `B-ui-remember-*`.

---

## §8 Governance (summary)

- Review verdicts: `approved` | `approved_with_notes` | `rejected`
- `task_context` attached on assign
- Deliverable `version` + `changelog`
- Deep sleep after idle heartbeats
- Subtask soft cap warning

Details: [state-machines.md](./state-machines.md) and TOOL/MEMORY docs.

Test IDs: `C-review-notes`, `C-task-context-inject`, `C-deliv-version`, `C-subtask-soft-cap`, `A-deep-sleep-skip`, `A-deep-sleep-wake`.

---

## §9 Acceptance metrics

| Metric | Target | Verify |
|--------|--------|--------|
| Cold converse fixed | ≤ 28_000 | `A-budget-contract-converse` + live |
| Cold reflex fixed | ≤ 8_000 | `A-budget-contract-reflex` + live |
| Deep sleep quiet period | 0 LLM calls | `A-deep-sleep-skip` + live |
| Afford over fixed | 0 provider calls | `A-afford-downgrade` |
| Skill library growth | Does not increase fixed L0 cost beyond catalog | `A-skill-l0-only` |
| Evolution rates API | reuse / first-pass / distill rate | `C-metrics-api` |

---

## §10 Spec → Test → Implement → Verify

1. Spec merged (this doc + linked specs).
2. Failing tests with Test IDs above.
3. Minimal implementation to green.
4. Verify checklist against MUST rows; live cold-start logs for Wave D.

If Spec is wrong: fix Spec → fix tests → fix code (never hack around Spec).

## §11 Verification checklist (Wave D)

Automated (must be green):

- [x] `packages/core/test/capability-packs.test.ts` (A-pack-*, A-tooldef-*)
- [x] `packages/core/test/afford-guard.test.ts` (A-afford-*)
- [x] `packages/core/test/deep-sleep.test.ts` (A-deep-sleep-*)
- [x] `packages/core/test/prompt-profiles.test.ts` (A-profile-*, B-hb-no-evolution-essay)
- [x] `packages/core/test/prompt-budget.contract.test.ts` (A-budget-contract-*)
- [x] `packages/core/test/learning-loop.test.ts` (B-hook-*, B-stats-*)
- [x] `packages/core/test/memory-taxonomy.test.ts` (A-knowledge / C-dream-state-ttl)
- [x] `packages/core/test/skill-fanout.test.ts` (C-fanout-*, C-task-context-inject)
- [x] `packages/core/test/evolution-metrics.test.ts` + `GET /api/evolution/metrics` (C-metrics-api)
- [x] `packages/core/test/governance-runtime.test.ts` (C-review-notes / C-subtask-soft-cap)

Live (operator):

1. Cold chat: log `systemTokens`+`toolDefTokens` ≤ 12k
2. Cold heartbeat / deep sleep: ≤ 8k fixed; idle skips LLM
3. Low afford: `prompt_pack_rejected` without OR call
4. Complex task complete → distillation (Habits encode; skill install via §8.3 HITL)
5. Deliverable update returns `version` bump
6. `acceptTask(..., notes)` stores `approved_with_notes`

## §12 Clock and heartbeat

`AgentClock` is the single periodic driver, and a heartbeat is no longer a **message**. The earlier
design had two timers (a heartbeat scheduler and `AgentClock` both owning a `setInterval`) and
modelled every tick as a `mailbox_items` queue row, which carried retention, triage and drop
semantics a tick never needed — `heartbeat` rows dominated the completed population (~70% of
`mailbox_items`). Both are gone (Forever Loop M6).

| Invariant | How it is enforced |
|---|---|
| **One clock, two sources** | `AgentClock` is the only periodic driver **of the agent runtime**: one timer per agent, coarse tick (`tickMs`, 1000 ms), each source keeping its own cadence and failure-isolated from the others. (The invariant is about the *agent cadence*, not about every `setInterval` in the process — unrelated subsystems keep their own: shell-session output polling, model-catalog refresh, OAuth device polling.) Exactly two sources are registered — `mailbox-maintenance` (defer release / lease reclaim / stale-row cleanup) and `trigger-expiry` (`rest(wakeOn)` expiry sweep + scheduled-wakeup sweep). **No heartbeat source exists on it**: a patrol is not time-driven at all — it runs only when the liveness fallback asks for one (`agent.triggerHeartbeat()` → `runHeartbeatPatrol()`), so the patrol interval is no longer a timer question, and a cadence change can never leave a second timer in the process. |
| **A tick is not a message** | The `heartbeat:trigger` listener runs the patrol directly. No `mailbox_items` row is produced, so the patrol has no retention, triage or age-based drop semantics. Re-entrancy is guarded by a single in-flight flag, which replaces the previous "heartbeat folding" inside `Mailbox.enqueue` — one guard, not two mechanisms. The `mailbox.enqueue('heartbeat')` row path is **gone**: cut 9 made `rest` the only sleep entry, so there is no rollback channel back to queue rows. |
| **One dream trigger** | The dream has no clock source: it is a **pre-sleep** act — `restOn()` runs `runDreamTick()` → `shouldRunDreamCycle` before parking, so the only producer is the decision to sleep. The `memory_consolidation` mailbox type is not a second entry link (and must not be subject to age-based dropping, otherwise the only cleaning task can be silently discarded when the queue is busy); in `clock` dream-path mode such a row is acknowledged, never replayed as a second trigger. |
| **One decision function** | `shouldRunDreamCycle` remains the only place that answers "should the dream run now". |

---

## Appendix A. State ownership contract

> **Status: living contract.** This describes how the code must behave today — update it in the same
> change that moves an owner.

> Why this document exists: pushing state down from "agent-level singleton" to "per-worker workspace"
> is the right direction, but it **legitimately changes** an implicit premise found all over the repo
> ("reading `currentSessionId` gives you this request's session").
> Changes of this kind don't throw errors, they compile, and all the old tests stay green — they only
> show up in production as "the agent has amnesia".
> So "who owns which state, who may read it, and in which context it may be read" has to be written down
> as a contract and enforced by machine.

**Applies to**: any change that touches session identity / history / concurrency / workspace state.

---

### A.1 The three execution contexts (first, figure out where you are)

| Context | When it occurs | `sessionWorkspaceStore.getStore()` | Default workspace |
|---|---|---|---|
| **HTTP thread** | `api-server` handling a request, SSE callbacks, route validation | `undefined` | `rootWorkspace` |
| **worker workspace** | an attention worker pool processing a mailbox item | that worker's workspace | that worker's workspace |
| **background timers / bare callbacks** | backstop timeouts, `setTimeout`, external events | `undefined` | `rootWorkspace` |

> The test: `private workspace() { return sessionWorkspaceStore.getStore() ?? this.rootWorkspace; }`
> Under concurrent mode (3 workers by default), **the HTTP thread and a worker do not see the same thing**.

---

### A.2 State ownership matrix (writer / reader / context)

| State | Ownership | Who writes | Who reads | Implicit reads allowed? |
|---|---|---|---|---|
| `currentSessionId` (in-memory session `sess_*`) | **per-worker** | the worker handling that item (restore / startNewSession / handle*) | the turn logic inside that same worker | ❌ **forbidden** to read across threads |
| `dbSessionMap` (`cs_*` → `sess_*` binding) | agent-level (shared across workers) | **written only in the worker handling that message** | anyone (looked up by DB id) | ✅ allowed (this is the only cross-thread-safe session bridge) |
| `MemoryStore.sessions` (the history itself) | agent-level singleton | `appendMessage` (inside a worker) | `getRecentMessages` / `getSession` | ✅ allowed (but an unknown id must warn — never silently return empty) |
| `chatSessionRepo` (`cs_*` persistence layer) | storage (out of process) | api-server (persist) | api-server / restore | ✅ allowed |
| `activeScenario` / `currentTaskId` / `turnModelOverride` / `currentInteractingUserId` | **per-worker** | same worker | same worker | ❌ forbidden to read across threads |
| `workerWorkspaces` / `workerStates` / `inFlightProcessing` | attention controller | attention itself | attention / targeted cancellation (**must carry workerId explicitly**) | ⚠️ only for targeted APIs that take a workerId |
| `session.summary` / fragments / slots | MemoryStore (singleton) | compactor | context assembly | ✅ allowed |

**In one sentence**: **per-worker things can never be obtained by "reading a global pointer"; they must be passed explicitly.**
The only session bridge that may be shared across threads is `dbSessionMap` (`cs_*` ↔ `sess_*`).

---

### A.3 Hard rules

1. **DB ids and in-memory ids are never mixed**. `cs_*` is the request identity, `sess_*` is the internal cache key;
   never use a `cs_*` directly as a `MemoryStore` key (that causes split-brain: one conversation splits into two stores).
2. **Passing session identity across threads must be explicit**. For the HTTP thread to hand a session to a worker,
   it may only go through the mailbox item's `extra.sessionHint` (normalized from the legacy `extra.sessionId` /
   `extra.sessionRestore`), never through any shared pointer.
3. **Session context is applied only in the workspace that handles that item**. "Eager restore" in the HTTP thread
   is forbidden (it only writes `rootWorkspace`, which the worker never sees).
4. **Failures must be visible**. Distinguish `found | missing | notLoaded`: the latter two must at minimum `log.warn`
   with `dbSessionId / memorySessionId / agentId`. "Not found → return empty / create new / swallow the exception" is forbidden.
5. **The binding may be written in exactly one place**: in the workspace that actually handles that message.
6. **Targeted operations must carry a workerId** (cancellation, status queries, hot updates); inferring it from ALS is not allowed.

---

### A.4 Enforcement mechanisms already in place

| Mechanism | Location | What it protects |
|---|---|---|
| Streaming path carries the DB session id explicitly | `agent.ts` `sendMessageStream` → `extra.sessionHint` | rule R2 |
| Session resolution order "DB-bound in-memory session > workspace pointer > create new" | `resolveTurnSession` (single resolution point, called from `processMailboxItemCore`) | rule R1 |
| restore / binding executed in the workspace handling that item | `processMailboxItemCore` | rules R3/R5 |
| Lazy loading for history reads + warning on unknown id | `memory/store.ts` `getRecentMessages` | rule R4 |
| Invariant test suite | `packages/core/test/conversation-session-invariants.test.ts` | all of the above |
| Architecture gate | `scripts/architecture-guard.mjs` (must pass in CI) | bans `console.*`, bans empty `catch` |

---

### A.5 Checklist for adding/changing state

1. Does this state belong to **agent level** or is it **per-worker**? (per-worker ⇒ it must be passed explicitly)
2. Who writes it, who reads it, in which context? (fill it into the matrix in section 2 — **a blank cell is a risk**)
3. What happens when it can't be read? Does it silently degrade? (it must be observable)
4. Add an **invariant test** (not an assertion over an implementation snapshot), and do mutation validation (revert the fix → the case must go red).
5. Does it affect the `worker=1` serial-equivalence contract? (equivalence must hold)

---

## Appendix B. Stop semantics — start and stop, nothing else

Owner rule (2026-11-08): **after an agent is stopped it must not start again on its own.** Only a
human can start it again, or the agent's own pending approval/question being answered. There are
**two verbs at two scopes** and no third:

| Scope | Actions | Meaning |
|-------|---------|---------|
| One agent | `start` / `stop` | Stop is sticky: only a human start revives it. |
| Whole team | `start` / `stop` | Start = start every member; stop = stop every member. |

There is **no pause / freeze / resume**, and no global "pause all": those were removed end to end
(HTTP routes, client methods, sidebar entry, WebSocket events, `isGlobalStopped()`/`globalPaused`,
i18n keys) because a third pair of verbs describing a temporary system-wide freeze is not something
a user can see or reason about.

MUST: **one writer** for "stopped by the human" — `agents.disabled` (persisted, written only when a
human presses stop). Runtime `status === 'offline'` must never be read as that intent: it also covers
crashed and never-started. MUST: one gate enforces the rule, not twelve call sites. A human action
may overturn the human's own earlier decision ("start team" starts members that had been stopped
individually); only **agent-initiated** paths are blocked by a stop.

The incident that produced this rule — twelve start paths, eleven of them keyed off "is it offline",
three of them reachable by an agent — is recorded in
[`records/agent-stop-intent-audit-2026-11-08.md`](../records/agent-stop-intent-audit-2026-11-08.md).
