# Cut 7 / C7-A — WorkUnit lands: chat, task and a2a get an identity

Status: implemented, gated, PR opened (target `feat/refactor-plan`). Card: `tsk_9fd9eb571e6ff46e2472e3e0`.

## Why this card exists

Cut 6 added `mailbox_items.work_unit_ref` **but wrote 0 rows** — deliberately: never build a
reference before the entity exists. C7-A is the moment that single writer goes live. Table,
writer and producers are one fact ("this unit of work has an identity for the first time"), so
they ship in one commit.

## What changed

| Area | File | Change |
|---|---|---|
| Concept (single source) | `packages/shared/src/work-unit.ts` | `WorkUnitStatus`, `WU_TRANSITIONS`, `canTransitionWorkUnit` / `assertWorkUnitTransition`, and **the only** `ref` generator `WORK_UNIT_REF` |
| Schema | `packages/storage/src/sqlite-storage.ts` | `work_units` table (idempotent `CREATE TABLE IF NOT EXISTS`), `uq_work_units_ref` unique index, `idx_work_units_agent_status`, `idx_work_units_parent` |
| Storage writer | `packages/storage/src/sqlite-storage.ts` | `SqliteWorkUnitRepo`: `ensure` (`ON CONFLICT(ref) DO NOTHING`), `transition` (matrix + optimistic `WHERE id = ? AND status = ?` + `status_transitions` row), `getByRef`, `listByAgent`, `listChildren`, `linkMailboxItem` |
| Value domain | `packages/shared/src/types/task.ts` | `status_transitions.entity_type` gains `'work_unit'` (TEXT column, no DDL) |
| Business writer | `packages/org-manager/src/work-unit-service.ts` | `WorkUnitService`: `ensure` (never throws, emits structured event), `transition` (matrix errors throw), `tryTransition`, `linkMailboxItem`, `workStatus`, counters |
| Producer ① chat | `packages/org-manager/src/api-server.ts` | `persistChatTurn()` → `WORK_UNIT_REF.chat(sessionId, round)`; round derived from message count **before** append |
| Producer ② task | `packages/org-manager/src/task-service.ts` | `createTask()` → `WORK_UNIT_REF.task(taskId, executionRound)` (reuses existing identity, no second naming scheme) |
| Producer ③ a2a | `packages/org-manager/src/agent-delivery.ts` | `deliver()` → `WORK_UNIT_REF.a2a(channelKey, deliveryId)`, `context_ref = channelKey` |
| Mailbox plumbing | `packages/core/src/mailbox.ts`, `packages/core/src/agent.ts`, `packages/shared/src/types/mailbox.ts`, `packages/storage/src/sqlite-storage.ts` | `workUnitRef` carried on enqueue; `onItemEnqueued` hands the item id back so the linkage uses the **real** item, never a guess |
| Introspection tool | `packages/core/src/tools/mailbox-tools.ts`, `packages/core/src/agent-manager.ts`, `packages/cli/src/commands/start.ts` | read-only `work_status()`, answered from `work_units` only |
| Guard | `scripts/architecture-guard.mjs` | new invariant `work-unit-single-writer` (6 checks) |
| Plan doc | `docs/records/cut7-workunit-execution-plan-2026-11-13.md` | corrected from the stale 6-card split to the approved 2-card scope |

## Ordering discipline (why no dangling references)

`ensure()` (entity) always runs **before** `linkMailboxItem()` (reference). Reversing it would
recreate exactly what C6 avoided: a `work_unit_ref` pointing at a row that does not exist — worse
than `NULL`, because it looks like identity.

## Evidence

**Red before green** (mutate the invariant, watch the tests fail, restore):

| Proof | Mutation | Result |
|---|---|---|
| Matrix | `archived: []` → `archived: ['running']` | 3 shared tests red (`archived 是终态`, `archived → running 非法`, structured-error) → restored green |
| Unique index | `CREATE UNIQUE INDEX` → `CREATE INDEX` | 8 storage tests red (idempotency, concurrency, index backstop, transitions, link) → restored green |

**New tests** — 38 passed (4 files):
`packages/shared/test/work-unit.test.ts` (10), `packages/storage/test/work-unit.test.ts` (11),
`packages/org-manager/test/work-unit-service.test.ts` (13),
`packages/org-manager/test/work-unit-producers.integration.test.ts` (4).

