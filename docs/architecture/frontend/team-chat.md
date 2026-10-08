# Team Chat Page — Feature Model, State Machine & Interaction Contracts

> Branch: `refactor/team-chat-state-machine` (based on main #308, 19 commits ahead)
> Goal: map out feature requirements → refactor state management → eliminate fragile assignments → fix all state conflicts/data issues
> Status: design document v1 (under review)

---

## 1. Current-state Health Check (one-sentence verdict)

The core page of Team chat, `pages/Team.tsx`, is a **5918-line monolithic component**: roughly **78 useStates, 82 destructured states, 106 useRef/useCallback sites**, the same "abort/cleanup" sequence copy-pasted 4+ times, and the same state (messages/sending/activities) duplicated in 4 places and kept in sync by hand — a direct expression of "an unreasonable state machine with fragile assignments everywhere".

A previous round already built the skeleton of a state machine (a plain class `ConversationBufferManager` + the hook `useConversationBuffers`), **but it was only partially adopted**: old and new state coexist in Team.tsx, synchronized by convention.

---

## 2. Feature Requirements Breakdown (what the Team chat page actually does)

### 2.1 Conversation model (four conversation shapes)

| Shape | convKey rule | Description |
|---|---|---|
| direct (1v1 agent) | agentId | Default shape, streaming replies |
| channel (group chat/channel) | `ch:<channel>` | Standalone channel, synced via REST |
| dm (direct message with a human member) | `dm:<userId>` | Same semantics as channel |
| session tabs | multiple sessions per agent | history pagination, title editing, model override |

### 2.2 User-visible feature list

**Conversation side**
- Switch conversations (direct agent / channel / dm / session tab)
- Paginated loading of conversation history (older messages), `hasMore` cursor
- Conversation title editing (session_rename)
- session-switch **loading state** (history exists but is not fully loaded → show loading instead of a blank new conversation)
- Multi-conversation stream isolation (switching to B while A is streaming: A's stream continues, B renders independently)

**Send/reply side**
- Sending text + images + @mentions
- Reply (replyTo) quoting
- Sending state (sending), input debounce/duplicate-submit prevention
- Conversation model override, agent-bound model

**Streaming side**
- SSE chunked rendering (text + thinking segments + tool timeline)
- Tool call in-progress/completed collapsing
- Abort (stop) / retry / resume
- Exponential-backoff polling recovery after an SSE disconnect
- Soft disconnect → reattach continuation

**State/awareness side**
- Sidebar agent "working" red dot/busy state (from the same source as the Chat top badge)
- Unread counts, new-message bubble, scroll following
- Thinking-agents hint bar

**Other**
- Notification cards / user-input approval dialogs
- Task linkage (linkedTaskId), global search
- Mobile responsiveness (L2 floating panel, back stack)

### 2.3 Backend interactions

- `api.agents.sendMessage` (REST + SSE stream)
- `api.sessions.*` (history pagination / getMessages / streamStatus / rename)
- `api.channels.sendMessage` (channel/dm go through REST with full responses)
- WS broadcast (agent:update / task:update / mailbox, etc.)

---

## 3. State-machine Health Check: Where the Fragile Assignments Are (list of defects)

### A. Copy-pasted abort/cleanup sequences (most severe)
The same teardown is repeated in at least 4 places:

```ts
resetSending(key);
actBuffers.delete(sessionId ?? key);
endStream(key);
if (sessionId) clearStreamSession(key, sessionId);
setSending(false);
setActivities([]);
```

It appears in: the stop handler (2652-2659), send duplicate-submit retry (2701-2717), send resend after abort in the same conversation (2722-2751), channel abort (2762-2765). **Omitting one step = a state leak**, and the subtle ordering differences between the sites make safe reuse impossible.

### B. Multiple state sources (4 copies of the same data)
`messages / sending / activities` exist simultaneously in:
1. The internal Map of `ConversationBufferManager`
2. The `setMessages/setSending/setActivities` of the `useConversationBuffers` hook
3. Team.tsx's own `useState` (e.g. `sending`, `activities`, `loadingChat`, `streamingVisual`)
4. `chatStore` (the global store in useChatStore.ts)

Manual synchronization across four places → **the direct source of state conflicts**.

### C. A mutable session id captured by a closure
```ts
let streamSessionId: string | null = ...; // rewritten at runtime by SSE events
```
During streaming, session ownership can change at any moment, and every `updateConvMsgs(..., streamSessionId)` depends on this mutable variable — once the stream is switched away/merged, the write target is wrong.

### D. Manual message-flag transformation
`isStopped / isError / isStreaming` and the tool segment's `running → stopped` are manually mapped in a dozen-plus places, with no unified "end-state convergence" function.

### E. Timers/visual state
`thinkingAgents` (120s timeout), `streamingVisual` (STREAMING_MIN_DISPLAY_MS), `streamingTimerRef` — all "temporary visual state" separated from the real stream state, and prone to going out of sync.

---

## 4. Target State Machine Design

### 4.1 Single source of truth
- **One state per convKey**, all converged into `ConversationBufferManager` (a plain class, unit-testable).
- The hook layer (`useConversationBuffers`) only acts as the "React bridge for the manager" — turning Map changes into render snapshots and **no longer holding an independent copy**.
- Team.tsx no longer creates its own `messages/sending/activities` useStates; it always reads the render state exposed by the hook.
- `chatStore` keeps only "cross-conversation" things (the streaming agent set, unread); per-conversation data does not enter the store.

### 4.2 Conversation lifecycle state machine (per conversation)
```
        ┌────────┐  select/load ┌─────────┐
        │  idle  │─────────────▶│ loading │
        └────────┘              └─────────┘
          ▲                         │ applyLoad / completeLoad
          │                         ▼
        reset                        ┌───────┐   send    ┌───────────┐
          ◀─────────────────────────│ ready │──────────▶│ streaming │
          │                         └───────┘           └───────────┘
          │                             ▲  done / stop / abort / reconnect recovery
          └─────────────────────────────┴──────────────┘
```
- Invariant: **while in the streaming state, DB load results only write to the cache and never overwrite the display buffer** (already implemented).
- New invariant: **any path leaving streaming must, and may only, pass through the single convergence point `completeStream(key, { stopped | done | error | detached })`**, which uniformly handles: endStream, clearStreamSession, resetSending, tool running→stopped, and message isStopped/isError marking.

### 4.3 Single entry point for abort/cleanup
Converge the group-A repeated sequence into a single method:

```ts
manager.abortStream(key, opts: { markStopped?: boolean; sessionId?: string })
```

Internally it guarantees idempotency: when already ready/idle it is a no-op; each sub-step checks its preconditions. All call sites (stop / duplicate-submit retry / same-conversation abort / channel abort / component unmount) call only this one method.

### 4.4 Streaming session ownership
`streamSessionId` is no longer a "mutable closure variable"; instead it becomes the **active streaming session** tracked per `convKey` inside the manager (`activeStreamSession.get(key)`); SSE `session_start` updates it through the single write point `manager.setStreamSession`, and all reads go through `manager.getActiveStreamSession(key)`. This inherently avoids defect C.

### 4.5 End-state convergence (D)
Provide `manager.finalizeAgentMessage(msg, outcome)` to uniformly handle isStopped/isError + tool segment convergence, replacing 12+ manual maps.

---

## 5. Migration Order and Acceptance Criteria

> Principle: **one rollback-safe commit per step; move to the next step only after typecheck + the relevant unit tests pass**; no "one-shot big-bang rewrite".

| Step | Content | Acceptance |
|---|---|---|
| S1 | Document + state-machine defect list | This file, typecheck passes |
| S2 | Land the single `abortStream` convergence entry point, replacing the 4 copy-pasted teardowns | ✅ `b0dd2c93`: stop/abort/resend/switch-conversation behavior unchanged, 5 idempotency unit tests |
| S3 | Converge streaming session ownership (defect C) | ✅ `682d0df7`: the duplicated formulas for `streamSessionId` and `effectiveSessionId` are merged; ownership remains the locally correct state of send() (needed to route to the right cache), and multi-conversation stream isolation behavior is unchanged |
| S4 | End-state convergence `finalizeAgentMessage` (defect D) | ✅ `9ecd655e`: 12+ manual isStopped/isError/tool transformations converged into 4 helper functions + 8 unit tests. **Follow-up completion** (after `d63f3c75`): the original done/error finishing paths did not pass through finalize, so `finalizeStreamEnd`/`finalizeLastStreamingBubble` fill in isStreaming convergence for direct-stream done/error/soft-disconnect + reattach abort (5 new unit tests) |
| S5 | Eliminate hidden dual sources (defects B/E), single responsibility for chatStore | ✅ `682d0df7`: chatStore deletes 8 dead state fields that were never read or written (226→110 lines), keeping only the streaming agent set + a version number; `messages/sending/activities` were already converged in the manager, and Team has no duplicate useStates |
| S6 | Converge visual state (defect E) | ✅ `50065608`: the `chatStreamActive` tail scan is extracted into the pure function `hasStreamingTail` (3 unit tests); the thinkingAgents lifecycle is self-consistent (WS event + 120s fallback) and needs no rework |
| S7 | Split the tab panel (conversation/stream rendering/approval/search) | ⬜ Not done: message rendering is already cohesive in ChatComponents/ExecutionTimeline, and Team.tsx is the orchestration layer; the split's benefit < its risk, so it is left for a later standalone PR |
| S8 | Migrate stream orchestration into the `useChatStream` hook | ✅ This round: `send` (~780 lines) / `stopSending` / `tryReattachActiveStream` (~390 lines) / `loadSessionMessages` are all moved out of Team.tsx; the logic passes typecheck + 239 unit tests + vite build all green |
| S9 | Fix concurrent cross-talk between multiple session tabs | ✅ `614f419f`: atomic reset of `resetConv(key, repinTo?)` + activeSession re-pin, eliminating the ordering bug "reset without re-pin → the old session's stream bleeds into the new buffer" (handleRememberConfirm pinned first and reset second — reversed order; a new tab conversation missed the pin). 2 regression unit tests added, 246 unit tests + build all green |

### S8 notes: the `useChatStream` migration
- **Ownership model**: Team.tsx still holds all application state; the hook only borrows it through `ctx` (a stable handle) + `ctx.stateRef.current` (mutable read-only state, refreshed on every render). The hook privately holds stream-specific refs (`abortControllerRef`/`reattachAbortRef`/`reattachCooldownRef`/`userStoppedSessionsRef`/`lastSendGuardRef`/`lastSseEventTimeRef`), because every write point for them is inside the functions being moved in.
- **Wiring**: `loadSessions` is moved up to avoid the TDZ; Team destructures `hookSend / stopSending / tryReattachActiveStream / loadSessionMessages` from the hook and wires them to `sendRef` and 5 UI event sites.
- **State issues converged** (resolved together this round): the streaming session id no longer depends on a mutable closure variable (a hook-local `streamSessionId`); end states uniformly go through `finalizeStreamEnd`/`finalizeAgentMessage`; the sidebar busy state goes through the chatStore idempotent Set (see S5); shared refs such as `thinkingTimeoutRef`/`sessionSwitchSeqRef`/`oldestMsgId` that span non-stream code stay in Team and are injected into ctx.

> **Known leftover (platform tool limitation)**: the file-edit tool's `old_string` cannot match text containing `<thinking>`/`</thinking>` tags (cleaned by the render layer), so the original `send`/`tryReattachActiveStream`/`stopSending` in Team.tsx were renamed to `*Legacy` and kept (not wired up, exempted via `void` references), so the diff stays reviewable and any anomaly stays rollback-safe. The hook is the only effective implementation. Cleaning up the legacy copies requires manual deletion in the IDE or a tool that can match the tags verbatim.

**UI/UX improvements (landed together with the refactor)**: while loading, show the conversation name as a subtitle (switching to a session with history no longer looks like an empty new one); the send key → stop key during streaming generation; an empty-state greeting; a back-to-latest button + new-message count; an IME composition guard; mention/slash dropdowns; multi-conversation streams that do not contaminate each other.

**Regression scope**: direct-streaming, channel/dm, session-tab switching, history pagination, stop/retry/resume, reconnect recovery, sidebar busy state, unread counts, mobile.

---

## 6. Relationship to Existing Commits

The branch already has 19 commits; on the web-ui side these have already resolved: a streaming refcount leak, sidebar "working" residue (single source of truth), conversation history pagination, the session-switch loading state, and multi-conversation stream isolation. S2-S7 of this design document are a **deep refactor** on top of that; they do not overturn the existing results, only converge the remaining old/new coexistence and copy-paste.

---

## 7. Interaction Reliability Contracts (`feat/ui-optimize-1008`, 2026-10)

Three user-reported failures in the Team Chat page — a **stalled tool approval**, a **notification that
landed nowhere**, and an **unreliable "jump to search result"** — turned out to be the same two
structural faults in different clothes:

- **R1 — one fact, several writers.** Two independent async writers could publish the same fact, and
  whichever finished last won. (Which session tab is active; where the viewport is; how much history a
  window still has.)
- **R2 — one invariant, several measures.** The same invariant was computed in more than one place, so
  the places could disagree — and one of them was cached past the point of being true. (`hasMore` read
  from a React render-time projection; "the target session finished loading" inferred from
  `!loadingChat`.)

Both are cured the same way: **delete the second writer / the second measure**, or move the fact into the
scope that actually owns it. The contracts below are the durable outcome; the round-by-round chase is
recorded in the commit message, and the invariants are pinned by unit tests in
`packages/web-ui/src/lib/*.test.ts` + `packages/web-ui/test/*.test.ts`.

### 7.1 The message scroll container has exactly two write paths

`pages/Team.tsx` drives a single scroll container, and it may only be written by:

1. **bottom-follow** while a stream is appending, and
2. **one pending scroll intent** for the view (`pendingRestoreRef`, keyed by the scroll-memory key).

There is deliberately **no third path**. In particular the virtualizer's `scrollToIndex` / `measure()`
are forbidden: `scrollToIndex` arms an uncancellable internal rAF reconcile loop (≤ 5 s) that re-pushes
the viewport every time the measured offset of that index changes — which is exactly while lazy row
measurement is still settling — and `measure()` resets every cached row height to an estimate, causing
overlap and drift.

**Intent priority** (`ScrollIntentPriority`; the single arbiter is `shouldAcceptRestoreIntent`):

| priority | intent | meaning |
|---|---|---|
| 3 | `jump` | the user explicitly asked to see this message |
| 2 | `prepend` | pagination layout compensation (scrolled to top → older page inserted above) |
| 1 | `restore` | "bring me back to where I was" |

A later intent replaces an in-flight one **only if its priority is ≥** (equal ⇒ later wins) and only for
the same view. Consequence: an unsatisfied `jump` is never overridden by a `prepend` / `restore`.

**Viewport ownership** (`mayChangeViewportOwner`): only `jump` / `restore` may change who owns the
viewport. `prepend` moves pixels and nothing else — a pure layout compensation must not hand control
back to bottom-follow. `decideScrollFollow` takes `intentPending` so a pending intent also blocks
hand-back while the jump is still travelling.

**Release condition** (`anchorStability` + `planIntentPass`): an intent is released by **stability, not
by a timer**. "Rendered in the DOM" is not "at rest" — with estimated row heights, the first measurement
pass pushes the target away. `planIntentPass` therefore returns `refine` (correct now, keep retrying)
until the anchor is measured at its target position in **two consecutive passes**. While unsettled,
`RESTORE_INTENT_TTL_MS` (10 s) is not a release reason, and a `jump` / `prepend` is never downgraded to
"scroll to bottom". `GOTO_ROW_INSET` (12 px) parks the hit just below the viewport top so its trailing
context stays visible.

### 7.2 Window bounds are per-buffer, owned by the buffer manager

`{ hasMore, oldestCursor }` used to live in **two globals** on `Team.tsx` while message content lived in
`ConversationBufferManager`, keyed per `bufferId`. Any session's load then overwrote the current view's
bounds → the loader read another session's `hasMore=false` / `oldestCursor=null`, spanned zero pages, and
a `jump` concluded "target not found → go to bottom". This is why it worked the first time (empty
buffer → the guarded path) and broke from the second visit onward.

Contract: bounds live **next to the messages they describe** — `windowBounds: bufferId → { hasMore,
oldestCursor }` inside the manager, same key, same storage, same lifetime (reset on eviction). The single
writer is the loader for **that** buffer. `loadMore()`'s return value is the only progress signal, and
`hasMore` is never re-derived from a render-time value.

### 7.3 "Jump to message" is self-fetching and never shares the pagination channel

`loadMore()` returns `0` for three unrelated reasons — end of history, page dropped because the view
changed mid-flight, or "I joined someone else's in-flight request". A caller cannot tell them apart, so
`jumpToMessage` does **not** use that channel:

- `collectJumpWindow` — if the target is already in the buffer, **no fetch at all** (the fast path; this
  is why same-session jumps always worked). Otherwise it pages from newest backwards until the target is
  found, the target's own timestamp (`targetCreatedAt`) is passed, or the page cap (40) is hit.
- The collected ascending window plus its bounds are installed **in one write**; the scroll intent then
  positions the view.
- `trimJumpWindow` — when the display cap trims, the target must survive (the cap keeps the newest, and
  deep-history targets sit at the oldest end).
- Anchor resolution is **by row identity, not index** (`resolveRowAnchor`): the rendered list is a
  projection of the buffer (activity-log rows and acknowledged notifications are filtered out), so a
  buffer index does not address a rendered row.

### 7.4 Session selection has one owner while a navigation is in flight

`navigationOwnsSessionChoice` — while a navigation intent is pending, the agent-switch effect must **not**
pick a session tab and must **not** schedule its own scroll restore. Otherwise two async writers race for
"which tab is active" (the late one wins → "it flashes the right message, then moves"), and a spurious
background load for the previously-viewed session can write bounds that the jump then reads.
`await switchSession()` resolves *after* messages are loaded, so callers must never infer "loaded" from
`!loadingChat`.

### 7.5 Blocking approvals and notifications get a near-field entry point

Focus arbitration: **tool approval (it blocks the agent turn) > user input > notification.** One arbiter,
one modal at a time.

- **Tool approvals** (`hitlService.requestApprovalAndWait` suspends the whole agent turn) now get the same
  treatment as `request_user_input`: an **amber banner above the composer** plus an auto-opened
  `ToolApprovalModal`. Selection uses `details.toolName` — the marker unique to tool approvals — which
  naturally excludes task/requirement structured approvals from the chat surface. The banner is scoped to
  `activeSessionId` via `details.sessionId`, falling back to `agentId` for rows written before that field
  existed. Auto-open happens once per approval, and only while the Team page is active on the chat tab.
- **Notifications**: clicking an agent in the roster (L1) opens **one review queue modal** — progress
  `1 / N`, button "Next" → "Done" on the last — rather than N stacked modals. Closing it still performs
  the landing. Only unread notifications auto-pop, and only on an explicit roster click (live arrivals
  still go to the banner). Landing (`resolveReviewLanding`) prefers the session the notifications came
  from and locates the earliest one, falling back to the main session only when they span sessions. The
  notification's own time is shown via the single `lib/timeAgo.ts` implementation shared with the bell.

### 7.6 Diagnostics

`lib/scrollDebug.ts` is an **opt-in, zero-overhead-when-off** trace for the intent path. Enable it once
in DevTools with `localStorage.setItem('markus.scrollDebug', '1')` (remove the key to disable). It prints
about ten decisions per jump (`jump:collected` / `jump:located` / `intent:apply` / `intent:refine` /
`intent:release-*`). This link is only truly observable in a live Electron window; the switch exists so
the next report can be diagnosed from evidence instead of inference.

### 7.7 Known residuals

- Cross-agent jumps where the target session is not on the first page of that agent's session list still
  switch by id; the left-hand tab title renders empty until refresh.
- Very deep targets need several sequential page fetches, so there is a brief wait between click and
  landing (the viewport is pinned meanwhile — it does not bounce).
- A target that genuinely does not exist (deleted, or beyond the page cap) falls back to bottom with a
  `console.warn` — an honest fallback, not a silent wrong jump.
