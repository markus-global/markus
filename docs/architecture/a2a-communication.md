# Agent-to-Agent Communication (A2A)

> Extracted **2026-11-15** from [`mailbox-system.md`](./mailbox-system.md) §11. The chapter was
> moved verbatim — no invariant, table, spec or code path was dropped — and its section numbers
> (§11.1 … §11.5) are kept unchanged so existing cross-references stay unambiguous.

**Scope of this file** — how one agent reaches another: DM/group channels, the
one-message-one-delivery-fact invariant, the reply sink, the entry-point inventory, tools &
transport, async-only correlation, and the two mechanisms that historically lived inside this
chapter (`PendingCallbackRegistry` §11.3, heartbeat integration §11.4). The **queue** that
carries these items — `enqueue` / `dequeueAsync`, priorities, enqueue-time dedup, attention
controller, leasing/retry, persistence, addresses/envelopes — stays in
[`mailbox-system.md`](./mailbox-system.md). A2A is a *producer* of `a2a_message` mailbox items;
the mailbox is the **only** delivery mechanism (§11.1.1 point 1).

Related: [mailbox-system.md](./mailbox-system.md) (queue, priority, attention, dedup) ·
[notification-delivery.md](./notification-delivery.md) (user & IM notification delivery) ·
[concurrent-processing.md](./concurrent-processing.md) (worker-pool / per-entity locking) ·
[state-machines.md](./state-machines.md) (delegation FSM).

---

## 11. Agent-to-Agent Communication (A2A via Mailbox)

Inter-agent messaging is fully consolidated into the Mailbox system. The legacy `A2ABus` class has been retired — it added a redundant routing layer when the mailbox already provides serialised attention handling.

### 11.1 A2A DM Channels

A2A messages now route through **deterministic DM channels** that reuse the group-chat infrastructure for persistence, WebSocket delivery, and mailbox enqueue:

```
Channel key: dm:a2a:{sorted_id_1}:{sorted_id_2}
             (agent IDs sorted lexicographically — one channel per pair)
```

```
Agent A                              Agent B
────────                             ────────
tool: agent_send_message ──►  AgentManager.sendMessage()
                                     │
                                     ▼
                               ensureDmChannel(dm:a2a:...)
                                     │
                                     ▼
                               sendGroupMessage(channelKey, ...)
                               ├─ persist to channel_messages
                               ├─ WebSocket broadcast
                               └─ enqueueToMailbox('a2a_message', { extra: { channelKey } })
                                     │
                                     ▼
                               AttentionController picks it up
                               (stable session: channel_{channelKey}_{agentId})
```

Benefits over ephemeral session IDs:

- **Persistent history** — both agents recall past exchanges via `recall_context` with `scope: "channel"` and `channel_key`. Personal user↔agent DM **chat sessions** (`chat_sessions` table) use `recall_context` with `scope: "chat_session"` and `session_id` (pagination via `before` / `limit`) — see [learning-loop.md](./learning-loop.md) §9.3.
- **Stable sessions** — all messages in a pair share one session ID derived from the channel key
- **Enqueue-time dedup** — messages from the same `channelKey` coalesce ([`mailbox-system.md`](./mailbox-system.md) §14)
- **Group chat parity** — DM channels use the same `groupChatRepo`, member resolution, and API paths as custom group chats

When `groupChatHandlers` are not wired (e.g., unit tests), A2A falls back to direct `sendMessage()` with `sourceType: 'a2a_message'` and the same `channelKey` in `extra`.

### 11.1.1 Delivery invariant — one message, one delivery fact

> **Normative.** This section is the contract; the code must not have a second way
> to reach another agent. It replaces the previous, unwritten arrangement in which
> some paths persisted + woke the peer directly and others enqueued (see [`mailbox-system.md`](./mailbox-system.md) §14.5).

1. **Exactly one delivery mechanism.** Every inter-agent message — DM
   (`dm:a2a:*`), group/team channel, `@mention`, review/comment notification — MUST
   reach the recipient as a mailbox item:
   `enqueueToMailbox('a2a_message', { extra: { channelKey } })`.
   `channel_messages` is a **projection** (UI history + the context slice the
   recipient reads when it processes the item). It is **not** a delivery channel:
   persisting a row has never delivered anything and must never be reported as if
   it had.

2. **No half-state.** Either a pending mailbox item exists for the recipient
   (possibly merged with siblings, [`mailbox-system.md`](./mailbox-system.md) §14) or the message was never sent. The state
   `delivered-but-not-awake` is forbidden — it is invisible to the sender and to
   the UI, and it was the direct cause of the 2026-10-25 repeat-notification
   incident.

