# Cut 7 / C7-B — delegation has a parent, budget has one unit

Status: implemented on `task/tsk_d1e815539620748b892d10b2-c7b`, PR #443 → `feat/refactor-plan`
(not merged, not released, no tag). Contract lives in
[`state-machines.md` §16](../architecture/state-machines.md#c7-b--budget-has-exactly-one-meaning-now).

## What changed and where

| Concern | File | Note |
|---|---|---|
| Child WorkUnit for subagent / fan-out | `packages/core/src/tools/subagent.ts` | `DelegationWorkUnitPort` (`resolve` / `ensureChild` / `settle`); created **before** the child runs |
| Parent ref for this turn | `packages/core/src/agent.ts` | set on `onFocusChanged`, exposed as `getCurrentWorkUnitRef()` |
| Port injection | `packages/core/src/agent-manager.ts`, `packages/cli/src/commands/start.ts` | `setWorkUnitPort()` — both agent-construction paths |
| Cross-team delegation parent | `packages/org-manager/src/agent-delivery.ts` | `DeliveryDeps.workUnits.currentWorkUnitRef()`, passed as `parentRef` |
| `ref → id` resolution, usage ledger, settle | `packages/org-manager/src/work-unit-service.ts` | `WorkUnitService.ensure()` resolves `parentRef`; `recordUsage()` / `settle()` / `adoptContextRef()` |
| Iteration accounting SQL | `packages/storage/src/sqlite-storage.ts` | `addUsage()` (`used = used + ?`), `adoptContextRef()` (`WHERE context_ref IS NULL`) |
| Task chain mailbox link | `packages/core/src/agent.ts`, `packages/org-manager/src/task-service.ts` | `sendTaskExecution(..., onItemEnqueued)` → `linkMailboxItem(item.id, task_<id>_r<round>)` |
| chat WorkUnit at turn start | `packages/org-manager/src/api-server.ts`, `sse-handler.ts` | `openChatTurnWorkUnit()` on enqueue; close path settles `running → idle` |
| 6b patches removed | `packages/shared/src/limits.ts`, `subagent.ts` | unbounded per-child default gone; circuit breaker is a breaker again |
| `sessionLockKey` from `context_ref` | `packages/shared/src/work-unit.ts`, `agent.ts` | `sessionLockKeyOfContextRef()` + mandatory fallback |

## Evidence (commands actually run in the worktree)

Gates:

- `npx tsc -b` → **0 errors**
- `npx eslint packages/{core,org-manager,shared,cli,storage}/src --quiet` → **0 errors**
- `node scripts/architecture-guard.mjs` → 34 hits all whitelisted, **contracts 17/17**
- `node scripts/security-guard.mjs` → ok
- `grep -rn 'DEFAULT_MAX_SUBAGENT_ITERATIONS = Infinity' packages/*/src` → **0 hits**

Targeted suites (sequential — never two vitest runs at once in one checkout):

| Family | Result |
|---|---|
| `subagent-tools` / `subagent-work-unit-delegation` / `subagent-budget-visibility` / `subagent-result-schema` | 33 passed |
| `concurrent-*` (handoff / state-manager / task-queue / task-executor) | 38 passed |
| `mailbox-claim-lease` | 13 passed |
| `session-lock-concurrency` | 3 passed |
| `work-unit-producers.integration` (real SQLite) | 5 passed |
| `work-unit-service` / `agent-delivery` / storage `work-unit` / `work-unit-lock-key` | 49 passed |

Real-instance probe (real SQLite file, real `SqliteWorkUnitRepo` + `WorkUnitService` + real
subagent tool; only the LLM mocked — a probe cannot call a paid model):

```
work_units:            5 rows = 1 parent + 4 children, children_with_parent_id = 4
budget / used:         children budget=10; completed child used=0; exhausted child status=paused_budget used=10
status_transitions:    4 rows (entity_type='work_unit')
                       3 × running→idle  reason=subagent_completed
                       1 × running→paused_budget reason=subagent_budget_exhausted
fan-out results:       3 × {status: completed, workUnitRef: delegation:<parentRef>#<taskId>}
looper result:         1 × {status: budget_exhausted, budgetHit: own, iterations: 10, filesTouched: []}
```

Cross-team parent chain is asserted in `work-unit-producers.integration.test.ts`: a delivery
sent while the sender has a turn WorkUnit produces a child whose `parent_id` is that parent's
id — read back from the database, not from the return value.

## Final gate (after the review pass)

- `npx vitest run --project node` → 539 files passed, **2 failed**, both the documented baseline
  reds on this machine (`cli/commands-start-integration > auto-runs quickInit` binds the product
  default 8056, occupied by the desktop app; `agent-concurrent-cancel-isolation` is
  load-sensitive and green isolated). A pristine baseline worktree, same command, same 2.
- Touched surface: 9 files / 86 tests green; `api-server-final` + `api-server-extended` 203/203.
- `architecture-guard` invariants **18/18** — the new one fails any implementation of
  `turnWorkUnitRef` that reads the ledger (`listByAgent` / `SELECT` / `.repo.`): a "current
  WorkUnit by agent id" cannot exist in a store that only has history.
- Regression found and fixed by bisection: `/api/message` returned 500 on three route tests.
  `0eca3464` passes, `ebdda914` fails — the handler evaluated `agent.getMemorySessionId()`
  synchronously while building arguments, so an incomplete agent object threw inside the
  request path. That read is enrichment only, so it now goes through `memorySessionIdOf()`
  (capability detection; the method's own errors are not swallowed).

## Honest boundaries

- The chat WorkUnit exists at turn **start**, but its `context_ref` is only known at close;
  it is filled once by `adoptContextRef()` (only when NULL). Until then the lock key falls
  back to the legacy `peekTurnSessionId` path — correct, just one layer less structural.
- `task` and `a2a` `context_ref` values are not memory-session identities, so their lock keys
  fall back by design (`sessionLockKeyOfContextRef` returns `undefined` for them).
- Budget unit stays **iterations**; token accounting is a later column, not a reinterpretation
  of `budget`.
- **web-ui project is not verified in this worktree**: those tests are red here and only here
  (React duplicate copy + happy-dom AbortError, stack inside this worktree's `node_modules`),
  green in a clean baseline worktree, and this diff touches zero `packages/web-ui` files. That
  is a broken dependency topology in one worktree, not a pre-existing red — CI on a clean
  checkout is the authority.
- Heartbeat / dream triggering was not touched (that is C8).
