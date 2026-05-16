# Mailbox & Attention System

> Last updated: 2026-04

---

## 1. Design Philosophy

Markus agents are modelled as **single-threaded cognitive entities**. Like a human employee, an agent can only focus on one thing at a time. When multiple stimuli arrive concurrently — chat messages, task assignments, status updates, review requests — the agent must make deliberate decisions about what to attend to and in what order.

This is implemented through two core abstractions:

- **Agent Mailbox** — A priority queue that serialises all incoming stimuli.
- **Attention Controller** — An event-driven focus manager that processes mailbox items one at a time, with interrupt handling at safe yield points.

### Why not concurrent processing?

Previous designs allowed agents to handle multiple messages simultaneously. This caused:
- **Memory contamination** — Concurrent conversations polluted each other's session context.
- **Cognitive interference** — An agent composing a code review could be mid-thought when a chat message hijacked its attention.
- **Non-deterministic behaviour** — Race conditions in state mutations made debugging nearly impossible.

The mailbox model eliminates these issues by treating the agent's attention as a scarce, serial resource.

---

## 2. Architecture

```
External Events                    Agent Internals
─────────────                      ───────────────
  human_chat ──┐
  a2a_message ──┤                  ┌──────────────┐
  task_status ──┤  enqueue()       │  AgentMailbox │ priority queue + dedup
  task_comment ──┼────────────────►│  (per agent)  │ sorted by priority + FIFO
  req_comment ──┤                  └──────┬───────┘
  review_req ──┤                         │ dequeueAsync()
  system_event──┤                         ▼
  heartbeat ────┤               ┌──────────────────┐
  session_reply──┤               │ AttentionController│ event-driven loop
  daily_report ──┤               │  state: idle →    │
  memory_consol──┘               │  focused → idle   │
                                 └──────┬───────────┘
                                        │ delegate.processMailboxItem()
                                        ▼
                                 ┌──────────────┐
                                 │  Agent Core   │ handleMessage / executeTask
                                 │  (internal)   │ handleHeartbeat / respondInSession
                                 └──────────────┘
```

---

## 3. Mailbox Item Types — Centralised Type Registry

### 3.1 Single Source of Truth

All mailbox item types, their metadata, and their processing behaviour are defined in **one place**: `MAILBOX_TYPE_REGISTRY` in `@markus/shared`. Every other module (core routing, attention heuristics, default priorities, frontend filters/labels/icons) reads from this registry. **No string literals for type values should appear outside the registry and the shared type union.**

```typescript
// @markus/shared — packages/shared/src/types/mailbox.ts

export const MAILBOX_TYPE_REGISTRY: Record<MailboxItemType, MailboxTypeDescriptor> = {
  system_event:         { label: 'System Event',         defaultPriority: 1, category: 'system',       icon: '⚙',  activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  human_chat:           { label: 'Chat',                 defaultPriority: 0, category: 'interaction',   icon: '💬', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  task_comment:         { label: 'Task Comment',         defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false },
  mention:              { label: 'Mention',              defaultPriority: 1, category: 'interaction',   icon: '@',  activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  session_reply:        { label: 'Session Reply',        defaultPriority: 1, category: 'task',          icon: '↩',  activityType: 'respond_in_session', createsActivity: true,  invokesLLM: true  },
  task_status_update:   { label: 'Task Status',          defaultPriority: 1, category: 'task',          icon: '📋', activityType: null,                 createsActivity: true,  invokesLLM: false },
  a2a_message:          { label: 'Agent Message',        defaultPriority: 2, category: 'interaction',   icon: '🔗', activityType: 'a2a',                createsActivity: true,  invokesLLM: true  },
  review_request:       { label: 'Review Request',       defaultPriority: 1, category: 'task',          icon: '👀', activityType: 'chat',               createsActivity: true,  invokesLLM: true  },
  requirement_comment:  { label: 'Requirement Comment',  defaultPriority: 2, category: 'task',          icon: '💬', activityType: null,                 createsActivity: false, invokesLLM: false },
  requirement_update:   { label: 'Requirement Update',   defaultPriority: 1, category: 'notification',  icon: '📝', activityType: 'internal',           createsActivity: true,  invokesLLM: false },
  daily_report:         { label: 'Daily Report',         defaultPriority: 2, category: 'system',        icon: '📊', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
  heartbeat:            { label: 'Heartbeat',            defaultPriority: 3, category: 'system',        icon: '♡',  activityType: 'heartbeat',          createsActivity: true,  invokesLLM: true  },
  memory_consolidation: { label: 'Memory Consolidation', defaultPriority: 4, category: 'system',        icon: '🧠', activityType: 'internal',           createsActivity: true,  invokesLLM: true  },
};
```

### 3.2 Type Descriptor Schema

```typescript
export interface MailboxTypeDescriptor {
  label: string;                    // Human-readable display name
  defaultPriority: MailboxPriority; // 0=critical, 1=high, 2=normal, 3=low, 4=background
  category: MailboxCategory;        // Filter group for UI
  icon: string;                     // Emoji/icon for UI display
  activityType: string | null;      // Derived agent_activities.type (null = set at runtime)
  createsActivity: boolean;         // Whether processing normally creates an activity record
  invokesLLM: boolean;              // Whether processing invokes an LLM call
}

export type MailboxCategory = 'interaction' | 'task' | 'notification' | 'system';
```

### 3.3 Filter Categories

The frontend uses `category` for filtering. Users can also filter by individual `sourceType`.

| Category | Types | Description |
|----------|-------|-------------|
| `interaction` | `human_chat`, `a2a_message`, `mention` | Direct conversations with humans or agents |
| `task` | `task_status_update`, `task_comment`, `requirement_comment`, `review_request`, `session_reply` | Task & requirement lifecycle events (including execution triggers) |
| `notification` | `requirement_update` | Status change notifications |
| `system` | `system_event`, `heartbeat`, `daily_report`, `memory_consolidation` | Internal agent processes |

### 3.4 Special Processing Rules

**`task_status_update` — Execution vs. Informational**

`task_status_update` serves as the **unified trigger for all task lifecycle events**. It operates in two modes:

1. **Execution mode** (`extra.triggerExecution = true`): When a task transitions to `in_progress` and needs execution, `TaskService.runTask()` sends a `task_status_update` with execution context (onLog, cancelToken, workspace, executionRound) via `agent.sendTaskExecution()`. The agent processes this by calling `executeTask()` — the full task execution loop. Priority is set to 1 (high).

2. **Informational mode** (default, `invokesLLM: false`): For non-execution status changes (e.g., cancelled, blocked, completed), the item is **auto-completed without LLM invocation**. The agent logs the status change for awareness but does not spend tokens processing it. These transitions are handled by the system (FSM side-effects) and need no agent action.

When `updateTaskStatus()` triggers auto-start execution, the separate notification is **skipped** to avoid redundant processing. The execution-mode `task_status_update` serves as both trigger and notification.

Similarly, when a task transitions from `in_progress` to `review` (via `task_submit_review`), the assignee notification is skipped — the assignee itself initiated the submission and already knows the state change. Only the reviewer receives a `review_request` notification.

**Silent Transitions**: Certain system-managed transitions never produce a `task_status_update` notification because the real mechanism (cancel token or auto-start) already handles the work:

| Transition | Reason suppressed |
|-----------|-------------------|
| `blocked -> in_progress` | Auto-start fires a separate execution-mode item |
| `in_progress -> blocked` | Cancel token stops execution; notification is redundant |

These are defined in `TaskService.SILENT_TRANSITIONS` and checked early in `maybeNotifyAssignee()`.

**`requirement_update` — Conditional LLM Processing**

`requirement_update` is `invokesLLM: false` by default. Most requirement status transitions are informational — the agent is auto-notified without an LLM call.

There are three exceptions where `extra.actionRequired = true` triggers an LLM call with `scenario: 'requirement_action'`:

1. **Approval** (`priority: 1`): When a requirement is approved, the creator agent is prompted to create tasks to fulfill it. This is high priority because the user expects immediate follow-up.
2. **Rejection** (`priority: 1`): When a requirement is rejected, the agent decides whether to resubmit with updates via `requirement_resubmit` or abandon the requirement.
3. **All tasks done — review needed** (`priority: 2`): When all linked tasks reach terminal state, instead of auto-completing the requirement, the system notifies the creator agent. The agent reviews results and decides whether to mark the requirement as `completed` or create additional tasks.

