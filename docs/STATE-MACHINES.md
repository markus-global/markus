# Task & Requirement State Machines

This document defines the Finite State Machine (FSM) specifications for tasks and requirements in Markus.

## 1. Unified Status Vocabulary

Tasks and requirements share a **single status enum** (`ItemStatus`). Not every status applies to both types, but when the same concept exists, it uses the same name and behaves the same way.

| Status | Label | Tasks | Requirements | Description |
|--------|-------|:-----:|:------------:|-------------|
| `pending` | Pending | ✓ | ✓ | Created, awaiting human approval |
| `in_progress` | In Progress | ✓ | ✓ | Approved, work is active |
| `blocked` | Blocked | ✓ | ○ | On hold (dependencies, manual pause) |
| `review` | In Review | ✓ | ○ | Execution done, awaiting reviewer evaluation |
| `completed` | Completed | ✓ | ✓ | Successfully finished |
| `failed` | Failed | ✓ | ○ | Unrecoverable error after retry exhaustion |
| `rejected` | Rejected | ✓ | ✓ | Proposal not approved by human |
| `cancelled` | Cancelled | ✓ | ✓ | Deliberately stopped after work began |
| `archived` | Archived | ✓ | ○ | Historical record, no longer active |

✓ = actively used, ○ = reserved for future use

**Key design decisions:**
- `rejected` ≠ `cancelled`. Rejection means "we don't want this" (proposal denied). Cancellation means "we chose to stop" (work was underway).
- There is no `approved` status. Approval transitions directly to `in_progress` (for both tasks and requirements). The intermediate state added no user decision point.
- There is no `draft` status. Items are created directly as `pending`. The distinction between "draft" and "submitted for review" added no practical value — agents create items programmatically and don't iterate on drafts.
- `pending` replaces the old `pending_approval` (tasks), `pending_review` (requirements), and `draft` (requirements).
- **All tasks start as `pending`** — both human-created and agent-created tasks begin in `pending` status. Human-created tasks require the user to explicitly click "Start Execution" to transition to `in_progress`. Agent-created tasks require human approval (HITL). This gives humans full control over when execution begins.

---

## 2. Task States

### State Transition Diagram

```
                    ┌─────── (retry fresh) ───────┐
                    │                              │
                    ▼                              │
    pending ──────► in_progress ──► review ──► completed ──► archived
       │                │    ▲         │
       │                │    │         └── (revision) ──► in_progress
       │                │    │
       │                ▼    │
       │             blocked ┘ (resume / deps satisfied)
       │                │
       ▼                ▼
    rejected          failed ──► archived
                        │
                        └── (retry fresh) ──► in_progress
```

### Transition Table

**All state transitions go through `updateTaskStatus()`**, which validates every transition against the declarative `TASK_TRANSITIONS` matrix defined in `@markus/shared`. Transitions not in the matrix are rejected with an error. No direct status mutation.

| From | To | Trigger | Method |
|------|----|---------|--------|
| `pending` | `in_progress` | Human approves or starts execution (no blockers) | `approveTask()` |
| `pending` | `blocked` | Human approves or starts execution (has unmet blockers) | `approveTask()` |
| `pending` | `rejected` | Human rejects | `rejectTask()` |
| `in_progress` | `review` | Agent execution finishes | Auto (log handler in `runTask`) |
| `in_progress` | `blocked` | User pauses task | API `POST /tasks/:id/pause` |
| `in_progress` | `failed` | Error + retries exhausted | Auto (retry logic) |
| `in_progress` | `cancelled` | User cancels | `cancelTask()` |
| `blocked` | `in_progress` | User resumes, or all blockers satisfied | `resumeTask` / `checkDependentTasks()` |
| `blocked` | `cancelled` | User cancels / cascade cancel | `cancelTask()` |
| `review` | `completed` | Reviewer approves | `acceptTask()` |
| `review` | `in_progress` | Reviewer requests revision (new round) | `requestRevision()` |
| `review` | `cancelled` | User cancels | `cancelTask()` |
| `failed` | `in_progress` | User clicks Retry (fresh start, new round) | `retryTaskFresh()` |
| `failed` | `archived` | Manual archival | `archiveTask()` |
| `completed` | `archived` | Manual archival | `archiveTask()` |
| `cancelled` | `archived` | Manual archival | `archiveTask()` |
| `rejected` | `archived` | Manual archival | `archiveTask()` |

