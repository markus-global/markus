# Cut 8 · C8-A — Entity identity converges on the WorkUnit; destinations split on three axes

> Branch `task/c8-a-entity-keys` → PR into `feat/refactor-plan`.
> Base: `0425bd48` (merge of PR #444, cut 7).
> Design + test plan were written before the first red run; §7 records what the
> final implementation actually decided where the plan was wrong.

---

## 1. Symptom

Send three A2A messages about the **same** piece of work. The recipient's number
of memory sessions grows by three instead of staying flat, and the three
`mailbox_items` rows carry three different `work_unit_ref` values.

Live reading (read-only, `~/.markus/data.db`, 2026-11-14 17:0x):

| reading | value |
|---|---|
| `mailbox_items` where `source_type='a2a_message'` | 34 739 |
| … of those with `work_unit_ref IS NOT NULL` | 11 |
| … **without** a `[conversation:x]` tag in `payload.content` | **29 993 (86 %)** |
| messages on the busiest single `(agent, channel)` | 612 |

The 86 % is the mechanism: a message without a conversation tag fell through to
`a2a_${agentId}_${timestamp}` — a timestamp in an identity slot, i.e. one new
session per message by construction. The other 14 % were pinned to a stable
session id but still minted one WorkUnit per delivery.

## 2. Root cause (R1 — one fact, two writers)

"Which thing is this message about" had two writers, and the delivery channel won:

| writer | where | what it claimed |
|---|---|---|
| transport route | `resolveEntityKeys()` → `channel:<channelKey>` | the item belongs to a route |
| transport route (again) | `sessionHint {role:'channel', key: channelKey}` → `channelMemorySessionId()` | the turn's memory session |
| transport route (again, per hop) | `WORK_UNIT_REF.a2a(channelKey, deliveryId)` | **one WU per delivery** |
| the thing itself | `mailbox_items.work_unit_ref` | the item belongs to a WorkUnit |

Because the ref encoded `deliveryId`, three messages about one task necessarily
became three WUs; because the session id was derived from the transport (or a
timestamp), they became three sessions.

**Root-cause test — could this recur under a different name?** Yes: any new
transport (email, webhook, a new IM gateway) could mint its own `<transport>:`
key and split sessions again. So the fix cannot be an `a2a` special case; the fix
is that **the entity is derivable from the WorkUnit ref and nowhere else**.

## 3. Design (as implemented)

### 3.1 One pure derivation, three consumers

`packages/shared/src/work-unit.ts`:

```
entityKeysOfWorkUnitRef(ref): string[]
  task_<id>_r<n>        → ['task:<id>']
  a2a:task:<id>         → ['task:<id>']
  a2a:channel:<key>     → ['wu:<ref>']
  session:<cs>:r<n>     → ['conv:<cs>']
  delegation:…          → ['wu:<ref>']
  anything else         → ['wu:<ref>']            (never empty)

turnSessionIdOfWorkUnitRef(ref): string | undefined
  task_<id>_r<n>        → same string           (existing convention, zero migration)
  a2a:<rest>            → 'a2a_' + sanitise(rest)
  everything else       → undefined             (use the legacy path)

taskIdOfWorkUnitRef(ref): string | undefined
  task_<id>_r<n> / a2a:task:<id> → <id>
```

`undefined` means "this ref carries no session identity, use the legacy path" —
**not** "there is no session". Same discipline as `sessionLockKeyOfContextRef()`.

### 3.2 `WORK_UNIT_REF.a2a` names the thing, not the delivery

```diff
- a2a(channelKey, deliveryId) { return `a2a:${channelKey}:${deliveryId}`; }
+ a2a(entityKey)               { return `a2a:${entityKey}`; }
```

The caller supplies the entity: `task:<taskId>` when the sender's current turn is
a WorkUnit that belongs to a task, else `channel:<channelKey>` (a conversation is
a legitimate entity; a delivery is not). The parent turn ref is read from
in-memory turn state (`turnWorkUnitRef`), never queried from the DB.

### 3.3 The registry decides which dimensions lock — not the call site

The plan (§7.1) originally proposed filtering `conversation`/`channel` inside
`resolveEntityKeys()` when a WorkUnit was present. That would have been a second
derivation source, and `mailbox-route.test.ts` ("keys derive only from
`route().affinity`") exists precisely to catch that. The implemented shape is a
registry change instead:

- `MailboxEntityScope`: **`'channel'` deleted**, **`'workunit'` added**.
- `a2a_message.affinity`: `['task','requirement','channel','system']` →
  `['task','requirement','workunit','system']`.
- `resolveEntityKeys()` gains one `case 'workunit'` that calls
  `entityKeysOfWorkUnitRef(item.workUnitRef)` — a declared dimension, resolved in
  the one place dimensions are resolved.

`channel:` is gone rather than kept as a non-locking dimension: locks live only in
memory (`entityLocks`), so there is no historical key to migrate, and leaving a
dead namespace is the suspended-reference antipattern. A legacy A2A row with no
WorkUnit now falls back to `system:<agentId>` — the documented "unknown =
conservatively serial" rule (slower, never wrong). New A2A rows always carry a
WorkUnit, so this is a drain-the-queue path only.

**`conv:` needed no change**: for chat, `WORK_UNIT_REF.chat` is
`session:<cs>:r<n>`, whose entity key is `conv:<cs>` — exactly what the
`conversation` dimension already derived from `metadata.dbSessionId`. The
convergence is true by construction, and §3.1's table is the proof.

### 3.4 `dedupeKey` derives from the entity

`roundDedupKeyOf()` now reads the task id from the WorkUnit ref first
(`taskIdOfWorkUnitRef`), falling back to `payload.taskId` / `metadata.taskId` for
legacy rows. Shape `(sourceType, taskId, round)` is unchanged: two review requests
for the same task in two different rounds are two facts, not one.

### 3.5 One producer-side change in core

`agent.ts` was deriving the A2A channel session a **second** time from
`extra.channelKey`, overriding the hint `resolveTurnSession()` had just applied.
It now reads the session key from the hint (single source); `extra.channelKey`
still falls back for rows without a hint.

### 3.6 Three destinations, one decision point

```
resolveMailboxDestination(entityKeys, activeTurnEntityKeys): 'inject' | 'queue' | 'overview'
  no concrete entity (only `system:` fallback) → 'overview'
  intersects the active turn's entities        → 'inject'      (never queue behind itself)
  otherwise / turn unknown                     → 'queue'
```

The one pre-existing in-turn injection point (`task_comment` while its task is
executing) now goes through this function instead of its own
`activeTasks.has(taskId)` check — one predicate answered one question. `'overview'`
is the existing `catch_all` surface where entity-less signals already land.

Delta-injection *content* (what injected text looks like, cache behaviour when
empty) is **C8-B** and deliberately not in this card.

## 4. Test plan — each test observed red before implementation

`packages/shared/test/work-unit-ref.test.ts` (new, 17 assertions)
1. `a2a` ref carries no per-delivery discriminator (same entity twice → same ref).
2. `entityKeysOfWorkUnitRef` table, all six shapes.
3. `a2a:channel:*` yields **no** `channel:` key (would re-introduce the transport writer).
4. Never empty (an empty key set silently disables mutual exclusion).
5. `turnSessionIdOfWorkUnitRef` table; `session:*` → `undefined`; safe charset.

`packages/shared/test/mailbox-route.test.ts` (extended, +10)
6. Same task + different `channelKey` + same WU → **identical** entity keys.
7. A WU-carrying item emits no `channel:` / `conv:` key.
8. A WU-less item falls back to `system:` (not `channel:`).
9. `dedupeKey` takes the task id from the WU ref when the payload is silent.
10. `resolveMailboxDestination`: inject / queue / overview.

`packages/org-manager/test/agent-delivery.test.ts` (extended, +6)
11. Three deliveries in one task turn → one ref (`a2a:task:tsk_1`).
12. … → one session key (`a2a_task_tsk_1`).
13. Identity lands on the in-memory item at enqueue, not only the DB column.
14. No turn WU → `a2a:channel:<channelKey>`, still not per-delivery.
15. Different tasks → different refs.
16. `linkMailboxItem` remains the only writer of the DB column.

`packages/core/test/mailbox-concurrent.test.ts` (rewritten)
17. Same entity serial even across different channels; different entities parallel.

## 5. Verification

| gate | result |
|---|---|
| `tsc -b --force` | clean |
| `npm run lint` | 0 errors (1001 pre-existing warnings) |
| `node scripts/architecture-guard.mjs` | 34 hits, all whitelisted; contracts 18/18 |
| `node scripts/security-guard.mjs` | ok |
| `npx vitest run` (whole repo, serial) | 8530 passed / 1 failed / 13 skipped |
| the 1 failure | `cli: auto-runs quickInit when config is missing` — **also fails at base `0425bd48`** (60 s timeout; reproduced in a clean baseline worktree, see §6) |

## 6. Baseline red-proof

A detached worktree at base `0425bd48` was installed offline and built. It
reproduces the CLI failure independently of this branch, so that failure is
**pre-existing**, not introduced here. The new C8-A assertions cannot pass at base
(the functions and the `workunit` dimension do not exist there), which is what
makes them non-hollow.

## 7. Where the implementation corrected the plan

1. **§3.3 rewritten**: the plan filtered scopes inside `resolveEntityKeys`; that
   is a second derivation source, so it became a registry dimension change
   instead. `channel` was deleted outright rather than demoted.
2. **`conv:` convergence needed no code**: it was already true by construction
   (§3.3) — asserting a "fix" there would have been theatre.
3. **A third writer was found and removed** (§3.5): core re-derived the A2A
   session from `extra.channelKey` after `resolveTurnSession` had already applied
   the hint. That was a small-scale copy of the same R1.

## 8. Boundaries

- No `cs_*` / `sess_*` session contract change; no LLM provider change.
- No back-fill or migration of historical rows; locks are in-memory only.
- `mailbox_items.work_unit_ref` keeps exactly one writer (`linkMailboxItem`).
- `work_units` schema untouched. Heartbeat / dream / memory-consolidation
  affinity (`['system']`) untouched — that is C8-C.
- The batch-assembly entry point is untouched — that is C8-D.
