# Identity backlog disposition — C10-0B (2026-11-22)

Status: living record. The `FINAL_EPOCH` marker below is the **single authoritative
source** for the product epoch constant `IDENTITY_FIX_EPOCH`
(`packages/shared/src/identity-audit.ts`); a guard test
(`packages/shared/test/identity-audit-epoch.test.ts`) fails if the two diverge.

## 1. What is being disposed of (counts, not rows)

Real-DB readings, `~/.markus/data.db`, read-only:

| Reading | Value | Read at (UTC) |
|---|---|---|
| `agent_decisions` rows with `work_unit_ref IS NULL` (all time) | 228,083 | 2026-11-21T14:1xZ |
| Split by proposed epoch 2026-11-19T06:09:30Z: before / after | 226,983 / 1,100 | 2026-11-21T14:1xZ |
| Post-epoch `pick` decisions, source=rule: no identity / with identity | 1,100 / 71 (~94% leak) | 2026-11-21T14:1xZ |
| No-identity picks by day: 11-18 / 11-19 / 11-20 / 11-21 | 14 / 28 / 1,028 / 49 | 2026-11-21T14:1xZ |
| Post-epoch null-ref picks by joined mailbox source_type | system_event 1,093; task_status_update 12; orphan 1 | 2026-11-21T16:0xZ |
| Audit gates 1 / 2 / 5 / 11 (others 0) | 25 / 5 / 3 / 1,120 | 2026-11-21T14:1xZ |
| Gates 1/2/5 violations: latest queued_at | <= 2026-11-18T08:07Z (all pre-0A history, NOT a live leak) | 2026-11-21T16:0xZ |

Smoking gun for the task-chain leak: decision `dec_b32c39f9e57698b4efe8f9cf`
(2026-11-21T15:59:24.515Z) has `work_unit_ref = NULL` while its mailbox row carries
`task_tsk_fcd9cb0fabeeb39e3eaa496a_r1` — the DB-only post-enqueue link wrote the row,
never the in-memory item the decision ledger reads.

Attribution (full map: `docs/design/c10-0b-pick-identity-leak-2026-11-22.md` §2):
- **P2** task execution chain: `sendTaskExecution` enqueued without ref
  (`pending-link`), `linkMailboxItem` UPDATE-ed only the DB column → in-memory item
  stayed null → pick null. (12 post-epoch rows.)
- **P3** platform-internal closed set (`system_event` wakes etc.): no entity by
  design, no turn WU → pick null. (1,093 post-epoch rows.)
- Pre-epoch 226,983 rows: the column did not exist / had no writer before
  2026-11-15; history, not violations.

## 2. Disposition decision (Owner ruling 2026-11-19)

**No data migration, no DROP, no row edits.** The real DB IS the archive. Copying
rows into git would create a second, drifting copy of the same fact (R1). This
record carries counts + attribution + read timestamps only — never data rows.
Historical rows are not backfilled and history is not fabricated: a decision row
written without identity stays without identity; the fix stops NEW rows from
leaking, it does not rewrite old ones.

## 3. The fix (this card)

1. Task execution identity is built BEFORE enqueue (`ensureExecutionEpoch`) and
   lands with the enqueue itself (memory + DB, one writer).
2. `linkMailboxItem` and the `pending-link` token are physically deleted
   (grep = 0 across `packages/*/src`).
3. Platform-internal closed-set sources produce NO decision rows (single writer
   `recordDecision` refuses them). Gate 11 is not relaxed: every persisted
   decision row must carry identity.
4. Fixed product epoch + daily real-DB audit on the existing AgentClock (named
   source `identity-audit`, no new setInterval), one dated record per day
   (exclusive create), alerting only on post-epoch violations.

## 4. Epoch protocol (CTO ruling A, 2026-11-21; supplements ①–④ agreed)

- **Definition (single source of meaning):** the epoch IS the **start time of the
  new process running the fix build** — not "build effective time", not a planned
  time, not `Date.now()`. Definition and reading are the same fact (supplement ①,
  option a).
- **Reading (single source of value):** `ps -o lstart -p <pid>` of the restarted
  instance (or the first line of its runtime log — exactly ONE of the two is used
  and recorded here with the raw output).
- **Sentinel period:** from merge until finalization, `IDENTITY_FIX_EPOCH = null`.
  The audit reports an independent `epoch-unset` state (script exit code 2; daily
  record `state: "epoch-unset"` + alert). It is NEVER silently green (supplement ④).
- **Finalization commit (supplement ②):** ONE commit does all three: set the
  constant to the recorded reading, update the `FINAL_EPOCH` marker below with the
  source command + raw output + timestamp, adjust test expectations. The guard
  test bites any divergence (supplement ③: presetting a planned time into the
  constant without this record goes red).
- **No preset planned time** (ruling ②): betting on restart punctuality either
  strands old-build leak rows as permanent post-epoch violations or blinds the
  audit to new-build rows.

FINAL_EPOCH: unset

## 5. Post-restart closure (pending Owner restart — asked, never self-restart)

After the Owner restarts the instance into the fix build:
1. Read the new process start time (command + raw output recorded here).
2. Finalization commit (§4).
3. Live probe: real-DB audit post-epoch violations = 0 (reading + timestamp).
4. Two consecutive daily audit runs with timestamped dated records.

Until then the sentinel state is the honest reading: the instrument refuses to
claim green while it cannot distinguish history from live leak.