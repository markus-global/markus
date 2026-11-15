# Observability Tables and the Single Source of "Running"

This document is canonical. It answers two questions that used to be answered by
whatever code happened to be nearby:

1. **What are the four observation tables, and what does each row mean?**
2. **Who is allowed to answer "is this agent working right now"?**

The short answer to (2) is: `work_units` — and nothing else. An observation table
records *what happened*; it never carries state.

---

## 1. The four observation tables

They are append-mostly event logs: they answer "what happened to this agent / this
task, and when". Before cut 9 they also silently carried a second, weaker answer to
"is it still running" (an unfinished row), because no code could ask `work_units`.
That second answer is now removed — see §3.

| Table | One row is | Volume at cut 9 (live DB) | `work_unit_ref` |
|---|---|---|---|
| `agent_activities` | one activity (a turn's execution: chat / task / review / heartbeat) with its start time, end time, token and tool totals | ~250k | nullable, indexed |
| `agent_activity_logs` | one log line *inside* an activity (`status` / `text` / `tool_start` / `tool_end` / `llm_request` / `error`), ordered by `seq` | ~3.8M | nullable, indexed |
| `execution_stream_logs` | the unified execution stream: the same kind of log line, but keyed by `(source_type, source_id)` so `task` / `activity` / `chat` streams share one read face | ~4.5M | nullable, indexed |
| `task_logs` | one persisted task log line, grouped by `execution_round` | ~0.5M | nullable, indexed |

Notes that are contracts, not trivia:

- **`work_unit_ref` is nullable and is not backfilled.** ~9M historical rows keep
  `NULL`. `NULL` means "this row predates the identity chain (cut 7)" — it is a
  legal value, not a defect. Backfilling would manufacture a second history of
  which turn produced which row, and no reader could tell it from the real one.
- **`work_unit_ref` is derived, never inferred.** It is written from the identity
  the producer already holds (`Agent.currentTurnWorkUnitRef`, sourced from
  `mailbox_items.work_unit_ref`; or `WORK_UNIT_REF.task(taskId, round)` in
  `TaskService`). It is *never* recovered by looking up "the nearest WorkUnit in
  time" — that would be inferring structure from timing.
- **`agent_activity_logs` inherits the ref from its activity.** A log line cannot
  belong to a different WorkUnit than the activity that emitted it, so the row is
  written with `(SELECT work_unit_ref FROM agent_activities WHERE id = ?)`. One
  writer, no drift, no second derivation.
- **The migration is additive only** (`ALTER TABLE ... ADD COLUMN` + `CREATE INDEX
  IF NOT EXISTS`), guarded by `PRAGMA table_info` in
  `packages/storage/src/sqlite-storage.ts`. Re-opening an old database adds the
  columns once and never rebuilds the table.

---

## 2. What a row does *not* mean

`agent_activities.ended_at IS NULL` does **not** mean "still running". It means
"no end was recorded for this row". Two independent reasons:

1. A process can die between `insertActivity` and the end callback. The row is then
   permanently unfinished, and nothing will ever close it.
2. `ended_at` is duration data about an event. Process liveness is a different
   question with a different owner.

Consequently there is no "close the orphans" sweeper any more. There used to be one
(`SqliteActivityRepo.closeOrphansAgainstTerminalMailbox()`): it rewrote `ended_at`
on zombie rows so that "unfinished" would become trustworthy as a liveness signal.
It was a second writer of a fact that only exists to prop up a wrong reading. It is
deleted — if a row has no end, the row has no end.

---

## 3. The single source of "running"

**Answer only from `work_units`:**

```
work_units.status = 'running'
  AND claimed_by IS NOT NULL          -- somebody actually holds it
  AND lease_until > now               -- and the lease has not expired
```

- The read face is `GET /api/agents/:id/work-units?status=running`
  (`packages/org-manager/src/api-server.ts`), which applies the lease filter once,
  server-side.
- The UI component is `RunningWorkUnits` (`packages/web-ui/src/components/RunningWorkUnits.tsx`).
  It shows internal turns (`requirement_*` / `channel_*` / `session:*`) as well as
  user-visible chat turns — "I am working but the page is empty" was the bug.
- `work_status()` is the agent-facing read of the same table.

Forbidden sources of "running" (each of these was, at some point, in production):

| Forbidden source | Why it lies |
|---|---|
| `agent_activities.ended_at IS NULL` | unfinished ≠ running (§2) |
| In-memory `activeStreams` / `activeTaskCount` | resets on restart; empty after a crash |
| "the last message was recent" | intensity of traffic is not execution state |

### 3.1 How an activity list may still show liveness

It may **not** decide liveness itself. An activity row is history. If a list needs a
live marker, it takes the set of live WorkUnit refs from the `work_units` read face
and asks the pure function

```ts
isActivityLive(activity, liveWorkUnitRefs)   // packages/web-ui/src/lib/workUnitLiveness.ts
```

which answers `true` only when the row carries a `workUnitRef` that is present in
that set. A row without a ref (all historical rows) is history, full stop.

### 3.2 Enforcement

`node scripts/architecture-guard.mjs` fails the build if either side of this contract
is reintroduced:

- a read path in `packages/web-ui/src` that derives liveness from a missing
  `endedAt` (`!x.endedAt`, `x.endedAt == null`, …);
- SQL in `packages/*/src` **or `scripts/`** that reads `agent_activities` /
  `agent_activity_logs` state from `ended_at IS NULL`, or re-introduces an
  orphan-closing sweep.

The scan covers the whole repo, not just the UI: the same mistake is just as wrong in
a service, a CLI command, or an operations script. `scripts/` is scanned by this rule
only (it is not a product source root), so the invariant cannot survive there by being
outside the scan roots.

`scripts/identity-audit.mjs` used to carry a fifth gate for "trigger row terminal but
`ended_at` still empty". It is **gone** with the sweep that kept it satisfied: a row
without an end is "we did not record an end", not a violation, and with no time bound
it could only stay permanently red on the ~3k historical rows. The underlying fact —
"a turn closed but left work hanging" — is measured on the authoritative object by the
lease-expired `running` gate.

---

## 4. Scope boundaries

- **Not here**: `facts` (cut 9 / C9-A) and its `FactService` writer, `agent_decisions.work_unit_ref`,
  board / inbox persistence. This document covers the four observation tables only.
- **Not here**: the `work_units` schema and lifecycle. See
  [state-machines.md §16](./state-machines.md).
