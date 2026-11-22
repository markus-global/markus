# C10 — External Source Adapters: Execution Plan

Date: 2026-11-19 · Refreshed: 2026-11-22 20:3x CST · Author: CTO
Status: **Part 1 CLOSED (all six cards dispositioned, code merged). Part 2 re-planned
from measured code state; ready to open as a new requirement.**
Base: `origin/feat/refactor-plan` @ `92237b30` (refresh worktree `task/c10-plan-refresh`).
Concept SSOT: master refactor plan (workspace deliverable
`markus-master-refactor-plan-2026-11-11.md`, §4.9 / §5.2 C10 row / appendix A-4).
This doc is the execution plan only; it does not redefine concepts.

> Owner instruction 2026-11-19: anything still broken from earlier cuts gets fixed in
> the first half of C10. That half is now closed (§1). Owner decision 2026-11-19
> (still binding): **no data migration and no DROP — old-user compatibility is
> preserved**; everything else delegated to the CTO on first principles.
> Owner instruction 2026-11-22: re-read the master plan, this plan, and the feature
> branch; adjust from first principles; update both SSOTs; propose the requirement
> and task DAG for the second half. This refresh is that adjustment.

---

## 0. Position and preconditions (measured 2026-11-22 20:2x CST)

- C6–C9 merged. Part 1 closed via #467 (0A), #468→#470 (0D), #475 (0B+0E+0C),
  plus the CI-wording card; 0F cancelled by adjudication (§1). C9 requirement
  `req_dcbf7ddf997c6346e0ee1ba2` = **completed** (runtime probe landed, 0D).
- Merged since the 11-19 snapshot: #471 (tool-budget eviction removed, `memory_curate`),
  #472 (chat reply recovery / notification folding / Feishu SDK egress), #474
  (background-callback lineage: one durable store, in-turn await, coalesced
  continuations), #475 (first-half closeout), #476 (concurrent session isolation),
  #477 (composer model menu never rewrites the agent binding).
- **The serving instance restarted 2026-11-22 20:18:34 CST into the fix build**
  (pid 28013, `ps -o lstart=` reading; `app.asar` built 20:17; symbol probes
  `identity-audit` ×15, `ensureExecutionEpoch` ×4, `epoch-unset` ×2;
  `/api/health` = 0.12.3, 100 agents, port 8056). This **triggers the 0B post-restart
  closure protocol** (disposition record §5) → card C10-0G below.
- Live readings (2026-11-22 20:2x CST, `~/.markus/data.db`): `work_units` 510,
  `facts` 61, `envelope` non-empty 1,704; business tables 53 (+`sqlite_sequence` = 54
  in `sqlite_master`, no new table since 11-19). Post-restart: `pick` decisions 2/2
  carry a resolving ref; `requirement_update` 1/1 carries a ref. `agents.autonomy`:
  **240/240 = 'act'** (no observe-mode agent today).
- Identity audit: `state = epoch-unset` — the honest sentinel reading. The epoch
  constant `IDENTITY_FIX_EPOCH` (shared `identity-audit.ts`) is still `null` at tip;
  finalization is C10-0G, not a silent assumption.
- Master plan §5.1 rule 0 stands: nothing enters `main` until all cuts are complete
  and accepted. All probes run against feature-branch builds.

### 0.1 Two code facts that change Part 2 (verified at `92237b30`, not from memory)

1. **Identity assembly is now fail-closed, and there is exactly one constructor.**
   #475 (0B) physically deleted `linkMailboxItem` and the `'pending-link'` token
   (guard: `identity-single-constructor.guard.test.ts`); task execution ensures its
   ref *before* enqueue; platform-internal closed-set sources write **no decision
   rows** at all. Consequence for adapters: an external event is **not**
   platform-internal, so it must arrive at `mailbox.enqueue` already carrying a
   resolvable `work_unit_ref` built by the single `WORK_UNIT_REF` constructor
   (shared `work-unit.ts`). "Enqueue now, link identity later" is structurally
   impossible — the old plan's wording predates this and is corrected in C10-B.
2. **The observe/act enforcement point was deleted by #464 — it must be rebuilt,
   not reused.** `maySelfInitiate()` + its single consumer (`agent.ts:1415`) + the
   declaration witness + `autonomy-single-consumer.test.ts` were introduced by #462
   (`cc06f99e`) and **physically removed by #464** (`887e6a58`, forever-loop rewrite;
   `git log -S maySelfInitiate` shows exactly these two commits). At tip the
   `agents.autonomy` column has writers and **zero readers**. The old C10-C text
   ("enforced at `maySelfInitiate`, #462") referenced a phantom. All 240 agents are
   `'act'`, so there is no live behavioral difference today; the risk window is
   accepted until C10-C lands, and C10-C is now explicitly a *rebuild* card.