3. **Reply generation is not delivery.** `processGroupChatReply` exists to produce
   a reply for an item the peer is **already** processing. It MUST NOT be used to
   hand a new message to a peer; that is the mailbox's job.

4. **Storm control is causal, never temporal.**
   - *Chain*: `chainId` propagates trace-style. When an item is processed its
     `extra.chainId` becomes the turn's current chain (per-worker
     `SessionWorkspace.chainId`, so concurrent workers never share one); anything
     the turn sends inherits it, and `sendGroupMessage` hands the parent to
     `deliver()` with `depth + 1`. A fresh id is minted only when a delivery truly
     starts a conversation. The context is cleared in the processing `finally` so
     it cannot leak into the next turn.

     > **Failure mode worth remembering**: this shipped once and did nothing,
     > because the send logic existed **twice** in `AgentManager` — two
     > near-identical `sendMessage` closures in different tool-context factories —
     > and only one forwarded the chain. The A2A tools received the other one, so
     > every delivery still minted a fresh id while the code read correctly. Both
     > copies are now deleted in favour of one private `deliverA2AMessage()`.
     > Reading either copy alone could not have revealed it: only the pair did.
   - *Coalescing*: messages on the same `channelKey` merge into **one** mailbox
     item at enqueue time ([`mailbox-system.md`](./mailbox-system.md) §14), with the full text preserved in the channel.
   - Wall-clock throttles MUST NOT drop a wake. `a2aCooldowns` (per-channel 30 s)
     and `wakeBudget` (global per-agent quota) were removed for exactly this
     reason — both could answer "sent" for a message the peer never received.

5. **The sender is told the truth.** `agent_send_message` returns
   `{ deliveryState: 'queued' | 'coalesced', deliveryId, peerPendingItems,
   coalescedCount }`. `coalesced` means "your message is part of the item the peer
   will process next" — it is a delivery outcome, not a silent drop.

6. **One place decides.** `AgentDelivery.deliver()` is the only caller of the
   mailbox enqueue for inter-agent traffic. Any new feature that wants to reach
   another agent calls it; it must not re-implement "persist + wake".

### 11.1.2 Reply sink — one writer for "an agent said something in a channel"

A2A has two facts, and each needs exactly one writer:

| Fact | Writer | Never |
|---|---|---|
| "A message is addressed to agent X" | `AgentDelivery.deliver()` → `mailbox.enqueue('a2a_message')` | never a direct `getAgent(...).handleMessage(...)` |
| "Agent Y produced a reply in channel C" | `AgentDelivery.postReply()` — persists to `channel_messages`, broadcasts, and **does not** auto-trigger anyone | never a second persist/broadcast path |

`processGroupChatReply` used to be **both** — it woke the peer *and* wrote the
reply — which is why an A2A message had two possible lifecycles depending on which
branch produced it. Under this contract it has no role: the mailbox item wakes the
agent (with its own lease/retry/merge semantics), and the reply returns through
`responsePromise` to the single sink.

**No automatic reply chain.** A reply never triggers the peer. If the other side
has something to add it must call `agent_send_message` — a deliberate act. This
removes the class of incident in which two agents re-replied for 43 turns /
35 minutes after a single proactive message.

### 11.1.3 Replies are a decision, never a chain

The platform does not decide that an agent should answer. It delivers the message
and the agent decides:

* **Perception is automatic, response is optional.** A delivered message wakes the
  agent (mailbox semantics); whether it says anything back is its own call. Ending
  a turn without replying (`end_turn`) is a legitimate, expected outcome — for
  human messages too.
* **No automatic reply chain.** A reply never triggers the peer. If the
  conversation should continue, the replying agent calls `agent_send_message`
  itself — a deliberate act with its own cost. There is therefore no "reflection"
  to bound: without a chain, `DM_MAX_DEPTH`, per-round `respondedAgents`,
  `shouldChainDmReply`'s regex, the 30 s `a2aCooldowns` and `wakeBudget` have **no
  subject matter left**. They existed only to bound a chain the platform itself
  was creating.
* **`chainId` is correlation, not a guard.** It is inherited from the inbound item
  (§11.1.1 point 4), so a request and the answer it provokes share one id; it is
  never used to throttle or to drop.
* **Nothing is lost when someone stays silent.** The message is in the channel and
  in the recipient's mailbox history; silence is observable, not a delivery failure.

Rationale (learned the hard way, 2026-10): every storm guard we ever added was a
consequence of the platform auto-replying on the agent's behalf. Removing the
auto-reply removes the storm; keeping it forced us to invent judges (wall clock,
quota, regex) that had to guess "does this reply need an answer?" — and when they
guessed wrong they discarded the wake while still reporting success.

### 11.1.4 Entry-point inventory (nothing may bypass the delivery service)

