# Team Chat streaming bug: treating "transport ended" as "turn ended"

Date: 2026-10-08 · Branch: `feat/ui-optimize-1008` · Status: fixed

## 1. What the user saw

> The streaming bubble's **animated border disappeared**, yet the bubble's **content keeps updating**.
> That is very confusing.

> Even while you are working ... the bubble **is not streaming** on the front end. The state is wrong.

"Content is still arriving" and "the border is lit" are two separate predicates, and here they disagreed —
which is itself proof that one of them is wrong.

## 2. Root cause

### 2.1 In one sentence

**"The transport died" was read as "the turn is over."**

The server does **not** stop generating when the SSE connection drops
(`SSE_DISCONNECT_FORCE_STOP_MS = 45min`; on disconnect it logs
`SSE client disconnected — detaching (agent continues)`). But the client read loop, as soon as it stops
receiving data, lands the turn locally: `setSending(false)` + `clearStreamSession()` +
`finalizeLastStreamingBubble()`. So the client decides "this turn is finished" while the server keeps going.

### 2.2 One wrong inference, three downstream defects

| Downstream | Mechanism |
|---|---|
| Border disappears | `isStreaming` is cleared by the local landing, and `showStreamingBubble` requires it (`Team.tsx`) |
| In-flight bubble gets dropped | `ConversationBufferManager.mergeDbWithCache` keeps the in-flight tail only when `streamLive && isStreaming`, and `streamLive` comes from the **client-side ownership set** — already emptied on disconnect → the in-flight bubble is discarded as a "stale copy" |
| Ghost sweep backfires | `shouldSweepGhostStreaming` fired only when *all* local signals said "no stream" — and on disconnect they *all* go false → it executed a live turn as a ghost, irreversibly; that effect hung on `[messages]`, so it ran on **every delta**, and the border could never come back |

> Downstream ③ deserves its own note: `shouldSweepGhostStreaming` **had 9 tests and all of them passed**.
> Those cases had frozen the **wrong** invariant ("all local signals false ⇒ this bubble is a ghost").
> A green suite only bought false confidence.
> **Tests protect the definition that was written into the code, not the correct definition; when the
> definition is wrong, more tests are more dangerous.** The file was therefore not deleted but converted
> into an **incident regression guard** (the assertion direction is inverted: this input must **never** land).

### 2.3 The authority was right there, and was never consulted

The partial row the server persists on disconnect carries authoritative evidence:

```ts
const meta = { isStreaming: true, streamId: this.streamId };   // sse-handler, persistPartialOnDisconnect
```

The client even restores it (`ChatHelpers.dbMsgToChat`: `if (m.metadata?.isStreaming) base.isStreaming = true`).
So "this turn is still running" has three independent judges in the system:

1. the client per-session ownership set (`isStreamLiveForSession`)
2. a mutable boolean `isStreaming` on the message object
3. the server's `streamId` + active-stream registry (**the only truth**)

The decisions "should we drop the live bubble / clear the border" were made from 1 and 2 — both of which are
**copies derived from transport state that corrode the moment the transport drops**. Truth (3) was never asked.

This belongs to a family the codebase already knows (`R1 — one fact, many writers`;
`a derived "in progress" UI must be vetoable by the authority`), except that here the authority is not some
client-side set but **the server itself**.

### 2.4 Disconnects also keep appending content (hence "content keeps growing")

`persistPartialOnDisconnect` is called by `onClose` while `!isComplete` — so **every disconnect persists
another row and the text gets longer**. Any later DB load (navigation / tab switch / recovery / the
`!result` heal fallback) picks up a **longer** partial row. That is why the text updates while the border
does not. A refresh only "looked fixed" because a fresh page re-attached and re-lit `isStreaming` —
**until the next disconnect**.

### 2.5 The amplifier: reconnects replay from event 0

`api.sessions.reattachStream(..., afterSeq = 0)`, and every caller passes `0`; the wire events carry **no
`id:` line**, so the client cannot know which seq it has consumed and can only replay everything.
And every attach `abort()`s the previous SSE.

