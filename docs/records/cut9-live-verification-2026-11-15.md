# C9 live verification — facts layer, derived board, independent verifier

Date: 2026-11-15 · Head at time of writing: `feat/refactor-plan` (C9 code merged via #459)
Status: **code complete and verified on real data; 刀-level close-out recorded here for the first time**

---

## 1. Why this record exists (and why it is dated the same day as the cut)

The C9 row in the master plan requires this file as an acceptance condition. It did
not exist. The acceptance task that would have produced it (`tsk_b06a0b33`) was
cancelled on the Owner's instruction and replaced with verification done directly in
session — but the conclusion was never written down.

That is the specific failure this file repairs: **a verification that exists only in a
conversation is not a verification, because the next reader cannot check it.** C8
already paid for this lesson (see `cut8-live-verification-2026-11-14.md`); C9 repeated
it. The fix is not "be more careful next time", it is "the record is a deliverable,
not a by-product".

## 2. Verification tree — which code is being verified

**The code under test is on `feat/refactor-plan`, not `main`.** Per master plan §5.1
rule 0, nothing enters `main` until all cuts are complete and accepted. A running
instance built from `main` therefore does **not** contain C9, and any reading taken
against it would be measuring the wrong build.

This is not a gap and not a pending approval. It is the accepted sequencing.

| Item | Where |
|---|---|
| `facts` table, unique writer, predicate closed set, three tools | `packages/core/src/facts/fact-service.ts` |
| derived stage (pure function) | `packages/core/src/facts/derive-stage.ts` |
| consolidation suggestions (closes DR7) | `packages/core/src/facts/consolidation-suggestions.ts`, `consolidation-recorder.ts` |
| facts prompt block | `packages/core/src/facts/facts-block.ts` |
| single cards | PRs #454–#458, all CLOSED, absorbed by **#459 `build/c9-integration`** |

> Note on PR archaeology: the five single-card PRs all show CLOSED. That is the
> cost of integrating through a branch — it reads as "nothing merged" to anyone
> scanning the PR list. Recorded here so the next reader does not re-open them.

## 3. The gates: what is enforced, and against what

`scripts/identity-audit.mjs` carries thirteen predicates. The ones that belong to C9:

| # | Gate | Reading on live DB (2026-11-15 21:5x) |
|---|---|---|
| 6 | fact has no source identity | **0** |
| 7 | fact not traceable (`source_refs_json` empty/invalid) | **0** |
| 8 | self-verified (`verified_by` == `asserted_by`) | **0** |
| 9 | two active values for one `subject+predicate` | **0** |
| 10 | predicate outside the closed set | **0** |
| 11 | new-epoch decision row without `work_unit_ref` | **0** (see §6 — column added today) |
| 12 | verification verdict without evidence | **0** |
| 13 | verification verdict without an author | **0** |

Every one of these can be shown to bite: `--self-test` seeds one violation per
predicate into a temporary database, asserts the count is 1, applies the fix, and
asserts the count returns to 0. Current result: **12/12 predicates bite and return to
zero.** A gate that has never been seen red is not known to work.

## 4. Live-database readings

Probe: `~/.markus/data.db`, read-only, 2026-11-15 21:53 local (Asia/Shanghai).

### 4.1 Facts

| Reading | Value |
|---|---|
| total facts | **18** |
| with non-empty `work_unit_ref` | **18 / 18** |
| with valid non-empty `source_refs_json` | **18 / 18** |

By predicate:

| predicate | count |
|---|---|
| `task.completion_evidence` | 11 |
| `task.rejection_reason` | 3 |
| `agent.capability_claim` | 3 |
| `memory.consolidation_suggestion` | 1 |

The predicate set is closed and small on purpose. A facts table that accepts any
predicate string is a key-value store with extra steps; the closed set is what makes
"this conclusion is about a task's completion evidence" a checkable claim rather than
a convention.

### 4.2 Supersede chain

| Reading | Value |
|---|---|
| active (`superseded_by IS NULL`) | **12** |
| superseded | **6** |

Facts are never edited in place. A conclusion that changes is superseded: the old row
keeps its value and gains a pointer to its replacement. History is never rewritten —
which is the only way "what did we believe on date X" stays answerable.

### 4.3 Independent verification

| Reading | Value |
|---|---|
| facts carrying a `pass`/`fail` verdict | 1 |
| of those, `verified_by` ≠ `asserted_by` | **1 / 1** |

The one verifiable fact was asserted by `agt_d7f911ea…` and verified by
`agt_b56cd620…`. Gate 8 exists precisely so that this ratio can never quietly become
0/N: a project that verifies its own work has no verifier, only a second signature
from the same hand.

### 4.4 Work units (the substrate facts hang on)

| status | count |
|---|---|
| idle | 178 |
| paused_budget | 5 |
| running | 6 |
| **total** | **185** |

Gate 3 (running with an expired lease) reads **0** — the six running units all hold
live leases, so they are working, not zombies.

## 5. Code-level verification

| Check | Reading |
|---|---|
| `tsc -b packages/{shared,storage,core}` | **0 errors** |
| C9-focused tests (`derive-stage`, `consolidation-suggestions`, `facts-block`, `fact-tools`) | **90 passed** |
| `derive-stage.test.ts` | 42 tests |
| `consolidation-suggestions.test.ts` | 20 tests |
| `identity-audit --self-test` | 12/12 predicates bite, all return to 0 |

`deriveStage()` is a pure function over facts; its 42 cases are positive and negative
per stage, so a stage regression fails by name rather than by a diff nobody reads.

## 6. Work done today that this cut depended on

Gate 11 had been **permanently skipped**, not passing: `agent_decisions` had no
`work_unit_ref` column, so "who cancelled which round" had no gate looking at it. The
column landed today (`d0fc267e`), together with the writer, the read direction, and a
fixed epoch for the gate (`DECISIONS_IDENTITY_EPOCH = 2026-11-15`) so it does not
spend a week red on 226,964 historical rows that can never be repaired.

Historical rows stay NULL and are not backfilled: their work units were never
recorded, so any value written there would be invention rather than data.

## 7. Conclusion — three-way, per the card discipline

**Verdict: PASS on code and live readings; two residual items, both named below.**

### Residual 1 — requirement status not yet updated

`req_dcbf7ddf997c6346e0ee1ba2` still reads `in_progress`. All five execution cards and
all four close-out cards are `completed`, and the code is on the integration branch.
The requirement status is the last bookkeeping step, and it is **not** something this
record may flip on its own authority — it is the Owner's acceptance signal, and
flipping it here would be the same class of error as self-verification.

### Residual 2 — C10 prerequisites are genuinely absent, and that is deliberate

`organizations.org_slug`, `agents.agent_alias`, `agents.role_slug`, and the
`envelope.auth` slot do not exist. Master plan §8 item 10 records this as an explicit
decision, not an oversight. C10 must not start before the facts layer is stable
(§5.1 discipline 3), and it has not.

### What is NOT residual

- The five single-card PRs showing CLOSED (§2) — that is how branch integration looks.
- Running against a `main` build instead of a `feat/refactor-plan` build (§2).
- Any expectation that C9 verification implies C10 may begin. It does not.

## 8. Reproduce

```bash
# gates against the live database (read-only)
node scripts/identity-audit.mjs

# prove the gates still bite (temp DB, seeds one violation each, asserts 1 then 0)
node scripts/identity-audit.mjs --self-test

# C9 code-level surface
npx tsc -b packages/shared packages/storage packages/core
npx vitest run packages/core/test/derive-stage.test.ts \
                packages/core/test/consolidation-suggestions.test.ts \
                packages/core/test/facts-block.test.ts \
                packages/core/test/fact-tools.test.ts
```

## 9. What this record does not cover

- The four-stage derivation's UI badge (§C9-C) — verified by `derive-stage.test.ts`
  and the component, not re-verified here.
- Inbox dual-run equivalence — has its own record:
  `cut9-inbox-dual-run-diff-2026-11-15.md`.
- Adjacent identity paths (shutdown re-queue, gateway receipt) — have their own
  records: `cut9-adjacent-identity-paths-2026-11-15.md`,
  `cut9-identity-declaration-2026-11-15.md`.

This file records the cut-level close-out; those three record their own subjects. No
fact is duplicated across them.
