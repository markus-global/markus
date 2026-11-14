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

sessionScopeKeyOfWorkUnitRef(ref): string | undefined
  a2a:<rest>            → 'a2a_' + sanitise(rest)
  everything else       → undefined             (this layer declares no session)

taskIdOfWorkUnitRef(ref): string | undefined
  task_<id>_r<n> / a2a:task:<id> → <id>
```

`undefined` means "this ref carries no session identity, use the legacy path" —
**not** "there is no session". Same discipline as `sessionLockKeyOfContextRef()`.
It deliberately yields nothing for `task_<id>_r<n>`: the consumer wraps the value
in `channelMemorySessionId()`, so returning the task ref there would mint
`channel_task_x_r1_<agent>` beside the task's real execution session — the same
R1 in a new place (§7.5).

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

### 3.7 All fifteen types: affinity → destination

The card's objective is "re-sort the **15** mailbox item types onto three axes",
so listing one consumer would read as "the other fourteen were missed". They were
not missed — fourteen of them are already carried by an existing path, and this
section says which one, per type. Column *who decides* has exactly three
possible answers and no fourth:

- **`resolveMailboxDestination`** — the entity-intersection predicate
  (§3.6). Today it has **one** consumer, `task_comment` (`agent.ts:2798`); the
  other types have no in-turn injection to decide.
- **default queue** — the item is dequeued and its own `case` in the dispatch
  switch (`agent.ts:2481`–`2990`) handles it. Whether that costs an LLM turn is
  a *type-level* fact (`invokesLLM`), not a destination decision.
- **overview** — the `catch_all` surface (`bounceSignal(..., 'catch_all', ...)`
  at `mailbox.ts:626`, read-only `catchAll()` at `:654`). It is an **exit path**
  for items nobody handled, not a per-type destination; a type never "goes to
  overview" by design, it lands there by failing to be handled.

| # | type | affinity (lock dimensions) | `invokesLLM` | destination — who decides |
|---|---|---|---|---|
| 1 | `human_chat` | task, requirement, conversation, system | yes | default queue → own case (`agent.ts:2481`) |
| 2 | `a2a_message` | task, requirement, **workunit**, system | yes | default queue → shares the `human_chat` case |
| 3 | `mention` | task, requirement, user, conversation, system | yes | default queue → own case (`:2718`) |
| 4 | `session_reply` | task, requirement, conversation, system | yes | default queue → own case (`:2951`) |
| 5 | `task_comment` | task, requirement, system | no | **`resolveMailboxDestination`** → `inject` when the entity is the running task, else `queue` (one `comment_response` turn) |
| 6 | `review_request` | task, requirement, system | yes | default queue; `strictState` ⇒ may not be merged/deferred/dropped (`:2823`) |
| 7 | `requirement_comment` | task, requirement, system | no | default queue → records, no turn (`:2754`) |
| 8 | `requirement_update` | requirement, system | no | default queue; only `intent='action_required'` is authoritative (`:2731`) |
| 9 | `workflow_update` | task, requirement, system | yes | default queue; informational branch closes without a turn (`:2770`) |
| 10 | `task_status_update` | task, system | no | default queue; `intent='trigger_execution'` is the execution instruction (`:2614`) |
| 11 | `callback_result` | conversation, system | yes | default queue → own case (`:2972`); never age-purged (`isNeverPurgeable`) |
| 12 | `heartbeat` | system | yes | default queue → own case (`:2901`) |
| 13 | `daily_report` | system | yes | default queue → grouped with `system_event` (`:2918`) |
| 14 | `memory_consolidation` | system | yes | default queue → own case (`:2938`); **not** age-droppable any more (§3.8) |
| 15 | `system_event` | system | yes | default queue → own case (`:2918`) |

The three axes therefore hold for all fifteen: every type resolves entity keys
through one function (`resolveEntityKeys`, driven by the registry), every type's
destination is answered either by the one predicate or by the default queue, and
nothing reaches "overview" except by the existing catch-all exit. The gap this
card actually had was *not* in the other fourteen — it was that `a2a_message`
was the one type whose identity came from the transport (§2).

### 3.8 The disposal table: dream is not age-droppable

The card owns the whole `type → disposal` dispatch table, and one entry was
wrong: `memory_consolidation` (dream) was listed as "stale information, drop by
age". A dream run is background work on the sleep path, not attention noise; age
expiry silently discards the run and leaves no trace.

The table also had **two writers**: a hand-maintained literal array in
`limits.ts` beside the registry's per-type `triageStaleDrop` flag. Only the flag
was ever read (`routeMailboxItem(item).triageStaleDrop` at `mailbox.ts:682` and
`:2145`); the literal had no readers at all and still looked like the source of
truth. That is the same R1 as the rest of the card, one layer down, so it is
fixed the same way — **delete the second writer**: `TRIAGE_STALE_DROP_TYPES` is
now a projection of `MAILBOX_TYPE_REGISTRY`, and `memory_consolidation`'s flag is
`false`.

Scope note: this is the *disposal* fact only. `memory_consolidation`'s **affinity**
(`['system']`, the global single key) is C8-C's battlefield and is untouched here.

## 4. Test plan — each test observed red before implementation

`packages/shared/test/work-unit-ref.test.ts` (new, 17 assertions)
1. `a2a` ref carries no per-delivery discriminator (same entity twice → same ref).
2. `entityKeysOfWorkUnitRef` table, all six shapes.
3. `a2a:channel:*` yields **no** `channel:` key (would re-introduce the transport writer).
4. Never empty (an empty key set silently disables mutual exclusion).
5. `sessionScopeKeyOfWorkUnitRef` table; `session:*` → `undefined`; `task_*` →
   `undefined` (see §7.5); safe charset for the values it does return.

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

`packages/core/test/mailbox-entity-consolidation.test.ts` (new)
18. One thing over two channels → **one** queued item (guards pre-triage merge).
19. Two different things in one channel → **two** items (guards enqueue merge).
20. Legacy rows (no WorkUnit) still merge by `channelKey` — behaviour preserved.

18 and 19 each bypass the *other* merge layer on purpose (18 pulls the first item
out of the queue with `dequeue()` / `putBack()`, 19 relies on the enqueue path),
so neither can be satisfied by a layer other than the one it names.

`packages/core/test/mailbox-batch-and-purge.test.ts` (extended, +2 and one
updated expectation)
21. An expired `memory_consolidation` item **survives** `purgeStaleItems()` —
    behavioural, not a source-text assertion.
22. `TRIAGE_STALE_DROP_TYPES` equals the registry projection **and** does not
    contain `memory_consolidation`, with `heartbeat` still present as the control
    (otherwise "dream is absent" could just mean the list went empty).
23. The mixed-purge test now expects dream **and** the `action_required` item to
    survive while only the plain informational item is reclaimed (its old
expectation counted dream as droppable).

## 5. Verification

| gate | result |
|---|---|
| `tsc -b --force` | clean |
| `npm run lint` | 0 errors (1001 pre-existing warnings) |
| `node scripts/architecture-guard.mjs` | 34 hits, all whitelisted; contracts 18/18 |
| `node scripts/security-guard.mjs` | ok |
| `npx vitest run` (whole repo, serial) | 8536 passed / 1 failed / 13 skipped (8550) |
| `npm run test:web-ui` | 1476 passed / 3 skipped, 0 failed |
| the 1 failure | `cli: auto-runs quickInit when config is missing` — **also fails at base `0425bd48`** (60 s timeout; reproduced in a clean baseline worktree, see §6) |

Live reading of the rows the **old** code produced (read-only `~/.markus/data.db`):

```
last 2h, source_type='a2a_message':
  a2a_rows = 17   distinct_refs = 17   ref_with_delivery_id = 17   null_ref = 0