---

## 1. Part 1 closeout (C10-0) — CLOSED 2026-11-22

Six cards, dispositioned as follows. Problem/solution detail lives in the card
records and the dated repo records; this table is the authoritative outcome.

| Card | Outcome | Evidence |
|---|---|---|
| 0A identity enforcement at assembly | **Done** — #467: ensureIdentity at the single assembly point; three `?? null` requirement-service sites → `turn ?? entity ref` | `d7f3288f`; regression 6012 green |
| 0B backlog disposition + audit point | **Done, rewritten** — the "34 historical rows" premise was falsified by the live DB (1,100 post-epoch identity-less rule picks, ~94% of rule picks). Real fix: single identity constructor (pre-enqueue ensure; `linkMailboxItem`/`pending-link` deleted; internal sources write no decision rows) + shared `identity-audit` module + sentinel epoch + AgentClock daily source `identity-audit` (24h, no new `setInterval`, records under `~/.markus/records/identity-audit/`) | #475 (`52c8b534`); `docs/records/identity-backlog-disposition-2026-11-22.md` |
| 0C orphan marketplace freeze | **Done, merged into 0E** (both touch `architecture-guard.mjs` — one card, one writer): 3 rows exported verbatim, resurrection guard biting, no DROP | #475; `docs/records/marketplace-orphan-freeze-2026-11-22.md` |
| 0D C9 runtime close-out | **Done** — probe steps 0–6 executed on the serving build; requirement completed via review | #468→#470; `docs/records/cut9-runtime-probe-2026-11-19.md` |
| 0E activities append-only | **Done** — the single UPDATE path removed, guard forbids `UPDATE agent_activities`, derived readers unchanged | #475 |
| 0F L4 baseline + L1 wording | **Cancelled by adjudication** (requirement comment `rc_82a1461ab6e84971`): G10 repo-side already aligned (no "no Thread symbol" claim, no 53/55-table contradiction); G9 deferred — it is new instrumentation, not residual closure, and a baseline across churning build epochs has no explanatory power. **Restart condition:** after 0B's fix is live and the instance runs 7 days in a single build epoch, re-evaluate; if still no consumer, close G9 instead of measuring | requirement `req_1a8c554721a5d43576a28590` completed 2026-11-22 |
| CI wording (extra card) | **Done** — step names aligned with `continue-on-error` reality; removal conditions written | #475 train |

**Post-restart obligation still open (the only Part 1 tail, and it is owned):**
the 0B closure protocol (disposition record §5) — epoch finalization commit + live
post-epoch probe + two consecutive daily readings — was waiting for the Owner
restart. The restart happened 2026-11-22 20:18:34 CST. It is now card **C10-0G**.

**Structural lessons kept (they constrain Part 2):**
- One identity, N construction points is the same R1 disease as one fact, N writers.
  The fix is deleting construction points, not filtering their output.
- A permanently-red alarm trains people to ignore it; a sentinel that reports
  "epoch unset" instead of green is the honest instrument. Never preset a planned
  timestamp as the epoch — that bets on the restart being on time.
- Rewrites can silently delete an invariant's only consumer (§0.1 fact 2). After any
  mechanism rewrite, grep the witness registry, not just the tests that survived.

---

## Part 2 — C10 proper: external source adapters (re-planned 2026-11-22)

Scope authority: master plan §5.2 C10 row + §4.9.4 trust boundary + §4.9.5 hook
list (H3/H5/H6/H7/H8/H9/H11 enable here). The one-sentence contract, amended with
the post-0B identity reality:

> **An adapter only translates an external event into a DeliveryEnvelope. It never
> routes, never decides identity, never writes WorkUnits directly. It ensures the
> event's `work_unit_ref` BEFORE enqueue, through the single `WORK_UNIT_REF`
> constructor — assembly is fail-closed and there is no "link later" path. The
> platform signs all outbound uniformly. Every external event is traceable
> `external_thread_ref → work_unit_ref`. `verified=false` inbound can only
> `observe`. No new table without a writer and real traffic.**

### C10-0G · Epoch finalization + 0B post-restart closure (trigger already fired)

