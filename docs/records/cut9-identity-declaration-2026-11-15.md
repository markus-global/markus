# C9 follow-up — identity declaration for `task_status_update` enqueues

Date: 2026-11-15
Scope: `packages/core/src/agent.ts`, `packages/org-manager/src/api-server.ts` (+ new tests)
Status: implemented

## 1. Symptom

The C8-P0 identity guard (`packages/core/src/mailbox.ts`, `AgentMailbox.enqueue`) fired
on a fact type that some callers legitimately enqueue without an identity:

```
[ERROR] [mailbox] mailbox.enqueue(task_status_update) has no workUnitRef and no refOrigin
 — identity would be silently NULL (declare refOrigin: "pending-link" | "platform-internal")
 {"agentId":"agt_d7f911ea2163f2151277b90e","sourceType":"task_status_update","itemId":"mbx_aa61…"}
```

Readings on 2026-11-15 (`~/.markus/logs/runtime-2026-11-15.log`):

| Reading | Value |
|---|---|
| `grep -c "has no workUnitRef and no refOrigin"` | 13 |
| distinct `sourceType` values among those hits | `task_status_update` only |
| `intent` of those mailbox rows (DB cross-check, 13/13) | `trigger_execution` |
| `work_unit_ref` of those rows **after** claim (DB cross-check, 13/13) | `task_<id>_r<n>` (e.g. `task_tsk_41782…_r2`) |
| callers that declare `refOrigin` in `packages/*/src` before this change | **0** |

The guard's actionable hint ("declare `refOrigin`") had no exemplar in the codebase:
the capability the gate demanded was unreachable in the turn that needed it. Same shape
as the family C9 just closed.

Production behaviour of the guard is fail-open (`log.error` + `unclaimedIdentityCount++`),
but if that counter becomes a CI gate or `MARKUS_STRICT_IDENTITY=1` is enabled, these
paths throw. So the signal has to become truthful, not merely quiet.

## 2. Root cause (R1 — one fact, several writers)

"Who provides the identity" is decided in three different places:

1. `mailbox.enqueue` derives `workUnitRef` from `options.workUnitRef`;
2. the task chain supplies it **after** the fact exists (`onItemEnqueued` → TaskService
   writes `mailbox_items.work_unit_ref`);
3. the guard re-decides "was this forgotten?" by looking at a NULL ref.

A caller that legitimately has no ref *at enqueue time* is indistinguishable from a
caller that forgot. The missing piece is not a second guard but a **declaration**: the
caller must state *why* the ref is empty. `EnqueueOptions.refOrigin` already exists for
this; nobody used it.

## 3. Site-by-site decision

`task_status_update` is enqueued from exactly three places in `packages/*/src`.

### 3.1 `packages/core/src/agent.ts` — `sendTaskExecution()` → `pending-link`

The item is enqueued first; the caller then receives the item id through `onItemEnqueued`
and TaskService links the work unit to that row. Identity genuinely arrives *after* the
fact — this is the definition of `pending-link`.

Evidence: all 13 production hits are this path (`intent='trigger_execution'`), and 13/13
rows ended with `work_unit_ref = task_<id>_r<n>`. The declaration does not change the
linkage; it names it.

### 3.2 `packages/org-manager/src/api-server.ts` — gateway `createTask` delivery record → `platform-internal`

Written when an external gateway creates a task: `intent='deliver'`, `invokesLLM=false`,
envelope `messageId = gateway-task:<taskId>`. It is a **receipt** for the creation event.
No work unit exists at creation and no code path will ever link this row — declaring
`pending-link` would be a promise nobody keeps. The task's entity linkage is carried
structurally by `envelope.messageId` and `metadata.taskId`.

### 3.3 `packages/org-manager/src/task-service.ts` — `maybeNotifyAssignee()` → no change

Already passes `workUnitRef: WORK_UNIT_REF.task(task.id, task.executionRound ?? 1)`, so
the guard never fired here. Listed as a candidate on the card; confirmed not affected.

## 4. Why option A and not option B

Option B (add `task_status_update` to `PLATFORM_INTERNAL_SOURCES`) is keyed by
`sourceType`, so it would also silence §3.1 — the one place where identity is real and
merely late. That would trade a loud signal for a false one. Option A (per-call
declaration) keeps the guard honest and matches its own message.