```

That is the "before" baseline in one line: one WorkUnit per delivery, and every
ref embeds the delivery id. Feeding the same entity through the **shipped**
derivation (`packages/shared/dist/work-unit.js` — no re-implementation of the
rule in the probe):

```
three messages on one task    → ref: 1, entity: 1, session scope key: 1, ref contains dlv_: false
three messages on one channel → ref: 1, entity: 1, session scope key: 1
```

## 6. Baseline red-proof

A detached worktree at base `0425bd48` was installed offline (`pnpm install
--frozen-lockfile`) and built (`tsc -b`). Two things were proven there.

**The CLI failure is pre-existing.** The identical test fails identically in the
baseline worktree — 1 failed / 15 passed there, 1 failed / 15 passed here, same
60 s timeout. This card touches neither the CLI nor `quickInit`.

**The new merge assertions are not hollow.** Copied into the baseline worktree
and run there:

| assertion | base | head |
|---|---|---|
| one thing over two channels → one item | ✗ `expected length 1, got 2` | ✓ |
| two things in one channel → two items | ✗ `expected length 2, got 1` | ✓ |
| legacy rows (no WorkUnit) still merge by channel | ✓ | ✓ |

The third row is the control: it proves the fallback path was preserved rather
than replaced, so the two red rows above are attributable to the entity rule.

The dream/disposal assertions were proven the same way — same file copied into
the built baseline worktree, where the registry still says "drop dream by age":

| assertion | base | head |
|---|---|---|
| an expired `memory_consolidation` survives `purgeStaleItems()` | ✗ `expected 1 to be +0` (it was purged) | ✓ |
| the stale-drop list does not contain `memory_consolidation` | ✗ `expected [ 'task_status_update', …(4) ] to not include 'memory_consolidation'` | ✓ |
| mixed purge: dream **and** the `action_required` item survive | ✗ `expected 2 to be 1` | ✓ |

The control stays green on both sides: `heartbeat` (real informational noise) is
still reclaimed by age, so "dream survives" cannot be a side effect of the purge
having stopped working altogether.

One trap worth recording: a fresh baseline worktree fails **every** test in a file
within single-digit ms until the workspace dependencies are built
(`Failed to resolve entry for package "@markus/shared"`). That is an install
artefact and must not be read as "red at base" — the tell is `AssertionError`
versus module resolution, and per-test duration of ms versus seconds.

## 7. Where the implementation corrected the plan

1. **§3.3 rewritten**: the plan filtered scopes inside `resolveEntityKeys`; that
   is a second derivation source, so it became a registry dimension change
   instead. `channel` was deleted outright rather than demoted.
2. **`conv:` convergence needed no code**: it was already true by construction
   (§3.3) — asserting a "fix" there would have been theatre.
3. **A third writer was found and removed** (§3.5): core re-derived the A2A
   session from `extra.channelKey` after `resolveTurnSession` had already applied
   the hint. That was a small-scale copy of the same R1.
4. **The merge key had to move too** (review requirement, §5.1 below): merging
   a2a items by `channelKey` reproduces the same defect in a new shape — one
   thing over two channels is *not* merged (read twice, in two contexts), and two
   things inside one channel *are* merged (the second one's reason to execute
   disappears). Both merge layers now key on the entity; the dead
   `_groupType: string` parameter went with it, which is why the `'channel'`
   literal at the call site is gone rather than renamed.
5. **`turnSessionIdOfWorkUnitRef` → `sessionScopeKeyOfWorkUnitRef`** (§3.1):
   the old name promised a session id but the value gets wrapped by
   `channelMemorySessionId()`, and the `task_*` branch returned the ref itself —
   which would have produced `channel_task_x_r1_<agent>` beside the task's real
   execution session. Same R1, re-introduced by a name. No production caller
   passed a task ref, so behaviour is unchanged; the trap is what is gone. A name
   is a constraint for the next reader, so it now says what the function answers.
6. **dream was taken out of the age-based purge** (review requirement, §3.8):
   `memory_consolidation.triageStaleDrop` → `false`, and
   `TRIAGE_STALE_DROP_TYPES` stopped being a hand-maintained literal. Worth
   recording *why* this was a defect rather than a preference: the literal had no
   runtime readers at all (the only reader is
   `routeMailboxItem(item).triageStaleDrop`), so it pretended to be the source of
   truth while the registry actually decided — and the entry it carried said
   "drop a dream run after four hours". Deleting the second writer is what makes
   the correction stick; editing both copies would have left the drift trap in
   place.

## 8. Boundaries

- No `cs_*` / `sess_*` session contract change; no LLM provider change.
- No back-fill or migration of historical rows; locks are in-memory only.
- `mailbox_items.work_unit_ref` keeps exactly one writer (`linkMailboxItem`).
- `work_units` schema untouched.
- `heartbeat` / `daily_report` / `memory_consolidation` **affinity**
  (`['system']`, the global single key) untouched — that is C8-C's battlefield.
- **dream's disposal is this card, and it is done** (§3.8): `memory_consolidation`
  is out of the age-based purge and the stale-drop list is now derived, not
  hand-written. The `type → disposal` dispatch table belongs to C8-A; the
  affinity table does not.
- The batch-assembly entry point is untouched — that is C8-D.