**What.** Execute the disposition record §5 protocol, now unblocked by the
2026-11-22 20:18:34 CST restart into the fix build:
1. Re-verify the serving build contains #475 (symbol probes) and that this was the
   first restart into it. Epoch reading already taken: `ps -o lstart= -p 28013` →
   `日 11月/22 20:18:34 2026` (CST) = **2026-11-22T12:18:34Z**. The executor records
   the command + raw output in the disposition record; if the instance restarted
   again before execution, the epoch stays the FIRST fix-build start, not the latest.
2. One finalization commit: `IDENTITY_FIX_EPOCH` null → value, disposition record
   updated (source command + raw output + reading time), test expectations updated.
   One commit, no second writer.
3. Live probe: real-DB audit post-epoch violations = 0 (reading + timestamp).
4. Two consecutive daily audit runs with timestamped dated records
   (`~/.markus/records/identity-audit/`; first run is staggered, not at startup).
   This card spans ~2 days by construction — that is the protocol, not a stall.

**Acceptance.** Disposition record §5 items 1–4 all evidenced; sentinel state gone;
`--self-test` green; a seeded post-epoch violation still alerts (the instrument
still bites after finalization).

### C10-A · Identity columns and envelope slots (H3 / H5 / H6)

**What.** Build the columns §4.9.6 reserved (names and semantics already frozen):
- `organizations.org_slug TEXT` — nullable, `UNIQUE`, immutable after first address
  issuance, `source:'registry'` semantics. The two historical orgs get explicit
  `org_<id>` values in one migration — never derived from `name`.
- `agents.agent_alias TEXT` — nullable, `UNIQUE(org_id, agent_alias)`; unset = no
  mail address; a change revokes the old binding + isolation period.
- `role_slug` — name stays reserved; no table until a consumer exists.
- `envelope.auth = {spf, dkim, dmarc, verified}` — four nullable fields, no values
  written until an adapter actually verifies.
- `address_bindings.kind` column; `status_transitions.entity_type` gains `address`.

**Consumer clarification (2026-11-22, measured).** `bind_address` already exists
(C6, `core/src/tools/address-tools.ts`) and validates format + global uniqueness
only. The real consumers these columns add: **slug ownership** — today any org can
bind any org's slug (the global unique index prevents collision, not squatting);
`org_slug` makes "which org owns this slug" a checkable fact at bind time — plus
alias issuance/revocation lifecycle (`agent_alias`) and registry-copy semantics.
This is why A precedes B: the L5 gate binds an address, and binding must be
org-owned, not first-come-first-served.

**Migration discipline** (data-layer contract): DDL + migrations array entry both;
indexes/uniques after migrations, never in `SCHEMA_SQL`; nullable only; no backfill
of observation logs; fresh-DB and migrated-DB schema identical (tested).

**Acceptance.** Columns + constraints on both fresh and migrated DBs;
`formatAddress`/`parseAddress` behavior tests still green (format unchanged);
explicit-assignment probe for the two orgs; a test proves no code path derives a
slug from a display name; **squatting probe: org B binding `x.<orgA-slug>@…` is
rejected with an actionable hint**.

### C10-B · Adapter contract + external ref constructor + webhook + RSS

**What.** One adapter interface, two first consumers chosen because they need no
DNS change and no auth chain — everything arrives `verified=false` and the observe
ceiling is exercised from day one:
- Interface: external event → envelope `{from: AddressRef{kind:'external', raw,
  verified:false}, to: <resolved internal address>, messageId (idempotency key),
  external_thread_ref (opaque, read-only, never routes/dedupes), auth: null}`.
- **Identity (amended post-0B):** a new constructor in the single `WORK_UNIT_REF`
  table (shared `work-unit.ts`) for external signals — shape decided in-card under
  frozen constraints: idempotent per `messageId`, ensured before enqueue, exactly
  one construction point (extend `identity-single-constructor.guard.test.ts` to
  bite on any straggler). External sources are NOT platform-internal; the fail-closed
  assembly guard rejects a ref-less external enqueue. No adapter gets a private
  write path, and no adapter may resurrect a "link later" token.