## 5. Test plan

New file `packages/core/test/mailbox-identity-declaration.test.ts`, two directions:

1. **Positive (must not throw)** — real assembly chain under `MARKUS_STRICT_IDENTITY=1`:
   construct an `Agent`, call `sendTaskExecution(...)`. Before the change this throws;
   after it returns an item with `workUnitRef === null` (pending-link is a declaration,
   not a ref) and the guard counter stays 0.
2. **Negative (must throw)** — an undeclared caller of the same fact type: a record-shaped
   `task_status_update` enqueue with no ref and no declaration throws the guard message.
   This is what stops a fail-open regression: removing the throw in `mailbox.ts` turns
   this red.

Both directions go through `Agent`/`AgentMailbox` — no test pokes `options.refOrigin`
directly to fake a declaration.

## 6. Verification readings

### 6.1 The live runtime cannot execute this diff (and why that is not a gap)

The running instance is a **packaged Electron app**
(`packages/desktop/dist-electron/mac-arm64/Markus.app`, pid 83331) whose server code is the
bundle built into the `.app`; `packages/cli/src/commands/start.ts` also hardcodes
`join(homedir(), '.markus')` as the data dir. Testing this diff against the live instance
would mean rebuilding and restarting that app — which kills every in-flight agent session
(the platform is executing five concurrent workers). That is a destructive, unauthorized
action, so it was not taken.

Instead the real chain was booted in a real Node process against a throwaway SQLite DB
(`/tmp` probe, not committed): real `TaskService` + real `Agent` + real
`SqliteMailboxRepo`/`SqliteWorkUnitRepo`, with `MARKUS_STRICT_IDENTITY=1` — strictly
stronger than "0 ERROR lines", because an undeclared empty identity **throws** instead of
logging.

### 6.2 Readings (2026-11-15 16:14 CST)

Scenario: create task → `approveTask(runNow)` → r1 dispatch → 打回 (terminal `failed` →
`in_progress`, the only transition that bumps `executionRound`) → r2 dispatch.

```
after approve -> status: in_progress round: 1
mailbox_items:
  mbx_0b226f0b | task_status_update | trigger_execution | ref=task_tsk_422e…_r1
after failed -> status: failed round: 1
after 打回(reopen) -> status: in_progress round: 2
mailbox_items:
  mbx_0b226f0b | task_status_update | trigger_execution | ref=task_tsk_422e…_r1
  mbx_bc848a4e | task_status_update | deliver           | ref=task_tsk_422e…_r1
  mbx_0dc4c499 | task_status_update | trigger_execution | ref=task_tsk_422e…_r2
assertions:
  rows with ref task_<id>_r2: 1
  rows with NULL ref: 0
  unclaimedIdentityCount: 0
RESULT: PASS (no throw, identity landed, 0 unclaimed)
```

Both card gates hold: the enqueue no longer trips the guard (it throws if it did, and the
count is 0), **and** the r2 item still landed its real identity `task_<id>_r2` — the
declaration named the behaviour, it did not erase it.

### 6.3 Quality gates (same order as CI)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (1003 pre-existing warnings) |
| `node scripts/architecture-guard.mjs` | pass (34 hits whitelisted, 27/27 invariants) |
| `node scripts/security-guard.mjs` | ok |
| `npm run test` | 8877 passed / 1 failed — `cli/test/commands-start-integration.test.ts` "auto-runs quickInit" 60s timeout, **pre-existing**: reproduces in isolation, untouched by this diff (live web-ui holds the port) |
| `node scripts/probe` (strict identity) | PASS, see §6.2 |

## 7. Out of scope (audited, deliberately unchanged)

`packages/core/src/attention.ts` re-enqueues a shutdown-interrupted row with
`{ reuseItemId }` and no declaration; it therefore also reaches the guard. That is a
different mechanism (re-queue of an existing row whose `work_unit_ref` is already in the
DB, not a new fact), and fixing it means deciding whether reuse inherits the row's
identity or declares its own. I did not touch it here: it is outside this card's
`task_status_update` scope and it changes re-queue semantics. Recorded so the next reader
does not have to rediscover it.
