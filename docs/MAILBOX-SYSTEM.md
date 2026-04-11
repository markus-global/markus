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
  task_assign ──┤  enqueue()       │  AgentMailbox │ priority queue
  task_comment ──┼────────────────►│  (per agent)  │ sorted by priority + FIFO
  review_req ──┤                   └──────┬───────┘
  status_update──┤                        │ dequeueAsync()
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
  human_chat:           { label: 'Chat',                defaultPriority: 1, category: 'interaction',   icon: '💬', createsActivity: true,  invokesLLM: true  },
  task_assignment:      { label: 'Task',                defaultPriority: 1, category: 'task',          icon: '☑', createsActivity: true,  invokesLLM: true  },
  task_comment:         { label: 'Task Comment',        defaultPriority: 1, category: 'task',          icon: '💬', createsActivity: false, invokesLLM: false },
  mention:              { label: 'Mention',             defaultPriority: 1, category: 'interaction',   icon: '@', createsActivity: true,  invokesLLM: true  },
  session_reply:        { label: 'Session Reply',       defaultPriority: 1, category: 'task',          icon: '↩', createsActivity: true,  invokesLLM: true  },
  task_status_update:   { label: 'Task Status',         defaultPriority: 2, category: 'notification',  icon: '📋', createsActivity: true,  invokesLLM: true  },
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
| `task` | `task_assignment`, `task_comment`, `review_request`, `session_reply` | Task lifecycle events |
| `notification` | `task_status_update`, `requirement_update` | Status change notifications |
| `system` | `system_event`, `heartbeat`, `daily_report`, `memory_consolidation` | Internal agent processes |

### 3.4 Special Processing Rules

`task_comment` has a unique behaviour: when the referenced task is **actively being executed**, the comment is **injected into the running LLM session** (`injectUserMessage`) rather than creating a new activity. This means:
- `createsActivity: false` — it does not always create an activity (but the merge decision IS recorded)
- `invokesLLM: false` — it does not invoke a new LLM call; the injected text becomes part of the current task's next LLM turn
- If the task is NOT active, it falls back to `handleMessage` and DOES create an activity

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

### Safe Yield Points

Yield points are inserted at natural pauses in the agent's processing pipeline:

- **Task execution** (`_executeTaskInternal`): After all tool calls complete and before the next LLM turn. If preempted, the task session state is fully saved and can be resumed.
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
Used to run a task through the mailbox. Fire-and-forget with streaming log callback:
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
| `executeTask()` | `sendTaskExecution()` | `task_assignment` |
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
| `task_assignment` | `task` | Has `task_id` |
| `task_comment` | *(none or `chat`)* | Active task → inject only (no activity); inactive → `chat` |
| `task_status_update` | `notification` | Ephemeral LLM call |
| `requirement_update` | `notification` | Ephemeral LLM call |
| `mention` | `chat` | |
| `review_request` | `chat` | |
| `session_reply` | `respond_in_session` | Has `task_id` |
| `heartbeat` | `heartbeat` | |
| `system_event` | `internal` | |
| `daily_report` | `internal` | |
| `memory_consolidation` | `internal` | |

This mapping is defined as `MAILBOX_TO_ACTIVITY_TYPE` in `@markus/shared` and used by `Agent.startActivity()`. The existing `AgentActivityType` union will be kept for backward compatibility but derived, never independently assigned.

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
│  ● task_assignment  "Implement feature X"  completed │
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

## 10. Future Work

- **Cross-agent priority coordination**: Allow a manager agent to influence subordinate agents' mailbox priorities.
- **Deferred item resurfacing**: Automatically re-enqueue deferred items when conditions are met (e.g., blocked task unblocked).
- **Decision pattern learning**: Use long-term decision history to adaptively tune heuristic thresholds.
