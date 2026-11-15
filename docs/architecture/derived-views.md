# Derived views (C9) — thread stage, inbox, observation tables

> **Single authority.** 本文件是 C9 派生视图的单一权威，2026-11-15 由 `thread-stage.md`、
> `inbox-derivation.md` 与 `observability-tables.md` 合并而来（原因：三者都是「从事实派生出来的
> 视图」，同一类契约分开维护会生出多个派生点、多个读侧）。
>
> All three parts answer the same shape of question — **what may be derived from the facts, and
> who is allowed to derive it** — so they are one document:
>
> - **Part I** — thread stage (C9-C): the badge that answers "who is this thread waiting for".
> - **Part II** — inbox derivation (C9-D): the list that answers "what must a human do now".
> - **Part III** — observation tables (C9-B): the four append-mostly logs, and the single source
>   of "is this agent running".
>
> Section numbers run continuously (1-17) so no two sections of this file share an anchor: both
> derivation parts legitimately own a section called "One derivation, one reader".
>
> The fact layer itself — the row contract and its verification mechanism — is
> [`facts.md`](./facts.md). Every view here derives from it, never the other way round; a view
> that wrote back would be a second writer of the fact it summarizes.

---

## Part I — thread stage (C9-C)

`ThreadStage` answers exactly one question: **who is this thread waiting for right now.**
It is not the governance state (`TaskStatus`, which is persisted) and not the runtime
attention state (`AttentionState`, which is in-memory). Three concepts, three
vocabularies, no shared literals — the front-end test asserts that mechanically.

The facts write path and the independent verifier are C9-A / C9-E (see [`facts.md`](./facts.md));
the inbox derivation is Part II of this file.

### 1. The closed set

```
waiting_human | running | needs_evidence | in_verification | done | blocked_deps | failed
```

Declared once in `packages/core/src/facts/derive-stage.ts` (`THREAD_STAGES`) and mirrored
once for the UI in `packages/web-ui/src/lib/threadStage.ts`. The two lists are compared by
`scripts/architecture-guard.mjs` (`thread-stage-closed-set`), so a stage added on one side
and forgotten on the other is a CI failure, not a blank badge in production.

`saved` as free text is impossible by construction: the function's return type is the union,
and every boundary between the server and the UI passes through `isThreadStage()` /
`asThreadStage()`. A value the reader does not understand renders **nothing** — the UI never
invents a stage.

### 2. One derivation, one reader

```
packages/core/src/facts/derive-stage.ts        deriveStage({fsm, facts, approvals}) — pure
packages/org-manager/src/thread-stage.ts       the only place that turns rows into that input
packages/org-manager/src/routes/tasks.ts       GET /api/tasks/:id returns { threadStage, evidence }
packages/web-ui/src/components/ThreadStage.tsx renders the value, never re-derives it
```

Why the UI does not re-derive: the previous generation of this knowledge lived in four
components that each assembled "what is going on" from whatever they had loaded. Four
writers, one fact, four answers — and the most consequential one ("is it running?") was
derived from *whether a message existed*, which is why a stopped agent kept showing as busy
(C8-E). Re-deriving in the browser would bring that back; the page now renders a value.

### 3. Precedence (first match wins)

| # | Stage | Structural source |
|---|---|---|
| 1 | `failed` | FSM row `failed` / `rejected` |
| 2 | `waiting_human` | a pending approval/question row; FSM `pending` (awaiting approval); FSM `blocked` + `blocked_reason='hold'` |
| 3 | `done` | FSM `cancelled` / `archived` — closed without claiming success |
| 4 | `blocked_deps` | an open dependency id (resolved by the caller); or FSM `blocked` when nobody resolved the graph |
| 5 | `running` | a `work_units` row in `running`; or FSM `in_progress` |
| 6 | `needs_evidence` | no active `task.completion_evidence` fact |
| 7 | `in_verification` | evidence exists, no independent `pass` |
| 8 | `done` | evidence + independent `pass` |

Two rules carry the weight:

- **No branch reads traffic.** The input has no message/notice/timestamp channel at all, so
  "it must be running because things are happening" cannot be expressed.
- **Only an independent `pass` produces `done`** for a success terminal. `verification.result
  === 'fail'` and a self-verification both land in `in_verification` — a disproven claim is an
  unevidenced claim, and the reader must not be told otherwise.

Deliberate decisions worth reviewing:

