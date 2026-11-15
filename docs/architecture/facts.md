# Facts (C9) — the row contract and the verification mechanism

> **Single authority.** 本文件是 C9 事实层的单一权威，2026-11-15 由 `facts-layer.md` 与
> `facts-verification.md` 合并而来（原因：两者描述同一子系统，分开维护会产生第二写者）。
>
> The merge is lossless: **Part I** is the C9-A row contract (invariants, single writer, rejection
> matrix, schema, prompt surface, flag, CI gates), **Part II** is the C9-E verification mechanism
> (producer ≠ confirmer, write-once verdicts, the two terminal hooks, dream suggestions, the
> read-only audit page). Section numbers stay 1-7 and 8-12 respectively, so that a `§N` reference
> pointing at this subsystem keeps resolving after the merge.

Status: **implemented** (C9-A + C9-E). The stage / inbox derivation and the four observation
tables are C9-C / C9-D / C9-B and live in [`derived-views.md`](./derived-views.md).

A **fact** is a structured statement that some work *proved* something, with the evidence pointer
and the identity of the turn that asserted it. It replaces prose-as-record on the read path:
`task_comments` / `deliverables` stay the narrative layer, `facts` is the machine layer.

This file is the single source of truth for the invariants below. Every invariant names its
enforcement point — an invariant without an execution point is not an invariant.

---

## Part I — the row contract (C9-A)

### 1. Invariants and where each one is enforced

| # | Invariant | Enforced by |
|---|---|---|
| 1 | A fact is **immutable**; it is superseded, never rewritten | DB trigger `facts_no_rewrite` (any `UPDATE` touching `value_json` / `predicate` / subject / identity columns → `RAISE(ABORT)`) + `FactService.assert` never issues such an update |
| 2 | Identity is mandatory: `work_unit_ref`, `asserted_by`, `source_refs_json` non-empty. Empty = error, **not** a default | DB trigger `facts_require_provenance` (INSERT with NULL/'' → `RAISE(ABORT)`) + `missing_provenance` rejection in `FactService.assert` |
| 3 | Predicates are a **closed set** — no `custom.*`, no runtime registration | `packages/shared/src/facts/predicates.ts` (`FACT_PREDICATES`, compile-time visible) + `unknown_predicate` rejection + gate G5 |
| 4 | A subject+predicate has **at most one active row** | Partial unique index `ux_facts_active` + `must_supersede` rejection (never auto-supersede: replacing a conclusion is a separate decision) |
| 5 | **No self-verification**: the assertor cannot be the verifier of its own fact | `self_verification_forbidden` rejection in `FactService.assert` + gate G3 |
| 6 | Facts are only asserted at a **terminal hook**, never per turn | Prompt contract (§5) + product decision, not a runtime gate |
| 7 | Every turn that can assert a fact carries a **turn WorkUnit identity**, and an execution turn's identity is `WORK_UNIT_REF.task(taskId, round)` with the same `round` the session is actually running | `Agent.turnWorkUnitRef()` reads `taskAsyncContext.workUnitRef` first (per-execution scope) and only then the mailbox-focus field; `executeTaskConcurrent` / `executeChatTask` / the review turn each set it from that one constructor |
| 8 | **`round` has exactly one owner: the dispatcher.** Consumers set no default; when a consumer cannot see the authoritative round it must not speak for it (no identity, fail closed) | `work_units.work_unit_ref` / `facts.work_unit_ref` / the task session id are all built by `WORK_UNIT_REF.task(taskId, round)` — one constructor; the only `?? 1` is in `TaskService` at the point that creates the `task_execution` mailbox item; guard `identity-string-single-builder` forbids a second builder or a reverse parse (string → entity) anywhere else |

