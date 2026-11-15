# Inbox derivation (C9-D) — contract

Status: **implemented** (C9-D). Facts write path is C9-A (`facts-layer.md`); the stage badge is
C9-C (`thread-stage.md`); the independent verifier is C9-E.

`deriveInbox()` answers exactly one question: **what does a human have to do right now, and where
do they do it.** It is a pure function. It does not persist anything — a stored inbox is a second
copy of the truth and would immediately drift from the four sources it summarizes.

## 1. One derivation, one reader

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

## 2. Identity: `subjectKind:subjectId:needKind`

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

## 3. `action` and `blocking` are mandatory

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

## 4. Purity

No IO, no `Date.now()`, no `Math.random()`, no `process.env`, no repo, no fetch. Time enters only
as data (`waitingSince`, `lastSeenAt`); the only clock-dependent output is `isNew`, computed by
string comparison against a caller-supplied timestamp. Two calls on the same snapshot return
byte-identical output, whatever the wall clock says — `packages/shared/test/derive-inbox.test.ts`
runs one case with `Date.now`/`Math.random` replaced by throwing stubs, and no test in the file
mocks a repo (there is nothing to mock).

Sorting is a contract, not an implementation detail: longest wait first, then priority, then need
precedence, then key. All four are total orders over data, so the list never reshuffles between
two renders of the same state.

## 5. Inputs

`InboxSnapshot` = normalized rows of the four sources. Rows are structural (they mirror the API
shapes) so the caller passes what it already has:

| channel | fields read | why |
|---|---|---|
| `approvals` | `status`, `title`, `requestedAt`, `agentName`, `agentId`, `questions`, `details.{taskId,requirementId}` | pending approvals ARE human needs |
| `notifications` | `read`, `createdAt`, `priority`, `title`, `metadata`, `actionType/actionTarget` (via port) | unread messages, and the *duplicate* of an FSM/approval row. **A notification never raises a need** — its need is always `read`; the state comes from the row that owns it. Mapping `type = 'task_review'` → need `review` invented three blocking reviews for already-`completed` tasks on the first run over live data (`inbox-dual-run-diff.md` §3.4) |
| `tasks` | `status`, `reviewerType`, `blockedReason`, `priority`, `statusChangedAt`, `updatedAt`, `createdAt` | review / hold / failed |
| `requirements` | `status`, `priority`, `createdAt` | requirement approval |
| `stages` | `subjectKind`, `subjectId`, `stage` | facts-derived stage (C9-C): `failed` → `resolve_failure`, `waiting_human` → `answer`. They corroborate a row rather than invent one, so a stage can never create a row without a destination. |

`ports` are **required** named functions, not optional defaults: an omitted `resolveNotificationTarget`
would silently make every notification undeliverable (and every row disappear), which is the
"optional injection silently becomes the root" defect recorded in the C9 playbook.

## 6. What is deliberately not here

- No inbox table, no read-state of its own (`notifications.read` stays the only read flag).
- No approval FSM changes, no historical notification migration.
- No runtime `legacy | derive` switch. A switch would keep the old assembly alive in the shipped
  bundle — i.e. two live deciders again, which is the defect this cut removes. The dual run is a
  **build-time** artifact (§7) and rollback is `git revert` of one commit (or `INBOX_DERIVATION`
  is deliberately not a thing).

## 7. Verification

| Claim | Proof |
|---|---|
| three sources, one subject, one need ⇒ one row | `packages/shared/test/derive-inbox.test.ts` (`describe('dedupe')`) |
| three sources, three subjects ⇒ three rows (no over-dedupe) | same file, negative case that fails if `foldBySubject` keys on anything but the subject |
| no `action` ⇒ dropped, and the drop is recorded | same file; delete the `if (!action) continue` line and the case turns red (verified while developing) |
| zero IO / zero clock / zero randomness | same file: no repo is mocked anywhere, and one case throws from `Date.now`/`Math.random` |
| the adapter no longer decides membership | `scripts/architecture-guard.mjs` → `inbox-single-derivation` (fixtures included) |
| the rendered list matches the old queue on real data | `scripts/inbox-dual-run.mjs` → `docs/architecture/inbox-dual-run-diff.md` (read-only on `~/.markus/data.db`) |
| the badge never double-counts | `actionableCount()` keeps excluding `read`; unread stays merged in `lib/attentionCount` |
