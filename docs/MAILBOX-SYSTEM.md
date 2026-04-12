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
  task_status ──┤  enqueue()       │  AgentMailbox │ priority queue
  task_comment ──┼────────────────►│  (per agent)  │ sorted by priority + FIFO
  review_req ──┤                   └──────┬───────┘
  system_event──┤                        │ dequeueAsync()
  heartbeat ────┤                         ▼
  system_event ──┤               ┌──────────────────┐
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
  system_event:         { label: 'System Event',        defaultPriority: 0, category: 'system',       icon: '⚙', createsActivity: true,  invokesLLM: true  },
  human_chat:           { label: 'Chat',                defaultPriority: 0, category: 'interaction',   icon: '💬', createsActivity: true,  invokesLLM: true  },
  task_comment:         { label: 'Task Comment',        defaultPriority: 0, category: 'task',          icon: '💬', createsActivity: false, invokesLLM: false },
  mention:              { label: 'Mention',             defaultPriority: 1, category: 'interaction',   icon: '@', createsActivity: true,  invokesLLM: true  },
  session_reply:        { label: 'Session Reply',       defaultPriority: 1, category: 'task',          icon: '↩', createsActivity: true,  invokesLLM: true  },
  task_status_update:   { label: 'Task Status',         defaultPriority: 2, category: 'task',          icon: '📋', createsActivity: true,  invokesLLM: true  },
  a2a_message:          { label: 'Agent Message',       defaultPriority: 2, category: 'interaction',   icon: '🔗', createsActivity: true,  invokesLLM: true  },
  review_request:       { label: 'Review Request',      defaultPriority: 2, category: 'task',          icon: '👀', createsActivity: true,  invokesLLM: true  },
  requirement_update:   { label: 'Requirement Update',  defaultPriority: 2, category: 'notification',  icon: '📝', createsActivity: true,  invokesLLM: true  },
  daily_report:         { label: 'Daily Report',        defaultPriority: 2, category: 'system',        icon: '📊', createsActivity: true,  invokesLLM: true  },
  heartbeat:            { label: 'Heartbeat',           defaultPriority: 3, category: 'system',        icon: '♡', createsActivity: true,  invokesLLM: true  },
  memory_consolidation: { label: 'Memory Consolidation',defaultPriority: 4, category: 'system',        icon: '🧠', createsActivity: true,  invokesLLM: true  },
};
```

### 3.2 Type Descriptor Schema

```typescript
export interface MailboxTypeDescriptor {
  label: string;                    // Human-readable display name
  defaultPriority: MailboxPriority; // 0=critical, 1=high, 2=normal, 3=low, 4=background
  category: MailboxCategory;        // Filter group for UI
  icon: string;                     // Emoji/icon for UI display
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
| `task` | `task_status_update`, `task_comment`, `review_request`, `session_reply` | Task lifecycle events (including execution triggers) |
| `notification` | `requirement_update` | Status change notifications |
| `system` | `system_event`, `heartbeat`, `daily_report`, `memory_consolidation` | Internal agent processes |

### 3.4 Special Processing Rules

**`task_status_update` — Dual-Mode Processing**

`task_status_update` serves as the **unified trigger for all task lifecycle events**. It operates in two modes:

1. **Execution mode** (`extra.triggerExecution = true`): When a task transitions to `in_progress` and needs execution, `TaskService.runTask()` sends a `task_status_update` with execution context (onLog, cancelToken, workspace, executionRound) via `agent.sendTaskExecution()`. The agent processes this by calling `executeTask()` — the full task execution loop. Priority is set to 1 (high).

2. **Notification mode** (default): For non-execution status changes (e.g., cancelled, blocked, completed), the item is processed via `handleMessage()` as a lightweight LLM call. The notification includes action guidance (e.g., "Task cancelled. Stop any related work.").

When `updateTaskStatus()` triggers auto-start execution, the separate notification is **skipped** to avoid redundant LLM calls. The execution-mode `task_status_update` serves as both trigger and notification.

Similarly, when a task transitions from `in_progress` to `review` (via `task_submit_review`), the assignee notification is skipped — the assignee itself initiated the submission and already knows the state change. Only the reviewer receives a `review_request` notification.

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

Priorities can be overridden per-item when enqueuing.

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
- **deciding** — Evaluating whether to continue, preempt, merge, or defer (at a yield point).

### Event-Driven Interrupts

There is **no polling**. When a new item arrives while the agent is focused:

1. The mailbox emits `mailbox:new-item` via the EventBus.
2. The `AttentionController` sets an **interrupt signal**.
3. At the next **safe yield point** (between LLM turns in the tool loop), the agent calls `checkYieldPoint()`.
4. The controller evaluates the pending item and returns a **decision**.

### Decision Types

| Decision | Effect |
|----------|--------|
| `pick` | Item dequeued from idle state (initial selection) |
| `continue` | New item not urgent enough — keep working on current focus |
| `preempt` | Pause current work, switch to higher-priority item |
| `merge` | Absorb new item into current work (e.g., comment on current task) |
| `defer` | Explicitly postpone the new item |
| `delegate` | Hand off to another agent (future) |
| `drop` | Discard the item |

### Priority Invariant: User Interactions First

User chat (`human_chat`) and task comments (`task_comment`) are assigned **priority 0 (critical)** — the highest possible level. The heuristic rules enforce:

1. **R1**: If a new `human_chat` or `task_comment` arrives while the agent is focused on any non-user work, the agent **always preempts** to handle the user interaction immediately.
2. When idle with multiple items queued, the priority queue ensures user interactions are dequeued first.
3. The agent's system prompt includes the **full mailbox queue** (not a truncated view), so the agent is always aware of everything waiting for its attention.

### Safe Yield Points

Yield points are inserted at natural pauses in the agent's processing pipeline:

- **Task execution** (`_executeTaskInternal`): After all tool calls complete and before the next LLM turn. If preempted, the task session state is fully saved and execution is **automatically re-queued** via `TaskService.runTask()` — the task stays `in_progress` and a new `task_status_update` (execution mode) is enqueued to the mailbox. The re-queued item sits behind any higher-priority items and resumes with full session context when the agent is available.
- **Chat/message handling** (`handleMessage`): After tool results are recorded. Only merge decisions are honoured here (no preemption, since the caller is awaiting a response).

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
  taskId, taskDescription, onLog, cancelToken, taskWorkspace, executionRound
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
| `task_status_update` | `task` or `internal` | Execution mode (`extra.triggerExecution`) → `task`; notification mode → `internal` |
| `requirement_update` | `internal` | Lightweight LLM call (scenario: `comment_response`) |
| `mention` | `chat` | |
| `review_request` | `chat` | |
| `session_reply` | `respond_in_session` | Has `task_id` |
| `heartbeat` | `heartbeat` | |
| `system_event` | `internal` | |
| `daily_report` | `internal` | |
| `memory_consolidation` | `internal` | |

The `activityType` is set to `null` in the registry for `task_status_update` because it depends on the processing mode. `Agent.startActivity()` sets the type explicitly: `executeTask()` creates a `task` activity, while `handleMessage()` creates the appropriate type based on scenario.

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

The mailbox system feeds into the agent's memory at multiple layers:

| Layer | Source | Cadence |
|-------|--------|---------|
| **Working memory** | Current focus item + recent decisions injected into system prompt | Every LLM turn |
| **Episodic memory** | Full mailbox timeline + decisions queryable from SQLite | Persistent |
| **Daily logs** | Derived from mailbox items processed that day | End of day |
| **Long-term memory** | Patterns extracted from decision history (e.g., "I tend to preempt for review requests") | Periodic consolidation |

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

| Type | Label | Icon | Default Priority |
|------|-------|------|-----------------|
| `approval_request` | Approval Request | ⚠ | high |
| `bounty_posted` | Bounty Posted | 🎯 | normal |
| `task_created` | Task Created | ☑ | normal |
| `task_review` | Task Review | 👀 | high |
| `task_completed` | Task Completed | ✓ | normal |
| `task_failed` | Task Failed | ✗ | high |
| `requirement_created` | Requirement Proposed | 📝 | normal |
| `agent_chat_request` | Chat Request | 💬 | high |
| `agent_notification` | Agent Notification | 🔔 | normal |
| `system` | System | ⚙ | normal |

### 12.3 Action Types

Notifications can be **actionable** — clicking them navigates the user to the relevant context:

| `action_type` | `action_target` format | Behaviour |
|---------------|----------------------|-----------|
| `navigate` | `{ "path": "/work?task=T123" }` | Navigate to the specified route |
| `open_chat` | `{ "agentId": "...", "sessionId": "..." }` | Open chat with agent, resume session |
| *(null)* | — | Notification only, no navigation |

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

### 13.1 `notify_user` — One-Way Notification

Fire-and-forget informational updates. Creates a persistent notification in the user's notification bell.

```typescript
// Tool schema
{
  name: 'notify_user',
  parameters: {
    title: string,     // Short notification headline
    message: string,   // Notification body
    priority: 'low' | 'normal' | 'high' | 'urgent'  // optional, default 'normal'
  }
}
```

**When to use**: Status updates, task completion notices, FYI messages, non-blocking announcements.

**Flow**: `agent.executeTool('notify_user')` → `agent.userNotifier(title, message, priority)` → `HITLService.notify()` → SQLite + WebSocket → NotificationBell

### 13.2 `request_user_chat` — Interactive Chat Request

Opens (or continues) a two-way chat conversation. Creates both a notification AND a chat message.

```typescript
// Tool schema
{
  name: 'request_user_chat',
  parameters: {
    message: string,      // The chat message to send
    reason: string,       // Why the agent needs user input (shown in notification)
    session_id?: string   // Optional: continue an existing chat session
  }
}
```

**When to use**: Blocking questions, approval requests, design decisions, anything requiring user response.

**Flow**: `agent.executeTool('request_user_chat')` → `agent.userMessageSender(message, sessionId)` → chat session created/reused → `HITLService.notify('agent_chat_request', ...)` → WebSocket `notification` + `chat:proactive_message`

### 13.3 Session Awareness

Agents are given context about their recent chat sessions in the system prompt:

```
## Recent user conversations
- Session abc123: "API design discussion" (last: 2h ago) — "Should we use REST or..."
- Session def456: "Bug report follow-up" (last: 1d ago) — "The fix has been deployed..."
```

This enables agents to continue existing conversations by passing `session_id` to `request_user_chat`, rather than always creating new sessions.

### 13.4 Prompt Guidance

The system prompt includes scenario-specific guidance on which tool to use:

| Situation | Tool |
|-----------|------|
| Task completed, just informing | `notify_user` |
| Need approval or clarification | `request_user_chat` |
| Encountered an error, FYI | `notify_user` |
| Design question, need answer | `request_user_chat` |
| Progress update | `notify_user` |
| Continuing a previous conversation | `request_user_chat` with `session_id` |

---

## 14. Future Work

- **Cross-agent priority coordination**: Allow a manager agent to influence subordinate agents' mailbox priorities.
- **Deferred item resurfacing**: Automatically re-enqueue deferred items when conditions are met.
- **Decision pattern learning**: Use long-term decision history to adaptively tune heuristic thresholds.