**`requirement_comment` — Direct Discussion on Requirements**

`requirement_comment` is dedicated to threaded comments on requirements (analogous to `task_comment` for tasks). Unlike `requirement_update` (which covers status/decision notifications), `requirement_comment` represents interactive dialogue — questions, feedback, coordination.

Processing follows the same pattern as `task_comment`: `createsActivity: false`, `invokesLLM: false`. If the requirement has an active agent context, the comment is injected; otherwise it falls back to `handleMessage` with `scenario: 'comment_response'`, following the context-first protocol (§3.5).

**`task_comment` — Live Session Injection**

`task_comment` has a unique behaviour: when the referenced task is **actively being executed**, the comment is **injected into the running LLM session** (`injectUserMessage`) rather than creating a new activity. This means:
- `createsActivity: false` — it does not always create an activity (but the merge decision IS recorded)
- `invokesLLM: false` — it does not invoke a new LLM call; the injected text becomes part of the current task's next LLM turn
- If the task is NOT active, it falls back to `handleMessage` and DOES create an activity

### 3.5 Context-First Protocol for Comments

When processing `task_comment` (on inactive tasks) or `requirement_update` (comments), the agent uses `scenario: 'comment_response'`. This instructs the LLM to follow a mandatory context-gathering protocol **before** replying:

1. **Fetch the full item** — call `task_get` or `requirement_list` to get the complete current state
2. **Read ALL previous comments** — understand the full conversation thread
3. **Identify the commenter's intent** — question, request, feedback, objection, etc.
4. **Check related context** — look up referenced tasks, requirements, or files

Only after completing these steps does the agent formulate its reply. This prevents superficial responses that ignore important context already discussed in the comment thread.

The notification text sent to agents also includes explicit MANDATORY instructions reinforcing this protocol.

**Structural reply-to**: Both `task_comment` and `requirement_comment` tools support a `reply_to_comment_id` parameter that creates a structural link to the parent comment. The `task_comments` and `requirement_comments` tables have a `reply_to_id` column; when queried, a LEFT JOIN returns the parent comment's author and content snippet (`replyToAuthor`, `replyToContent`). The notification payload also injects an agent streak count (consecutive agent-only comments) to help agents decide whether further replies are warranted.

**Batch awareness**: The `comment_response` scenario prompt instructs agents to handle multiple bundled comments (separated by `---`) as a single consolidated reply, using `reply_to_comment_id` for the most important one and quoting others inline.

Priorities can be overridden per-item when enqueuing.

### 3.6 Review Comment Cascade Suppression

When a reviewer (agent or human) posts `task_comment` during an active review (`task.status === 'review'` and `authorId === task.reviewerId`), the automatic `task_comment` notifications to the worker and creator agents are suppressed. Only explicit `@mention` notifications are delivered.

**Rationale**: Without this guard, the reviewer's intermediate comments trigger a notification cascade:
1. Reviewer posts comment → worker/creator receive `task_comment`
2. Worker processes notification with full LLM → may send A2A message back to reviewer
3. Reviewer processes A2A message → posts redundant second review

The review outcome is properly communicated through the status transition (`completed` or `in_progress` revision), not intermediate comments.

---

## 4. Attention Controller

### States

```
idle ──► focused ──► idle
           │  ▲
           ▼  │
        deciding
```

- **idle** — Waiting for mail. Blocks on `mailbox.dequeueAsync()`.
- **focused** — Processing a single mailbox item. All new mail triggers an interrupt signal.
- **deciding** — Evaluating whether to continue, preempt, cancel, merge, or defer (at a yield point).

### Event-Driven Interrupts

There is **no polling**. When a new item arrives while the agent is focused:

1. The mailbox emits `mailbox:new-item` via the EventBus.
2. The `AttentionController` sets an **interrupt signal**.
3. At the next **safe yield point** (between LLM turns in the tool loop), the agent calls `checkYieldPoint()`.
4. The controller evaluates the pending item using **heuristics first** (fast, no LLM call), then optionally falls back to an **LLM interrupt judge** for ambiguous cases where heuristics return `continue`. The LLM judge sees both the current work context and the full content of the new message, enabling it to understand semantic intent (e.g., "stop publishing" → cancel, "hold off for now" → preempt).

### Decision Types

| Decision | Effect |
|----------|--------|
| `pick` | Item dequeued from idle state (initial selection) |
| `continue` | New item not urgent enough — keep working on current focus |
| `preempt` | **Pause** current work — session is **deferred for later resumption**. The agent switches to the new item. When the agent becomes idle, `resurfaceDue()` automatically re-queues the deferred item for continued processing. |
| `cancel` | **Permanently stop** current work — the item is **dropped and will NOT be resumed**. Used when the new message explicitly revokes or contradicts the current work (e.g., "cancel that task", "don't publish this"). |
| `merge` | Absorb new item into current work (e.g., comment on current task) |
| `defer` | Explicitly postpone the new item |
| `delegate` | Hand off to another agent (future) |
| `drop` | Discard the item |

### Preempt vs Cancel Semantics

These two decisions handle fundamentally different situations:

- **Preempt (pause)**: "暂停" — The current work is saved. The mailbox item is moved to `deferred` status and will automatically resurface when the agent is idle. Session context (conversation history) is preserved by `sessionId`, so processing continues from where it left off.
- **Cancel (stop)**: "取消" — The current work is permanently abandoned. The mailbox item is marked as `completed` and will NOT be resumed. Used when the incoming message explicitly revokes or invalidates the current work.

The heuristic interrupt rules (`heuristicDecision`) never produce `cancel` — only the **LLM interrupt judge** can make this semantic distinction, since it requires understanding message content (e.g., distinguishing "wait before deploying" from "cancel the deployment entirely").

### Priority Invariant: User Interactions First

User chat (`human_chat`), task comments (`task_comment`), and requirement comments (`requirement_comment`) are assigned **priority 0 (critical)** — the highest possible level. The heuristic rules enforce:

1. **R1**: If a new `human_chat`, `task_comment`, or `requirement_comment` arrives while the agent is focused on any non-user work, the agent **always preempts** to handle the user interaction immediately.
2. When idle with multiple items queued, the priority queue ensures user interactions are dequeued first.
3. The agent's system prompt includes the **full mailbox queue** (not a truncated view), so the agent is always aware of everything waiting for its attention.

### Safe Yield Points

Yield points are inserted at natural pauses in the agent's processing pipeline:

- **Task execution** (`_executeTaskInternal`): After all tool calls complete and before the next LLM turn. Both `preempt` and `cancel` decisions are honoured:
  - **Preempt** → task session state is saved, mailbox item deferred. When the agent is idle, the deferred item resurfaces and execution resumes with full session context.
  - **Cancel** → mailbox item is dropped permanently. The task may need separate status updates (e.g., `cancelTask`) depending on the cancelling message's intent.
- **Chat/message handling** (`handleMessage`): After tool results are recorded. Interrupt behaviour depends on the **scenario**:
  - **Non-preemptable** (`chat` only): Only merge decisions are honoured (no preemption/cancellation), since a human user is awaiting a direct response. If a preempt/cancel decision is returned, the interrupt signal is **restored** (not consumed) so the high-priority item is processed immediately after the chat completes.
  - **Preemptable** (all other scenarios: `a2a`, `comment_response`, `requirement_action`, `review`, `heartbeat`, `memory_consolidation`): Full preemption/cancellation is allowed. These either have no real-time human caller waiting, or the caller (another agent, a system process) can tolerate the interruption.
- **Streaming chat** (`handleMessageStream`): After tool results are recorded. Only merge is honoured (same as non-preemptable `handleMessage`), since a human is receiving a streamed response. Preempt/cancel decisions restore the interrupt signal for immediate processing after the stream completes.

### Agent Stop/Pause Behaviour

When an agent is stopped (`Agent.stop()`) or paused (`Agent.pause()`):
1. **Active LLM stream is cancelled** via `cancelActiveStream()` — any in-flight LLM response is aborted immediately.
2. **Attention loop stops** — `AttentionController.stop()` sets `running = false` and wakes any blocked `dequeueAsync()`.
3. **In-flight item is preserved** — if processing was in progress, the item is **requeued** (not lost) so it can be picked up when the agent resumes.
4. **Deferred items survive** — items deferred by preemption remain in the database and will be resurfaced when the agent restarts.

