# Streaming & Reattach

> Last updated: 2026-07

How Markus streams an agent turn to the browser over SSE, how a **client refresh or
navigation reattaches** to an in-flight generation without killing it, and how the agent
surfaces **structured lifecycle events** (including failures) to the client.

Related docs: [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) (the attention loop and interrupt/
preempt semantics that a stream must honor), [TOOL-SYSTEM.md](./TOOL-SYSTEM.md) (tool
progress and tool-result events), [STATE-MACHINES.md](./STATE-MACHINES.md) (mailbox-item
terminal states, including "completed without marker").

---

## 1. Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `SSEHandler` | [`org-manager/src/sse-handler.ts`](../packages/org-manager/src/sse-handler.ts) | Owns one HTTP SSE response; drives `agent.sendMessageStream`; buffers + persists |
| `SSEBuffer` | `org-manager/src/sse-*` | Batches writes, heartbeats the connection |
| `ActiveStreamRegistry` / `ActiveStreamSession` | [`org-manager/src/active-stream-registry.ts`](../packages/org-manager/src/active-stream-registry.ts) | Tracks in-flight generations for reattach; ring buffer + UI snapshot |
| `cancelToken` | in `SSEHandler` | `{ cancelled, userStopped }` — the single source of truth for stopping the agent |

---

## 2. Soft-Disconnect (refresh does not kill the agent)

When the SSE client disconnects (`SSEBuffer.onClose`) **before** completion:

1. `sseDisconnected = true`; partial output is persisted.
2. The agent is **not** cancelled — writers detach, the agent keeps running, and events
   keep accumulating in the `ActiveStreamSession` ring buffer.
3. A **force-stop grace timer** (`SSE_DISCONNECT_FORCE_STOP_MS`) starts. If the turn is
   still running when it fires and the user did not explicitly stop, the agent is
   force-stopped (`cancelToken.cancelled = userStopped = true`, stream cancelled).

Only an explicit user **Stop** or the grace-timer force-stop sets `cancelToken`. This is
the key difference from naive SSE agents, which abort the model the moment the socket drops.

---

## 3. Reattach

A generation is registered per `(agentId, sessionId)`. On reconnect the client calls the
reattach endpoint and `ActiveStreamSession.attach(res, afterSeq)` replays state:

1. Emit a `reattach` event (`streamId`, `lastSeq`, `status`, `hasSnapshot`).
2. If a **UI snapshot** exists and this is a full rebuild (`afterSeq <= 0`), emit a
   `snapshot` event (authoritative `content` + tool `segments` + `thinking`) — this is the
   correct prior UI even if the ring dropped early events.
3. Live-tail subsequent events; on terminal (`done` / `error`) end the response.

Finished streams are retained for `DONE_TTL_MS` (90s) so a late refresh still drains the
terminal event. Status probes treat `streaming | done(<TTL) | error(<TTL)` as attachable.

### 3.1 Ring buffer & the snapshot invariant

The ring is capped at `RING_CAP = 2500` events; older events are dropped. The UI snapshot
exists precisely so a reattach does not depend on the (lossy) ring.

- **Invariant**: after a reattach, the client's rendered state (text + tool cards) must be
  reconstructable from `snapshot` + post-snapshot tail alone — never from ring replay of
  early events (which may have been truncated).
- **Client contract**: a reattaching client **must** consume the `snapshot` event when
  `hasSnapshot` is true and treat it as authoritative, rather than replaying only ring
  deltas.
- **Testing** (`packages/org-manager/test/sse-buffer.test.ts` + registry tests): with a
  ring overflow, reattach still yields complete tool/text UI via snapshot.
- **Status**: implemented (snapshot); the client-contract assertion is the durable guard.

---

## 4. Structured Lifecycle Events

The stream currently emits: `session_start`, `reattach`, `snapshot`, `text_delta`,
tool progress events, and terminal `done` / `error`.

### 4.1 Spec: surface incomplete / tool failure (P0)

- **Behavior**: three currently near-silent conditions become **visible** structured
  events (and activity-log entries), without changing retry semantics:
  - completion-marker missing after in-session continuation → `incomplete`
    (see [STATE-MACHINES.md](./STATE-MACHINES.md) mailbox-item terminal states),
  - a tool returning a structured failure (`isToolErrorResult`) → `tool_error`,
  - a `MEMORY.md` write refused for exceeding limits → surfaced (see
    [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md)).
- **Invariants**:
  - Each condition is surfaced without being mistaken for success.
  - No **additional** retries are triggered by making these visible (visibility only).
- **Design rationale**: Hermes makes tool execution observable via callbacks; a failure or
  an unfinished turn should never look like success to the user.
- **Testing** (`packages/core/test/attention.test.ts` "A3:", `packages/core/test/tool-result.test.ts`
  "B1:", `packages/core/test/memory-store.test.ts` "B1:"): the incomplete event fires exactly
  once with no extra retry; tool-error and memory-refusal classification are covered.
- **Status**: implemented, surfaced across layers (visibility only, no new retries):
  - *incomplete* — `AttentionController.emitIncomplete` emits one `agent:incomplete` event on
    the agent bus (marker-missing / max-retries terminals); see
    [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) and [STATE-MACHINES.md](./STATE-MACHINES.md).
  - *tool failure* — the SSE handler marks the tool segment `status: 'error'` when
    `event.success === false` and persists `success:false`, so a failed tool never renders as
    a green result (`sse-handler.ts`).
  - *MEMORY.md refusal* — `addLongTermMemory` returns `{ ok:false, reason }` and the memory
    tools return a structured `{ status:'error', ok:false }` (recognized by
    `isToolErrorResult`), see [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md).
  - Remaining (roadmap): a *dedicated* SSE `incomplete` frame forwarded from the agent bus to
    the client (today the bus event + activity log carry it; the streamed reply is still
    delivered).

### 4.2 Spec: interruptible streaming (P1)

Streaming chat is human-facing and **non-preemptable by design** (a human is awaiting the
reply; see the `isPreemptable = scenario !== 'chat'` rule and `agent-loop.test.ts`). B3
narrows the gap without breaking that principle by distinguishing **revocation** from
**preemption** at the stream yield point:

- **Behavior**:
  - **Explicit cancel** (the attention judge decides the new message *revokes* the work —
    e.g. "stop / cancel that") → **abort the in-flight stream** via the `AbortController`
    already threaded through `llmRouter.chatStream` and **drop** the item (`[cancelled]`).
  - **Preempt** (a higher-priority item arrived, but the work is not revoked) → the interrupt
    signal is **restored** so the higher-priority item runs immediately *after* the current
    turn, rather than truncating the human's answer.
  - The backstop-timeout path (A1 `cancelProcessing` → `cancelActiveStream`) also aborts an
    in-flight stream, so a stuck stream is bounded.
- **Invariants**:
  - An explicit cancel aborts the in-flight model call promptly and drops the item.
  - A preempt never silently truncates a waiting human's reply; it is serviced next.
  - Cancel/abort reuses the shared token/`AbortController` infrastructure (no new mechanism).
- **Design rationale**: Hermes favors interruptible API calls; Markus keeps human chat
  responsive while still cutting work the user has explicitly revoked.
- **Testing** (`packages/core/test/agent-loop.test.ts`, `attention.test.ts`): the
  chat-non-preemptable mapping is retained; A1's `cancelProcessing` aborts the active stream.
- **Status**: implemented (yield-point `cancel` → abort + `[cancelled]`; `preempt` → restore;
  shared abort via `cancelActiveStream`).