- Each adapter: its own kill switch (offline without losing queued items — the
  post-#474 durable-store pattern, not an in-memory buffer), its own traffic gate:
  **≥1 real event → envelope row → resolving work_unit_ref → visible in overview**.
  A 0-row table at acceptance = fail. Traffic-gate readings ride the existing daily
  `identity-audit` clock source — no second audit mechanism.

**Acceptance.** Real webhook POST and real RSS item each traced end-to-end in the
live DB; `verified=false` signal cannot create a task or send a message (behavior
test bites: flip the ceiling → red); duplicate `messageId` produces exactly one
item; kill switch stops ingestion cleanly; the ref-constructor guard is red when a
second construction point is seeded.

### C10-B2 · IM inbound into the envelope contract (Feishu first, real traffic)

**Why a separate card (new 2026-11-22).** IM is the only external channel with
substantial existing traffic (`channel_messages` ≥8,280 rows, Feishu approval-card
chains verified through round 8). Webhook/RSS prove the contract on traffic we
generate; B2 closes the traceability invariant on traffic that already exists.
Different seam (comms gateway files), independently reviewable.

**What.** The existing messaging-gateway keeps its single-writer contracts; the
Feishu inbound path (`processMessageEvent` / `processCardAction`, one dispatch
point) gains envelope + pre-ensured ref translation only. No routing behavior
change: golden tests lock inbound behavior line by line; dual-run diff = 0.

**Acceptance.** A real Feishu message traced `external_thread_ref → work_unit_ref`
in the live DB; routing dual-run diff = 0; the approval-card action path unchanged
(the 2026-11-21 verified chain stays green).

### C10-C · Trust boundary: REBUILD the enforcement point + cross-org policy

**What (amended — this is construction, not reuse; see §0.1 fact 2).**
- **Rebuild the autonomy axis consumer:** one named predicate in shared
  (`maySelfInitiate` restored or one new name — exactly one), exactly one consumer
  at the self-initiation admission (the forever-loop wake path where #464 deleted
  the check), the declaration witness re-registered in `declarations.ts`, and the
  biting test restored (delete the consumer → red; set an agent to `observe` → it
  proposes but does not act). The `verified=false → observe` ceiling hangs on the
  SAME predicate — not per-adapter guards.
- `cross_org_policy` defaults `observe` (no code slot exists today — grep 0 at
  `92237b30`; this is new construction); elevation to `auto` requires one human
  approval + an audit row. Global resolution stays org-agnostic.
- Forged-identity rule: an external `From` that looks internal
  (`cto.acme@markus.global` from outside) is still `kind:'external', verified:false`
  — dot-count parsing decides namespace, string similarity never decides identity.

**Acceptance.** Observe-mode agent probe (set one disposable agent to `observe`,
it must not self-initiate); forged-From probe lands observe-only; cross-org delivery
probe between the two local orgs resolves globally; policy elevation without a
human approval row is rejected; witness registry shows the predicate witnessed.

### C10-D · Email (⚖ every DNS/policy step Owner-approved)

Unchanged in shape; starts only after C is accepted AND the Owner approves the
first DNS change. Order inside the slice:
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

### Explicit non-goals (inherited + one addition)

No four-tier autonomy (product decision, Owner only); no `rest()` for N workers;
no global slug registry until global addressing actually enables (H11); no `+tag`
sub-addressing (v2); no `main` merge / release without Owner approval; no DNS
change without Owner approval; no new table without writer + traffic gate.
**Added 2026-11-22: no G9/L4 baseline in this cut** — Owner-adjudicated deferral
(§1, 0F row); the restart condition lives in the requirement record, not here.

### L5 end-to-end acceptance (master plan §4.3)

Give a content agent a resource it has never owned (an RSS feed is enough): within
one conversation it binds the address, receives the first real signal, and proposes
the next step — no human UI clicks — with corresponding rows in `work_units`,
`address_bindings`, and `facts`. This is the cut's final gate, after C10-B; B2/C
strengthen it with real IM traffic and the rebuilt ceiling.

---

## 3. Execution discipline

- Branches `task/c10-<slice>` from `origin/feat/refactor-plan` (@ `92237b30` at
  refresh time; re-read at card start); one worktree per card. **Integration
  (second half):** after task-board review approval the CTO merges the card branch
  into `build/c10-adapters` (`--no-ff`); a single PR (`build/c10-adapters` →
  `feat/refactor-plan`) accumulates those merges and is the one gate into the
  feature branch. No per-card PRs target the integration branch: CI only runs on
  bases `main` / `feat/**`, so a PR to `build/**` would silently skip CI — card
  verification happens at review time, and the final PR's CI is the last gate.
  Never branch from the main checkout's HEAD.
- Per slice: red test first → implement → real-data probe on the running build →
  both gate layers in §3.1; one rollback-able commit per slice.
- Evidence: every reading carries a timestamp; live counts written as "≥N + read
  time"; gates must be seen red before green (`--self-test`); no fixture-only proof.

### 3.1 Verification gates — two layers, one convergence point

The convergence point is the `--no-ff` merge into `build/c10-adapters`, not the
per-card review. Merges are serial, so a red gate is attributable to the card that just
merged; nothing may accumulate to the final PR unattributed.

**Layer 1 — every card, at review (seconds, mandatory):**

```
pnpm typecheck          # tsc -b && tsc --noEmit -p packages/web-ui
pnpm lint
node scripts/architecture-guard.mjs
node scripts/identity-audit.mjs --self-test
```

These four stop the defect class that review has missed before: the only CI red on the
C9 integration branch was `packages/core/src/agent.ts:60  '@markus/shared' import is
  duplicated (no-duplicate-imports)` — it passed review (tsc + vitest + guards) and was
caught by the CI `lint` step alone.

**Layer 2 — before every merge into `build/c10-adapters` (CTO runs the full set, in
this order; the order is load-bearing):**

```
pnpm typecheck
pnpm lint
node scripts/architecture-guard.mjs
node scripts/identity-audit.mjs --self-test
pnpm test:json
pnpm test:web-ui
pnpm test:skipped-audit
```

1. `test:skipped-audit` reads `coverage/vitest-report.json`, which `test:json` writes —
   it must run after it. It is the guard against `.skip` tests rotting silently, and it
   is a blocking step, not a report.
2. `pnpm typecheck` runs `tsc -b`, which also emits `dist`. **Never run vitest
   concurrently with it**: a half-written `dist` produces false reds (14 in one
   measured case). This is also why the `quality` job needs no separate build while
   `backend-coverage` and `storage-cross-platform` call `pnpm build:ts` explicitly.
3. `pnpm test` (`vitest run`, both projects) is **not** the CI command; use `test:json`
   + `test:web-ui` to match CI step for step.
4. `security:guard` exists in `package.json`, but **no CI job calls it**
   (`.github/workflows/ci.yml` is the authority). It is a local extra, not part of the
   CI set — label it as such, or wire it into CI on its own card. Writing it as
   "CI-equivalent" would claim a gate that does not exist.
5. Coverage steps sit outside the seven and **none of them block**: the `quality` job
   ends with "Frontend coverage (web-ui, blocking)" (`test:coverage:web-ui`) and
   "Coverage ratchet" (`coverage:ratchet`), both carrying `continue-on-error: true`;
   `backend-coverage` is a whole job with `continue-on-error: true` (build →
   `coverage:node` → `coverage:ratchet:node`), where only the last step deliberately
   omits the flag, so that job turns red while the run stays green — a signal, not a
   merge gate. **Do not judge blocking from a step name**: one is literally called
   "blocking" and carries `continue-on-error: true`; the flag is the authority.
6. CI fires on `push` to `main` **and** on `pull_request` targeting `main` or `feat/**`
   (`ci.yml:3-13`), so these coverage steps also run on every merge to `main` — not
   only on PRs.

**What local cannot cover:** `storage-cross-platform` runs on ubuntu *and* windows; the
Windows half is unreachable on a Mac. Local green therefore means
"`quality`-equivalent", and a delivery must mark the Windows storage matrix as **not
covered locally** — never as "all green".

**When a change may skip both layers:** when it touches only `docs/**`. `lint` scans
`packages/*/src/` and `typecheck` never reads markdown, so neither layer has anything
to say about it. The criterion is where the change lands, not what it looks like:
anything under `packages/*/src`, `scripts/`, or a test file runs both layers.

- Owner gates: first-half dispositions all adjudicated and executed (§1). Remaining:
  each DNS/policy change (C10-D), and the final `main` merge after all cuts are
  accepted.

## 4. Card summary (second half, 2026-11-22)

| Card | Seam | Depends on | Owner gate |
|---|---|---|---|
| C10-0G | epoch finalization + 0B post-restart closure (disposition §5) | — (restart fired 11-22 20:18:34) | — |
| C10-A | identity columns + envelope slots + slug-ownership enforcement | — (parallel with 0G) | — |
| C10-B | adapter contract + external ref constructor + webhook + RSS | 0G, A | — |
| C10-B2 | IM inbound envelope-ization (Feishu real traffic, routing diff=0) | B | — |
| C10-C | autonomy axis REBUILD + trust boundary + cross-org policy | B (parallel with B2) | — |
| C10-D | email auth chain + in/outbound + bounce | C | ⚖ per DNS step |

L5 end-to-end is the cut's final gate (after B; B2/C strengthen it). Cut-level
acceptance and the final integration PR are the reviewer's job, not a separate card.