---

## 5. External API

### Entry Points

All external code MUST interact with agents through the mailbox API. Direct calls to internal methods like `handleMessage()`, `executeTask()`, or `respondInSession()` are forbidden — those are private implementation details of the attention loop.

#### `agent.enqueueToMailbox(sourceType, payload, options?)` — Fire-and-forget
Used for notifications that don't need a response:
```typescript
agent.enqueueToMailbox('task_comment', {
  summary: 'Comment on task X',
  content: notificationText,
  taskId: 'task_123',
}, {
  metadata: { senderName: 'Alice', senderRole: 'user' },
});
```

#### `agent.sendMessage(text, senderId?, senderInfo?, options?)` — Awaitable chat
Used when the caller needs a text response:
```typescript
const reply = await agent.sendMessage(
  userText, senderId, senderInfo,
  { sourceType: 'human_chat', images, toolEventCollector }
);
```

#### `agent.sendMessageStream(text, onEvent, senderId?, ...)` — Streaming chat
Used for SSE/streaming chat where events are streamed back via callback:
```typescript
const reply = await agent.sendMessageStream(
  userText, onEvent, senderId, senderInfo, cancelToken, images
);
```

#### `agent.sendTaskExecution(taskId, description, onLog, ...)` — Task execution
Used to run a task through the mailbox. Internally enqueues a `task_status_update` with `extra.triggerExecution = true`. Fire-and-forget with streaming log callback:
```typescript
void agent.sendTaskExecution(
  taskId, taskDescription, onLog, cancelToken, taskProjectContext, executionRound
);
```

#### `agent.sendSessionReply(sessionId, text, onLog, ...)` — Session reply
Used for post-task comment replies within an existing session:
```typescript
const reply = await agent.sendSessionReply(
  taskSessionId, prompt, onLog, senderId, senderInfo
);
```

Internally, all awaitable methods create a promise, store its resolve/reject in the mailbox item's metadata, enqueue, and return the promise. The attention controller processes the item, and `processMailboxItemInternal` resolves the promise with the reply.

### Invariant: Every LLM Call Goes Through the Mailbox

This is a critical design invariant. The following internal methods invoke the LLM but must NEVER be called from outside `agent.ts`:

| Internal method | Routed through | Mailbox type |
|----------------|----------------|--------------|
| `handleMessage()` | `sendMessage()` | `human_chat`, `a2a_message`, `system_event`, etc. |
| `handleMessageStream()` | `sendMessageStream()` | `human_chat` (with `extra.stream`) |
| `executeTask()` | `sendTaskExecution()` | `task_status_update` (with `extra.triggerExecution`) |
| `respondInSession()` | `sendSessionReply()` | `session_reply` |
| `handleHeartbeat()` | heartbeat:trigger → `mailbox.enqueue('heartbeat')` | `heartbeat` |
| `generateDailyReport()` | internally calls `sendMessage()` | `daily_report` |
| `dreamConsolidateMemory()` | internally calls `sendMessage()` | `memory_consolidation` |

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents/:id/mind` | Current mind state (attention, focus, queue snapshot) |
| GET | `/api/agents/:id/mailbox` | Mailbox timeline — enriched history (see below) |
| GET | `/api/agents/:id/decisions` | Decision timeline (recent + persisted) |

#### `GET /api/agents/:id/mailbox` — Enriched Timeline

Query params: `limit`, `offset`, `type` (filter by `source_type`, comma-separated), `category` (filter by category from registry).

Response shape:

```json
{
  "queued": [ /* items currently in queue */ ],
  "queueDepth": 3,
  "history": [
    {
      "id": "mbx_...",
      "sourceType": "human_chat",
      "priority": 1,
      "status": "completed",
      "summary": "What's the status of...",
      "queuedAt": "2026-04-10T...",
      "startedAt": "2026-04-10T...",
      "completedAt": "2026-04-10T...",
      "decisions": [
        { "id": "dec_...", "decisionType": "pick", "reasoning": "Idle — picked from queue" }
      ],
      "activity": {
        "id": "act-...",
        "type": "chat",
        "label": "Chat with Owner",
        "totalTokens": 1234,
        "totalTools": 3,
        "success": true,
        "startedAt": "...",
        "endedAt": "..."
      }
    }
  ]
}
```

Each history item is self-contained: the mailbox stimulus, the decision(s) made, and the resulting activity summary. Activity logs are fetched separately on demand via `GET /api/agents/:id/activity-logs?activityId=...`.

### WebSocket Events

| Event Type | Payload | When |
|------------|---------|------|
| `agent:mailbox` | `{ agentId, item }` | New item enqueued |
| `agent:decision` | `{ agentId, decision }` | Attention decision made |
| `agent:attention` | `{ agentId, state, currentFocus }` | Attention state changed |
| `agent:focus` | `{ agentId, focus, mailboxDepth }` | Focus target changed |

---

## 6. Persistence & Data Model

### 6.1 Entity Relationships

```
mailbox_items (1) ──────┬──── (0..N) agent_decisions     (what the agent decided)
                        │
                        └──── (0..1) agent_activities     (what the agent did)
                                       │
                                       └── (0..N) agent_activity_logs  (LLM turns, tool calls)
```

`mailbox_items` is the **primary timeline**. Everything else hangs off it. The frontend queries mailbox history, and for each item can look up its decision(s) and execution log.

### 6.2 SQLite Tables

```sql
CREATE TABLE mailbox_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_type TEXT NOT NULL,       -- MailboxItemType enum value
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',    -- JSON (summary, content, taskId, etc.)
  metadata TEXT DEFAULT '{}',            -- JSON (senderId, senderName, etc.)
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  deferred_until TEXT,
  merged_into TEXT
);
CREATE INDEX idx_mailbox_agent_status ON mailbox_items(agent_id, status);
CREATE INDEX idx_mailbox_agent_queued ON mailbox_items(agent_id, queued_at DESC);
CREATE INDEX idx_mailbox_agent_type   ON mailbox_items(agent_id, source_type, queued_at DESC);

CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,       -- DecisionType enum value
  mailbox_item_id TEXT NOT NULL,     -- FK → mailbox_items.id
  context TEXT NOT NULL DEFAULT '{}',
  reasoning TEXT NOT NULL DEFAULT '',
  outcome TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_agent ON agent_decisions(agent_id, created_at DESC);
CREATE INDEX idx_decisions_mailbox_item ON agent_decisions(mailbox_item_id);

CREATE TABLE agent_activities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mailbox_item_id TEXT,              -- FK → mailbox_items.id (the causal link)
  type TEXT NOT NULL,                -- derived from mailbox source_type (see §6.3)
  label TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_tools INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activities_agent ON agent_activities(agent_id, started_at DESC);
CREATE INDEX idx_activities_mailbox_item ON agent_activities(mailbox_item_id);