**Real-DB probe of all three channels** (`work-unit-producers.integration.test.ts`, real SQLite file,
real `persistChatTurn` / `createTask` / `deliver`, zero mocks in the persistence layer):

| Channel | Reading |
|---|---|
| chat | `mailbox_items.work_unit_ref = session:cs_…:r1`, `agent_id` = 收件 agent；**WU 建于回合收口时**（回复已落库），建完立即 `running → idle`，所以最终读到的是 `status=idle` 且 `status_transitions` 有一条 `reason='chat_turn_settled'`；第二轮 → 第二个 WU（ref 不碰撞） |
| task | WU `ref = task_<taskId>_r<round>` (byte-identical to the existing execution identity), `task_id` set |
| a2a | `mailbox_items.work_unit_ref = a2a:<channelKey>:<deliveryId>`（**两段，不含 targetId**），WU 归**发送方**（`agent_id = req.fromAgentId`）—— 一次投递 = 一个 WU（`state-machines.md` §16）；N 个接收方共享同一 ref 是定义，不是缺陷 |

**Gate run** (all on this worktree):

```
npx tsc -b                                   → clean
npx tsc --noEmit -p packages/web-ui           → clean
npx eslint packages/*/src/                    → 0 errors (1001 warnings, pre-existing)
node scripts/architecture-guard.mjs           → ✓ 34 allowlisted, invariants 17/17
vitest packages/storage+org-manager+shared    → 156 files / 2341 tests passed
vitest packages/core/test                     → 277 files / 3538 passed, 10 skipped
```

## Plan-doc alignment (CTO request)

`grep -nE 'C7-[1-6]' docs/records/cut7-workunit-execution-plan-2026-11-13.md` → **1 hit**, and it is
the explicitly historical one at line 93: ““只建表”（原 C7-1）…”. Everything else now speaks in
C7-A / C7-B. §7 is retitled “裁决项与落定状态（2026-11-13 已定）” and records: requirement approved;
scope = 2 cards (C7-A `tsk_9fd9eb571e6ff46e2472e3e0`, C7-B `tsk_d1e815539620748b892d10b2` with
`blocked_by` A); card `tsk_1203177cce7a503bff96cd5a` stays independent; budget unit stays iteration.

The canonical copy now lives in the repo. The CTO's workspace copy could not be edited from my
session (platform denies cross-agent workspace writes), so the corrected version was added here —
versioned, reviewable, and moving in the same PR as the code that implements it.

## Durable contract and review-time reproduction

Two documents complete the picture and ship in the same PR:

- `docs/architecture/state-machines.md` **§16 WorkUnit Lifecycle** — the durable contract:
  state set, the matrix copied from `WU_TRANSITIONS`, the three layers, the six guard checks
  stated as what they prevent, producers and `ref` formats, the fact-source boundary and the
  fixed `ensure` → `linkMailboxItem` order, and failure semantics by event name. It states
  explicitly that budget has **no** semantics in this card and that this section must not
  describe a unified budget until C7-B's code exists.
- `docs/records/cut7-c7a-red-green-evidence-2026-11-13.md` — the reproduction a reviewer can
  repeat: the four committed test files copied onto a throwaway worktree of base `9b8bf879`
  fail there (4 files / 11 tests: `is not a constructor` ×10, missing `@markus/shared/work-unit`
  ×3) and pass here (4 files / 38 tests). It is labelled a review-time reproduction — no
  development-time timestamps are claimed.

The mutation-based red-before-green in §Evidence above and this base-reproduction answer two
different questions: mutations prove the *assertions* bite, the base reproduction proves the
*tests could not have passed on the untouched tree*. Neither substitutes for the other.

`docs/architecture/task-attention-economy.md` is deliberately untouched: it covers mailbox
signals versus records and contains zero budget references. Putting a budget section there
would give one fact a second home.

## Deliberately **not** in this card

- `parent_id` is always `NULL`: spawning child WUs on delegation is C7-B (behaviour change).
- No mirroring of `task.status` → `WU.status`: the WU state machine has its own driver (execution);
  a mirror would be a second execution point for one invariant (R2) and is C7-B's job.
- Budget semantics untouched (`budget`/`used` exist, `used` always 0 in this card).
- Heartbeat / dream do **not** write WUs.

## Rollback

Single commit revert. The table can stay: no historical rows, `ref` reuses the existing format,
zero migration, and every reader tolerates an empty `work_units`.