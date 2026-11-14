# Cut 8 · C8-A — Entity keys converge on WorkUnit; destinations re-partitioned along three orthogonal axes

> Branch `task/c8-a-entity-keys` → PR into `feat/refactor-plan`.
> Base: `0425bd48` (merge of PR #444, cut 7).
> Status: design + test plan (written before the first red test).

---

## 1. Symptom (one reading)

Send three A2A messages about the *same* piece of work. The recipient agent's
number of memory sessions grows by three instead of staying flat, and the three
`mailbox_items` rows carry three different `work_unit_ref` values (or none).

Live probe at the time of writing (read-only, `~/.markus/data.db`):

| reading | value |
|---|---|
| `mailbox_items` where `source_type='a2a_message'` | 34 728 |
| … of those with `work_unit_ref IS NOT NULL` | 1 |

So the entity layer C7 built is **wired but unpopulated** on the A2A chain: the
identity exists, the reference to it does not.

## 2. Root cause (R1 — one fact, two writers)

"Which session does this message go to" has two writers today, and the delivery
channel wins over the thing itself:

| writer | where | what it says |
|---|---|---|
| delivery channel | `resolveEntityKeys()` → `channel:<channelKey>` / `conv:<sessionId>` | the message belongs to a transport route |
| delivery channel (again) | `sessionHint { kind:'system', role:'channel', key }` → `channelMemorySessionId()` | the turn's memory session |
| delivery channel (again, per hop) | `WORK_UNIT_REF.a2a(channelKey, deliveryId)` | **one WU per delivery** |
| thing itself | `mailbox_items.work_unit_ref` | the message belongs to a WorkUnit |

Because the WU is minted *per delivery* (`deliveryId` is in the ref), three
messages about one task necessarily become three WUs — and, downstream, three
sessions (`a2a_<agent>_<timestamp>`, `channel_<key>_<agent>`). The WorkUnit was
supposed to be the answer to "which thing is this", but the ref was derived from
the delivery, so it re-encodes the delivery.

Two smaller second writers on the same fact:

- `agent.ts` falls back to `a2a_${this.id}_${ts}` when a message carries no
  `[conversation:x]` tag — a timestamp in an identity slot. Every such message
  gets its own session by construction.
- `agent-manager.ts` (`sys_${from}_${Date.now()}`) does the same thing one layer
  up.

Root-cause test: **could this bug recur under a different name?** Yes — any new
transport (email, webhook, group DM, a new IM gateway) would mint its own
`<transport>:` key and split sessions again. So the fix cannot be "add `a2a` to a
special case"; the fix is that **the entity key must be derivable from the
WorkUnit ref and nowhere else** whenever a WorkUnit is known.

## 3. Design

### 3.1 One pure derivation, three consumers

`packages/shared/src/work-unit.ts` gains two pure functions. They are the single
answer to "this ref belongs to which entity / which session":

```
entityKeysOfWorkUnitRef(ref): string[]
  task_<id>_r<n>        → ['task:<id>']
  a2a:task:<id>         → ['task:<id>']
  a2a:channel:<key>     → ['wu:<ref>']
  session:<cs>:r<n>     → ['conv:<cs>']
  delegation:<p>#<c>    → ['wu:<ref>']
  (anything else)       → ['wu:<ref>']

turnSessionIdOfWorkUnitRef(ref): string | undefined
  task_<id>_r<n>        → 'task_<id>_r<n>'        (existing convention, unchanged)
  a2a:task:<id>         → 'a2a_task_<id>'
  a2a:channel:<key>     → 'a2a_<sanitised ref>'
  session:<cs>:r<n>     → undefined              (chat keeps its DB→memory binding)
  (anything else)       → undefined
```

`undefined` means "this ref carries no session identity, use the legacy path" —
**not** "there is no session". Same discipline as
`sessionLockKeyOfContextRef()`.

### 3.2 `WORK_UNIT_REF.a2a` names the thing, not the delivery

```diff
- a2a(channelKey: string, deliveryId: string) { return `a2a:${channelKey}:${deliveryId}`; }
+ a2a(entityKey: string) { return `a2a:${entityKey}`; }
```

The caller supplies the entity: `task:<taskId>` when the sender's current turn is
a WorkUnit that belongs to a task, otherwise `channel:<channelKey>` (a
conversation *is* a legitimate entity; a delivery is not).

Consequence: three messages about one task share one WU ref, therefore one
entity, therefore one session. The WU stops being a receipt for a delivery and
becomes the identity of the work.

### 3.3 `resolveEntityKeys` yields to the WU

When `item.workUnitRef` is set:

- structural dimensions from the payload still apply (`task:` / `req:` / `user:` —
  they describe the same thing, not the route);
- `conversation` and `channel` scopes are **skipped** (transport identity);
- `entityKeysOfWorkUnitRef(ref)` is appended;
- never empty (falls back to the WU's own `wu:` key).

When `workUnitRef` is null the function behaves **exactly as before** — historical
`channel:` / `conv:` rows stay readable and are never back-filled or migrated.

### 3.4 `dedupeKey` derives from the entity

`roundDedupKeyOf()` currently reads `payload.taskId` (a payload field). It now
takes the task id from the WorkUnit ref when one exists, falling back to the
payload for legacy rows. Shape `(sourceType, taskId, round)` is preserved — round
is still part of the key, because two review requests for the same task in two
different rounds are two facts, not one.

### 3.5 Three destinations, one decision point

```
resolveMailboxDestination(entityKeys, activeTurnEntityKeys): 'inject' | 'queue' | 'overview'
  only the system fallback key  → 'overview'   (no entity: nothing to interrupt)
  intersects the active turn    → 'inject'     (same thing: never queue behind itself)
  otherwise                     → 'queue'      (different thing: parallel is safe)
```

The one in-turn injection point that exists today — `task_comment` while the task
is executing — is expressed through this function instead of its own
`activeTasks.has(taskId)` check. `'overview'` is the existing `catch_all` surface
(`listCatchAll` / `bounceTarget`), which is where an entity-less signal already
lands; the decision now has one name.

Delta content injection (what the injected text looks like, cache behaviour when
empty) is **C8-B**, not this card.

## 4. Test plan (written before the code — each test is observed red first)

`packages/shared/test/work-unit-ref.test.ts` (new)

1. `a2a` ref no longer contains a per-delivery discriminator: same entity twice → same ref.
2. `entityKeysOfWorkUnitRef` table — all six shapes above.
3. `a2a:channel:*` yields **no** `channel:` key (would re-introduce the transport writer).
4. `turnSessionIdOfWorkUnitRef` table; `session:*` → `undefined`.

`packages/shared/test/mailbox-route.test.ts` (extend)

5. Two items, same task, different `channelKey`, both with the same `workUnitRef`
   → **identical** entity keys (guards the actual symptom).
6. Same two items with `workUnitRef: null` → still different `channel:` keys
   (legacy read-only compatibility; proves the migration-free path).
7. `dedupeKey` for a WU-carrying item uses the WU's task id even when
   `payload.taskId` is absent.
8. `resolveMailboxDestination`: inject / queue / overview.

`packages/core/test/…` (extend)

9. A2A turn session id for a WU-carrying item equals
   `turnSessionIdOfWorkUnitRef(ref)`; three messages, one session id.
10. A2A turn session id for a legacy item (no WU) is unchanged.

`packages/org-manager/test/agent-delivery-workunit.test.ts` (new)

11. Two deliveries inside one task produce **one** `work_units.ref`.

## 5. Boundaries

- No `cs_*` / `sess_*` session contract change; no LLM provider change.
- No back-fill, no migration of historical `channel:` / `conv:` keys.
- `mailbox_items.work_unit_ref` keeps exactly one writer (`linkMailboxItem`).
- `work_units` schema untouched.