### Side Effects in `updateTaskStatus()`

| Trigger | Side Effect |
|---------|-------------|
| → `in_progress` (from non-`in_progress`) | Auto-start: `runTask()` via `setImmediate` |
| `in_progress` → anything else | Cancel running execution (cancel token) |
| → `completed` / `failed` / `cancelled` / `rejected` / `archived` | Set `completedAt`; check dependent tasks for unblocking |
| → `review` | Notify reviewer agent automatically |
| **Most status changes** | Enqueue `task_status_update` to assigned agent's mailbox (see [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md)). Skipped when: (a) auto-start triggers execution (the execution-mode item serves as both trigger and notification), or (b) `in_progress → review` (assignee self-initiated via `task_submit_review`) |

### FSM Enforcement

The legal transition set is defined as a declarative matrix `TASK_TRANSITIONS` in `@markus/shared/types/task.ts`. `updateTaskStatus()` validates every transition against this matrix and rejects any transition not present. This is the single source of truth — when adding a new status or transition, update the matrix first, then update this document.

### Key Rules

1. **Single entry point**: All status changes go through `updateTaskStatus()`. Methods like `approveTask`, `acceptTask`, `requestRevision` prepare the task then delegate to `updateTaskStatus`.
2. **Workers cannot self-complete**: Execution finish → `review`, not `completed`. A reviewer must approve.
3. **Reviewer ≠ Worker**: Self-review is blocked. `reviewerAgentId` is mandatory at task creation.
4. **Retry = fresh start**: Retry increments `executionRound`, creates a new LLM session, discards previous execution context. Only the task description and notes carry over.
5. **Pause = blocked**: Pausing a running task sets it to `blocked` and cancels execution. Resume calls `runTask` with full previous context.
6. **Rejected ≠ Cancelled**: `rejectTask()` sets `rejected` (proposal denied before work). `cancelTask()` sets `cancelled` (work stopped after starting). `rejected` is a terminal state — the proposal was not approved.
7. **Preemption ≠ blocked**: When the attention controller **preempts** (pauses) a task for a higher-priority item, the task stays `in_progress` (not `blocked`). The mailbox item is deferred and automatically resurfaced when the agent is idle. The same execution round and session context are preserved. **Cancellation** is different: when the controller **cancels** a task (because the incoming message explicitly revokes the work), the mailbox item is permanently dropped and will NOT be resumed.
8. **Irreversible actions require confirmation**: The UI requires explicit user confirmation (via modal dialogs) for Reject, Cancel (always, regardless of dependents), and Archive operations. This prevents accidental data loss.
9. **Scheduled task button restrictions**: Completed scheduled tasks do not show "Reopen" (the schedule handles re-runs). Failed scheduled tasks show only "Run Now" (no "Retry"/"Continue" since the scheduler manages retries).
10. **Human-created tasks**: Created as `pending` with no HITL approval request and no `task_created` notification (no self-notification). The UI shows "Start Execution" instead of "Approve" for human-created pending tasks. Agent-created tasks show "Approve" and trigger HITL approval flow.

---

## 3. Execution Rounds

Each task tracks an `executionRound` counter (starts at 1). It increments when:

- Reviewer requests revision (`requestRevision`)
- Scheduled task fires again (`resetTaskForRerun`)
- User clicks Retry (`retryTaskFresh`)

Within a single round, transient retries (network errors, timeouts) reuse the same LLM session — the agent picks up where it left off with full conversation history.

A new round always gets a fresh LLM session (`task_{taskId}_r{round}`).

### Context by Round Type

| Scenario | Previous execution context | LLM session |
|----------|---------------------------|-------------|
| Transient retry (same round) | N/A — same session | Reused (full history) |
| Review revision (new round) | Included with `🔴 REVISION REQUIRED` header | Fresh |
| Scheduled rerun (new round) | Included (last N rounds) | Fresh |
| User Retry (new round) | **Not included** — clean start | Fresh |

