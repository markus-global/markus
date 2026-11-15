# C9 adjacent paths — shutdown re-queue identity + gateway receipt fixture

Date: 2026-11-15
Card: `tsk_804c3f67235acca464742519` (follow-up to `tsk_4459e401385dfadc6d9e4c59`)
Scope: `packages/core/src/mailbox.ts`, `packages/core/src/attention.ts`,
`packages/org-manager/src/api-server.ts`, new `packages/org-manager/src/gateway-task-receipt.ts`
(+ 2 new test files, + 1 allowlist entry)
Status: implemented

## 1. Starting facts (measured on the card's base commit `76501788`)

| Fact | Reading |
|---|---|
| Callers that declare `refOrigin` before this change | 2 (`agent.ts` `pending-link`, `api-server.ts` `platform-internal`) — the previous card's work |
| Shutdown re-queue of an interrupted item | `attention.ts` inlined `enqueue(sourceType, payload, { priority, metadata, reuseItemId })` — no `workUnitRef`, no `refOrigin` |
| Same shape in `mailbox.reEnqueueOnShutdown()` | identical omission; **no caller** anywhere (dead public method, live duplicate of the inline block) |
| `SqliteMailboxRepo.requeueItem()` columns written | `status / queued_at / started_at / completed_at / claimed_by / lease_until / drop_reason / bounce_target` — **`work_unit_ref` is not in the UPDATE** |
| Gateway receipt enqueue | inlined in the `api-server.ts` sync-bridge closure; verdict `platform-internal` upheld by reading only |

## 2. Root cause (R1 — one fact, three writers)

Identity (`mailbox_items.work_unit_ref`) is decided in three places:

1. `enqueue()` writes whatever `options.workUnitRef` says;
2. the producer chain links the real ref afterwards (`linkMailboxItem`, the single writer);
3. the C8-P0 guard re-decides "was this forgotten?" by looking at a NULL ref + a declaration.

The re-queue path is the case where **none** of the three should decide anything: the row
already exists and its ref is already there. It reached the guard anyway (it builds a fresh
`MailboxItem` from `options`, where the ref defaults to `null`), so strict mode would throw
and the item would stay `processing` until the lease expired — a graceful restart silently
degrading into a crash recovery.

## 3. Semantics ruling: re-queue **inherits** the row's identity

The card asked to answer this before touching code:

> does reuse inherit the original row's `work_unit_ref`, or does it re-declare a new fact?

**Inherit.** Evidence is mechanical, not stylistic: `requeueItem()`'s `UPDATE` lists every
mutable column and does *not* include `work_unit_ref`, so a re-queued row keeps the identity
it had. Any code that computed a ref at the re-queue call site would be a second writer of the
same fact — exactly the defect family C9 closed.

Two consequences for the call site:

- when the caller still holds a ref (`item.workUnitRef`, populated by producers that know the
  entity at enqueue time), hand it back — otherwise the in-memory requeued item would drop an
  identity that was never in doubt (declare `entity`);
- when it holds none, declare `pending-link`: this call decides no identity, the row is the
  authority. That is the honest statement for both dominant families here — task
  (`sendTaskExecution`, linked by `onItemEnqueued`) and A2A (`AgentDelivery.deliver`, linked
  by `linkMailboxItem` after enqueue).

Not `platform-internal`: that would claim "there is no entity", which is false for a task or
A2A row that simply gets its ref late.

## 4. Probe: the path really did reach the guard (red → green)

Real assembly chain in a real Node process: `AgentMailbox` + real `SqliteMailboxRepo`
(+ `SqliteWorkUnitRepo` for the single identity writer), throwaway SQLite DB under `/tmp`,
`MARKUS_STRICT_IDENTITY=1` (stricter than "0 ERROR lines": an undeclared empty identity throws).

Scenario: producer enqueue (`task_status_update`, `intent=trigger_execution`, `pending-link`,
round 2) → `linkMailboxItem(row, task_<id>_r2)` → `dequeue()` (row goes `processing`) → the
shutdown re-queue call.

Before the change:

```
row before reuse: status=processing, work_unit_ref=task_tsk_probe_reuse_r1
attention-shape enqueue   -> THREW mailbox.enqueue(task_status_update) has no workUnitRef and no refOrigin
mailbox.reEnqueueOnShutdown -> THREW (same message)
unclaimedIdentityCount: 2
row after reuse attempt: status=processing (identity intact, but the item never came back)
```

After the change (same probe):

```
attention-shape enqueue   -> THREW (the inline duplicate is gone from attention.ts; kept here as a control)
mailbox.reEnqueueOnShutdown -> NO
row after reuse: status=queued, claimed_by=NULL, work_unit_ref=task_tsk_probe_reuse_r1  ← inherited
unclaimedIdentityCount: 1 (only the deliberate control call)
```

So: the guard *was* the thing firing, and inheritance is the real DB behaviour rather than an
assumption in prose.

## 5. Changes

### 5.1 `mailbox.reEnqueueOnShutdown()` — the single re-queue implementation

```ts
this.enqueue(item.sourceType, item.payload, {
  priority: item.priority,
  metadata: item.metadata,
  round: item.round,                                   // structural, not payload
  reuseItemId: item.id,
  workUnitRef: item.workUnitRef ?? null,               // hand back what we hold
  refOrigin: item.workUnitRef ? 'entity' : 'pending-link',
});
```