**What "no identity default" means here — precisely.** There is **no identity-specific default and
no tool-layer fallback**, and there is **no round default in any consumer**: the round has exactly
one owner, the dispatcher (`TaskService`, at the point where it creates the `task_execution`
mailbox item — "definitional default: never executed ⇒ round 1"). Everything downstream derives
the identity, the session id and the fact provenance from that one value through one constructor
(`WORK_UNIT_REF.task(taskId, round)`). A consumer that cannot see the authoritative round does
**not** substitute `1`: it refuses to start the epoch, logs a structured warning, and claims no
identity at all (`fact_*` then rejects with `missing_provenance`). Guessing would be worse than
failing: the 2026-11-15 incident is exactly a consumer that computed round `1` for a session that
was running round 2, and injected a human comment into the *previous* epoch's session where the
running execution could never see it — silently, with no error.

**Derived rule — a terminal hook may only demand what is reachable in the same turn.**
Both C9-E hooks (§9) require a fact before the transition, so the tool that writes the fact must be
usable in the very turn that calls the hook. The 2026-11-15 incident is the counter-example:
the hooks were correct and *unreachable* at once, because task-execution turns carried no
identity and `fact_assert` / `fact_verify` therefore rejected with `missing_provenance`
(identity came only from the mailbox-focus chain). Reachability is part of the gate's contract,
not an implementation detail.

### 2. Single writer

```
packages/core/src/facts/fact-service.ts     → port (assert / supersede / queryActive)
packages/org-manager/src/fact-service.ts    → implementation — the ONLY file with `INSERT INTO facts` / `UPDATE facts`
```

`grep -rn "INSERT INTO facts\|UPDATE facts" packages/*/src` must return exactly that one file.
This is machine-enforced by the `facts-single-writer` invariant in `scripts/architecture-guard.mjs`
(fixtures self-test included), so a second write path fails CI rather than review.

The `supersede` update only ever sets `superseded_by` + `superseded_at` — never the value.

### 3. Rejection matrix (all rejections are actionable, none silent)

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

### 4. Schema

`facts` is created in `packages/storage/src/sqlite-storage.ts` (`SCHEMA_SQL`), pure additive — no
backfill, no historical comment/deliverable migration. Columns: `id`, `subject_kind`,
`subject_id`, `predicate`, `value_json`, `work_unit_ref`, `asserted_by`, `source_refs_json`,
`verification_json` (`{result, verified_by, evidence_refs, verified_at?, work_unit_ref?}` or NULL — `evidence_refs` is required since C9-E), `confidence`,
`created_at`, `superseded_by`, `superseded_at`.

`verification_json` lives on the asserting row (rather than a second "verification fact" row) so
that "who verified this" can never be a second writer of the same conclusion; C9-E builds the
verifier flow on top of it (§8).

### 5. Prompt surface: `[FACTS:<subject>]`

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

### 6. `FACTS_ENABLED`

`FACTS_ENABLED=0` restores today's behaviour exactly:

- the four tools (`fact_assert` / `fact_supersede` / `fact_query` / `fact_verify`) are **not registered** (they do not appear in any tool schema);
- no `[FACTS:…]` block is rendered (the volatile tail is byte-identical to before);
- nothing reads or writes the `facts` table, so `DROP TABLE facts` is a complete rollback.

Default is **enabled** (`FACTS_ENABLED` unset or any value other than `0`). The flag is read once,
in `isFactsEnabled()` (`packages/shared/src/facts/predicates.ts`), so there is one reader, not one
per call site.

### 7. CI gates

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

---

## Part II — verification, terminal hooks and audit (C9-E)

Part II builds on Part I (the C9-A row contract), on the thread-stage derivation (C9-C) and on the
inbox derivation (C9-D) — the latter two now live in [`derived-views.md`](./derived-views.md).

C9-A made "what did this work prove" a structured row with identity. C9-E closes the three things
that a row alone cannot close:

1. **Who confirms it** — a verdict written by somebody other than the assertor, through the one
   write path, and impossible to write for oneself.
2. **When a claim must exist** — the two terminal hooks at which prose used to be enough.
3. **Where the dream's advisory output goes** — into `memory.consolidation_suggestion` facts
   instead of prose in `knowledge.md` (closes DR7).