---

## 4. Scheduled (Recurring) Tasks

Scheduled tasks follow the same state machine as standard tasks, with these differences:

### Lifecycle

```
pending → in_progress → review → completed
                                     │
                            (scheduled rerun)
                                     │
                                     ▼
                                 in_progress → review → completed → ...
```

After `completed`, the `ScheduledTaskRunner` checks `nextRunAt`. When it's time, it calls `resetTaskForRerun()` which bumps `executionRound` and transitions back to `in_progress`.

### Schedule Mechanism

1. **`ScheduledTaskRunner`** polls every 60 seconds.
2. Checks `nextRunAt` against current time.
3. Fires only when task is in a "fireable" state (`completed`, `failed`) and not paused.
4. Tasks in `in_progress`, `review`, `blocked`, `pending` are **skipped** (a run is active).
5. `config.paused = true` skips the task.
6. `maxRuns` limit stops scheduling when `currentRuns >= maxRuns`.

### Schedule Configuration Editing

The schedule configuration (`every`, `cron`, `maxRuns`, `timezone`) can be modified while a scheduled task exists:

- **Frontend**: "Edit" button appears on the schedule info banner (hidden when task is running or for one-shot `runAt` tasks). Opens an inline editor to switch between interval/cron mode and set max runs.
- **API**: `PUT /api/tasks/:id/schedule` with body `{ every?, cron?, maxRuns?, timezone? }`. Setting `every` clears `cron`/`runAt`; setting `cron` clears `every`/`runAt`. Recalculates `nextRunAt`.
- **Agent tool**: `task_update` accepts a `schedule` object `{ every?, cron?, maxRuns?, timezone? }` for scheduled tasks.

### Key Differences from Standard Tasks

| Aspect | Standard Task | Scheduled Task |
|--------|---------------|----------------|
| After `completed` | Terminal (can archive) | Waits for next scheduled run |
| Review acceptance | → `completed` (done) | → `completed` → next run at `nextRunAt` |
| Deliverables | Replaced each run | Accumulated (tagged with run number) |

---

## 5. Review Flow

```
Agent (Worker)              System                     Reviewer Agent
     │                        │                              │
     │── execution finishes ─►│                              │
     │                        │── status → review ──────────►│
     │                        │── notify reviewer ──────────►│
     │                        │   (handleMessage with        │
     │                        │    task context + prompt)     │
     │                        │                              │
     │                        │◄── acceptTask() ─────────────│
     │                        │    (→ completed)              │
     │                        │  OR                           │
     │                        │◄── requestRevision(reason) ──│
     │                        │    (→ in_progress, new round) │
     │                        │                              │
     │◄── auto re-execute ───│                              │
     │                        │                              │
```

### Reviewer Notification

When a task enters `review` status (via `updateTaskStatus`), the system automatically:
1. Looks up the `reviewerAgentId` on the task
2. Sends a structured review request message to the reviewer agent via the mailbox (`sendMessage`)
3. The message includes: task description, deliverables, subtask status, recent notes, and instructions

### Reviewer Actions

- **Approve**: Calls `acceptTask(taskId)` → task moves to `completed`
- **Request Revision**: Calls `requestRevision(taskId, reason)` → task moves to `in_progress` with incremented `executionRound`

---

## 6. Comment & Notification Rules

Comments on tasks and requirements trigger agent notifications via the agent's **mailbox**. Notifications are enqueued as `task_comment` or `requirement_update` mailbox items. The system ensures **each agent receives at most one notification per comment**, regardless of how many rules match. See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for details on the mailbox architecture.

### 6.1 Task Comment Notifications

When a comment is posted on a task, the following agents are notified (in priority order, deduplicated):