CREATE TABLE agent_activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL REFERENCES agent_activities(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                 -- 'status' | 'text' | 'tool_start' | 'tool_end' | 'error' | 'llm_request'
  content TEXT NOT NULL DEFAULT '',
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_logs_activity ON agent_activity_logs(activity_id, seq);
```

### 6.3 Activity Type Derivation

The `agent_activities.type` field is **not an independent enum**. It is deterministically derived from `mailbox_items.source_type` using the mapping in `@markus/shared`:

| `mailbox_items.source_type` | `agent_activities.type` | Notes |
|-----------------------------|------------------------|-------|
| `human_chat` | `chat` | |
| `a2a_message` | `a2a` | |
| `task_comment` | *(none or `chat`)* | Active task → inject only (no activity); inactive → `chat` |
| `requirement_comment` | *(none or `chat`)* | Same pattern as `task_comment`: inject or fallback to `chat` |
| `task_status_update` | `task` or *(none)* | Execution mode → `task`; informational → auto-completed (no activity) |
| `requirement_update` | `internal` or *(none)* | `actionRequired` → LLM call; otherwise auto-completed (no activity) |
| `mention` | `chat` | |
| `review_request` | `chat` | |
| `session_reply` | `respond_in_session` | Has `task_id` |
| `heartbeat` | `heartbeat` | |
| `system_event` | `internal` | |
| `daily_report` | `internal` | |
| `memory_consolidation` | `internal` | |

The `activityType` is set to `null` in the registry for `task_comment`, `requirement_comment`, and `task_status_update` because it depends on the processing mode. `Agent.startActivity()` sets the type explicitly: `executeTask()` creates a `task` activity, while `handleMessage()` creates the appropriate type based on scenario.

### 6.4 Migration Plan

The key schema change is adding `mailbox_item_id` to `agent_activities`. Since `mailbox_item_id` is nullable (historical activities predate the mailbox system), this is a non-breaking additive migration:

```sql
ALTER TABLE agent_activities ADD COLUMN mailbox_item_id TEXT;
CREATE INDEX IF NOT EXISTS idx_activities_mailbox_item ON agent_activities(mailbox_item_id);
```

Historical activities without `mailbox_item_id` remain valid but lack the causal link. All new activities created after the migration will have the link set.

### 6.5 Persistence Lifecycle

1. **Enqueued** → `mailbox_items` row with `status = 'queued'`
2. **Dequeued** by attention controller → `status = 'processing'`, `started_at` set
3. **Decision made** → `agent_decisions` row referencing `mailbox_item_id`
4. **Activity started** → `agent_activities` row with `mailbox_item_id` set
5. **LLM turns / tool calls** → `agent_activity_logs` rows referencing `activity_id`
6. **Completed** → `mailbox_items.status = 'completed'`, `completed_at` set; activity `ended_at` set
7. If **deferred** → `status = 'deferred'` with optional `deferred_until`
8. If **merged** → `status = 'merged'` with `merged_into` pointing to the absorbing item

---

## 7. Integration with State Machines

Every task and requirement status transition generates a `task_status_update` or `requirement_update` mailbox notification to the assigned/creator agent. This ensures:

- The agent is **always aware** of state changes, even those initiated externally (human approval, timeout, cascade cancellation).
- State transitions are **recorded in the mailbox timeline**, providing full traceability.
- The agent can **react** to state changes (e.g., start working when approved, reflect when rejected).

See [STATE-MACHINES.md](./STATE-MACHINES.md) for the full FSM specifications.

---

## 8. Relationship to Memory System

The mailbox system feeds into the agent's memory layers:

| Layer | Source | Cadence |
|-------|--------|---------|
| **Episodic** | Every mailbox item processed becomes an activity in `agent_activities` — searchable via `recall_activity` | Per interaction |
| **Semantic** | Patterns extracted from decision history via consolidation → MEMORY.md | Periodic (Dream Cycle) |
| **Procedural** | Recurring patterns may inform ROLE.md evolution | Rare |

The full stimulus/response record (`mailbox_items` + `agent_decisions`) and the action/outcome record (`agent_activities` + `agent_activity_logs`) together form the agent's **episodic memory** — retrievable via the `recall_activity` tool.

See [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) for details.

---

## 9. Frontend — Agent Mind View

The Agent Mind tab provides a unified view of the agent's cognitive state and history. There are **no sub-tabs** — it is a single scrollable view.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  [IDLE/FOCUSED/DECIDING]  Focused on: [type] label  │  ← Attention state header
│  Queue: 3 items waiting                        ↻    │
├─────────────────────────────────────────────────────┤
│  Filter: [All] [Interaction] [Task] [Notification]  │  ← Category filters from registry
│          [System]   + type dropdown for fine filter  │
├─────────────────────────────────────────────────────┤
│  ● human_chat  "What's the status of..."   completed │  ← Mailbox timeline
│    └─ [pick] Idle — picked from queue                │     (each item expandable)
│    └─ Activity: Chat with Owner  1.2k tokens  3 tools│
│       └─ (click to load activity logs)               │
│                                                      │
│  ● task_status_update  "Implement feature X"  completed │
│  ● heartbeat  "Heartbeat check-in"        completed │
│  ● task_comment  "Comment on task..."       merged   │
│    └─ [merge] Comment on active task — merged        │
│                                                      │
│  [Load Earlier...]                                   │
└─────────────────────────────────────────────────────┘
```

### Design Principles

1. **Mailbox is the primary timeline** — not activities, not decisions. Those are detail views within each mailbox item.
2. **Filters use `category` from the registry** — adding a new mailbox type automatically makes it filterable without frontend changes.
3. **Labels, icons, and colors all come from the registry** — the frontend reads `MAILBOX_TYPE_REGISTRY` at render time.
4. **Expandable detail** — clicking a mailbox item shows: (a) decision badge(s), (b) activity summary, (c) lazy-loaded activity logs.
5. **Status indicators**: `completed` (green), `processing` (blue pulse), `merged` (blue), `deferred` (purple), `dropped` (red), `queued` (amber).

---

## 10. Completeness Guarantee

All paths that invoke the LLM are routed through the mailbox:

- **Human chat** (HTTP / WebUI / gateway) → `sendMessage` / `sendMessageStream`
- **Task execution** (runTask / runTaskFresh) → `sendTaskExecution`
- **Post-task comment reply** → `sendSessionReply`
- **Daily report** (API trigger) → `generateDailyReport` → `sendMessage(sourceType: 'daily_report')`
- **Heartbeat** (periodic timer) → `heartbeat:trigger` event → `mailbox.enqueue('heartbeat')`
- **Memory consolidation** (dream cycle) → `dreamConsolidateMemory` → `sendMessage(sourceType: 'memory_consolidation')`
- **Cross-agent messages** (A2A / delegation) → `sendMessage` / `enqueueToMailbox`
- **Notifications** (task status, requirement, comments) → `enqueueToMailbox`

No LLM call is made outside this architecture.

---

## 11. Agent-to-Agent Communication (A2A via Mailbox)

Inter-agent messaging is fully consolidated into the Mailbox system. The legacy `A2ABus` class has been retired — it added a redundant routing layer when `agent.sendMessage()` already routes through the mailbox.

### How It Works Now

```
Agent A                              Agent B
────────                             ────────
tool: agent_send_message ──►  agentManager.sendAgentMessage()
                                     │
                                     ▼
                               agentB.sendMessage(text, senderInfo)
                                     │
                                     ▼
                               mailbox.enqueue('a2a_message', ...)
                                     │
                                     ▼
                               AttentionController picks it up
```

- **`agent_send_message`** tool: Agent calls this to message a peer. It resolves to `agentManager.sendAgentMessage()` which calls `targetAgent.sendMessage()`.
- **`agent_delegate_task`** tool: Delegation still uses `DelegationManager` for protocol orchestration (handshake, progress updates, completion), but the underlying message transport goes through `sendMessage()` → mailbox.
- **`agent_broadcast_status`** tool: Broadcasts to all other agents via `enqueueToMailbox('system_event', ...)` on each recipient.

The `@markus/a2a` package retains `DelegationManager` and protocol types. `A2ABus` is exported with a `@deprecated` annotation for backward compatibility only.

---

## 12. User Notifications (Human Mailbox)

Just as agents have a mailbox for incoming stimuli, users have a **persistent notification system** for events that require their attention. This is the user-facing counterpart to the agent mailbox.

### 12.1 Storage

```sql
CREATE TABLE user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- UserNotificationType
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  priority TEXT DEFAULT 'normal', -- 'low' | 'normal' | 'high' | 'urgent'
  read INTEGER DEFAULT 0,
  action_type TEXT,               -- 'navigate' | 'open_chat' | null
  action_target TEXT,             -- JSON: { path } or { agentId, sessionId }
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 12.2 Notification Type Registry

Analogous to `MAILBOX_TYPE_REGISTRY`, user notification types are defined in `USER_NOTIFICATION_TYPE_REGISTRY` in `@markus/shared`:

| Type | Label | Icon | Default Priority | Action | Category |
|------|-------|------|-----------------|--------|----------|
| `approval_request` | Approval Request | 🔐 | high | navigate | approval |
| `task_created` | Task Created | 📋 | normal | navigate | task |
| `task_completed` | Task Completed | ✅ | normal | navigate | task |
| `task_review` | Task Review | 👁️ | normal | navigate | task |
| `task_failed` | Task Failed | ❌ | high | navigate | task |
| `requirement_created` | Requirement Proposed | 📝 | high | navigate | task |
| `requirement_decision` | Requirement Decision | ⚖️ | normal | navigate | task |
| `agent_report` | Agent Report | 📊 | normal | none | agent |
| `system` | System | ⚙️ | normal | none | system |

### 12.3 Action Types

Notifications can be **actionable** — clicking them navigates the user to the relevant context:

| `action_type` | `action_target` format | Behaviour |
|---------------|----------------------|-----------|
| `navigate` | `{ "path": "/work?task=T123" }` | Navigate to the specified route |
| `open_chat` | `{ "agentId": "...", "sessionId": "..." }` | Open chat with agent, resume session |
| `none` | — | Notification only, no navigation |

### 12.4 REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications?type=...&limit=...&offset=...` | List notifications with filtering, returns `totalCount` and `unreadCount` |
| POST | `/api/notifications/:id/read` | Mark single notification as read |
| POST | `/api/notifications/mark-all-read` | Mark all notifications as read |

### 12.5 Real-Time Delivery

When a notification is created (via `HITLService.notify()`), a WebSocket `notification` event is broadcast. The frontend `App.tsx` listens for this and dispatches a `markus:notifications-changed` custom DOM event, which triggers the `NotificationBell` component to refresh.

---

## 13. Agent-to-User Communication

Agents have two distinct modes for communicating with users, reflecting different conversational intents:

### 13.1 `notify_user` — Proactive Chat Message + Notification

Proactive messages that appear in the agent's chat **and** the user's notification bell. The user can reply in chat, and the agent has full context of what it sent.

```typescript
// Tool schema
{
  name: 'notify_user',
  parameters: {
    title: string,     // Short headline (1 line)
    body: string,      // Full message content (visible in chat)
    priority: 'low' | 'normal' | 'high' | 'urgent',  // optional, default 'normal'
    related_task_id?: string,  // deep-link to task if applicable
    target_user_id?: string    // target specific user (defaults to currentInteractingUserId)
  }
}
```

**When to use**: Status updates, task completion notices, FYI messages, findings, alerts — any proactive communication where the user may want to reply.

**Flow**: `agent.executeTool('notify_user')` → builds formatted message with embedded context → `memory.appendMessage()` (in-memory session) → `eventBus.emit('agent:notify-user')` → `start.ts` handler: `chatSessionRepo.appendMessage()` (with `notifyUser` metadata) + `ws.broadcastProactiveMessage()` (with metadata) + `hitlService.notify()`

**Notification routing**: With `related_task_id` → `actionType: 'navigate'` to Work page. Without task → `actionType: 'open_chat'` with `sessionId` to agent's chat.

#### Message Metadata & Context Embedding

Every `notify_user` message is persisted with **two layers of context**:

1. **DB metadata** (`metadata` column): `{ notifyUser: true, priority, taskId?, requirementId? }` — used by the frontend to display context links and badges.

2. **Embedded context comment** (appended to message content): `<!-- notify_context: task_id=xxx, requirement_id=yyy -->` — survives through `restoreSessionFromHistory()` (which only reads `role` + `content`), ensuring the agent retains context about what it notified the user about when the user replies.

The agent's `chat` scenario system prompt instructs it to parse these `notify_context` references and use tools like `recall_activity` or `search_tasks` to retrieve full context before responding to user follow-ups.

#### Real-time Visibility

All `notify_user` messages are buffered in the frontend for every agent conversation immediately upon WebSocket receipt — regardless of whether the user is currently viewing that agent's chat. This ensures messages are visible as soon as the user navigates to the agent, without requiring a page reload.

### 13.2 `request_user_approval` — Blocking Decision Request

Requests a decision or approval from the user. The tool **blocks** until the user responds — no timeout. Supports default Approve/Reject options, custom options, and optional freeform text input.

```typescript
// Tool schema
{
  name: 'request_user_approval',
  parameters: {
    title: string,           // Short headline
    description: string,     // Detailed context
    options?: Array<{        // Custom options (defaults to Approve/Reject)
      id: string,
      label: string,
      description?: string
    }>,
    allow_freeform?: boolean, // Allow user to type custom text
    related_task_id?: string,
    priority?: 'normal' | 'high' | 'urgent'
  }
}
// Returns: { status: 'ok', approved: boolean, selected_option: string, comment: string }
```

**When to use**: Approval requests, design decisions, choosing between approaches, anything requiring user input or decision.

**Flow**: `agent.executeTool('request_user_approval')` → `attentionController.setWaitingForApproval(true)` → `HITLService.requestApprovalAndWait(options)` → notification + WebSocket → NotificationBell renders options → user responds → `HITLService.respondToApproval(selectedOption)` → promise resolves → agent receives result

The attention controller uses `APPROVAL_WAIT_TIMEOUT_MS` (24h) instead of the normal 10-minute backstop while waiting for approval, preventing the mailbox item from being requeued prematurely.

### 13.3 Prompt Guidance

The system prompt includes scenario-specific guidance on which tool to use:

| Situation | Tool |
|-----------|------|
| Status report, progress update, FYI alert | `notify_user` (appears in chat, user may reply) |
| Task completed notification | `notify_user` with `related_task_id` |
| Need user to approve/reject something | `request_user_approval` (default options) |
| Need user to choose between approaches | `request_user_approval` with custom `options` |
| Need user freeform input | `request_user_approval` with `allow_freeform: true` |
| Want to discuss interactively | Mention user via task/requirement comment |
| Need to review past execution details | `recall_activity` (list activities or get logs) |

---

## 14. Enqueue-Time Deduplication

When multiple messages for the same entity arrive before the agent can process them, the mailbox merges them at enqueue time to prevent redundant processing:

### Dedup Groups

| Group | Dedup Key | Eligible Types |
|-------|-----------|---------------|
| Task comments | `payload.taskId` | `task_comment` |
| Requirement comments | `payload.requirementId` | `requirement_comment` |

**Why status updates are excluded**: `task_status_update` and `requirement_update` represent distinct state transitions with different processing semantics. Merging a "task blocked" notification with a "task resumed" notification would lose critical state information. Only comments — which are additive human/agent text — are safe to merge.

### Merge Behaviour

When a new item matches an existing **queued** (not yet processing) item in the same dedup group:

1. The new item's `content` is appended to the existing item (separated by `\n\n---\n\n`)
2. The existing item's `summary` gains a `(+1)` suffix
3. The new item is **not** inserted into the queue — the existing item serves both
4. The merge is logged for traceability

This prevents scenarios where 5 rapid-fire comments on the same task each trigger separate LLM calls. Instead, the agent sees one consolidated item with all 5 comments.

**Execution-trigger safety**: Items with `extra.triggerExecution` (task execution triggers) are **never merged** — neither as the incoming item nor as the merge target. Execution items carry critical callbacks (`onLog`, `cancelToken`, `taskProjectContext`) in their `extra` field that would be lost during a content merge. They must always remain standalone queue entries.

### Complementary: Attention Controller Merge (R2/R3)

Enqueue-time dedup handles items that arrive while the queue is idle. The attention controller's R2 (same-task comment merge) and R3 (same-requirement comment/update merge) handle items that arrive **while the agent is focused** — merging them into the current work if they relate to the same entity.

---

## 15. Comment Activity Traceability

Agent-generated comments on tasks and requirements carry an `activityId` linking them to the execution context that produced them. This enables users to expand a comment in the UI and see the full execution log — every tool call, LLM turn, and reasoning step that led to the comment.

### Data Flow

```
Agent executing activity (activityId = "act-agent1-1234...")
  └─ calls task_comment / requirement_comment tool
       └─ tool reads getCurrentActivityId() → "act-agent1-1234..."
            └─ passes activityId to postTaskComment() / postRequirementComment()
                 └─ persisted in task_comments.activity_id / requirement_comments.activity_id
```

### Schema

Both `task_comments` and `requirement_comments` tables have an `activity_id` column (nullable, TEXT). Human-authored comments have `activity_id = NULL`.

### Frontend

The `CommentBubble` component checks for `activityId` on agent comments. When present, a "View log" button appears on hover. Clicking it fetches execution logs via `GET /api/agents/:id/activity-logs?activityId=...` and renders them inline using the `FullExecutionLog` component.

---

## 16. Mailbox Status Filters

The frontend Agent Mind view supports filtering by both **category** and **status**:

| Status | Color Indicator | Description |
|--------|----------------|-------------|
| `queued` | Amber | Waiting in queue |
| `processing` | Blue (pulse) | Currently being processed |
| `completed` | Green | Successfully processed |
| `merged` | Blue | Absorbed into another item |
| `deferred` | Purple | Postponed for later |
| `dropped` | Red | Discarded |

Both category and status filters are passed as query parameters to the mailbox API endpoint.

---

## 17. Restart Recovery

After a server crash or restart, mailbox items that were in `processing` status at the time of shutdown become stale — the in-flight LLM call and callbacks are lost. These items appear as permanent zombies in the mailbox history.

### Recovery Mechanism

On agent startup, `AgentMailbox.recoverStaleItems()` is called immediately after persistence is wired. It delegates to `MailboxPersistence.markStaleProcessingAsDropped(agentId)`, which executes:

```sql
UPDATE mailbox_items SET status = 'dropped' WHERE agent_id = ? AND status = 'processing'
```

This is safe because:
- `resumeInProgressTasks()` already re-creates execution items for any tasks that need to continue.
- The stale items' callbacks (`onLog`, `cancelToken`, etc.) are garbage-collected references that cannot be resumed.
- Marking as `dropped` (not `completed`) preserves the audit trail — these items did not complete successfully.

### Post-Recovery Deduplication

After all queued items are restored from the database, `recoverStaleItems()` runs `deduplicateQueue()` to collapse redundant entries that accumulated before the restart:

1. **Heartbeat collapse**: Multiple queued heartbeats are reduced to a single entry (the most recent). Older heartbeats are marked `dropped`.
2. **Comment merging**: `task_comment` items with the same `taskId` are merged (content appended, summary updated with `(+1)`). Same for `requirement_comment` by `requirementId`.
3. **Priority escalation**: When merging, the survivor inherits the highest priority of all merged items.
4. **Execution-trigger safety**: Items with `extra.triggerExecution` are never merged — they carry critical callbacks that must remain standalone.

This prevents scenarios where a restart causes the agent to process 10 redundant heartbeats or 5 separate comment notifications for the same task.

### Startup Sequence

```
1. wireMailboxPersistence(agentId)   — sets save/updateStatus/markStaleProcessingAsDropped/loadQueued
2. mailbox.recoverStaleItems()       — drops stale processing, restores queued, deduplicates
3. resumeInProgressTasks()           — re-creates execution items for active tasks
```

---

## 18. Retry Cleanup

When a task is retried (`retryTaskFresh`) or a scheduled task is reset for rerun (`resetTaskForRerun`), any queued informational `task_status_update` items for that task are dropped from the mailbox. This prevents stale notifications (e.g., "Task blocked" from before the retry) from being processed alongside the fresh execution.

### What is dropped

Only `task_status_update` items that meet **all** conditions:
- Status is `queued` (not yet processing)
- `sourceType` is `task_status_update`
- `extra.triggerExecution` is **not** set (execution-trigger items are real work, never dropped)
- `taskId` matches the retried task

### What is preserved

- `task_comment` — genuine human/agent interactions
- `mention` — explicit @mention notifications
- `a2a_message` — inter-agent messages
- All items already in `processing` state

### Implementation

`AgentMailbox.dropStatusUpdatesByTaskId(taskId)` iterates the queue in reverse, splicing matching items and marking them as `dropped` in persistence. Called from `retryTaskFresh()` and `resetTaskForRerun()` in `TaskService`, before the fresh execution is enqueued.

---

## 19. EventBus Architecture

Each `Agent` creates its own private `EventBus` instance. The `AgentManager` has a separate manager-level `EventBus`. External listeners (e.g., WebSocket broadcast handlers in `start.ts`) register on the **manager's** EventBus.

### Event Forwarding

To bridge the gap, `AgentManager.forwardAgentEvents()` is called when each agent is created or restored. It subscribes to key events on the agent's private bus and re-emits them on the manager's bus:

```
Agent's Private EventBus          Manager's EventBus          start.ts (WS broadcast)
─────────────────────              ──────────────────          ───────────────────────
agent:activity-log  ──────────►  agent:activity-log  ──────►  Persist to main session DB
agent:activity_log  ──────────►  agent:activity_log  ──────►  Stream to frontend Activity tab
agent:started       ──────────►  agent:started       ──────►  agent:started WS event
agent:stopped       ──────────►  agent:stopped       ──────►  agent:stopped WS event
agent:paused        ──────────►  agent:paused        ──────►  agent:paused WS event
agent:resumed       ──────────►  agent:resumed       ──────►  agent:resumed WS event
agent:focus-changed ──────────►  agent:focus-changed ──────►  agent:focus WS event
agent:message       ──────────►  agent:message
task:completed      ──────────►  task:completed      ──────►  task update WS event
task:failed         ──────────►  task:failed         ──────►  task update WS event
mailbox:new-item    ──────────►  mailbox:new-item    ──────►  agent:mailbox WS event
attention:decision  ──────────►  attention:decision  ──────►  agent:decision WS event
attention:state-changed ──────►  attention:state-changed ──►  agent:attention WS event
attention:triage    ──────────►  attention:triage    ──────►  agent:triage WS event
```

Events emitted directly on the manager's bus (no forwarding needed):
- `agent:created` — emitted by `AgentManager.createAgent()` / `restoreFromDB()`
- `agent:removed` — emitted by `AgentManager.removeAgent()`
- `system:*` — emitted by `AgentManager` global operations

### Why Two Buses?

The agent's private bus provides internal encapsulation — the agent, its mailbox, and its attention controller communicate without coupling to the manager. The manager's bus provides a single subscription point for infrastructure concerns (persistence, WS broadcast, monitoring).

---

## 20. Main Session Activity Injection

Each agent has a **main session** — a persistent chat session that serves as the agent's chronological activity log. Every mailbox item the agent processes (except `human_chat`) generates a concise activity summary in this session.

### Purpose

Without the main session, the agent loses narrative continuity across processing contexts. For example: a user creates a task via chat, the task completes via heartbeat-triggered execution, but the agent's chat session has no record of the completion. The main session bridges this gap by recording all mailbox-driven activity.

### Data Flow

```
Agent processes mailbox item
  └─ finally block in processMailboxItemInternal()
       └─ buildActivityOutcome(item) → outcome string
            └─ injectActivityToMainSession({type, summary, outcome, mailboxItemId})
                 ├─ memory.appendMessage() → in-memory context for next LLM turn
                 └─ eventBus.emit('agent:activity-log', {agentId, sessionId, message, metadata})
                      └─ [forwarded to manager's EventBus]
                           └─ start.ts listener:
                                ├─ chatSessionRepo.getOrCreateMainSession(agentId)
                                ├─ chatSessionRepo.appendMessage() → DB persistence
                                ├─ chatSessionRepo.updateLastMessage() → session sort order
                                └─ ws.broadcastProactiveMessage() → real-time frontend update
```

### Message Format

```
[ACTIVITY: <sourceType>] <summary> → <outcome>
```

Examples:
- `[ACTIVITY: heartbeat] Heartbeat check-in → heartbeat processed`
- `[ACTIVITY: review_request] Review task "Fix login bug" → reviewed`
- `[ACTIVITY: task_status_update] Task assigned: implement API → executed`

### Frontend Rendering

Activity log entries (marked with `activityLog: true` metadata) are hidden from the chat interface and visible only in the Agent Profile Mind tab. This reduces noise in the chat while keeping full traceability in the agent's profile.

**Exception — `notify_user` and escalation**: These messages bypass `injectActivityToMainSession` entirely and are instead injected as regular chat messages via their own `agent:notify-user` and `agent:escalation` event handlers. `notify_user` messages carry `{ notifyUser: true, priority, taskId?, requirementId? }` metadata (not `activityLog`), and their content includes an embedded `<!-- notify_context -->` comment with task/requirement references. They render as normal agent chat bubbles, allowing users to see and reply to them directly. The embedded context ensures the agent retains awareness of the notification's origin when processing the user's reply.

When the user opens an agent's chat, the frontend loads sessions via `getSessionsByAgent()`, which returns the main session first (sorted by `is_main DESC`). The main session's messages include both user conversations and notify/escalation messages, displayed chronologically.

### Completion Marker

Agent responses include a `<<HANDLE_COMPLETE>>` completion marker to detect abnormal termination. This marker is:
- Required in the agent's prompt instructions for non-chat processing
- Stripped from all output before display (streaming `text_delta`, SSE segment fallback, heartbeat daily log)
- Detected by `detectAbnormalCompletion()` — if absent, the mailbox item is requeued for retry

---

## 21. Mailbox Triage System

When an agent dequeues a mailbox item and additional items remain in the queue, the Attention Controller triggers an LLM-driven **triage phase** before processing. This ensures the agent considers all pending work holistically rather than blindly following priority order.

### Pre-Triage Entity Consolidation

Before triage (or processing), the system automatically consolidates queued items that share the same `taskId` or `requirementId` — regardless of `sourceType`. This is a cross-type merge: a `task_status_update`, `a2a_message`, `mention`, and `task_comment` all referencing `tsk_abc123` are collapsed into a single rich-context item.

This differs from enqueue-time dedup (which only merges same-type comments):
- **Enqueue-time**: `task_comment` + `task_comment` for same task → merged (fast, prevents accumulation)
- **Pre-triage**: `task_comment` + `a2a_message` + `task_status_update` for same task → consolidated (comprehensive, gives agent full entity context)

The headItem is temporarily put back into the queue so it participates in consolidation, then re-dequeued.

### Three-Tier Cognitive Model

The triage system implements a three-tier cognitive model inspired by Dual Process Theory (Kahneman, 2011):

- **Tier 0 (Reflexive / System 1)**: Queue depth = 0 after consolidation, or priorities clearly separate items → no LLM call needed. Process immediately.
- **Tier 1 (Quick Classification / System 1+)**: Interrupt arrives during focused work, heuristic says "continue" but LLM may disagree → single LLM call returning one word (`continue`/`preempt`/`cancel`/`merge`/`defer`).
- **Tier 2 (Full Deliberation / System 2)**: Multiple items with overlapping priorities AND `performDeliberation` configured → full agent session with complete tool access and memory.

### Triage Flow

```
dequeueAsync() → headItem
  │
  ├─ queue empty? → TIER 0: record 'pick' → process(headItem)
  │
  └─ queue non-empty?
       ├─ CONSOLIDATION: putBack(headItem) → consolidateByEntity() → dequeue()
       │    (items sharing same taskId/requirementId merged cross-type)
       │
       ├─ queue empty after consolidation? → TIER 0
       │
       └─ priorities clearly separate? → TIER 0
       │
       └─ ambiguous priorities AND (performDeliberation OR triageJudge)?
            │
            ├─ performDeliberation available?
            │    → TIER 2: Full-session deliberation (scenario='deliberation')
            │         ├─ Agent deliberates AS ITSELF with full identity
            │         ├─ Access to memory, recall_activity, task tools
            │         ├─ Can handle simple items INLINE (notify, comment, message)
            │         ├─ Calls complete_deliberation tool with decision
            │         ├─ Apply inline-completed / defer / drop / choose
            │         └─ Working memory updated (`deliberation` key from situational awareness)
            │
            └─ triageJudge only (fallback)?
                 → Mini triage loop (up to TRIAGE_MAX_TOOL_ITERATIONS rounds)
                      ├─ Build prompt with candidates + context
                      ├─ LLM calls read-only tools to gather context
                      ├─ Returns JSON: { processItemId, deferItemIds, dropItemIds }
                      └─ Apply decisions
```

### Full-Session Deliberation (Tier 2)

When `delegate.performDeliberation` is available (always in production), the attention controller delegates triage to a full agent session:

1. The agent receives all queued items formatted as a `[DELIBERATION MODE]` prompt.
2. It uses `handleMessage()` with `scenario: 'deliberation'` — the same code path as chat/task but with restricted tool access (`DELIBERATION_ALLOWED_TOOLS`).
3. The agent deliberates **as itself** (full system prompt, identity, memory access).
4. It can handle simple items **inline** (e.g., send a quick notification, post a comment).
5. It calls `complete_deliberation` with its structured decision.
6. The attention controller applies the decision: mark inline items completed, defer/drop others, choose the focus item.

**Deliberation is atomic**: yield points are suppressed during deliberation (new mail sets the interrupt signal but is not evaluated until deliberation completes).

### Tool Access During Deliberation

Defined by `DELIBERATION_ALLOWED_TOOLS` in `@markus/shared`:

| Category | Tools |
|----------|-------|
| Context gathering | `task_list`, `task_get`, `requirement_list`, `requirement_get`, `list_projects`, `team_list`, `team_status`, `recall_activity`, `memory_search`, `memory_search_longterm` |
| Inline communication | `notify_user`, `task_comment`, `requirement_comment`, `agent_send_message`, `agent_send_group_message`, `agent_create_group_chat`, `agent_list_group_chats` |
| Mailbox management | `check_mailbox`, `defer_mailbox_item`, `drop_mailbox_item`, `prioritize_mailbox_item` |
| Working memory | `update_working_memory`, `clear_working_memory` |
| Decision output | `complete_deliberation` |

**Excluded**: `task_create`, `task_update`, `requirement_propose`, code/shell tools, `spawn_subagent`. These are heavy side-effect tools that belong in the processing phase.

### Agent Mailbox Management Tools

In addition to the batch decision via `complete_deliberation`, agents can manage
individual mailbox items using dedicated tools:

| Tool | Available In | Purpose |
|------|-------------|---------|
| `check_mailbox` | All scenarios | Read-only queue inspection |
| `defer_mailbox_item` | Deliberation + focused processing | Postpone an item |
| `drop_mailbox_item` | Deliberation + focused processing | Discard stale item |
| `prioritize_mailbox_item` | Deliberation only | Re-prioritize item |
| `update_working_memory` | All scenarios | Update situational awareness |
| `clear_working_memory` | All scenarios | Clear stale awareness |

**Safety**: `human_chat` items are protected — they cannot be deferred, dropped,
or reprioritized by tool calls.

**Relationship to `complete_deliberation`**: The individual tools take immediate
effect. `complete_deliberation` handles remaining items in bulk. They are additive.

### DeliberationResult

```typescript
interface DeliberationResult {
  processItemId: string;       // Item to focus on next
  deferItemIds: string[];      // Postpone for later
  dropItemIds: string[];       // Discard (stale/redundant)
  inlineCompletedIds: string[]; // Already handled during deliberation
  reasoning: string;
  situationalAwareness?: string; // Agent-authored metacognitive summary
}
```

### Working Memory Injection

The agent maintains a **keyed working memory store** (`workingMemory` Map) that
replaces the former `currentCognition` string. Each entry has:
- A key (agent-chosen label, e.g., "deliberation", "task-priorities")
- Content text
- Update timestamp

Working memory is populated from three sources:
1. **Deliberation**: `situationalAwareness` → key `"deliberation"`
2. **Triage**: reasoning → key `"triage-decision"`
3. **Agent tools**: `update_working_memory` / `clear_working_memory`

All entries are injected into every system prompt as `## Working Memory` with
age labels per entry. The agent decides what to keep, update, or expire.

### Mini Triage Loop (Fallback)

When `performDeliberation` is unavailable, the system falls back to the legacy mini triage loop:
- Triage LLM uses the agent's name and role in its system prompt.
- Can call tools from `TRIAGE_ALLOWED_TOOLS` (including `recall_activity`, `memory_search`, `memory_search_longterm`) up to `TRIAGE_MAX_TOOL_ITERATIONS` (6) rounds.
- Returns a structured JSON decision (same as `TriageResult`).

### Key Methods

| Method | Location | Purpose |
|--------|----------|---------|
| `performDeliberation()` | `agent.ts` | Full-session deliberation via handleMessage(scenario='deliberation') |
| `applyDeliberationResult()` | `attention.ts` | Applies inline/defer/drop/choose from deliberation |
| `complete_deliberation` (tool) | `agent.ts` executeTool | Captures structured decision during deliberation |
| `applyTriageResult()` | `attention.ts` | Applies defer/drop/choose from mini triage (fallback) |
| `performTriage()` | `attention.ts` | Mini triage loop (fallback path) |
| `buildTriagePrompt()` | `attention.ts` | Constructs the triage prompt with candidates + context |
| `consolidateByEntity()` | `mailbox.ts` | Merges items sharing same taskId/requirementId (cross-type) |
| `updateCognitionFromDeliberation()` | `agent.ts` | Writes deliberation `situationalAwareness` into `workingMemory` under key `"deliberation"` |
| `evaluateWithLLMFallback()` | `attention.ts` | Heuristic-first interrupt decision with optional LLM fallback |

### Triage Prompt Identity

Both deliberation (Tier 2) and the mini triage loop (fallback) use first-person perspective: "You are {agentName}." The agent deliberates **as itself** with its role context, not as an external "attention manager."

---

## 22. Deferred Item Auto-Resume

Deferred mailbox items are automatically resurfaced when the agent is idle:

- `resurfaceDue()` is called at the top of each attention loop idle cycle (before `dequeueAsync`) and after `recoverStaleItems` on startup.
- Items where `deferredUntil <= now` or `deferredUntil` is undefined (deferred without a time = resume on next idle) are re-enqueued.
- Deferred items are loaded from persistence via `loadDeferred(agentId)`.

## 23. Task Status Update Processing

`task_status_update` items are **informational only** (`invokesLLM: false`). The side-effect system in `updateTaskStatus()` handles all real actions automatically:
- **→ `in_progress`**: Auto-starts task execution
- **Leaving `in_progress`**: Cancels running execution
- **→ `review`**: Notifies reviewer (agent via mailbox, or human via approval request)
- **Terminal states**: Checks and unblocks dependent tasks

Agents do NOT need to take action on these notifications — they serve as episodic memory and triage decision context. Agents should NOT send A2A messages to duplicate what the side-effect system already does.

## 24. Cognitive Science Foundation

The three-tier triage model (§21) is grounded in established cognitive science:

| Theory | Application in Markus |
|--------|----------------------|
| **Dual Process Theory** (Kahneman, 2011) | Tier 0/1 = System 1 (fast, automatic); Tier 2 = System 2 (slow, deliberative) |
| **Situational Awareness** (Endsley, 1995) | Full deliberation achieves Level 2+3 SA (comprehension + projection) via memory access |
| **Working Memory / Episodic Buffer** (Baddeley, 2000) | `recall_activity` and `memory_search` serve as the episodic buffer linking current stimuli to long-term memory |
| **Metacognition** (Flavell, 1979) | `situationalAwareness` field in `DeliberationResult` enables agent self-monitoring |
| **Prospective Memory** (Einstein & McDaniel, 2005) | During deliberation, agents can check pending commitments and proactively notify users |
| **Cognitive Load Theory** (Sweller, 1988) | Unified identity in deliberation eliminates task-switching cost between "triage assistant" and "agent self" |

### Design Rationale

- **Why not always use Tier 2?** Cost and latency. Tier 2 deliberation costs 5-15K tokens vs 0 for Tier 0. Now with `TRIAGE_BACKLOG_THRESHOLD = 2`, deliberation fires whenever 2+ items are queued (non-user head). The cost increase is acceptable because:
  - (a) most single-item processing still takes the fast path,
  - (b) deliberation with 2-3 items is much cheaper than with 5+, and
  - (c) the agent can now use `drop_mailbox_item` during deliberation to clean up before committing to expensive processing.
- **Why allow inline handling?** Cognitive science shows humans handle simple items (quick email replies) during triage rather than queuing them separately. This reduces total cognitive load and latency.
- **Why suppress yield points during deliberation?** Deliberation is a metacognitive process — interrupting it would break the agent's reasoning coherence (analogous to interrupting someone mid-thought during planning).
- **Why inject working memory into future prompts?** This implements **metacognitive regulation** — keyed summaries (deliberation, triage, agent-authored entries) persist across processing contexts, maintaining behavioral consistency.

---

## 25. Proactive Messaging Capabilities

### Can agents proactively send messages?

**Yes.** Agents can initiate communication across multiple channels, including targeted user notifications.

### 25.1 User DM (1:1 Chat)

**Tool**: `notify_user`

| Capability | Status |
|-----------|--------|
| Send proactive message to user | **Yes** — appears in agent's main chat session |
| Message shows in chat UI | **Yes** — as regular assistant message (not hidden as activity log) |
| User can reply in chat | **Yes** — reply triggers `human_chat` mailbox item |
| Notification bell | **Yes** — `HITLService.notify()` creates persistent notification |
| Target specific user by ID | **Yes** — `target_user_id` parameter (optional) |
| Fallback when no target specified | Uses `currentInteractingUserId` (last human who chatted), then team owner |
| Initiate first-ever conversation with user | **Yes** — via `target_user_id` during deliberation or heartbeat |

**Flow**:
```
Agent calls notify_user(title, body, target_user_id?)
  → Build context suffix: <!-- notify_context: task_id=xxx, requirement_id=yyy -->
  → memory.appendMessage(formattedMsg + contextSuffix) — in-memory session
  → eventBus.emit('agent:notify-user', { targetUserId, taskId, requirementId, ... })
  → start.ts handler:
      → chatSessionRepo.getOrCreateMainSession(agentId, targetUserId ?? ownerId)
      → chatSessionRepo.appendMessage(msg, metadata: { notifyUser, priority, taskId, requirementId })
      → ws.broadcastProactiveMessage(metadata: { notifyUser, taskId, requirementId }) — scoped to target user
      → hitlService.notify() — notification bell entry
```

**Context preservation**: When the user replies to a notification, `restoreSessionFromHistory()` loads the message content (including the `<!-- notify_context -->` comment). The agent's `chat` scenario prompt instructs it to use these references to retrieve full context before responding.

### 25.2 Group Chat

**Tool**: `agent_send_group_message`

| Capability | Status |
|-----------|--------|
| Send message to team group | **Yes** — `channel_key: "group:<teamId>"` |
| Send message to custom group | **Yes** — `channel_key: "group:custom:<id>"` |
| Message visible to all channel members | **Yes** — persisted + WebSocket broadcast |
| Triggers other agents in channel | **Yes** — enqueues `a2a_message` to peer agents |
| Create new group chat | **Yes** — `agent_create_group_chat` tool |
| Available during deliberation | **Yes** — in `DELIBERATION_ALLOWED_TOOLS` |

### 25.3 Agent-to-Agent (A2A)

| Tool | Capability |
|------|-----------|
| `agent_send_message` | Direct message to another agent |
| `agent_broadcast_status` | Status update to all colleagues |
| `agent_delegate_task` | Formal task delegation with protocol |

### 25.4 Proactive Messaging During Deliberation

During full-session deliberation (Tier 2), agents can handle simple items inline by calling communication tools directly:

```
Deliberation session starts (5 items queued)
  → Agent calls memory_search to check commitments
  → Agent calls notify_user(target_user_id="usr_alice", ...) — handles item #3 inline
  → Agent calls task_comment(...) — handles item #5 inline
  → Agent calls complete_deliberation({
      process_item_id: "item_1",
      inline_completed_ids: ["item_3", "item_5"],
      defer_item_ids: ["item_4"],
      drop_item_ids: ["item_2"],
      reasoning: "Item 1 is an urgent review request; handled notifications inline"
    })
```

This collapses what would have been 5 separate triage+process cycles into a single deliberation + 1 processing cycle.

---

## 26. Future Work

- **Proactive messaging scheduler**: Allow agents to schedule future messages (e.g., "remind user about this review tomorrow") using time-based prospective memory.
- **Cross-agent priority coordination**: Allow a manager agent to influence subordinate agents' mailbox priorities.
- **Decision pattern learning**: Use long-term decision history to adaptively tune heuristic thresholds.
- **Deliberation cost optimization**: Implement adaptive deliberation depth — use cheaper models or shorter budgets for simple multi-item scenarios, full budget only for genuinely complex triage.
- **Working memory persistence**: Persist keyed working memory across agent restarts (currently volatile).
- **Adaptive deliberation model selection**: Use cheaper models for simple 2-item queues; reserve fuller budgets for genuinely complex triage.
- **Recursive deliberation**: Allow deliberation to trigger sub-deliberation for complex multi-step planning (with depth limits).
