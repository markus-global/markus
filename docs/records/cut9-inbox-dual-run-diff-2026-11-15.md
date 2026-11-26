# Inbox dual run — legacy `buildAttentionQueue` vs `deriveInbox` (C9-D)

> **Historical record.** Moved here from `docs/architecture/` on 2026-11-15: this is a dated
> measurement, not a description of current behaviour. The living contract is
> [`derived-views.md`](../architecture/derived-views.md) §7–§13.

Measured **2026-11-15 02:34 (Asia/Shanghai)** on the live database
`~/.markus/data.db`, read-only, same input on both sides. This is the "灰度双跑" evidence
required by the card: the two lists are produced by the **shipped legacy code** and by the
**code under review**, not by a reimplementation of either.

## 1. How the two lists were produced (reproducible)

```
# 1. snapshot the exact rows the Overview page feeds the queue (read-only)
node /tmp/build-inbox-snapshot.mjs
#   → userId=usr_26f8cf3d14130d43d813b124
#     approvals=4 (pending)  notifications=20 (unread, the page's limit)
#     tasks=4 (review|blocked|failed|in_progress)  requirements=4 (pending|rejected)

# 2. legacy queue: base commit 1eb6b06d (C9-C tip; attentionQueue.ts unchanged from 011f23bf)
cd /private/tmp/c9c-base-dstage && npx vitest run packages/web-ui/test/__legacy_probe.test.ts
#   → /tmp/inbox-legacy.json

# 3. derived queue: this branch
cd <c9d worktree> && npx vitest run packages/web-ui/test/__derived_probe.test.ts
#   → /tmp/inbox-derived.json  (+ .dropped)

# 4. classify
node /tmp/classify2.mjs
```

Both probes are one-off and **were deleted before the commit** — no dead code ships.

## 2. Counts

| Reading | legacy | derived |
|---|---|---|
| rows in the list | 11 | **10** |
| rows that mean "a human must act" | 5 | 4 |
| unread notifications accounted for | 20 (6 rows + 14 attached) | 20 (all attached to rows) |
| rows folding more than one source | 0 (no such concept) | **5** |
| rows withheld for having no destination | 0 (they were rendered) | **0 on this snapshot** |

The one-row reduction is not a loss of work: it is the same requirement counted twice (§3.1).

## 3. Classified differences

### 3.1 Legacy **duplicated** one subject

```
requirement:req_202f503e2ecc6876567f069c  requirement_approval  台海「隔离/封控」常态化研判…
approval:apr_mwf4nzid_1p                  approval_request      台海「隔离/封控」常态化研判…
```

The legacy queue deduped by **task** entity only (`claimedTargets.add('task:' + id)`); a
requirement had no such key, so a requirement approval and an approval *about that requirement*
both survived. Derived: one row, `sources = [fsm:req_202f…, approval:apr_mwf4nzid_1p]`,
`key = requirement:req_202f503e2ecc6876567f069c:approve`. **This is a defect the Owner can see**
(two identical titles, one of which cannot be acted on differently).

### 3.2 Legacy **could not say what is blocking someone** — there was no such field

The legacy row set is `{id, kind, title, priority, waitingSince, waitingBasis, target, isNew, meta}`.
"Does a named other party wait on this?" was only implicit in `kind`, and the badge
(`actionableCount`) counted every non-message row the same. Derived carries `blocking` per row
(7 → 4 truths: the 4 rows above are blocking, the 6 message rows are not), so a later consumer
(mobile, audit page) cannot re-guess it.

### 3.3 Legacy merged **9 sources into 1 row without recording it**; derived keeps the record

```
task:tsk_d5c97ad4f4d267deb748e998:approve  ← approval:apr_mwg95oye_3p
                                            + fsm:tsk_d5c97ad4f4d267deb748e998
                                            + 7 notifications
```

Legacy also collapsed these into one row (via `notices`), but the *reason* was unrecoverable:
`sources[]` did not exist. Derived names every contributor, which is what makes "why is this
here" answerable and what the audit page (C9-E) can display.

### 3.4 The dual run caught a defect **in this cut's own first draft** (now fixed + tested)

Draft 1 mapped a notification's `type` to a need (`task_review` → `review`, `blocking: true`).
On real data that produced **three blocking "review" rows for tasks that are already
`completed`** — stale `task_review` notifications whose task was closed hours ago:

```
tsk_77be97a3…  completed (reviewer_type=agent)   ← notification type=task_review
tsk_dff4474a…  completed (reviewer_type=agent)   ← notification type=task_review
tsk_b04ac0a3…  completed (reviewer_type=agent)   ← notification type=task_review
```

That is the C8-E defect in a new costume: deriving state out of a payload. Fixed: a
notification only ever contributes need `read`; the state comes from the row that owns it
(the FSM/approval loops), and folding puts the unreadness on that row anyway. Two tests pin it
(`a notification never raises a need`, `that same stale notice folds into the row when the FSM
still says review`).

### 3.5 What the drop rule would have removed (not on this snapshot)

`dropped = 0` here. The rule exists for the rows that *do* occur over time: an approval whose
agent record is gone (no entity, no `agentId`), and a broadcast with no entity and no sender.
Legacy rendered those as a row that navigates to `TEAM` with **no parameters** — a click that
lands on a page where nothing can be done. Derived withholds them and reports
`{source, ref, reason: 'no_action'}` instead of silently hiding them.

## 4. Decision

The derived list is a **strict subset** on this data (same work, one duplicate removed) with two
additions that are not visible as rows: `blocking` and `sources`. Nothing that needs a human
disappeared, and no item lost its destination — checked by comparing the destination of every
surviving row, not by counting rows.

Rollback: the whole cut is one commit (`git revert`), and there is deliberately **no runtime
`legacy | derive` switch** — a switch keeps the old assembly in the shipped bundle and with it a
second decider for the same fact (see `derived-views.md` §12).