| # | Who | Condition | Mechanism | Reason |
|---|-----|-----------|-----------|--------|
| 1 | @mentioned agents | Always (except self and assignee on `in_progress` tasks) | `enqueueToMailbox('task_comment')` | Explicit intent to notify |
| 2 | Assigned agent (`assignedAgentId`) | Task is `in_progress` | Live inject into LLM session (`injectUserMessage`) | Agent sees comment immediately in current work context |
| 3 | Assigned agent (`assignedAgentId`) | Task is NOT `in_progress` | `enqueueToMailbox('task_comment')` | Agent is not actively working, needs separate notification |
| 4 | Creator (`createdBy`) | Task is NOT `in_progress` | `enqueueToMailbox('task_comment')` | Creator should know about discussion on their task |

**Key rules:**
- **Deduplication**: A `Set` tracks notified agent IDs. Each agent gets exactly one notification, even if they match multiple rules (e.g., creator = assignee, or creator is also @mentioned).
- **Self-skip**: The comment author never receives a notification about their own comment.
- **In-progress optimization**: When the task is `in_progress`, the assigned agent already receives every comment via live session injection. No separate mailbox notification is sent. The creator is also skipped — the assignee is responsible during execution.
- **@mention overrides**: Explicit @mentions always trigger notification, even for agents who would otherwise be skipped (except the assigned agent on `in_progress` tasks who already gets inject, and the comment author).

### 6.2 Requirement Comment Notifications

| # | Who | Condition | Mechanism |
|---|-----|-----------|-----------|
| 1 | @mentioned agents | Always (except self) | `enqueueToMailbox('requirement_comment')` |
| 2 | Creator (`createdBy`) | Always (except self) | `enqueueToMailbox('requirement_comment')` |

Requirements have no running agent, so there is no live injection mechanism. All notifications are routed through the mailbox.

### 6.3 Requirement Approval Notifications

When a human approves or rejects an agent-proposed requirement (`source: 'agent'`), the creator agent receives a `requirement_update` mailbox item with `actionRequired: true` and priority 1 (high). Both decisions trigger an LLM call with `scenario: 'requirement_action'`, prompting the agent to take immediate action:

| Decision | Notified | Agent Action |
|----------|----------|--------------|
| **Approved** | Creator agent | Create tasks via `task_create` to fulfill the requirement |
| **Rejected** | Creator agent | Review rejection reason; resubmit via `requirement_resubmit` with updates, or abandon |

Both decisions also create an HITL notification visible in the UI notification bell.

### 6.4 Notification Paths

Comments flow through two code paths depending on the caller:

| Path | Caller | File |
|------|--------|------|
| HTTP API | Human via Web UI | `api-server.ts` POST `/api/tasks/:id/comments`, `/api/requirements/:id/comments` |
| Agent tool | Agent via `task_comment` / `requirement_comment` | `task-service.ts` `postTaskComment()`, `postRequirementComment()` |

Both paths apply identical notification logic (dedup, self-skip, stakeholder auto-notify).

---

## 7. Cancellation

### Single Task Cancellation

When a task is cancelled:
1. Running execution is stopped (cancel token)
2. Status → `cancelled`
3. Dependent tasks are checked:
   - If the cancelled task was a dependent's **only** remaining blocker, the dependent unblocks
   - If the dependent has other incomplete blockers, it stays `blocked`

### Cascade Cancellation

User can choose to cascade-cancel all dependent tasks:
1. The task and all its `blocked` dependents are cancelled
2. Their dependents are recursively checked

### What Cannot Be Cancelled

- `pending` tasks → use Reject instead (sets `rejected`)
- Already terminal tasks (`completed`, `failed`, `cancelled`, `rejected`, `archived`)

---

## 8. Requirement FSM

Requirements represent high-level work items fulfilled by one or more tasks.

### State Transition Diagram