`round` is carried because it is the dedup-key / unicast-route input; dropping it on a re-queue
silently demotes a round-scoped delivery to "round unknown" (the existing re-delivery tests
already pass `round: item.round` for the same reason).

### 5.2 `attention.ts` — the inline duplicate is deleted

The shutdown branch now calls `this.mailbox.reEnqueueOnShutdown(item)` instead of re-building
the same options object. Before this change that method had **zero** callers while the
controller carried a copy of its body: one behaviour, two sites, and only one of them was ever
going to receive the declaration. Deleting the copy is the fix; adding a second declaration
would have been the same defect in a new place.

### 5.3 `org-manager/src/gateway-task-receipt.ts` — receipt enqueue as production code

The gateway `createTask` receipt enqueue (formerly inlined in the `api-server.ts` sync bridge)
moved into an exported function; `api-server.ts` now calls it inside the same `try/catch`
(a receipt failure must not fail task creation). The declaration is unchanged and still
`platform-internal`, now with the reason next to it:

- no WorkUnit exists at creation time; the first one (`task_<id>_r1`) is created at execution
  start and attached to the **execution item**, not this row;
- nothing links this row (`linkMailboxItem`'s callers are the execution / delivery chains);
- the task's entity linkage is structural: `envelope.messageId = gateway-task:<id>` +
  `metadata.taskId`.

`platform-internal` is the honest verb; `pending-link` would promise a link nobody makes.

## 6. Tests and mutation self-proof

### 6.1 `packages/core/test/mailbox-identity-reuse.test.ts` (4 cases)

Real `AgentMailbox` + real `SqliteMailboxRepo`/`SqliteWorkUnitRepo`, throwaway DB,
`MARKUS_STRICT_IDENTITY=1`:

1. re-queue of an interrupted, already-linked task row: no throw, `status=queued`,
   `work_unit_ref` still `task_<id>_r2` (read back from the DB, not from memory), `round`
   preserved, unclaimed count 0;
2. re-queue of an item that carried a ref at enqueue (review_request): the in-memory item keeps
   the ref (the `entity` branch), the row unchanged;
3. an **undeclared** caller of the same fact type still throws (the fail-open guard);
4. contract fence: `attention.ts` must not contain `reuseItemId:` again and must call
   `this.mailbox.reEnqueueOnShutdown(`.

### 6.2 `packages/org-manager/test/gateway-task-receipt.test.ts` (2 cases)

Calls the **production** helper (not a copy of its options object):

1. strict mode, no throw; receipt row `work_unit_ref IS NULL`, `intent=deliver`,
   `messageId=gateway-task:<id>`; then a real execution dispatch is enqueued and linked —
   the execution row gets `task_<id>_r1` while the receipt row stays NULL and exactly **one**
   row in the whole task carries an identity;
2. no assignee → no row written, no throw.

### 6.3 Mutation readings (each mutation applied alone, then reverted)

| Mutation | Expected | Observed |
|---|---|---|
| delete `workUnitRef`/`refOrigin` from `reEnqueueOnShutdown` | positive cases red | 2 failed / 2 passed; error text is the guard message (`…task_status_update) has no workUnitRef…`, `…review_request)…`) |
| delete the guard's `throw` in `mailbox.ts` | negative case red | 1 failed (`expected [Function] to throw an error`) / 5 passed across both files |
| delete `refOrigin: 'platform-internal'` in the receipt helper | receipt case red | 1 failed (guard message) / 1 passed |

No mutation left the suite green, so the three tests test the production decisions rather than
the ability to pass an option.

## 7. Quality gates (same order as CI, run in this worktree)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (both `tsc -b` and the standalone web-ui `tsc --noEmit`) |
| `npm run lint` | 0 errors / 1003 warnings (the pre-existing warning count is unchanged) |
| `node scripts/architecture-guard.mjs` | pass — 34 hits all allowlisted, 27/27 invariants |
| `node scripts/security-guard.mjs` | ok |
| `npm run test` | 8883 passed / **1 failed**, `cli/test/commands-start-integration.test.ts` "auto-runs quickInit" 60s timeout — **pre-existing**: reproduces in isolation here (16/17 with the same failure) **and on the untouched base checkout at `76501788`** (same single failure). Two consecutive full runs agreed; an earlier run under heavy machine load showed 12 failures (all timeouts in attention/turn-delta suites), which did not reproduce serially. |
| `npm run test:web-ui` | see §7.1 |

### 7.1 web-ui

```
Test Files  124 passed | 1 skipped (125)
Tests       1548 passed | 3 skipped (1551)
```

Both skipped entries are pre-existing platform-conditional skips (no failures).

## 8. One decision recorded, nothing left pending

**`architecture-allowlist.json` gained one `session-identity` entry** for
`packages/org-manager/src/gateway-task-receipt.ts`. The rule fires on
`.enqueueToMailbox(` call sites in `core`/`org-manager` `src/` that have no session token in
their window, and its own remediation text is "if this is a genuine exemption, register it and
write the reason". The extracted function is the same call site that used to sit in
`api-server.ts` (already allowlisted with the same rationale); the entry is the migration of
that rationale, not a new silence. The alternative — keeping the call in `api-server.ts` and
importing that 16k-line module from a test — would have made the fixture depend on the whole
API server boot surface, which is precisely the "test can't call production" problem this card
exists to remove.
