# C7-A — red-then-green evidence (review-time reproduction)

> Scope: `tsk_9fd9eb571e6ff46e2472e3e0` (C7-A), PR #442 → `feat/refactor-plan`.
> Status: **review-time reproduction**, not a captured development log.
> No timestamps are claimed for the original red run. The numbers below were produced by
> re-running the committed test files against the base commit, so a reviewer can repeat
> every step and get the same result.

## Why this document exists

A test that never failed is not evidence that it can fail. The requirement on C7-A was
"write the behaviour test first and watch it go red", and the honest way to prove that
after the fact is not to describe it — it is to **put the new tests back onto the base
commit and show them failing there**.

Anti-pattern this avoids: `readFileSync(...).toContain(...)` text fences. Those assert
that a string exists in a file, not that a behaviour holds. Every test file below drives
a real SQLite database or a real producer call path.

## Method

```bash
# 1. A clean checkout of the base, sharing nothing but git objects.
git worktree add "$RED" 9b8bf879 --detach

# 2. Reuse the already-installed dependencies (no rebuild needed for a test run).
ln -sfn "$WT/node_modules" "$RED/node_modules"
for p in packages/{shared,storage,org-manager,core,cli}; do
  ln -sfn "$WT/$p/node_modules" "$RED/$p/node_modules"
done

# 3. Copy ONLY the four new test files onto the base source tree.
#    The base has no work-unit implementation, which is the point.
cp "$WT/packages/shared/test/work-unit.test.ts"                        "$RED/packages/shared/test/"
cp "$WT/packages/storage/test/work-unit.test.ts"                       "$RED/packages/storage/test/"
cp "$WT/packages/org-manager/test/work-unit-service.test.ts"           "$RED/packages/org-manager/test/"
cp "$WT/packages/org-manager/test/work-unit-producers.integration.test.ts" "$RED/packages/org-manager/test/"

# 4. Run them against the BASE source.
cd "$RED" && npx vitest run \
  packages/shared/test/work-unit.test.ts \
  packages/storage/test/work-unit.test.ts \
  packages/org-manager/test/work-unit-service.test.ts \
  packages/org-manager/test/work-unit-producers.integration.test.ts
```

`$WT` = the C7-A worktree; `$RED` = a throwaway worktree of `9b8bf879`.

## RED — the four new test files against base `9b8bf879`

```
exit=1
Failed Tests 11
Test Files  4 failed (4)
     Tests  11 failed (11)
```

Failure kinds, verbatim from the run:

| Count | Error |
|---|---|
| 10 | `TypeError: ...SqliteWorkUnitRepo is not a constructor` |
| 3 | `Cannot find module` (the `@markus/shared/work-unit` exports) |

Representative per-file failures:

| File | Failing case (first) | Why it must fail on base |
|---|---|---|
| `packages/storage/test/work-unit.test.ts` | `work_units schema + ensure > 表与唯一索引存在` | No `work_units` table, no `uq_work_units_ref`, no `SqliteWorkUnitRepo` |
| `packages/storage/test/work-unit.test.ts` | `transition > 非法迁移 archived→running 抛错，且状态未被改动` | No matrix, no transition execution point |
| `packages/storage/test/work-unit.test.ts` | `linkMailboxItem > 把 NULL 的 work_unit_ref 写成真实 ref` | `work_unit_ref` exists since cut 6 but has no writer |
| `packages/org-manager/test/work-unit-service.test.ts` | service behaviour cases | `WorkUnitService` does not exist |
| `packages/org-manager/test/work-unit-producers.integration.test.ts` | chat / task / a2a producer cases | No producer wiring at all |
| `packages/shared/test/work-unit.test.ts` | matrix / `ref` format cases | `@markus/shared/work-unit` does not exist |

This is the failure mode the card was written against: on base, a WorkUnit simply is not
expressible, so every assertion about identity, idempotency, matrix refusal and mailbox
linkage fails at import or construction — it cannot pass by accident.

## GREEN — the same four files on the C7-A commit

```
exit=0
Test Files  4 passed (4)
     Tests  38 passed (38)
```

38 cases across the four files:

| File | What it locks down |
|---|---|
| `packages/shared/test/work-unit.test.ts` | State set closure, `WU_TRANSITIONS` edges, `archived` terminal, the three `ref` formats |
| `packages/storage/test/work-unit.test.ts` | Table + unique index exist; `ensure()` idempotent (second call `created=false`); concurrent `ensure` on one `ref` yields exactly one row; bypassing `ensure()` to insert a duplicate `ref` is rejected by the index; illegal `archived → running` throws and leaves state unchanged; legal transition writes a `status_transitions` row with `entity_type='work_unit'`; `archived_at` set on archive; `linkMailboxItem` writes the column and returns `false` for a missing row (no silent success); `listByAgent` / `listChildren` read-back |
| `packages/org-manager/test/work-unit-service.test.ts` | `ensure` never throws on write failure; `transition` throws on matrix violation; failure paths emit structured events and increment counters; `workStatus()` report shape |
| `packages/org-manager/test/work-unit-producers.integration.test.ts` | chat / task / a2a producers each create a WorkUnit and point the triggering mailbox row at it, in that order |

## What this evidence does NOT cover

- It is not a full-repository regression run. The full suites are reported separately in
  the PR body (`storage` + `org-manager` + `shared`, and `core`).
- It is not a live-service probe. The three-channel probe is a separate reading and is
  described in the implementation record, including its limitation (real SQLite file and
  real producer code, not a booted server).
- The base has no `work_units` table, so the RED run cannot express "the table exists but
  is empty" — that state belongs to cut 6, where the column existed with zero writers.