- **`running` from the FSM row.** A WorkUnit count of zero proves nothing (a turn boundary is
  not a state change), so absence never demotes. `in_progress` is a structural row, not
  silence, and is a legitimate source under the C9 rule ("every cell traces to a fact or an
  FSM row").
- **`cancelled` / `archived` → `done`.** They are terminal but never claimed success, so there
  is no claim to verify. Mapping them to `failed` would label a deliberate cancellation as a
  failure. The invariant "`done` ⇒ pass" is therefore stated for the *success* terminals
  (`review`, `completed`) and tested as such.
- **A human-declared `hold` is `waiting_human`.** `blocked_reason` is already the single
  discriminator for "why is this blocked" (`web-ui/src/lib/blockedReason.ts`); reusing it is
  not a second writer, it is reading the existing one. Rendering a hold as `blocked_deps`
  would tell the reader to wait for an engine that will never move.
- **An explicit dependency resolution beats the coarse flag.** If the caller resolved the
  graph and found nothing open, a task still flagged `blocked` is an engine anomaly — saying
  "waiting on deps" would point at work that already finished.

### 4. Facts that do not participate

Superseded rows (`superseded_by` / `superseded_at` present) are ignored: history cannot keep
a thread `done`. Among current rows the newest `created_at` wins, ties broken by id, so two
calls on the same set always agree (no clock, no unstable sort).

### 5. UI surface (what a human is allowed to see)

| Human question | Derived from | Where |
|---|---|---|
| What do I need to do | `deriveInbox()` (C9-D, §7) | Home |
| Where is this, who is it waiting for | `deriveStage()` | task/requirement detail badge |
| Why do we believe it is done | `facts.source_refs` | detail page evidence fold (collapsed by default) |

Asserting one fact may change exactly two things on screen: a stage label and an inbox item.
A "fact card" appearing in the UI means internal state leaked to the user.

The evidence fold never prints the fact's raw JSON. It shows `value.summary`, who asserted it,
the verification result, and clickable pointers: `dlv_…` opens the deliverable, comment ids
scroll to the activity section in place, anything else stays a labelled reference.

### 6. Verification

| Claim | Proof |
|---|---|
| zero IO / zero clock / zero randomness | `packages/core/test/derive-stage.test.ts` — no repo is mocked anywhere in the file, and two cases run with `Date.now`/`Math.random` replaced by throwing stubs |
| seven stages, positive and negative | same file, one `describe` per stage plus a totality matrix over 9 statuses × 5 reasons × 4 fact shapes × 2 human states × 2 WorkUnit counts × 2 dependency states |
| breaking the verification rule turns red | mutate `independentPass` to accept `fail`, the `in_verification` case goes red (verified while developing) |
| evidence → stage on the real writer | `packages/org-manager/test/thread-stage.test.ts` — real SQLite + `SqliteFactService`: assert → `in_verification`, add pass → `done`, supersede → back, self-verification rejected |
| the badge text follows the value | `packages/web-ui/src/components/ThreadStage.test.tsx` — DOM level: `needs_evidence → in_verification → done → in_verification` |
| no second vocabulary | `packages/web-ui/src/lib/threadStage.test.ts` — `crossVocabularyCollisions()` over stage / task-status / process labels in `en` and `zh-CN` |

---

## Part II — inbox derivation (C9-D)

`deriveInbox()` answers exactly one question: **what does a human have to do right now, and where
do they do it.** It is a pure function. It does not persist anything — a stored inbox is a second
copy of the truth and would immediately drift from the four sources it summarizes.

The facts write path and the independent verifier are C9-A / C9-E (see [`facts.md`](./facts.md));
the stage badge it corroborates rows with is C9-C (Part I of this file).

### 7. One derivation, one reader

```
packages/web-ui/src/lib/deriveInbox.ts      deriveInbox(snapshot, ports) — pure, zero IO
packages/web-ui/src/lib/attentionQueue.ts   presentation adapter: api rows → snapshot, items → rows
packages/web-ui/src/pages/Home.tsx          renders the adapter's output; assembles nothing
```

**Why it lives in `web-ui` and not in `packages/shared`** (measured, not assumed): the browser
bundle cannot import `@markus/shared` — it is absent from `packages/web-ui/package.json`, there is
no vite alias and no tsconfig `paths`, and twelve existing files record the same constraint
(`allowedTransitions.ts`, `providers.ts`, `mailboxStatusFilters.ts`, `mailboxTypeMeta.ts`, …). The
repo's habit in that situation is a hand-written mirror plus a test that keeps the two copies in
step — acceptable for a three-item constant (`thread-stage`), absolutely not for a derivation:
two copies of this algorithm *is* the second writer this cut exists to remove. So the single
implementation sits where its readers are, and when a server/mobile consumer appears it moves
whole (one file move, or one build alias) — never a split.

Before this cut the "what needs me" list was assembled inside `Home.tsx` (`:511-549` of the
2026-11-15 base commit): four sources — `approvals`, `user_notifications`, the task/requirement
FSM, and the board — were each turned into rows in the page body, with page-local dedupe. That
extraction already happened (2026-11-10, `lib/attentionQueue.ts`), so the *inline* copy was gone by
the time C9-D started; what remained was a **second decider**: `buildAttentionQueue` owned
membership, dedupe and precedence, and would have to stay in lock-step with any future derivation
(a server-side board, a mobile client, a CLI). C9-D moves every one of those decisions into
`deriveInbox()`; the web-ui file keeps only what is genuinely UI (i18n titles, route params of an
existing single discriminator, `NotificationInfo` objects for "mark read").

The `inbox-single-derivation` invariant in `scripts/architecture-guard.mjs` fails CI when a
membership keyword (`'pending'`, `'review'`, `dedupeKey`, an entity→row map) reappears in the
adapter, or when the drop rule disappears from the derivation. Both directions have self-test
fixtures.

### 8. Identity: `subjectKind:subjectId:needKind`

```
dedupeKey = `${subjectKind}:${subjectId}:${needKind}`
```

- `subjectKind` — the closed set `task | requirement | approval | notification`. `notification`
  means "the message itself is the object": two unrelated messages must never collapse into one
  row, because a row standing for three messages is a row nobody can act on.
- `needKind` — the closed set, in precedence order:

| # | need | what the human must do | `blocking` |
|---|---|---|---|
| 1 | `answer` | answer a blocking question (`request_user_input`) | yes |
| 2 | `approve` | approve / reject a request | yes |
| 3 | `review` | accept a finished task (reviewer is human) | yes |
| 4 | `resolve_failure` | re-dispatch or abandon a failed task | no |
| 5 | `unblock` | a declared `hold` — was parking it still intended? | yes |
| 6 | `read` | informational (unread message) | no |

Three sources pointing at the **same** subject and need produce **one** row, with every
contributing source kept in `sources[]` — that is the "why is this here" answer, and it is what
lets one click mark several notifications read.

The key is **necessary, not sufficient**. Rows are then folded per `subjectKind:subjectId`
(`foldBySubject`), keeping the highest-precedence need and recording the rest in `mergedNeeds`.
Reason: a list is scanned by object, not by verb — "task t1: answer" and "task t1: review" both end
on the same page with one obvious next action, and showing them twice is the defect the Owner
reported on 2026-11-10 ("两条内容重复"). The fold is visible, never silent: `mergedNeeds` and
`sources` name what was absorbed. Different subjects never fold — an over-aggressive dedupe that
swallows unrelated work is worse than a duplicate.

### 9. `action` and `blocking` are mandatory

Every row carries `action: { page, params }` — the concrete route that *resolves* the need, not a
description of it. `ports.resolveNotificationTarget` (the existing `notifyNavigate.notificationTarget`)
and the approval's `details.{taskId,requirementId}` / `agentId` are the only sources of a
destination.

**A row with no destination is dropped** (`if (!action) continue`). "A red light nobody can act
on is worse than no light": a system broadcast with no entity, an approval whose agent is gone,
a `creditExhausted` modal hook — none of these belong in a to-do list, because clicking them
lands the user on a page where nothing can be done. The drop is counted, not swallowed: the
derivation returns `dropped[]` (`{ source, ref, reason: 'no_action' }`) so the dual-run diff and
the audit page can prove what is being withheld.

`blocking` is a property of the **need**, not a per-row heuristic (`NEED_BLOCKING`): a question
blocks the agent's whole turn, an approval blocks the requested action, a human review blocks
completion, a `hold` blocks the task; a failure or a message blocks no named party. `foldBySubject`
ORs the flag, so folding can only ever *reveal* blocking, never hide it.

### 10. Purity

No IO, no `Date.now()`, no `Math.random()`, no `process.env`, no repo, no fetch. Time enters only
as data (`waitingSince`, `lastSeenAt`); the only clock-dependent output is `isNew`, computed by
string comparison against a caller-supplied timestamp. Two calls on the same snapshot return
byte-identical output, whatever the wall clock says — `packages/shared/test/derive-inbox.test.ts`
runs one case with `Date.now`/`Math.random` replaced by throwing stubs, and no test in the file
mocks a repo (there is nothing to mock).

Sorting is a contract, not an implementation detail: longest wait first, then priority, then need
precedence, then key. All four are total orders over data, so the list never reshuffles between
two renders of the same state.

### 11. Inputs

`InboxSnapshot` = normalized rows of the four sources. Rows are structural (they mirror the API
shapes) so the caller passes what it already has:

| channel | fields read | why |
|---|---|---|
| `approvals` | `status`, `title`, `requestedAt`, `agentName`, `agentId`, `questions`, `details.{taskId,requirementId}` | pending approvals ARE human needs |
| `notifications` | `read`, `createdAt`, `priority`, `title`, `metadata`, `actionType/actionTarget` (via port) | unread messages, and the *duplicate* of an FSM/approval row. **A notification never raises a need** — its need is always `read`; the state comes from the row that owns it. Mapping `type = 'task_review'` → need `review` invented three blocking reviews for already-`completed` tasks on the first run over live data (`records/cut9-inbox-dual-run-diff-2026-11-15.md` §3.4) |
| `tasks` | `status`, `reviewerType`, `blockedReason`, `priority`, `statusChangedAt`, `updatedAt`, `createdAt` | review / hold / failed |
| `requirements` | `status`, `priority`, `createdAt` | requirement approval |
| `stages` | `subjectKind`, `subjectId`, `stage` | facts-derived stage (C9-C, §3): `failed` → `resolve_failure`, `waiting_human` → `answer`. They corroborate a row rather than invent one, so a stage can never create a row without a destination. |

`ports` are **required** named functions, not optional defaults: an omitted `resolveNotificationTarget`
would silently make every notification undeliverable (and every row disappear), which is the
"optional injection silently becomes the root" defect recorded in the C9 playbook.

### 12. What is deliberately not here

- No inbox table, no read-state of its own (`notifications.read` stays the only read flag).
- No approval FSM changes, no historical notification migration.
- No runtime `legacy | derive` switch. A switch would keep the old assembly alive in the shipped
  bundle — i.e. two live deciders again, which is the defect this cut removes. The dual run is a
  **build-time** artifact (§13) and rollback is `git revert` of one commit (or `INBOX_DERIVATION`
  is deliberately not a thing).

### 13. Verification

| Claim | Proof |
|---|---|
| three sources, one subject, one need ⇒ one row | `packages/shared/test/derive-inbox.test.ts` (`describe('dedupe')`) |
| three sources, three subjects ⇒ three rows (no over-dedupe) | same file, negative case that fails if `foldBySubject` keys on anything but the subject |
| no `action` ⇒ dropped, and the drop is recorded | same file; delete the `if (!action) continue` line and the case turns red (verified while developing) |
| zero IO / zero clock / zero randomness | same file: no repo is mocked anywhere, and one case throws from `Date.now`/`Math.random` |
| the adapter no longer decides membership | `scripts/architecture-guard.mjs` → `inbox-single-derivation` (fixtures included) |
| the rendered list matches the old queue on real data | `scripts/inbox-dual-run.mjs` → `docs/records/cut9-inbox-dual-run-diff-2026-11-15.md` (read-only on `~/.markus/data.db`) |
| the badge never double-counts | `actionableCount()` keeps excluding `read`; unread stays merged in `lib/attentionCount` |

---

## Part III — observation tables and the single source of "running" (C9-B)

Part III is canonical for two questions that used to be answered by whatever code happened to be
nearby:

1. **What are the four observation tables, and what does each row mean?**
2. **Who is allowed to answer "is this agent working right now"?**

The short answer to (2) is: `work_units` — and nothing else. An observation table
records *what happened*; it never carries state.

### 14. The four observation tables

They are append-mostly event logs: they answer "what happened to this agent / this
task, and when". Before cut 9 they also silently carried a second, weaker answer to
"is it still running" (an unfinished row), because no code could ask `work_units`.
That second answer is now removed — see §16.

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

### 15. What a row does *not* mean

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

### 16. The single source of "running"

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
| `agent_activities.ended_at IS NULL` | unfinished ≠ running (§15) |
| In-memory `activeStreams` / `activeTaskCount` | resets on restart; empty after a crash |
| "the last message was recent" | intensity of traffic is not execution state |

#### 16.1 How an activity list may still show liveness

It may **not** decide liveness itself. An activity row is history. If a list needs a
live marker, it takes the set of live WorkUnit refs from the `work_units` read face
and asks the pure function

```ts
isActivityLive(activity, liveWorkUnitRefs)   // packages/web-ui/src/lib/workUnitLiveness.ts
```

which answers `true` only when the row carries a `workUnitRef` that is present in
that set. A row without a ref (all historical rows) is history, full stop.

#### 16.2 Enforcement

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

### 17. Scope boundaries

- **Not here**: `facts` and its `FactService` writer (the row contract and its verification
  mechanism are [`facts.md`](./facts.md)), `agent_decisions.work_unit_ref`, board / inbox
  persistence (the inbox derivation is Part II of this file, §7-§13). This part covers the four
  observation tables only.
- **Not here**: the `work_units` schema and lifecycle. See
  [state-machines.md §16](./state-machines.md).
