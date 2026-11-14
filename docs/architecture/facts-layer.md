# Facts Layer (C9-A) — contract

Status: **implemented** (C9-A). Board / Inbox derivation and the independent verifier are C9-C/D/E.

A **fact** is a structured statement that some work *proved* something, with the evidence pointer
and the identity of the turn that asserted it. It replaces prose-as-record on the read path:
`task_comments` / `deliverables` stay the narrative layer, `facts` is the machine layer.

This file is the single source of truth for the invariants below. Every invariant names its
enforcement point — an invariant without an execution point is not an invariant.

---

## 1. Invariants and where each one is enforced

| # | Invariant | Enforced by |
|---|---|---|
| 1 | A fact is **immutable**; it is superseded, never rewritten | DB trigger `facts_no_rewrite` (any `UPDATE` touching `value_json` / `predicate` / subject / identity columns → `RAISE(ABORT)`) + `FactService.assert` never issues such an update |
| 2 | Identity is mandatory: `work_unit_ref`, `asserted_by`, `source_refs_json` non-empty. Empty = error, **not** a default | DB trigger `facts_require_provenance` (INSERT with NULL/'' → `RAISE(ABORT)`) + `missing_provenance` rejection in `FactService.assert` |
| 3 | Predicates are a **closed set** — no `custom.*`, no runtime registration | `packages/shared/src/facts/predicates.ts` (`FACT_PREDICATES`, compile-time visible) + `unknown_predicate` rejection + gate G5 |
| 4 | A subject+predicate has **at most one active row** | Partial unique index `ux_facts_active` + `must_supersede` rejection (never auto-supersede: replacing a conclusion is a separate decision) |
| 5 | **No self-verification**: the assertor cannot be the verifier of its own fact | `self_verification_forbidden` rejection in `FactService.assert` + gate G3 |
| 6 | Facts are only asserted at a **terminal hook**, never per turn | Prompt contract (§5) + product decision, not a runtime gate |

## 2. Single writer

```
packages/core/src/facts/fact-service.ts     → port (assert / supersede / queryActive)
packages/org-manager/src/fact-service.ts    → implementation — the ONLY file with `INSERT INTO facts` / `UPDATE facts`
```

`grep -rn "INSERT INTO facts\|UPDATE facts" packages/*/src` must return exactly that one file.
This is machine-enforced by the `facts-single-writer` invariant in `scripts/architecture-guard.mjs`
(fixtures self-test included), so a second write path fails CI rather than review.

The `supersede` update only ever sets `superseded_by` + `superseded_at` — never the value.

## 3. Rejection matrix (all rejections are actionable, none silent)

`FactService.assert()` returns `{ status: 'rejected', code, message, … }`:

| Condition | code | extra |
|---|---|---|
| predicate not in the closed set | `unknown_predicate` | `allowed: string[]` (nearest legal predicates) |
| value fails the predicate's schema | `schema_violation` | `path` (e.g. `/evidence_refs/0`) |
| `work_unit_ref` empty (turn not bound to a WorkUnit) | `missing_provenance` | — |
| `verified_by` == `asserted_by` | `self_verification_forbidden` | — |
| an active row already exists for subject+predicate | `must_supersede` | `existing_fact_id` |

`fact_supersede` performs "assert new + mark old" in one call, in one transaction: a two-step API
guarantees someone does only one half.

`fact_query` is **exact matching only** (subject / predicate / active). No fuzzy or semantic
search: a guess layer on top of the fact layer puts back the ambiguity the facts exist to remove.
Its description states the division of labour (`memory_search` = "what did we discuss",
`fact_query` = "what is concluded").

## 4. Schema

`facts` is created in `packages/storage/src/sqlite-storage.ts` (`SCHEMA_SQL`), pure additive — no
backfill, no historical comment/deliverable migration. Columns: `id`, `subject_kind`,
`subject_id`, `predicate`, `value_json`, `work_unit_ref`, `asserted_by`, `source_refs_json`,
`verification_json` (`{result, verified_by, evidence_refs?}` or NULL), `confidence`,
`created_at`, `superseded_by`, `superseded_at`.

`verification_json` lives on the asserting row (rather than a second "verification fact" row) so
that "who verified this" can never be a second writer of the same conclusion; C9-E builds the
verifier flow on top of it.

## 5. Prompt surface: `[FACTS:<subject>]`

`packages/core/src/facts/facts-block.ts` is a **pure function** — no IO, no clock, no randomness —
rendered into the per-turn volatile tail (`ContextEngine.buildSystemPrompt` → `volatile`), never
into the byte-stable system text (same reason knowledge.md moved there: a per-turn change inside
the system message invalidates the whole prefix cache).

```
[FACTS:task_tsk_a208c5c7]
· task.completion_evidence {"summary":"…","evidence_refs":3}
· work.defect_class {"class":"R1","instances":4}
+2 more (use fact_query)
```

Guarantees (each one machine-tested, no mocked repo):

- **Same subject + same fact set ⇒ byte-identical output.** Sorted by predicate; no timestamps,
  no `Date.now()`, no ids in the header beyond the subject.
- Only the **current subject** is rendered — a different subject's facts never leak in.
- Budget: ≤ 20 facts and ≤ 2000 characters. Over budget, truncation follows priority
  (`task.completion_evidence` > `task.rejection_reason` > `verification.result` > others) and the
  block ends with `+N more (use fact_query)`.
- An **empty set still emits a stable empty form** (`[FACTS:<subject>]` + `(no facts yet)`).
  "Omit the whole block when empty" is forbidden: two prefixes would mean two cache entries for
  the same state.

## 6. `FACTS_ENABLED`

`FACTS_ENABLED=0` restores today's behaviour exactly:

- the three tools are **not registered** (they do not appear in any tool schema);
- no `[FACTS:…]` block is rendered (the volatile tail is byte-identical to before);
- nothing reads or writes the `facts` table, so `DROP TABLE facts` is a complete rollback.

Default is **enabled** (`FACTS_ENABLED` unset or any value other than `0`). The flag is read once,
in `isFactsEnabled()` (`packages/shared/src/facts/predicates.ts`), so there is one reader, not one
per call site.

## 7. CI gates

`scripts/identity-audit.mjs` runs the same `SINCE` mechanism as the C8 gates:

| Gate | Violation |
|---|---|
| G6 | fact rows with empty `work_unit_ref` |
| G7 | fact rows with no usable `source_refs_json` |
| G8 | self-verified pass (`verification.result='pass'` and `verified_by = asserted_by`) |
| G9 | more than one active row for the same subject+predicate |
| G10 | predicate outside the closed set (whitelist injected from code) |
| G11 | `agent_decisions` rows in the new epoch (`created_at >= SINCE`) without identity |

G11 becomes active when C9-B adds `agent_decisions.work_unit_ref`; until that column exists the
gate reports **skipped (column not migrated)** instead of failing — an always-red gate that nobody
can act on is worse than no gate. The self-test still proves it bites on a migrated schema.
