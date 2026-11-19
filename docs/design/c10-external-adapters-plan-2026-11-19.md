# C10 — External Source Adapters: Execution Plan

Date: 2026-11-19 · Author: CTO · Status: **Owner-approved 2026-11-19 (with amendments); Part 1 in execution**
Base: `feat/refactor-plan` @ `617e9fda` (branch `task/c10-plan`)
Concept SSOT: master refactor plan (workspace deliverable `markus-master-refactor-plan-2026-11-11.md`, §4.9 / §5.2 C10 row / appendix A-4). This doc is the execution plan only; it does not redefine concepts.

> Owner instruction 2026-11-19: write the C10 plan; **anything still broken from earlier
> cuts gets fixed in the first half of C10**, with the problem and the solution written
> here. Part 1 is that first half. Part 2 is C10 proper.
>
> Owner decision 2026-11-19 (adjudicates the ⚖ gates below): **no data migration and no
> DROP — old-user compatibility is preserved**; everything else is delegated to the CTO
> on first principles. Fix existing defects completely before starting C10 proper.
> Consequences: 0C becomes freeze-and-guard (no table drop); 0B's disposition uses a
> fixed product-wide epoch constant in code, never an instance restart reading.

---

## 0. Position and preconditions

- C6–C9 code is merged into `feat/refactor-plan`: #451 (C8), #459 (C9 integration),
  #461 (C9 doc placement), #462 (C8 residuals, merged 2026-11-15 22:04 CST),
  #464 (forever loop + work record by entity, merged 2026-11-19 12:11 CST).
  At snapshot time no code PR was open against the integration branch; the first are
  this plan (#466) and C10-0A (#467).
- Master plan §5.1 rule 0 stands: **nothing enters `main` until all cuts are complete
  and accepted.** All probes run against feature-branch builds.
- The running instance **now contains the new build**: process started 2026-11-19
  14:09:30 CST; `app.asar` built 12:13 the same day; symbol probes `loop_` ×17 and
  `declarationDebt` ×2 present; `/api/health` = `0.12.3`, 100 agents, port 8056.
  Live-DB readings taken after 14:09:30 measure the #464 build — earlier rows do not.
- C10's precondition "C9 fact layer stable" is **code-stable but not runtime-closed**:
  the C9-E terminal-hook probe (steps 0–5, recorded in the C9 probe spec) has never
  been executed on a running instance. Its trigger condition (C9-E in the running
  build) became true at 14:09:30 today. It is therefore the first item of Part 1,
  not a reason to defer C10 planning.

### 0.1 Evidence snapshot (2026-11-19 14:1x CST, all freshly measured)

`node scripts/identity-audit.mjs` against `~/.markus/data.db`
(window `SINCE` = 2026-11-12T06:16Z rolling 7 days; decisions epoch = 2026-11-15T00:00Z):

| Gate | Reading | Breakdown (measured, gate criteria) |
|---|---|---|
| 1 identity missing | **334** | 328 pre-seal historical (11-12: 110 / 11-13: 166 / 11-14: 89) + **6 `requirement_update` rows from the old-build era** (11-15T20:05Z → 11-18T08:07Z). **0 after today's restart** — but no `requirement_update` event has fired since, so the path is untested, not proven |
| 2 dangling ref | **5** | all 2026-11-16: `task_tsk_1203177c_r1` ×3, `task_tsk_30360e66_r5`, `task_tsk_280e77f4_r1` — refs declared on mailbox items whose WorkUnit was never ensured. Gate has **no time filter** → stays red forever unless dispositioned |
| 3 zombie running | 0 | — |
| 5 cancel fact w/o identity | **3** | `task_status_update` with `invalidatesPremise:true`, 11-14T14:48/15:22/15:44Z — pre-seal historical, ages out of the window by 11-22 |
| 6–10, 12–13 (facts layer) | **0** | all green |
| 11 new-epoch decision w/o identity | **23** | `pick` decisions: 11-17: 1 / 11-18: 14 / 11-19: 8 — **all written by the pre-restart process**. The new build's first pick (06:12Z = 14:12 CST) **has** a ref (n=1) |

Other live counts: `work_units` 401, `facts` 39, `envelope` non-empty 937, tables 53.
`marketplace_templates` 2 rows + `marketplace_skills` 1 row, **zero read paths in code**.

Code facts (HEAD `617e9fda`):

- `attention.ts:1822` — `recordDecision` writes `workUnitRef: item.workUnitRef ?? null`:
  decision identity is only as good as item identity. #464 rewrote `attention.ts`
  (522 lines) and `mailbox.ts`; the item-side gap appears closed but n=1.
- `requirement-service.ts:706 / 808 / 1018` — `workUnitRef: agent.turnWorkUnitRef?.() ?? null`.
  **Live code gap**: requirement events triggered by a human (approve / reject / status
  change via UI) happen outside any agent turn → `turnWorkUnitRef()` is null → the row
  lands without identity. The 6 leaked rows prove this path fires in production.
- `agent.ts:1876` — `enqueueToMailbox` is a thin pass-through to `mailbox.enqueue`;
  there is **no identity enforcement at the assembly point**.
- `MARKUS_STRICT_IDENTITY` — 0 hits repo-wide: the flag was retired (#462/#464);
  enforcement is now structural (`refOrigin` contract, `docs/architecture/mailbox-system.md` §3.2).
- CI runs `identity-audit.mjs --self-test` only (`.github/workflows/ci.yml:68`).
  No scheduled real-DB audit exists — the 23 pick rows accumulated over 3 days unnoticed.

---

## Part 1 — Close prior residuals (C10-0)

Six cards, cut by independently reviewable seam. Owner decision gates are marked ⚖.

### C10-0A · Identity enforcement at the single assembly point (P1+P2+P3) — DONE (#467)

**Problem.** Three leaks, one root cause: a mailbox item can declare (or omit) a
`work_unit_ref` without anyone checking that the referenced WorkUnit exists.
- P1: `requirement_update` enqueued outside a turn writes NULL (6 rows, live code gap).
- P2: task status/rejection paths declare `task_<id>_r<round>` refs that were never
  ensured (5 dangling rows).
- P3: `pick` decisions inherit whatever the item had (23 rows, old process).

**Solution (structure, not guards) — implemented in #467.** `mailbox.enqueue` is
already the single envelope assembly point (C2). It is now the single **identity
enforcement point** too:
1. Every non-platform-internal enqueue must carry a resolvable `work_unit_ref` or an
   explicit `refOrigin` declaration; the guard rejects with an actionable message
   pointing at the two legal exits (constructor / declaration).
2. A declared ref is ensured at the assembly point via `MailboxIdentityPort.ensureIdentity`
   (wired by `APIServer.wireWorkUnits` to `WorkUnitService.ensure`, the one writer, C7) —
   "declared but uncreated" becomes structurally unrepresentable. Ensure failures are
   counted (`takeIdentityEnsureFailedCount`), never silent, never break the business
   path. Owner resolution lives in org-manager: task → assignee, requirement → creator,
   fallback: recipient. Core never guesses entity semantics.
3. The three requirement-service sites carry
   `turnWorkUnitRef ?? WORK_UNIT_REF.requirement(id)` — never NULL. The turn ref is kept
   when present because C8-B same-turn delta matching is exact-ref; the entity ref
   (`requirement:<id>`, single constructor in shared) covers human-triggered events
   outside any turn. The `?? null` fallbacks are deleted, not guarded.
4. `linkExecutionEpoch` transitions a notification-prebuilt idle WU to `running`
   (`execution_started` transition row) — a turn never runs on an idle row; ensure is
   insert-or-nothing, the same row is reused.
5. `recordDecision` keeps copying `item.workUnitRef` — no second writer, no new
   mechanism; once items are honest, decisions are honest.

**Acceptance (probes on the running build, not fixtures).**
- Human approves a disposable requirement while the assignee is idle → the
  `requirement_update` row has a ref that resolves in `work_units`; gate 1 count for
  new `requirement_update` rows = 0.
- Reject a disposable task → `task_status_update` / `task_comment` refs resolve;
  gate 2 gains no new row.
- ≥10 `pick` decisions across ≥3 source types on the new build, all refs resolving;
  gate 11 stops growing.
- Behavior tests bite: removing the enforcement makes each probe's test red;
  `--self-test` still 13/13 (fixtures use post-epoch timestamps).
- Full regression green in CI order (typecheck → lint → architecture-guard → tests).

**Status 2026-11-19**: code + tests + docs landed in #467 (target suite red(10) →
green(53); real-SQLite probes for the idle→running transition and the identity-port
wiring; full regression core+org-manager+shared 6012 passed / 11 skipped, 449 files;
eslint 0 errors; architecture-guard 27/27). The runtime probes above run after #467
merges into `feat/refactor-plan` and the instance restarts into it — they are 0B's
entry evidence, not a fixture substitute.

### C10-0B · Backlog disposition + audit execution point (P4+P6) — policy adjudicated

**Problem.** After 0A, the gates still read red for rows that can never be fixed:
gate 2's 5 rows (no time filter) and gate 11's 23 rows (fixed epoch 11-15, all
pre-restart). A permanently-red, unactionable alarm trains people to ignore it —
the audit script's own documented failure mode. And nobody runs the real-DB audit
periodically (G4): CI cannot have a real DB, so "who runs it and records the result"
is missing, not "wire it into CI".

**Solution.**
1. **Disposition policy (Owner-approved 2026-11-19)**: add a documented build-epoch
   filter to gates 2 and 11 — same pattern as the existing `DECISIONS_IDENTITY_EPOCH`:
   a **fixed product-wide epoch constant in code** (value 2026-11-19T06:09:30Z, the
   first restart into the identity-complete build), identical on every instance —
   never read from instance state (a per-instance restart reading is a second writer
   and drifts per install). The 28 historical rows are enumerated in a dated record
   (`docs/records/identity-backlog-disposition-2026-11-1x.md`) with their refs and why
   they are pre-fix. Gate 1's 328+6 historical rows age out of the rolling window
   naturally (by 11-22 / 11-26); the 6 are listed in the same record. No backfill,
   no fabricated history, rows stay readable.
2. **Execution point**: a named clock source (the `AgentClock` pattern — no second
   `setInterval`) runs the real-DB audit daily, writes the readings as a dated
   record/fact, and surfaces any post-epoch violation in the overview. Alert only on
   actionable (post-epoch) violations.

**Acceptance.** Two consecutive daily runs recorded with timestamps; a seeded
violation on a test instance produces a visible alert; `--self-test` unchanged and
green; the disposition record enumerates exactly 34 rows (5+23+6) plus the 3 gate-5
rows with their aging-out dates.

### C10-0C · Orphan marketplace rows (P5, master-plan G7) — adjudicated: freeze, no DROP

**Problem.** `marketplace_templates` (2 rows) and `marketplace_skills` (1 row) still
hold data, but #462 (A3, Owner-merged) deleted their CREATE statements and repos;
grep confirms **zero read paths**. New databases no longer create these tables, old
ones still have them — the schema has forked, and three rows are unreachable.
"Table exists, data exists, nobody can read it" is not a safe state.

**Decision (Owner 2026-11-19): no migration, no DROP — old-user compatibility wins.**
The earlier recommended option (export then drop) is rejected: dropping tables on
existing installs is a data migration, and the 3 rows are harmless where they sit.
What is not safe is *ambiguity* — "table exists, data exists, nobody can read it"
without a recorded verdict. So freeze, don't delete:
1. Export the 3 rows verbatim into a dated record
   (`docs/records/marketplace-orphan-freeze-2026-11-1x.md`) — git becomes the readable
   archive; the DB rows stay untouched.
2. An architecture-guard invariant forbids any new reader/writer of
   `marketplace_templates` / `marketplace_skills` in source (resurrection guard) —
   the tombstone cannot grow a second life.
3. The schema fork is documented as intentional: fresh DBs never create the tables;
   existing DBs keep them frozen. No migration closes the fork by deletion.

The master plan's §M6 / §8.4 / G7 wording is aligned this round to the adjudicated
reality: "delete CREATE statements + unreachable repos; data rows frozen in place;
no DROP, no migration" (G6 was settled by the Owner's #462 merge).

**Acceptance.** Record contains all 3 rows byte-faithful; the guard invariant is
present and biting (a seeded reader fails the guard); zero code paths read or write
the two tables; no migration entry added; existing rows untouched (before/after row
counts identical).

### C10-0D · C9 runtime close-out (P7)

**Problem.** C9's code is merged and its close-out record exists
(`docs/records/cut9-live-verification-2026-11-15.md`, added via #462), but the
**runtime** half was never executed: branch code does not run at review time, and
until today the serving instance predated C9-E. The requirement
`req_dcbf7ddf997c6346e0ee1ba2` is still `in_progress`.

**Solution.** Execute the recorded C9-E probe spec (steps 0–5) now that the trigger
condition holds (instance restarted 14:09:30 into the #464 build):
0. Record the instance's version/commit evidence (already in §0.1).
1. Tool reachability before hooks: actually call `fact_assert` and
   `task_submit_review` once each in an execution session.
2. Negative: disposable one-shot card, no fact asserted → submit must be rejected;
   record the exact error text.
3. Positive: same card, `fact_assert` per the error text → same path submits clean.
4. Cancel the disposable card; dirty state back to zero.
5. Laziness: `FACTS_ENABLED=0` on a **second instance** (independent port + data
   dir) — both hooks inert, old behavior unchanged, readings before/after.
   **Never restart the serving instance.**
Readings land in `docs/records/cut9-runtime-probe-2026-11-19.md`; then the
requirement goes through review to completed (reviewer, not the worker).

**Acceptance.** All six steps have timestamped readings; the record is referenced
from the C9 close-out record; requirement status changes via the review gate.

### C10-0E · `agent_activities` append-only (P8, master-plan G8)

**Problem.** Promised in the C8 archive (§3.3) and never done: activity rows are
still updatable, so "what happened" has a second writer path.

**Solution.** Remove UPDATE paths on `agent_activities`; corrections become new
rows; readers derive current state; an architecture-guard invariant forbids
`UPDATE agent_activities` in source. No data migration (existing rows stay).

**Acceptance.** `grep "UPDATE agent_activities" packages/*/src` = 0; a behavior test
that attempts an update is rejected; derived readers unchanged in output (dual-run
diff = 0 on live data).

### C10-0F · L4 baseline + gate wording (P9+P10, master-plan G9/G10)

**Problem.** The single north star (L4: human attention per completed work) has
never been measured; and L1's wording ("no `Thread` symbol") can never pass because
C9's derived views are legitimately named `ThreadStage*`.

**Solution.**
- L4: define the measurement from existing tables only — human interventions =
  `status_transitions.changed_by_type='human'` on task/requirement objects per day;
  completed work = work units reaching terminal per day. A script computes the
  ratio; record a 7-day baseline as a dated record. No new instrumentation tables.
- L1: tighten to "no `Thread` **domain object**; derived-view names allowed"
  (master plan updated this round); align any repo doc still claiming 55 tables or
  "no table drops".

**Acceptance.** Baseline record with daily readings + reproducible script; wording
change landed in both SSOTs; no doc contradicts the measured table count (53).

### Part 1 dependency graph

```
0A (identity enforcement) ──> 0B (disposition + audit point; needs 0A verified first)
0C (orphan freeze + guard)     independent (Owner decision rendered: no DROP)
0D (C9 runtime probe)          independent (trigger already true)
0E (append-only)               independent
0F (baseline + wording)        independent
```

Part 2 starts only when 0A/0B/0D are accepted (identity gates green on the new
epoch, C9 runtime-closed). 0C/0E/0F may finish in parallel with early Part 2 slices.

---

## Part 2 — C10 proper: external source adapters

Scope authority: master plan §5.2 C10 row + §4.9.4 trust boundary + §4.9.5 hook
list (H3/H5/H6/H7/H8/H9/H11 enable here). The one-sentence contract:

> **An adapter only translates an external event into a DeliveryEnvelope. It never
> routes, never decides identity, never writes WorkUnits directly. The platform
> signs all outbound uniformly. Every external event is traceable
> `external_thread_ref → work_unit_ref`. `verified=false` inbound can only
> `observe`. No new table without a writer and real traffic.**

### C10-A · Identity columns and envelope slots (H3 / H5 / H6)

**What.** Build the columns §4.9.6 reserved (names and semantics already frozen):
- `organizations.org_slug TEXT` — nullable, `UNIQUE`, immutable after first address
  issuance, `source:'registry'` semantics. The two historical orgs get explicit
  `org_<id>` values in one migration — **never derived from `name`** (both rows are
  literally named "My Organization"; slugify would be a second writer).
- `agents.agent_alias TEXT` — nullable, `UNIQUE(org_id, agent_alias)`; unset = no
  mail address; a change revokes the old binding + isolation period.
- `role_slug` — name stays reserved; **no table until a consumer exists** (the
  tombstone lesson: a table nobody reads is where a second copy of a fact goes).
- `envelope.auth = {spf, dkim, dmarc, verified}` — four nullable fields, no values
  written until an adapter actually verifies.
- `address_bindings.kind` column; `status_transitions.entity_type` gains `address`
  (TEXT, no schema change).

**Migration discipline** (data-layer contract): DDL + migrations array entry both;
indexes/uniques after migrations, never in `SCHEMA_SQL`; nullable only; no backfill
of observation logs; fresh-DB and migrated-DB schema identical (tested).

**Acceptance.** Columns + constraints exist on both fresh and migrated DBs;
`formatAddress`/`parseAddress` behavior tests still 24/24 (the format does not
change); explicit-assignment probe for the two orgs; a test proves no code path
derives a slug from a display name.

### C10-B · Adapter contract + first adapters: webhook and RSS

**What.** One adapter interface, two first consumers chosen because they need
**no DNS change and no auth chain** — everything arrives `verified=false` and the
observe ceiling is exercised from day one:
- Interface: external event → envelope `{from: AddressRef{kind:'external', raw,
  verified:false}, to: <resolved internal address>, messageId (idempotency key),
  external_thread_ref (opaque, read-only, never routes/dedupes), auth: null}`.
  Enqueue goes through the single assembly point (which enforces identity after
  C10-0A) — adapters get no private write path.
- Each adapter: its own kill switch (offline without losing queued items), its own
  traffic gate: **≥1 real event → envelope row → resolving work_unit_ref → visible
  in overview**. A 0-row table at acceptance = fail, not "ready for traffic".
- IM adapters come next, reusing the existing messaging-gateway (bot instances,
  channel refs, bindings); the adapter only translates, the gateway keeps its
  single-writer contracts.

**Acceptance.** Real webhook POST and real RSS item each traced end-to-end in the
live DB; `verified=false` signal cannot create a task or send a message (behavior
test bites: flip the ceiling → red); duplicate `messageId` produces exactly one
item; kill switch stops ingestion cleanly.

### C10-C · Trust boundary enforcement (H7 + observe ceiling)

**What.**
- `cross_org_policy` defaults `observe`; elevation to `auto` requires one human
  approval + an audit row. Global resolution stays org-agnostic (the C6 partial
  unique index already excludes `org_id`).
- The `verified=false → observe` ceiling is enforced at **one point** — the
  autonomy axis (`maySelfInitiate`, #462) — not per-adapter guards.
- Forged-identity rule: an external `From` that looks internal
  (`cto.acme@markus.global` from outside) is still `kind:'external', verified:false`
  — dot-count parsing decides namespace, string similarity never decides identity.

**Acceptance.** Forged-From probe lands in observe-only; cross-org delivery probe
between the two local orgs resolves globally; policy elevation without a human
approval row is rejected.

### C10-D · Email (⚖ every DNS/policy step Owner-approved)

**What.** Last, because it is the only adapter whose trust chain requires external
changes. Order inside the slice:
1. ⚖ SPF include + DKIM key generation (keys never in DB or agent-readable files)
   + DMARC `p=none → quarantine` — each a separate Owner-approved DNS change with
   a written rollback.
2. Inbound: SES receipt rule → the C10-B webhook adapter → verification fills
   `envelope.auth`; `verified=true` only when SPF/DKIM/DMARC pass.
3. Outbound: platform-uniform signing; agents never choose `From`;
   `outbound_policy` slot governs what may leave.
4. Bounce: DSN → `bounced(dsn_bounce)` → catch-all (the reserved 6th `drop_reason`
   enables here); never silent.

**Acceptance.** One real round-trip email with auth results recorded in the
envelope; a forged email lands observe-only; a bounce is visible in catch-all;
DMARC rollback rehearsed once.

### Explicit non-goals (inherited, unchanged)

No four-tier autonomy (product decision, Owner only); no `rest()` for N workers;
no global slug registry until global addressing actually enables (H11); no `+tag`
sub-addressing (v2); no `main` merge / release without Owner approval; no DNS
change without Owner approval; no new table without writer + traffic gate.

### L5 end-to-end acceptance (master plan §4.3)

Give a content agent a resource it has never owned (an RSS feed is enough): within
one conversation it binds the address, receives the first real signal, and proposes
the next step — no human UI clicks — with corresponding rows in `work_units`,
`address_bindings`, and `facts`. This is the cut's final gate, after C10-B.

---

## 3. Execution discipline

- Branches `task/c10-<slice>` from `origin/feat/refactor-plan`; one worktree per
  card; PR base `feat/refactor-plan`, never `main`.
- Per slice: red test first → implement → real-data probe on the running build →
  full regression in CI order; one rollback-able commit per slice.
- Evidence: every reading carries a timestamp; live counts written as "≥N + read
  time"; gates must be seen red before green (`--self-test`); no fixture-only proof.
- Owner gates: backlog disposition (0B) and orphan disposition (0C) **adjudicated
  2026-11-19** (no migration / no DROP; fixed epoch constant). Remaining: each
  DNS/policy change (C10-D), and the final `main` merge after all cuts are accepted.

## 4. Card summary

| Card | Seam | Depends on | Owner gate |
|---|---|---|---|
| C10-0A | identity enforcement at mailbox assembly + 3 enqueue fixes + probes | — | done (#467) |
| C10-0B | audit epochs + disposition record + daily audit clock source | 0A | policy adjudicated |
| C10-0C | orphan freeze record + resurrection guard (no DROP) | — | adjudicated: freeze |
| C10-0D | C9-E runtime probe 0–5 + requirement close-out | — | — |
| C10-0E | agent_activities append-only + guard | — | — |
| C10-0F | L4 baseline script/record + L1 wording | — | — |
| C10-A | identity columns + envelope slots | 0A/0B/0D accepted | — |
| C10-B | adapter contract + webhook + RSS (+IM next) | C10-A | — |
| C10-C | trust boundary + cross-org policy | C10-B | — |
| C10-D | email auth chain + in/outbound + bounce | C10-C | ⚖ per DNS step |