```
 (agent)              (human approves)       (agent reviews &
    │                       │                 marks complete)
    ▼                       ▼                       ▼
  pending ──────────► in_progress ──────────► completed
    │  ▲                    ▲
    ▼  │                    │
  rejected ── resubmit ──┘  │
                             │
  any ──► cancelled          │
                             │
  [all tasks done] ──notify agent──┘ (agent decides: complete or create more tasks)
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| (new, agent) | `pending` | Agent proposes via `requirement_propose` |
| (new, human) | `in_progress` | User creates directly (auto-approved) |
| `pending` | `in_progress` | User approves |
| `pending` | `rejected` | User rejects |
| `rejected` | `pending` | Agent resubmits via `requirement_resubmit` (optionally with updates) |
| `in_progress` | `completed` | Agent evaluates all tasks done and marks complete |
| any | `cancelled` | Manual cancellation |

### Key Rules

1. **User-created requirements auto-approve** — start at `in_progress`
2. **Agent proposals need user approval** — start at `pending`
3. **Max 3 pending proposals per agent** — prevents spam
4. **Completion is agent-driven** — when all linked tasks reach terminal state, the system notifies the creator agent (via `requirement_update` with `actionRequired: true`). The agent reviews the results and decides whether to mark the requirement as `completed` or create additional tasks. There is no automatic completion.
5. **Approval triggers agent action** — when a requirement is approved (`pending → in_progress`), the creator agent receives a high-priority `requirement_update` with `actionRequired: true`, prompting immediate task creation.
6. **No `approved` intermediate state** — approval goes directly to `in_progress`, same as tasks
7. **No `draft` state** — items are created directly as `pending`; there is no separate drafting phase
8. **Rejected requirements can be resubmitted** — agent calls `requirement_resubmit` to move back to `pending`, optionally updating title, description, priority, or tags. Rejection metadata is cleared on resubmit
9. **Heartbeat checks requirements** — agents proactively check their created requirements during heartbeat: reviewing progress of `in_progress` requirements, reminding users about stale `pending` proposals, and handling `rejected` requirements

---

## 9. Mailbox Notifications for State Changes

Every status transition in both task and requirement FSMs generates an automatic **mailbox notification** to the relevant agent. This ensures agents maintain full awareness of their work state.

### Task Status Changes

`updateTaskStatus()` enqueues a `task_status_update` item to the assigned agent's mailbox for non-execution status transitions. When a transition triggers execution (→ `in_progress`), the notification is **skipped** because `runTask()` sends its own `task_status_update` with execution context via `sendTaskExecution()`:

```
non-execution status change → agent.enqueueToMailbox('task_status_update', {
  summary: "Task 'X' status: old → new",
  content: transition details + action guidance,
  taskId
})

execution trigger (→ in_progress) → runTask() → agent.sendTaskExecution() → enqueues task_status_update with extra.triggerExecution
```

### Requirement Status Changes

`updateRequirementStatus()` enqueues a `requirement_update` item to the creator agent:

```
requirement status change → agent.enqueueToMailbox('requirement_update', {
  summary: "Requirement 'X' status: old → new",
  content: transition details,
  requirementId, fromStatus, toStatus
})
```

### Design Rationale

- **Informational context only**: Task status notifications (`task_status_update`) are enqueued with `invokesLLM: false` — they do **not** trigger LLM processing. They exist as decision context for triage and as episodic memory, not as work items.
- **Side-effect system handles all actions**: The `updateTaskStatus()` method in `TaskService` automatically handles all real side effects triggered by status changes:
  - **→ `in_progress`**: Auto-starts task execution via `runTask()`
  - **Leaving `in_progress`**: Cancels any running execution
  - **→ `review`**: Notifies the reviewer agent
  - **Terminal states** (`completed`, `failed`, `cancelled`): Checks and unblocks dependent tasks
- **Agents should NOT duplicate these actions**: Do not send A2A messages to notify about task status changes — the system handles everything. A2A should only be used for substantive coordination that goes beyond a status change.
- **Episodic memory**: These notifications become part of the agent's mailbox timeline — the authoritative record of everything that happened. See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md).
- **Event-driven**: Notifications are fire-and-forget (`enqueueToMailbox`). The agent's attention controller uses them as context during triage deliberation.

---

## 10. Migration from Legacy Statuses

On startup, the following data migrations run automatically:

| Table | Old Value | New Value | Reason |
|-------|-----------|-----------|--------|
| `tasks` | `pending_approval` | `pending` | Unified naming |
| `requirements` | `draft` | `pending` | `draft` state eliminated |
| `requirements` | `pending_review` | `pending` | Unified naming |
| `requirements` | `approved` | `in_progress` | `approved` state eliminated |