Nothing here adds a second writer. Every new write goes through `FactService` and therefore the
same single SQL file (`packages/org-manager/src/fact-service.ts`) that §2 already pins, which is
why the `facts-single-writer` CI invariant keeps holding without a new rule.

### 8. Verification is a fact *about* a fact

**Reachability invariant (2026-11-15 incident).** Both terminal hooks (§9) are only satisfiable
if the turn that calls them can *write* the fact they require. `FactService.assert` / `verify`
reject any turn without a WorkUnit identity (`missing_provenance`), so identity has to be
established by the turn itself: an execution turn's identity is `WORK_UNIT_REF.task(taskId, round)`
with the round actually being executed, held in the per-execution async scope
(`taskAsyncContext`) and read through the single reader `Agent.turnWorkUnitRef()`.
There is **no** "assert it from a chat turn instead" route: a chat round asserting on behalf of an
execution round is a second writer for the same fact and is not a legal path — when the two
disagree the answer is to fix the identity chain, never to route the write elsewhere.

`verification_json` lives on the asserting row (§4). C9-E gives it the only write path it may
ever have:

```
FactService.verify({ factId, result: 'pass' | 'fail', verifiedBy, evidenceRefs, workUnitRef })
```

| Rule | Why | Enforced by |
|---|---|---|
| `verified_by ≠ asserted_by` | producer ≠ confirmer; "I checked my own work" is the failure this whole layer exists to make impossible | `self_verification_forbidden` rejection in `FactService.verify` + gate G8 (SQL-level backstop) |
| only `verification_json` is written | a verdict must never rewrite the claim it judges | `verify()` issues no other column; DB trigger `facts_no_rewrite` aborts any update that touches value / predicate / subject / identity |
| the target must be **active** and exist | verifying history is meaningless (a superseded claim keeps the verdict it had) | `not_found` / `must_supersede` rejections |
| a verdict needs **at least one evidence pointer** | a pass with no pointer is the same unfalsifiable claim as prose | `schema_violation` at `/evidence_refs`, for `pass` **and** `fail` |
| **write-once** per fact | flipping a verdict in place would make the one column two writers over time; a changed verdict is a changed claim | `already_verified` rejection naming the existing verdict; the fix is to supersede the claim (a new row, unverified) |