> **Accountability:** the "keeps aborting mid-stream" storm of 2026-10-08 20:10–20:12 was caused by my own
> previous revision — I **added triggers** to reconnection (a 10s heartbeat plus WS lifecycle signals)
> without adding a single-owner constraint for the SSE, i.e. under the banner of "fixing multiple writers"
> I **added a writer**. That revision is stashed (`wip: stream authority reconcile`) and is **not** in this branch.

## 3. Design: delete the mechanism, don't add a guard

**Core invariant:** `isStreaming` ("this turn is still running") **may only be changed by a server terminal
state, or by an explicit user stop. A transport ending is never a valid reason to change it.**

What this branch **did land**:

1. **One predicate, pure, testable**: new `lib/streamLiveness.ts#decideOnStreamEnd`, input
   `{ aborted, sawTerminal, serverStatus }`, output `finalize | reattach`. Everything transport-level
   (attach cooldown, socket close, watchdog) **has no entry point** in the predicate — this is not
   "a guard was added", it is "this class of bug cannot be expressed". **An unreachable authority (`null`)
   also yields `reattach`**: the two costs are asymmetric (one more reattach vs. the user seeing
   "half a reply + no border + content still growing").
2. **The ghost sweep mechanism is deleted outright**: `shouldSweepGhostStreaming` + the `Team.tsx`
   reconciliation effect. It existed **only because of the wrong inference in 2.1**; once that is fixed it
   is actively harmful (it was the only thing that could strip the border off a live stream).
3. **Cooldown is no longer a predicate**: `useChatStream`'s 1.5s attach-cooldown branch used to call
   `finalizeIfDetached()` — so "switched tabs twice within 1.5s" was read as "the turn ended". Cooldown is
   now **throttling**, responsible only for "don't connect this time".
4. **Error text no longer leaks into the model's prose**: `friendlyAgentError` used to be appended to
   `segments`, and the timeline renders text blocks with `MarkdownMessage` → a system annotation was
   rendered as ordinary model body copy (default colour, `⚠` intact). It now stays in `msg.text` only, and
   the bubble footer renders it as a **calm grey annotation** (`Ended early · ...`, no red, no warning colour).

**Deliberately not done (separate, independently revertible units)**:

- **Incremental reattach**: the server writes `id: <seq>` before each event, the client records `lastSeq`
  and sends it back on reattach, and `useSnapshot` is used only for a brand-new page with no seq (refresh).
  This changes the server's wire format — a different order of risk, so it is not mixed into this commit.
- **Single SSE owner**: at most one attach loop per conversation; probes/heartbeats **must not open their
  own attach**, only ask the owner to work.
- **DB merge predicate**: `mergeDbWithCache` should keep an in-flight tail based on "does this row carry a
  still-running `streamId`" instead of the client-side ownership set.
- **Shape of the persisted partial row**: it still masquerades as a completed message (the ambiguity remains
  in the DB; the front end can now recover via the authority).

## 4. Tests and verification

Red first, then green: the new predicate module first failed with "module not found"; after adding it:

| Item | Result |
|---|---|
| `src/lib/streamLiveness.test.ts` (predicate + normalisation, incl. the incident cell and reverse protection) | green |
| `npx vitest run --project web-ui` | **793/793 green (50 files)** |
| `tsc --noEmit` (web-ui) | 0 errors |

Real-world acceptance: during a long turn, hit `Cmd+R` → the border must stay lit throughout, and
"Completed / Continue / Retry" must not appear while the server is still running.

## 5. Known residuals

- **Half-open connections** (no FIN, no error) can still only be found by the watchdog; not solved at this layer.
- After 45 minutes the server force-stops → the client eventually receives an authoritative `done` and falls
  back to "completed", which is semantically correct.
- The **trigger** that rebuilt the renderer is still unknown (only the 19:04 instance was observed) — this fix
  is independent of the trigger; any trigger should now self-heal.

## 6. Rollback

The commit reverts as a whole. **No data migration.**

```
packages/web-ui/src/lib/streamLiveness.ts
packages/web-ui/src/lib/streamLiveness.test.ts
packages/web-ui/src/hooks/useChatStream.ts
packages/web-ui/src/pages/ChatHelpers.ts
packages/web-ui/src/pages/Team.tsx
packages/web-ui/src/pages/ChatComponents.tsx
packages/web-ui/src/locales/{en,es,zh-CN}/team.json
```
