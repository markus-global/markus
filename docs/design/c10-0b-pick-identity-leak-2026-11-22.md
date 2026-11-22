# C10-0B — Pick identity leak: single identity constructor + fixed epoch + daily real-DB audit

> **Dated correction (2026-11-22, C10-0G).** Owner ruling: the daily real-DB audit
> mechanism (§3.5) and the fixed PRODUCT epoch (§3.4's constant + sentinel
> protocol) do not ship to users. C10-0G deleted the in-process mechanism,
> localized the epoch to an explicit `--epoch` deployment parameter, and replaced
> the daily clock with a retireable scheduled task on the Owner's instance
> (tsk_d4ed5b323793d738c746d719). The single constructor (§3.1–3.3) and the gate
> closed set remain the permanent net. See
> docs/records/identity-backlog-disposition-2026-11-22.md §0 and
> docs/design/c10-external-adapters-plan-2026-11-19.md §0G. Sections below are
> kept as history, not as instructions.

Status: built-pending (this document is the implementation SSOT for card tsk_fcd9cb0fabeeb39e3eaa496a)
Base: origin/feat/refactor-plan @ 5ea5efd4. Branch: task/c10-0b-pick-identity-leak.

## 1. Phenomenon (measured, real DB, 2026-11-21T14:1xZ / 16:0xZ)

`node scripts/identity-audit.mjs` on ~/.markus/data.db: gate 11 = 1120. Post the proposed
epoch 2026-11-19T06:09:30Z there are 1100 rule `pick` decisions with `work_unit_ref IS NULL`
vs 71 with identity (~94% leak), still produced today. Breakdown of the 1106 post-epoch
null-ref picks by joined mailbox source_type: `system_event` 1093, `task_status_update` 12,
orphan 1. Gates 1/2/5 (25/5/3) are ALL historical rows (latest <= 2026-11-18T08:07Z, pre-0A) —
not a live leak.