`FactVerification` gained two optional fields inside the JSON column — `verified_at` and
`work_unit_ref` (the verifier's turn) — so the audit page can answer "who, when, in which turn".
No table change: the column shape is C9-A's.

**Who verifies** (requirement decision 3, written down so it is decided once):

| Situation | Verifier |
|---|---|
| Same team | the task's **reviewer** (never the assignee) |
| Cross-team | an agent named by the owning team's **manager** |
| Human reviewer | the human's decision is recorded by the platform as `verified_by = <user id>` |

`deriveStage()` (C9-C, [`derived-views.md`](./derived-views.md) §3) is the **only** consumer that
turns a verdict into a stage: `pass` + independent verifier ⇒ `done`; anything else (no verdict,
`fail`, or a self-verdict smuggled in past the write path) ⇒ `in_verification`. C9-E adds no second
derivation — the acceptance test removes the verification from a real fact and asserts the stage
falls back.

### 9. Terminal hooks — the only two places a claim is mandatory

Facts are **not** a per-turn obligation (the 166-turn incident in §5 came from exactly that
pressure). Two transitions are gated, both inside `TaskService`, which is the single execution
point for every caller (agent tool and REST alike):

| Hook | Gate | Rejection text must tell the model what to do |
|---|---|---|
| `task_submit_review` | an active `task.completion_evidence` fact for that task | names the exact `fact_assert` call shape (subject, predicate, value fields, source_refs) |
| reviewer rejects (`requestRevision`) | the acting agent must have an active `task.rejection_reason` fact for that task | names `fact_assert` with the `{reason, blocking_refs}` value shape |

Out of scope on purpose, and stated here so nobody "fixes" it later by accident:

- **chat / heartbeat / a2a** turns never need a fact — they have no terminal state.
- a **human** rejecting from the UI is not gated: a human has no turn identity and cannot assert
  a fact, so gating would only block the decision, not record it.
- `rejectTask` (a human rejecting a *pending* task at the approval gate) is a different event:
  it decides whether work starts, not whether work is done.

**Rollback**: with `FACTS_ENABLED=0` (or a `TaskService` built without a fact service) both hooks
are inert and submission/rejection behave exactly as before C9-E. Measured, not assumed — see §12.

### 10. dream output: seven suggestion actions land as facts (closes DR7)

DR7's authority is master plan §3.3: the seven advisory actions in `learning-loop.md §5` had no
landing place other than prose in `knowledge.md`, so they were unqueryable, unreviewable, and
could not be superseded. Target shape is master plan §4.5 line 784.

The **closed set of exactly seven** (an eighth is a schema violation, a missing one is a test
failure — both are mechanical):

| # | action | what it advises | `target_refs` |
|---|---|---|---|
| 1 | `archive` | a skill with no usage and age > 30 days | skill ids |
| 2 | `revise` | a skill whose success/usage < 0.5 (usage ≥ 3) | skill ids |
| 3 | `merge` | duplicate skill names / tags | colliding skill ids |
| 4 | `ttl` | notebook entries past their tier TTL | entry ids / tier keys |
| 5 | `promote` | 3+ observations sharing a theme | observation ids |
| 6 | `negative_feedback` | ≥ 3 negative feedback on a skill → revision task | skill ids + feedback ids |
| 7 | `team_skill` | ≥ 3 agents independently recorded the same theme | agent ids + observation ids |

Landing: **one active `memory.consolidation_suggestion` fact per agent**, whose value is the
current suggestion set:

```json
{ "suggestions": [ { "action": "archive", "target_refs": ["skl_…"] },
                   { "action": "promote", "target_refs": ["obs_…", "obs_…", "obs_…"] } ] }
```

Why a set-valued fact and not seven rows: §1 invariant 4 pins **at most one active row per
subject+predicate** (partial unique index `ux_facts_active`). Seven active rows for one agent would
need either a second index change (C9-A's table, out of scope) or a synthetic subject id that
encodes the action — structure inferred from a payload, which is R3. One row per agent also gives
the audit page the thing that actually matters: last cycle's suggestion set → this cycle's, with
who/when on both.

Each dream cycle therefore **supersedes** the previous snapshot (or asserts the first one), which
is the same lifecycle as any other conclusion; `supersede` keeps the old row, so history is never
rewritten.

**`knowledge.md` must not receive these seven as prose.** The writer is `writeKnowledgeMd` (single
physical writer, unchanged); the dream's suggestion stage calls `FactService`, never the memory
store. Two guards keep that from drifting back:

- the dream prompt says these are emitted as `suggestions` and **must not** be written as prose;
- a test runs the suggestion stage against a real memory store and asserts the `knowledge.md`
  bytes are unchanged (a reintroduced prose write turns it red).

The 7 actions are **computed** by a **pure** function
(`packages/core/src/facts/consolidation-suggestions.ts`): it takes structural inputs (skill
usage/success, notebook ages vs tier TTL, observation clusters, negative-feedback counts, peer
themes) and returns suggestions. No clock, no IO — the caller passes `now`. That is what makes
"all seven have a landing point" a unit test rather than a hope, and it keeps the platform from
inventing advice: a rule with no signal emits nothing.

#### 10.1 What the platform derives today, and what the model must declare

The pure function's input **type** is wider than what the dream actually supplies. Today the
production caller (`Agent.recordDreamSuggestions`) passes **exactly one** signal:

| action | derived by the platform at dream time? | signal / where it comes from |
|---|---|---|
| `promote` | **yes** | `plan.promote` — the clusters the dream's own consolidation step formed (3+ observations, one theme) |
| `archive` · `revise` · `merge` · `negative_feedback` | **no** | only the model's `suggestions` declaration |
| `ttl` | **no** | only the model's `suggestions` declaration |
| `team_skill` | **no** | only the model's `suggestions` declaration |

So in production, six of the seven land **only when the model declares them** in its `suggestions`
array; the closed-set parser drops anything that is not one of the seven, and drops an item with no
`target_refs`. Nothing is derived for them and nothing is written as prose instead.

What the dream prompt shows the model (built in `Agent.dream`): the current memory entries, a
preview of curated `knowledge.md` sections, and the seven action definitions with their thresholds.
What it does **not** show: per-skill usage/success counters, notebook tier TTLs, other agents'
observations. So the model's declarations are bounded by what it can see.

Why the other six are not derived — the signals have no producer today:

- **`archive` / `revise` / `merge`** need per-skill `usage_count` / `success_count` / `name` /
  `tags` / age. `recordSkillActivation` is wired (`Agent`, skill activation path), but the
  counters that make a *rate* are not: `recordSkillTaskSuccess` and `recordSkillTaskRejection`
  have no production caller (`packages/core/src/learning-loop.ts`), so `success_count` stays 0 —
  a derived `revise` would read a permanent 0/N and fire on every used skill. That is the platform
  manufacturing advice (R4), worse than emitting nothing.
- **`ttl`** would be a permanently empty branch: entries past their tier TTL are already removed by
  `pruneNotebookEntries` (per-tier TTL pass) before the dream reads the notebook, so there is never
  an expired entry left to report.
- **`team_skill`** needs a cross-agent view of observations; the core `Agent` has no such source.

The row that says "no" is a contract: any change that starts deriving one of those six must update
this table in the same commit. And the `negative_feedback` signal likewise needs a real feedback
producer before it can be derived rather than declared.

### 11. Read-only audit page `/#/audit/facts`

The product rule for the reader is: **a person never needs to see the fact layer to do their
job**, but the evidence chain and the audit trail must be reachable when something is questioned.

| Aspect | Decision |
|---|---|
| Who | `owner` / `admin` only. Everyone else gets no page and no navigation entry — the check is on the API (`403`) and the page is not even mounted, so a deep link cannot leak |
| What | active + superseded rows, filterable by subject kind / subject id / predicate / time range |
| Chain | each row shows `old → new → who → when` for its supersede link, plus `work_unit_ref` and the verifier (`result`, `verified_by`, `verified_at`) |
| Writes | none. The endpoint is `GET` only; there is no UI affordance that asserts, supersedes or verifies |

API: `GET /api/facts` — `subjectKind`, `subjectId`, `predicate`, `predicatePrefix`, `since`,
`until`, `includeSuperseded`, `limit` → `{ facts: [...], truncated: boolean }`.

### 12. Rollback and CI

`FACTS_ENABLED=0` now covers **five** surfaces, all measured in the acceptance run:

1. `fact_assert` / `fact_supersede` / `fact_query` / `fact_verify` are not registered;
2. no `[FACTS:…]` block in the volatile tail;
3. `GET /api/facts` returns `503`-equivalent "facts disabled" (the page then shows the disabled
   state rather than an empty table — an empty table would look like "no data");
4. `task_submit_review` and reviewer rejection behave exactly as they did before C9-E;
5. the dream cycle runs, but asserts no suggestion fact (it never writes prose either way).

CI gates added on top of §7:

| Gate | Violation |
|---|---|
| G12 | a `pass` verdict with no evidence pointer (`evidence_refs` empty / not an array) |
| G13 | a verdict whose `verified_by` is empty (a verdict with no author) |

`scripts/architecture-guard.mjs` keeps `facts-single-writer`; C9-E adds one more invariant —
`terminal-hook-single-point`: the two terminal checks live in `task-service.ts` and nowhere else
(the tool layer must not re-implement them, or a caller using the REST path would skip them).