| Entry | Path | Notes |
|---|---|---|
| `agent_send_message` (DM) | `AgentDelivery.deliver` | one item per `channelKey`, mergeable |
| group chat, no @mention | `AgentDelivery.deliver` (`throttled` when a chain is hot) | awareness, not a reply request |
| group chat, @mention | `AgentDelivery.deliver` with `mentions` + `chainId` | the chain decision happens **after** delivery |
| `agent_delegate_task` | delegation manager → `deliver` | protocol on top of the same transport |
| review / comment / requirement notifications | `task-service` mailbox items | their own item types, not A2A; they must not invent a second wake path |

**Addressedness** (who is this message for): a message aimed at a specific agent —
a DM, or a group message where the agent was `@mentioned` — is delivered with a
one-line `[MENTIONED] This message is addressed to you …` prefix so the recipient
knows it is the target. Open/broadcast messages carry no marker. Single writer:
`DeliveryRequest.addressedTargetIds` (a list of the target ids that are actually
addressed) in `AgentDelivery.deliver()`; callers must not construct the marker
themselves.

The prefix also carries the **count**: `… Others also addressed: N.` Knowing that
nobody else was addressed ("this is yours to handle") is a different action from
knowing two others were ("whoever picks it up first"). The count is emitted
always, including `0`, for two reasons:

- **One template, one stable prefix.** The marker line is a prompt prefix shared by
every a2a message. Two shapes (with/without the clause) would fork that prefix and
degrade prompt-cache hits; a fixed template with only the trailing number varying
keeps the common prefix intact. Put variable content at the **end** of a stable
template, never by making the template conditional.
- **It is the decision-relevant part, and only that.** Names are deliberately not
included: the list would grow the line without bound and would expose unrelated
agents' identities to a third party. A count answers "must I act" without leaking.

It is an id list, deliberately, not a boolean. One group message can address two
of ten members: with a boolean a caller can only mark the whole batch (bystanders
think they were singled out) or none of it (the mentioned agent never learns it
was the target). With a list the ambiguous state is not expressible — which is
the point.

**Origin** (who sent it): `DeliveryRequest.origin` — `[FROM HUMAN] <name> … humans can
see this channel` versus `[FROM AGENT] … no human is waiting on this`. Produced
only in `deliver()`, like the addressedness marker. It is load-bearing: a human
group message delivered as a bare `a2a_message` would be read under the a2a prompt
section ("humans do NOT see this conversation"), so the agent misjudges the context
and answers the wrong audience.

**Machine-checkable**: `enqueueToMailbox('a2a_message'` may appear only inside
`agent-delivery.ts`; a direct `handleMessage`/`processGroupChatReply` used to hand a
message to another agent is a regression.

### 11.2 Tools & Transport

- **`agent_send_message`**: Always asynchronous — returns immediately with `conversation_id` and `channel_key`. Messages are tagged `[conversation:...]` for multi-turn correlation.
- **`agent_delegate_task`**: Uses `DelegationManager` for protocol orchestration; transport goes through the DM channel path above.
- **`agent_broadcast_status`**: Lightweight path — writes to target agent's daily log without an LLM call. Does not use DM channels.
- **`agent_send_group_message`**: Team/custom group channels (`group:<teamId>`, `group:custom:<id>`). @mentions control which peer agents receive `a2a_message` mailbox items.

The `@markus/a2a` package retains `DelegationManager` and protocol types. `A2ABus` is exported with a `@deprecated` annotation for backward compatibility only.

### 11.3 PendingCallbackRegistry

`PendingCallbackRegistry` (`packages/core/src/pending-callback.ts`) tracks async operations that must report results back through the mailbox rather than injecting directly into an active session.

```typescript
type CallbackType = 'background_exec' | 'wakeup' | 'a2a_reply';
type CallbackDelivery = 'in_session' | 'mailbox';

interface PendingCallback {
  id: string;                    // Unique callback ID (e.g., background session ID, a2a_<conversation_id>)
  agentId: string;               // Originating agent
  originSessionId: string;       // Session to resume on completion (in_session mode)
  type: CallbackType;            // Operation type
  deliveryMode?: CallbackDelivery; // in_session (default) → callback_result; mailbox → system_event
  command?: string;              // Optional context (shell command, etc.)
  note?: string;                 // Free-text label (wakeup reason, delegation goal)
  correlationId?: string;        // Correlates an external event (conversation_id)
  wakeAt?: number;               // Scheduled wakeups: epoch ms when due
  recurringMs?: number;          // Recurring wakeups: re-arm interval
  registeredAt: number;          // Epoch ms
  timeoutMs: number;             // 10 min for background_exec; 30 min for a2a_reply; effectively ∞ for wakeup
}
```

**Lifecycle:**

