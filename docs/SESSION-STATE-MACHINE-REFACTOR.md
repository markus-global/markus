# Session Lifecycle & Turn Completion

> Status: implemented and verified.
> Branch: `refactor/session-state-machine` (stacked on #359; PR #359 untouched).
> Related: [STATE-OWNERSHIP.md](./STATE-OWNERSHIP.md) · [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) · [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md)

---

## 1. Motivation

The platform answers two questions in several independent places, and those answers can disagree:

- **Is this session busy?** — today it is inferred from worker state, DB item status, an in-flight stream registry, and client-local flags.
- **Is this turn finished?** — today it is inferred from a provider finish reason, an `end_turn` tool flag, an iteration limit, and an in-prompt nudge.

When nothing owns these answers, the parts drift apart: the UI can show an agent as idle while a session is still running; a stream that ends without a finish reason is indistinguishable from a model that finished cleanly; and a callback result can land in an unrelated session.

This document describes a single, backend-authoritative model for both questions.

---

## 2. Design

### 2.1 Core invariants

1. **The unit of work is a turn; a turn belongs to exactly one session.** Sessions have stable keys: `cs_*` (Team Chat), `task_{id}_r{n}`, `a2a_{conversationId}`, `channel_{key}`, a stable per-agent `system` session, and — for callbacks — the session that originated them.
2. **A session has a state machine, owned by the backend:**
   ```
   messageCreated(session)        end_turn / clean finish / cancel
   idle ────────────────────► processing ─────────────────────────► idle
                                │
                                ├── hard bound exceeded ──► error (visible, not silent)
                                └── user cancel ─────────► cancelled
   ```
   - Entering `processing` happens when the message is **enqueued**, not when a worker picks it up.
   - Leaving `processing` happens only on an explicit `end_turn`, a cancellation, or a hard bound.
   - A fault (upstream error, dropped stream, unknown finish reason) **does not change the state**: the session stays `processing` and the same turn continues, **bounded**.
3. **An agent is "working" when any of its sessions is processing** — the union of session states, derived from the registry.
4. **Every mailbox item carries a subject** that determines which session it runs in.

### 2.2 Turn completion

Completion is decided by a **typed terminal event** rather than a mix of conditions:

```
reason ∈ { end_turn tool, clean finish, cancelled, bound exceeded }
```

- "Clean finish" means a **genuine** finish reason, a complete stream, and no pending tool calls. It is semantically equivalent to an explicit `end_turn`, without forcing the model to emit an extra tool call on every reply.
- Any fault or unknown condition produces **no** clean finish: the turn stays open and continues.

### 2.3 Mailbox subject binding

`MailboxItem.subject` is a first-class, persisted field, written by the producer at creation time. Entity keys are derived from the subject alone. A callback result returns to the session that created it; a missing origin is an explicit error rather than a silent fallback. System-originated turns use a stable per-agent session instead of a fresh `sys_{id}_{ts}` key.

### 2.4 Status exposure and frontend sync

The backend exposes the authoritative per-session state for an agent. The frontend uses it to **override** an optimistic local "idle" — never the other way round — so the displayed status converges to the backend after a refresh, reconnect, or restart.

### 2.5 Untouched by design

The task auto-continue / submit-review flow is intentionally not modified. Tasks connect to the new state machine only at the `executeTask` boundary.

---

## 3. What changed

| Area | Module | Change |
|---|---|---|
| Session state machine | `packages/core/src/session-state.ts` *(new)* | `SessionStateRegistry`: single writer for session processing state; bounded continuation; derived per-agent status |
| Turn completion | `packages/core/src/llm/provider-helpers.ts` + providers | Unrecognised/missing finish reason maps to `incomplete` (was silently `end_turn`); `turnContinuationKind` unifies the continuation decision |
| Agent loop | `packages/core/src/agent.ts` | Session begin/settle at turn boundaries; fixed settle-order contract (settle → persist → resolve) |
| Mailbox | `shared/types/mailbox.ts`, `core/mailbox.ts`, `storage/sqlite-storage.ts` | First-class `subject`; single derivation point; additive DB column |
| Reply persistence | `packages/core/src/recovered-reply-persist.ts` | One decision point for "can this turn's reply reach a user conversation"; control-signal and source-type guards |
| API / SSE | `packages/org-manager/src/api-server.ts` | Authoritative `isProcessing` on `/api/agents`; out-of-band agent reply broadcast |
| Frontend | `packages/web-ui/src/**` | `resolveAgentStatus` override; background-task badge; per-session status |

---

## 4. Verification

| Item | Result |
|---|---|
| Full suite — core + storage + web-ui + shared | **320 files · 4378 passed · 0 failed** (10 skipped) |
| `agent-concurrent-cancel-isolation` (repeated) | 4/4 stable |
| `tsc -b` — core / storage / org-manager / web-ui / cli | clean |
| Guard checks (temporarily remove a guard → the new test turns red) | verified per phase |

Each phase was written test-first: the failing test was observed **before** the change, and again after.

**Delivered in phases** (each an independently revertible commit; squashed for review):

1. `SessionStateRegistry` — backend authority for session state.
2. Honest turn completion — `incomplete` for unrecognised/missing finish reasons; bounded continuation.
3. Truncation visibility — reaching the iteration bound settles the turn as `error`, not as success.
4. Mailbox `subject` — first-class subject; callbacks return to their originating session.
5. Authoritative per-session status exposed to the client, and used as the source of truth.
6. Callback replies surfaced in Team Chat with a provenance badge; a single persistence execution point.

---

## 5. Database compatibility

The only schema change is **additive**:

- `mailbox_items.subject TEXT` (JSON), added through the repository's guarded migration pattern (`PRAGMA table_info` guard + `ALTER TABLE ADD COLUMN`).
- Old rows have `subject = NULL`; readers **fall back to the previous derivation**. No backfill, no destructive change, no data rewrite.
- Everything else is in-memory: the session registry is rebuilt from `mailbox_items` at startup, and the reply-persistence lookup is a **read-only** `json_extract` query.

Migration can be rolled back in place.

---

## 6. Rollback

- A single revert commit restores the previous behaviour.
- The additive column is invisible to older code, so a rollback needs no schema change.

---

## 7. Known limitations and follow-ups

1. **No automatic whole-turn retry.** If a stream is persistently truncated, the turn ends with partial content and is marked `error` (visible). Automatic retry belongs to the task mechanism and is deliberately left untouched here.
2. **Callback process is not streamed.** Only the final result is surfaced; the callback turn's tool calls and logs do not produce a streaming bubble.
3. **`a2a_message` replies** are not surfaced in Team Chat — unchanged behaviour.
4. **Per-session "busy" badge** in the chat header is not implemented; the exposed status is agent-level. The backend already exposes per-session state; a per-session read endpoint is the remaining piece.
