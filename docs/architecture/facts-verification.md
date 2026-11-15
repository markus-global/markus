# Facts: independent verifier, terminal hooks, audit page (C9-E) — contract

Status: **implemented** (C9-E). Builds on `facts-layer.md` (C9-A), `thread-stage.md` (C9-C),
`inbox-derivation.md` (C9-D).

C9-A made "what did this work prove" a structured row with identity. C9-E closes the three things
that a row alone cannot close:

1. **Who confirms it** — a verdict written by somebody other than the assertor, through the one
   write path, and impossible to write for oneself.
2. **When a claim must exist** — the two terminal hooks at which prose used to be enough.
3. **Where the dream's advisory output goes** — into `memory.consolidation_suggestion` facts
   instead of prose in `knowledge.md` (closes DR7).

Nothing here adds a second writer. Every new write goes through `FactService` and therefore the
same single SQL file (`packages/org-manager/src/fact-service.ts`) that
`facts-layer.md §2` already pins, which is why the `facts-single-writer` CI invariant keeps
holding without a new rule.

---

## 1. Verification is a fact *about* a fact

**Reachability invariant (2026-11-15 incident).** Both terminal hooks (§2) are only satisfiable
if the turn that calls them can *write* the fact they require. `FactService.assert` / `verify`
reject any turn without a WorkUnit identity (`missing_provenance`), so identity has to be
established by the turn itself: an execution turn's identity is `WORK_UNIT_REF.task(taskId, round)`
with the round actually being executed, held in the per-execution async scope
(`taskAsyncContext`) and read through the single reader `Agent.turnWorkUnitRef()`.
There is **no** "assert it from a chat turn instead" route: a chat round asserting on behalf of an
execution round is a second writer for the same fact and is not a legal path — when the two
disagree the answer is to fix the identity chain, never to route the write elsewhere.

`verification_json` lives on the asserting row (`facts-layer.md §4`). C9-E gives it the only
write path it may ever have:

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

`deriveStage()` (C9-C) is the **only** consumer that turns a verdict into a stage:
`pass` + independent verifier ⇒ `done`; anything else (no verdict, `fail`, or a self-verdict
smuggled in past the write path) ⇒ `in_verification`. C9-E adds no second derivation — the
acceptance test removes the verification from a real fact and asserts the stage falls back.

## 2. Terminal hooks — the only two places a claim is mandatory

Facts are **not** a per-turn obligation (the 166-turn incident in `facts-layer.md §5` came from
exactly that pressure). Two transitions are gated, both inside `TaskService`, which is the single
execution point for every caller (agent tool and REST alike):

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
are inert and submission/rejection behave exactly as before C9-E. Measured, not assumed — see §5.

## 3. dream output: seven suggestion actions land as facts (closes DR7)

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

Why a set-valued fact and not seven rows: `facts-layer.md §1` invariant 4 pins **at most one
active row per subject+predicate** (partial unique index `ux_facts_active`). Seven active rows for
one agent would need either a second index change (C9-A's table, out of scope) or a synthetic
subject id that encodes the action — structure inferred from a payload, which is R3. One row per
agent also gives the audit page the thing that actually matters: last cycle's suggestion set →
this cycle's, with who/when on both.

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

### What the platform derives today, and what the model must declare

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

## 4. Read-only audit page `/#/audit/facts`

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

## 5. Rollback and CI

`FACTS_ENABLED=0` now covers **five** surfaces, all measured in the acceptance run:

1. `fact_assert` / `fact_supersede` / `fact_query` / `fact_verify` are not registered;
2. no `[FACTS:…]` block in the volatile tail;
3. `GET /api/facts` returns `503`-equivalent "facts disabled" (the page then shows the disabled
   state rather than an empty table — an empty table would look like "no data");
4. `task_submit_review` and reviewer rejection behave exactly as they did before C9-E;
5. the dream cycle runs, but asserts no suggestion fact (it never writes prose either way).

CI gates added on top of `facts-layer.md §7`:

| Gate | Violation |
|---|---|
| G12 | a `pass` verdict with no evidence pointer (`evidence_refs` empty / not an array) |
| G13 | a verdict whose `verified_by` is empty (a verdict with no author) |

`scripts/architecture-guard.mjs` keeps `facts-single-writer`; C9-E adds one more invariant —
`terminal-hook-single-point`: the two terminal checks live in `task-service.ts` and nowhere else
(the tool layer must not re-implement them, or a caller using the REST path would skip them).
