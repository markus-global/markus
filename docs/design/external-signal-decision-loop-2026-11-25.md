# Unclaimed addresses: one decision per address, not one per signal

Date 2026-11-25 · CTO · v3 (first-principles rewrite; v1/v2 superseded, kept in git history)

Owner directive: *"没有建立路由的，应该进入决策循环，然后建立路由；下次就可以直接路由了；
如果还是路由不了，仍然进入决策循环。决策循环应该知道怎么处理外部事件或者消息，应该有对应的
系统提示词。"* — then: *"再从第一性原理好好想想。"*

## 0. What the evidence overturned

v1/v2 designed a "routing decision" path for **any external signal without a route**. Reading
the gate that already exists shows most of that state is unreachable through the product:

| Evidence | Fact |
|---|---|
| `org-manager/src/external-source-service.ts:159-165` | `registerSource` refuses unless the address is **actively bound to the caller** (`address_not_bound_to_you`). A source cannot be born without a route. |
| `storage/src/sqlite-storage.ts:6637-6650` (`revoke`) | Revoking an address writes `channel_bindings.revoked_at` and records a transition — it **does not touch `external_sources`**. A source can outlive its route. |
| Live DB, 2026-11-25 22:1x | The only enabled-source-without-binding row is the probe I inserted by direct SQL and then revoked. **I bypassed the single writer and manufactured the state the product forbids.** |
| `core/src/mailbox.ts:351-352` | `catch_all` is defined as «已归集到概览、**等人认领**», and the transition `catch_all → queued` already exists. The primitive is there; **no agent consumes it**. |
| `shared/src/mail.ts:262` `catchAllTargetOf(agentId)` | The catch-all bucket owner is already computed by the platform. The decision-maker needs no new configuration. |

**Two different problems were conflated:**

- **P1 — a registered source outliving its route.** Not a missing capability; a lifecycle hole
  at exactly one enforcement point (`revoke`). It deserves a structural fix, not a decision loop.
- **P2 — mail for an address nobody ever claimed.** No source row, no binding. Today it dies in
  catch-all. *This* is the capability the owner is asking for, and it is what L5 needs.

## 1. Contract

**R1 — a source cannot outlive its route.** `revoke` is the only place the invariant can break,
so it is the only place it is enforced: revoking an address disables the sources registered on
it, with a recorded reason. After this, «registered source, no route» is **structurally
inexpressible** — no decision loop, no marker, no prompt is needed for it.

**R2 — an unclaimed address is a decision, and catch-all is its inbox.** A signal whose address
resolves but has no active binding keeps today's `bounced → catch_all` path (the echo already
exists, `bounceTarget` already names the bucket owner). What changes is that a catch-all row is
**claimable by an agent**, using the transition that already exists (`catch_all → queued`), and
the claiming turn runs in the agent's existing decision loop (`loop_<agentId>`, `#464`).
No second channel, no second loop, no new session namespace.

**R3 — the unit of decision is the address.** The decision's work-unit ref is
`address:<address>` — an **entity** key, not a per-message key. Consequences that fall out for
free, with no counters and no coalescing rules:

- 20 RSS items arriving at one unclaimed address = **one** decision (idempotent `ensure`);
- the per-message identity of each signal is untouched (`external:<sourceId>:<messageId>`), so
  traceability is unchanged — the two keys answer different questions and stay separate;
- «decide once, route forever» is a property of the key, not a rule someone must remember.

**R4 — a decision is sticky; re-entry needs new evidence.** Once the address has a settled
decision work unit:

- claimed → an active binding exists → later signals route directly, no decision;
- declined → the work unit is terminal **with a reason** → later signals bounce carrying that
  reason (visible, never silent), and do **not** start a new turn;
- re-entry happens only when the decision is explicitly reopened (human action or superseding
  evidence) — never on a timer, never once per arriving message.

This is the owner's «如果还是路由不了，仍然进入决策循环» made bounded by construction rather than
by a retry cap.

**R5 — the prompt states authority and boundary.** One resident segment: an unclaimed address
is a decision you may take; claiming = `bind_address` to yourself; you may not claim an address
that belongs to another org; declining must leave a reason. Stable header, variable tail
(`unclaimed_pending: 0`) — the segment always renders, so the prompt prefix stays byte-identical.

## 2. What this deletes compared with v1/v2

| v1/v2 proposed | v3 |
|---|---|
| `envelope.routing.state` / `.disposition` | **Deleted.** «Is it routed» is derivable from the single resolver `findActive`; recording it on the envelope is a second writer of a derivable fact (§4.1 of the master plan forbids exactly this). |
| per-source session `external:<sourceId>` | **Deleted.** The existing `loop_<agentId>` is the decision loop; §2.7 closes the session id space at four. |
| coalescing rule + open-item counter per `(source, address)` | **Deleted.** The address-keyed work unit makes duplicates impossible by identity. |
| a new «routing decision item» kind | **Deleted.** `catch_all` already is that item; it only lacked an actor. |
| deciding who receives unclaimed mail | **Deleted.** `catchAllTargetOf` already answers it. |

Net: one cascade at `revoke`, one consumer for an existing state, one entity-keyed work unit,
one prompt segment. **Fewer mechanisms than the draft it replaces.**

## 3. Acceptance (red before green, each falsifiable)

1. **R1**: register a source on a bound address, revoke the address → the source is disabled with
   a reason. Remove the cascade → red.
2. **R2**: a signal to a resolvable-but-unclaimed address produces a catch-all row that an agent
   turn actually claims (`catch_all → queued`), and that turn runs in `loop_<agentId>`.
3. **R3**: 20 signals to the same unclaimed address create **exactly one** decision work unit
   (`address:<address>`), while all 20 keep their own per-message refs. Falsify by keying the
   decision on `messageId` → 20 work units → red.
4. **R4**: after a declined decision, the next signal bounces with the recorded reason and starts
   **no** turn; after a claimed decision, the next signal routes directly.
5. **R5**: the segment renders for agents with and without unclaimed mail; the stable prefix is
   byte-identical between the two renderings.
6. **Live probe** on a fresh build: real webhook → unclaimed address → decision turn →
   `bind_address` → second event routes directly. Readings written as «≥N + read time».

## 4. Non-goals

No schema change and no new table (owner ruling: 不迁移数据、不删表). In particular the deeper R1
smell — `external_sources.agent_id` and `channel_bindings.agent_id` are two writers of «who owns
this» — is **recorded, not fixed here**: removing the column is a migration and needs its own
ruling. No trust-ceiling change, no email/DNS work, no `main` merge without owner approval.