1. **Register** — An async operation is registered as a `PendingCallback` and persisted via `SqlitePendingCallbackRepo`:
   - `background_exec` → `registerBackgroundSession()` (called from `Agent.executeTool` on the tool result).
   - `agent_send_message` with `reply_in_session` (alias `await_in_session`) → an `a2a_reply` callback keyed by `conversation_id`.
   - `schedule_wakeup` → a `wakeup` callback with `wakeAt` (+ optional `recurringMs`).
2. **Complete / fire** — On completion (`background_exec`, `a2a_reply`) or when a wakeup is due, the entry is resolved and delivered via the shared `Agent.deliverCallback()` helper: `in_session` → `callback_result` (bound to `originSessionId`); `mailbox` → `system_event`. Recurring wakeups re-arm.
3. **Timeout** — Heartbeat calls `getTimedOut()` to find expired callbacks, then `expireTimedOut(id)` removes each from the registry. Timed-out operations are surfaced in the heartbeat prompt (§11.4) for agent investigation — they do not silently disappear. (Wakeups use an effectively infinite timeout and are never flagged.)

**Wakeup scheduler:** each agent runs a coarse (~1-minute) sweep (`Agent.sweepDueWakeups`) that fires any `wakeup` callbacks whose `wakeAt` has passed. This lets an agent register precise time-based follow-ups (`schedule_wakeup`) and stay idle in between, rather than relying on the periodic heartbeat.

**Heartbeat as coarse safety-net:** the periodic heartbeat is a fallback patrol (`DEFAULT_HEARTBEAT_INTERVAL_MS`, 6h), not the primary timing mechanism — `schedule_wakeup` is. The interval is configurable live by the user (Heartbeat tab / `PATCH /api/agents/:id/config`) and by the agent itself via the `set_heartbeat_interval` tool (clamped 5min–24h). Both paths go through `Agent.setHeartbeatInterval()`, which restarts the scheduler immediately; agent-initiated changes persist via the `agent:heartbeat-interval-changed` event → `agentRepo.updateConfig`.

The registry is a process singleton (`pendingCallbackRegistry`), restored from SQLite on startup so callbacks survive server restarts.

### 11.4 Heartbeat Integration

Periodic heartbeat items (`priority: 3 — low`) drive proactive agent patrol. Beyond the standard checklist, heartbeat now integrates:

**Active goals review** — When `goalFetcher` is wired (from org-manager requirement service), the heartbeat prompt includes an **Active Goals** section listing each goal's title, status, iteration count (`currentIteration` / `maxIterations`), and completion criteria. The agent is instructed to:

1. Check linked tasks for progress
2. Create follow-up tasks if needed
3. Mark requirements complete when criteria are met
4. Escalate or adjust approach if stuck

**Callback timeout handling** — Before building the heartbeat prompt, `handleHeartbeat()` calls `pendingCallbackRegistry.getTimedOut()`. For each expired callback:

1. `expireTimedOut(id)` removes it from the registry (and persistence)
2. Details are injected into the heartbeat prompt under **Timed-Out Async Operations** (background exec or an awaited A2A delegation whose reply never arrived)
3. The agent investigates and takes corrective action during the heartbeat LLM session

This ensures orphaned async operations are surfaced even when the completion handler never fires (process crash, hung command, etc.).

Background process completions that *do* finish normally are still routed as separate `callback_result` mailbox items (priority 1) — the heartbeat section only handles the timeout case.

### 11.5 Async-Only A2A (Deadlock Prevention)

The `wait_for_reply=true` parameter is **deprecated and ignored**. All A2A messaging is non-blocking. This eliminates deadlocks that occurred when two agents simultaneously awaited each other's reply.

**Correlation pattern**: Each message carries a `conversation_id` (auto-generated UUID). Agents record pending questions in working memory and recognize replies by the `[conversation:...]` tag prepended to the message content. Multi-turn exchanges use the same `conversation_id` for context continuity.

---

## Where the mailbox side lives

| Question | Document |
|---|---|
| Which item types exist, and their default priorities | [`mailbox-system.md`](./mailbox-system.md) §3 |
| How items are claimed, leased, yielded and retried | [`mailbox-system.md`](./mailbox-system.md) §4, §17, §18 |
| Enqueue API, merge/dedup at enqueue time (referenced by §11.1.1) | [`mailbox-system.md`](./mailbox-system.md) §5, §14 |
| Persistence (`mailbox_items`, `channel_messages`) | [`mailbox-system.md`](./mailbox-system.md) §6 |
| Addresses, envelopes and bounces (`refOrigin`, delivery facts) | [`mailbox-system.md`](./mailbox-system.md) §28 |
| User / IM notification delivery | [`notification-delivery.md`](./notification-delivery.md) |