Smoking gun: decision `dec_b32c39f9e57698b4efe8f9cf` (2026-11-21T15:59:24.515Z, the pick of
this card's own approval item) has `work_unit_ref = NULL` while its mailbox row carries
`task_tsk_fcd9cb0fabeeb39e3eaa496a_r1`.

## 2. Root cause (R1: one fact, two construction points)

The ONLY decision writer is `AttentionController.recordDecision`
(packages/core/src/attention.ts:1796); identity is read at :1822 as
`workUnitRef: item.workUnitRef ?? null`. The ONLY pick call site is attention.ts:925 inside
`processFocusedItem` (both serial and concurrent loops pass through it). The decision
therefore reflects the **in-memory** mailbox item's ref at pick time.

Identity reaches the in-memory item by two paths:

- **P1 — at enqueue** (`options.workUnitRef`, mailbox.ts:1211/1234 writes memory + DB row
  together): chat (api-server prepareChatTurnWorkUnit:2851), A2A (agent-delivery.ts:257
  ensure BEFORE enqueue, ref passed at :305), task status notifications
  (task-service.ts:3892), requirement/review notifications. These picks have identity.
- **P2 — post-enqueue, DB-only** (`linkMailboxItem`, sqlite-storage.ts:6053, UPDATE-only):
  the task execution chain. `Agent.sendTaskExecution` (agent.ts:2195) enqueues with
  `refOrigin: 'pending-link'` and NO ref; `onItemEnqueued` fires
  `TaskService.linkExecutionEpoch` (task-service.ts:2760) which ensures the WU and calls
  `units.linkMailboxItem` — writing ONLY the DB column. The in-memory item stays null
  forever, so the pick (which reads memory) is null even though the row has a ref.
  agent-delivery.ts:255 comment already documents this exact hazard ("linkMailboxItem 只写
  DB 列") and solved it for A2A by moving ensure before enqueue. Task chain never got it.
- **P3 — no identity by design**: `PLATFORM_INTERNAL_SOURCES` (mailbox.ts:427 closed set:
  heartbeat, system_event, session_reply, memory_consolidation, callback_result,
  workflow_update). system_event wake turns (start wake agent.ts:1741, rest-expiry :8884,
  callback mailbox delivery :8610, announcements agent-manager.ts:4426, distillation
  task-service.ts:5786) are 1093/1106 of the leak. They are platform wake signals, not
  decisions about work; no turn WU exists for them.

## 3. Fix (structural — the second construction point must cease to exist)

### 3.1 Task execution identity at enqueue (kills P2)

- `Agent.sendTaskExecution` (agent.ts:2150): replace the trailing
  `onItemEnqueued: (item: { id: string }) => void` parameter with `workUnitRef: string`
  (REQUIRED — fail closed; caller builds it with `WORK_UNIT_REF.task(taskId, round)`).
  Enqueue with that ref and `refOrigin: 'entity'`. The C10-0A identityPort
  (mailbox.ts:1242) ensures the WU exists at enqueue.
- `TaskService.linkExecutionEpoch(itemId, taskId, round)` (task-service.ts:2760) becomes
  `ensureExecutionEpoch(taskId, round): string` — ensure + transition to running, RETURN
  the ref, no link call. Both call sites (main execution ~:2309 with callback at :2554,
  fresh retry ~:6409 with callback at :6499) call it BEFORE `sendTaskExecution` and pass
  the ref as the new trailing argument. Same pattern as A2A (agent-delivery.ts:257).

### 3.2 Delete `linkMailboxItem` and `pending-link` everywhere (grep must reach 0 in src)

- packages/storage/src/sqlite-storage.ts:6053 — delete method.
- packages/org-manager/src/work-unit-service.ts — port interface :43 + method :205.
- packages/org-manager/src/agent-delivery.ts — port :169 + redundant call :325 (the item
  already carries the ref at enqueue).
- packages/org-manager/src/api-server.ts — wiring :492 + settle backfill :2804
  (settleChatTurnWorkUnit; chat rows already carry the ref at enqueue — the backfill writes
  the same value, it is redundant).
- packages/core/src/mailbox.ts:191 — remove `'pending-link'` from the refOrigin union
  (keep 'entity' | 'turn' | 'platform-internal'); update guard message :1274;
  `reEnqueueOnShutdown` :2015 becomes `refOrigin: item.workUnitRef ? 'entity' : undefined`
  (non-internal null-ref requeue now fail-closed via the existing guard; internal sources
  are exempt by the closed set).
- packages/core/src/agent.ts:2005 / :2055 / :2134 — `refOrigin: options?.workUnitRef ? 'turn' : undefined`
  (a missing ref on a non-internal source is now a rejection, not a dead declaration).
- Update every test that asserts linking/pending-link behavior to assert the NEW invariant
  (identity present at enqueue, in memory AND DB). No test may keep the old second-writer
  semantics alive.

### 3.3 Internal closed-set sources produce NO decision rows (kills P3, card-sanctioned)

Card authorizes the structural option "该 pick 不产生决策行". Platform wake signals are not
decisions about work and have no turn identity to hang a row on. Enforced at the SINGLE
writer, not at call sites:

- Export `PLATFORM_INTERNAL_SOURCES` from packages/core/src/mailbox.ts.
- `recordDecision` (attention.ts:1796): if `PLATFORM_INTERNAL_SOURCES.has(item.sourceType)`
  return null — no ledger push, no persistence, no event. Return type becomes
  `AttentionDecision | null`; all callers (attention.ts:374, :925-926, :1519-1522, :1727,
  :1738, :1746) handle null (skip onDecisionMade / downstream use).
- Gate 11 is NOT relaxed: every persisted decision row must have identity. After 3.1+3.2
  every non-internal item has identity at enqueue, and internal items produce no rows.

### 3.4 Fixed product epoch + real-DB audit alerts only post-epoch (superseded by C10-0G — see the dated correction at the top)

- New single source: `packages/shared/src/identity-audit.ts` exporting
  `IDENTITY_FIX_EPOCH` (fixed constant, identical on every instance; NEVER read from
  instance restart time) and `makeIdentityGates({ epoch, predicates })` returning the gate
  list (pure data + SQL strings, no sqlite import). Gates 1/2/5/11 are bounded by the
  epoch (mailbox queued_at / decision created_at >= epoch); gates 3/6-10/12/13 unchanged
  (current-state invariants). The rolling `MARKUS_AUDIT_SINCE` window is DELETED — a fixed
  epoch is the only lower bound (two bounds = two measures of the same fact, R2).
- Predicate whitelist derives from `FACT_PREDICATES` (shared/src/facts/predicates.ts) —
  the regex file-reader in the script is deleted (one source, not a copy).
- `scripts/identity-audit.mjs` imports the gates from shared **dist** (CI runs `tsc -b`
  before the self-test step, so dist exists; document the build requirement in the header).
  Self-test keeps seeding every violation and asserting bite + clean-to-zero, and ADDS the
  two-way bite: a pre-epoch violation row must NOT be counted; a post-epoch one MUST be.
- Epoch VALUE (CTO ruling A, 2026-11-21): `IDENTITY_FIX_EPOCH: string | null = null`
  is an explicit **sentinel** until the fix build goes live. The epoch is DEFINED as
  the start time of the new process running the fix build; the single reading is
  `ps -o lstart` (or the runtime log first line — exactly one, recorded with raw
  output in the disposition record). No preset planned time, no `Date.now()`
  fallback. During the sentinel period the audit reports an independent
  `epoch-unset` state (script exit 2; daily record `state:"epoch-unset"` + alert) —
  never silently green. The finalization commit sets the constant AND the
  `FINAL_EPOCH` marker in `docs/records/identity-backlog-disposition-2026-11-22.md`
  together; `packages/shared/test/identity-audit-epoch.test.ts` bites any divergence
  (presetting a planned time into the constant goes red). Self-test uses an explicit
  fixture epoch, so CI keeps biting regardless of the sentinel.

### 3.5 Daily real-DB audit on the existing AgentClock (no new setInterval) (superseded by C10-0G — mechanism deleted, see the dated correction at the top)

- Core port `IdentityAuditPort { runDaily(): void | Promise<void> }` injected via
  AgentOptions (same wiring pattern as workUnitPort, api-server.ts:482 → agent-manager).
  Agent.start() registers a named clock source `identity-audit` (everyMs 24h, staggered
  initial delay) ONLY when the port is wired; absent port = no source (assembly laziness is
  proven by dependency absence).
- Org-manager implements the port: exclusive-create (flag 'wx') the dated record
  `<markusHome>/records/identity-audit/YYYY-MM-DD.json` — first agent of the day wins,
  others skip (single daily writer, no lock service). Run the gates read-only against the
  real DB, write { date, ranAt, agentId, epoch, dbPath, gates:[{id,name,count}] }, and
  log.error/alert ONLY when a gate count > 0 (all identity gates are epoch-bounded, so
  historical rows cannot alert).
- Rationale kept: CI self-test proves the gates bite on fixtures; ONLY the real-DB audit
  can catch a live leak like this one — it is the instrument that found it.

## 4. Test plan (red first)

1. core: task-execution-shaped enqueue (task_status_update + intent trigger_execution +
   workUnitRef) → pick decision carries the ref (behavioral, real Mailbox +
   AttentionController + capturing decisionPersistence). RED at base because the base
   sendTaskExecution path enqueues without ref.
2. core: internal source (system_event) pick → decisionPersistence.save NOT called, ledger
   empty; non-internal pick → saved with ref. RED at base (base saves null-ref rows).
3. core: non-internal enqueue without ref/refOrigin → throws (existing guard, stays).
4. structural grep guard: `linkMailboxItem` and `pending-link` absent from packages/*/src
   (0 matches). RED at base.
5. org-manager: ensureExecutionEpoch returns the ref and the enqueued item carries it in
   memory AND DB before any pick; no post-enqueue UPDATE of work_unit_ref happens.
6. audit self-test: two-way epoch bite (pre-epoch silent, post-epoch alerts) + all gates
   still bite and clean to zero.
7. clock source: registered iff port wired; daily runner writes exactly one dated record
   per day (second call same day skips), alerts on post-epoch violation only.
8. Falsification: reverting the fix must turn the new tests red (run once, record).

## 5. Boundaries

- No data migration, no DROP, no restart of the serving instance (human performs restart).
- Merge flow per Owner 2026-11-19: review → CTO merge --no-ff into build/c10-integration;
  no per-card PR; exit PR #470.
- Historical rows (226,983 pre-epoch + the leak rows before the fix goes live) stay
  untouched — the real DB IS the archive; disposition record carries counts + attribution,
  never copied rows.

## 6. Verification evidence (readings, not claims)

### 6.1 Red at base (2026-11-21T16:31Z, base 5ea5efd4 + new tests, before implementation)

7 new tests red across 6 files:
- guard: `linkMailboxItem` 0-hit FAIL; `pending-link` 0-hit FAIL (detector self-check green).
- attention-internal-no-decision: system_event pick persisted 1 row (expected 0).
- identity-audit-clock-source: `agent.setIdentityAuditPort is not a function`.
- task-execution-identity-at-enqueue: in-memory ref null (expected task_tsk_c10_0b_enqueue_r2).
- task-execution-epoch-identity (2): `svc.ensureExecutionEpoch is not a function`.
- identity-audit-runner: module absent (import failure).
Audit self-test two-way bite red at base: gates 1/2/5 counted pre-epoch history
(6 assertions failed) — the rolling window had no epoch lower bound.

### 6.2 Green after implementation (2026-11-22T00:5x–01:0x local / 16:5x–17:0xZ)

| Check | Reading |
|---|---|
| npm run typecheck | exit 0 |
| npm run lint | exit 0 (0 errors; 1027 pre-existing warnings) |
| node scripts/architecture-guard.mjs | exit 0, contracts 27/27 |
| node scripts/security-guard.mjs | exit 0 |
| node scripts/identity-audit.mjs --self-test | exit 0 — 12 gates bite, silent on pre-epoch history, clean to zero |
| 7 new suites (epoch/runner/clock/guard/internal/enqueue/epoch-identity) | 19/19 passed |
| npm run test (full node, post-restore rerun) | 1 failed \| 9041 passed \| 14 skipped (9056) |
| npm run test:web-ui | 1581 passed \| 3 skipped (1584), exit 0 |
| grep linkMailboxItem / pending-link in packages/*/src | 0 matches |

The single remaining node failure is `packages/cli/test/commands-start-integration.test.ts
> auto-runs quickInit when config is missing` — **pre-existing environmental**, independently
confirmed on two cards: quickInit hard-codes port 8056 in nonInteractive mode and does not
inherit the test's getFreePort; the packaged desktop app holds 8056 on this host. Card
0E+0C recorded the same failure on a clean base tree (three-stage evidence, commit 6337f9ac
delivery report §3); this card's isolated investigation found zero identity/mailbox code in
that test and an empty cli diff. Not a regression of this change; not silently waived.

### 6.3 Falsification (guard proof, 2026-11-22T01:0xZ)

Two probes applied to the finished fix, then reverted:
- attention.ts recordDecision internal-source early return bypassed (`if (false && …)`);
- agent.ts sendTaskExecution enqueue `workUnitRef: null`.
Result: attention-internal-no-decision + task-execution-identity-at-enqueue both RED
(2 failed | 2 passed). Probes reverted; same files 4/4 GREEN; full-suite rerun above is
post-restore. No probe text remains in the tree.

### 6.4 Real-DB probe (2026-11-21T17:01:06Z, read-only)

`node scripts/identity-audit.mjs` → **exit 2, state: epoch-unset** — the sentinel refuses
to claim green before the fix build is live (CTO ruling A). The old build is still serving
and still leaking, as expected until the Owner restart: 7 new null-ref picks since 16:00Z,
latest 2026-11-21T17:00:15.973Z; total null-ref decision rows 228,094. Post-epoch-zero and
the two consecutive daily readings are the post-restart closure steps (disposition record
§5) — they cannot be produced before the restart and were asked of CTO/Owner, never
self-restarted.