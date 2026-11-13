# State Machines

This document defines the Finite State Machine (FSM) specifications for tasks, requirements, and related subsystems in Markus (goals, callbacks, mailbox items, A2A channels, notebook).

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
| `blocked` | `failed` | Blocker failed → cascade fail (dead dependency) | `autoFailBlockedDependent()` |
| `review` | `completed` | Reviewer approves | `acceptTask()` |
| `review` | `in_progress` | Reviewer requests revision (new round) | `requestRevision()` |
| `review` | `cancelled` | User cancels | `cancelTask()` |
| `failed` | `in_progress` | User clicks Retry (fresh start, new round) | `retryTaskFresh()` |
| `failed` | `archived` | Manual archival | `archiveTask()` |
| `completed` | `archived` | Manual archival | `archiveTask()` |
| `cancelled` | `in_progress` | Run Now (scheduled tasks) | `resetTaskForRerun()` |
| `cancelled` | `archived` | Manual archival | `archiveTask()` |
| `rejected` | `archived` | Manual archival | `archiveTask()` |

### Side Effects in `updateTaskStatus()`

| Trigger | Side Effect |
|---------|-------------|
| → `in_progress` (from non-`in_progress`) | Auto-start: `runTask()` via `setImmediate` |
| `in_progress` → anything else | Cancel running execution (cancel token) |
| → `completed` / `failed` / `cancelled` / `rejected` / `archived` | Set `completedAt`; check dependent tasks for unblocking |
| → `review` | Notify reviewer (agent via mailbox, or human via approval request) |
| **Most status changes** | Enqueue `task_status_update` to assigned agent's mailbox (see [mailbox-system.md](./mailbox-system.md)). Skipped when: (a) auto-start triggers execution (the execution-mode item serves as both trigger and notification), or (b) `in_progress → review` (assignee self-initiated via `task_submit_review`) |

### FSM Enforcement

The legal transition set is defined as a declarative matrix `TASK_TRANSITIONS` in `@markus/shared/types/task.ts`. `updateTaskStatus()` validates every transition against this matrix and rejects any transition not present. This is the single source of truth — when adding a new status or transition, update the matrix first, then update this document.

### Key Rules

1. **Single entry point**: All status changes go through `updateTaskStatus()`. Methods like `approveTask`, `acceptTask`, `requestRevision` prepare the task then delegate to `updateTaskStatus`.
2. **Workers cannot self-complete**: Execution finish → `review`, not `completed`. A reviewer must approve.
3. **Reviewer ≠ Worker**: Self-review is blocked. `reviewerId` is mandatory at task creation.
4. **Retry = fresh start**: Retry increments `executionRound`, creates a new LLM session, discards previous execution context. Only the task description and notes carry over.
5. **Pause = blocked**: Pausing a running task sets it to `blocked` and cancels execution. Resume calls `runTask` with full previous context.
6. **Rejected ≠ Cancelled**: `rejectTask()` sets `rejected` (proposal denied before work). `cancelTask()` sets `cancelled` (work stopped after starting). `rejected` is a terminal state — the proposal was not approved.
7. **Preemption ≠ blocked**: When the attention controller **preempts** (pauses) a task for a higher-priority item, the task stays `in_progress` (not `blocked`). The mailbox item is deferred and automatically resurfaced when the agent is idle. The same execution round and session context are preserved. **Cancellation** is different: when the controller **cancels** a task (because the incoming message explicitly revokes the work), the mailbox item is permanently dropped and will NOT be resumed.
8. **Irreversible actions require confirmation**: The UI requires explicit user confirmation (via modal dialogs) for Reject, Cancel (always, regardless of dependents), and Archive operations. This prevents accidental data loss.
9. **Scheduled task button restrictions**: Completed scheduled tasks do not show "Reopen" (the schedule handles re-runs). Failed scheduled tasks show only "Run Now" (no "Retry"/"Continue" since the scheduler manages retries). Cancelled scheduled tasks show "Run Now" and "Resume Schedule" to allow re-activation.
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
4. Tasks in `in_progress`, `review`, `blocked`, `pending`, `cancelled`, `archived`, `rejected` are **skipped**.
5. `config.paused = true` skips the task.
6. `maxRuns` limit stops scheduling when `currentRuns >= maxRuns`.
7. **Cancelling** a scheduled task automatically pauses its schedule (`config.paused = true`). The user can later resume the schedule or use "Run Now" to manually trigger execution.

### Schedule Configuration Editing

The schedule configuration (`every`, `cron`, `maxRuns`, `timezone`) can be modified while a scheduled task exists:

- **Frontend**: "Edit" button appears on the schedule info banner (hidden when task is running or for one-shot `runAt` tasks). Opens an inline editor to switch between interval/cron mode and set max runs.
- **API**: `PUT /api/tasks/:id/schedule` with body `{ every?, cron?, maxRuns?, timezone? }`. Setting `every` clears `cron`/`runAt`; setting `cron` clears `every`/`runAt`. Recalculates `nextRunAt`.
- **Agent tool**: `task_update` accepts a `schedule` object `{ every?, cron?, max_runs?, timezone? }` for scheduled tasks.

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
1. Looks up the `reviewerId` on the task
2. Sends a structured review request to the reviewer — agent via mailbox, or human via HITL approval
3. The message includes: task description, deliverables, subtask status, recent notes, and instructions

### Reviewer Actions

- **Approve**: Calls `acceptTask(taskId)` → task moves to `completed`
- **Approve with notes** (`approved_with_notes`): Task moves to `completed` (or continues downstream);
  notes are stored on the task (note / metadata) and SHOULD surface to the assignee via notebook/state
  on the next related turn. Minor issues MUST NOT force a full revision round.
- **Request Revision**: Calls `requestRevision(taskId, reason)` → task moves to `in_progress` with incremented `executionRound`

### Spec: `approved_with_notes`

MUST: Review verdict enum includes `approved` | `approved_with_notes` | `rejected`.
MUST: `approved_with_notes` completes the review gate without requiring another full execution round.
MUST: Notes are persisted and visible to the assignee.
Test ID: `C-review-notes`.

### Spec: `task_context` on assign

MUST: When a task is assigned, the system attaches a read-only `task_context` package:
parent requirement summary, related deliverable refs (+ version), predecessor output summary,
project knowledge pointer. MUST inject into the assignee's first `execute` pack turn under a hard cap.
Test ID: `C-task-context-inject`.

### Spec: Deliverable versioning

MUST: `deliverable_update` increments `version` and appends a `changelog` entry.
MUST: Reads return current `version`.
Test ID: `C-deliv-version`.

### Spec: Subtask soft cap

MUST: When subtask count would exceed `SUBTASK_SOFT_CAP` (8), the tool MUST warn in the result
but MUST NOT block creation.
Test ID: `C-subtask-soft-cap`.

### Spec: Deep sleep (heartbeat)

MUST: After `DEEP_SLEEP_IDLE_HEARTBEATS` consecutive idle/zero-change heartbeats with no active
tasks/pending reviews and no human/task mailbox pressure, heartbeat MUST skip the LLM call,
extend interval (≤ 24h), and wake on `human_chat` / new task / review events.
Test IDs: `A-deep-sleep-skip`, `A-deep-sleep-wake`.

### Spec: Post-task distillation

MUST: On task `completed` (and gated predicates), enqueue Learning Loop distillation
([learning-loop.md](./learning-loop.md)) without blocking the status transition.
MUST NOT: Distill on `failed` — wait for completion or human Remember.

---

## 6. Comment & Notification Rules

Comments on tasks and requirements trigger agent notifications via the agent's **mailbox**. Notifications are enqueued as `task_comment` or `requirement_comment` mailbox items. The system ensures **each agent receives at most one notification per comment**, regardless of how many rules match. See [mailbox-system.md](./mailbox-system.md) for details on the mailbox architecture.

**Structural reply-to**: Comment notifications include `replyToId` linking to a parent comment. The notification payload also includes an agent streak count (consecutive agent-only comments without human input) to help agents self-moderate reply frequency.

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
3. If the task is a scheduled task, the schedule is automatically paused (`scheduleConfig.paused = true`)
4. Dependent tasks are checked:
   - If the cancelled task was a dependent's **only** remaining blocker, the dependent unblocks
   - If the dependent has other incomplete blockers, it stays `blocked`

A cancelled scheduled task can be re-activated via "Run Now" (`cancelled → in_progress`) or by resuming the schedule after un-cancelling.

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
10. **Optional goal loop overlay** — requirements may carry `GoalConfig` (`loopEnabled`, `completionCriteria`, `maxIterations`, etc.). When enabled, a parallel goal loop state runs on top of the requirement FSM (see §11)

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
  - **→ `review`**: Notifies the reviewer (agent or human)
  - **Terminal states** (`completed`, `failed`, `cancelled`): Checks and unblocks dependent tasks
- **Agents should NOT duplicate these actions**: Do not send A2A messages to notify about task status changes — the system handles everything. A2A should only be used for substantive coordination that goes beyond a status change.
- **Episodic memory**: These notifications become part of the agent's mailbox timeline — the authoritative record of everything that happened. See [mailbox-system.md](./mailbox-system.md).
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

---

## 11. Goal Loop States

Requirements with an optional `GoalConfig` gain a **goal loop state** overlay when `loopEnabled` is true. The requirement FSM (§8) still governs approval and completion; goal loop states track heartbeat-driven iteration.

### State Diagram

```
requirement in_progress + loopEnabled
              │
              ▼
        goal_active ◄─────────────────────────┐
              │                               │
              │  heartbeat check              │  next iteration
              │  (incrementGoalIteration)     │  (autoResume)
              ▼                               │
    ┌─────────┼─────────┐                     │
    │         │         │                     │
    ▼         ▼         ▼                     │
goal_completed  goal_max_iterations    goal_paused
(criteria met)  (iteration limit)      (loop disabled
    │              │                    or waiting)
    ▼              │                      │
requirement        │                      │
→ completed        └──── goal_update ─────┘
loopEnabled=false      (re-enable / raise max)
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| — | `goal_active` | `enableGoalLoop()` or `goal_create` on an `in_progress` requirement |
| `goal_active` | `goal_active` | Heartbeat patrol assesses progress; `currentIteration` increments |
| `goal_active` | `goal_completed` | Agent evaluates criteria met → requirement marked `completed`, `loopEnabled` → false |
| `goal_active` | `goal_max_iterations` | `currentIteration >= maxIterations` |
| `goal_active` | `goal_paused` | `disableGoalLoop()` or `goal_update(loop_enabled: false)` |
| `goal_paused` | `goal_active` | `enableGoalLoop()` / `goal_update(loop_enabled: true)` with `autoResume` |
| `goal_max_iterations` | `goal_active` | `goal_update` raises `max_iterations` or resets iteration count |

### Key Rules

1. **Heartbeat-driven** — active goals appear in the heartbeat **Active Goals** section via `goalFetcher`; the agent creates follow-up tasks and reassesses each iteration
2. **Orthogonal to requirement status** — goal loop states apply only while the requirement is `in_progress`; terminal requirement statuses (`completed`, `cancelled`, `rejected`) end the loop
3. **Safety cap** — `maxIterations` prevents unbounded heartbeat cycles; hitting the limit enters `goal_max_iterations`, not automatic completion
4. **Tools** — `goal_create`, `goal_update`, `goal_status` manage the loop; see [mailbox-system.md](./mailbox-system.md) §11.4

---

## 12. Pending Callback States

`PendingCallbackRegistry` tracks async operations (e.g., `background_exec`) that must report results through the mailbox. See [mailbox-system.md](./mailbox-system.md) §11.3.

### State Diagram

```
registerBackgroundSession()
              │
              ▼
          pending ────── resolve() ──────► resolved
              │         (operation done)     │
              │                              └── enqueue callback_result
              │
              ├── getTimedOut() ──► timed_out
              │                          │
              │                          └── expireTimedOut() ──► expired
              │                               (removed; surfaced in heartbeat)
              └── (server restart) ──► pending  (restored from SQLite)
```

### Transitions

| From | To | Trigger | Side Effect |
|------|----|---------|-------------|
| — | `pending` | `registerBackgroundSession()` / `PendingCallbackRegistry.register()` | Persisted via `SqlitePendingCallbackRepo` |
| `pending` | `resolved` | Operation completes; `resolve(id)` | Registry entry removed; `callback_result` mailbox item enqueued |
| `pending` | `timed_out` | Heartbeat calls `getTimedOut()` (`now - registeredAt > timeoutMs`) | Detected only — entry still in registry |
| `timed_out` | `expired` | Heartbeat calls `expireTimedOut(id)` | Registry entry removed; details injected into heartbeat prompt (no `callback_result`) |
| `pending` | `pending` | Server restart | `setPersistence()` restores all pending callbacks |

### Key Rules

1. **Resolved → mailbox** — only the `resolved` path produces a `callback_result` item; timeouts are surfaced for agent investigation, not auto-enqueued
2. **Default timeout** — 10 minutes for `background_exec`
3. **Origin session preserved** — `originSessionId` on the callback is copied into `callback_result.extra` for session resumption

---

## 13. Mailbox Item Lifecycle (`callback_result`)

All mailbox items, including `callback_result`, follow the standard attention pipeline. See [mailbox-system.md](./mailbox-system.md) §6.5.

### Pipeline

```
enqueue (queued)
    │
    ▼
dequeueAsync → (entity lock, concurrent mode) → processing
    │
    ▼
AttentionController triage → handleMessage(originSessionId)
    │
    ▼
complete (completed)
```

> **Concurrent mode.** With a worker pool ([concurrent-processing.md](./concurrent-processing.md)),
> a worker takes an **entity-affinity lock** right after `dequeueAsync` and releases it in a
> `finally` after processing; items whose entity is already locked are skipped by
> `dequeue()` (put back and retried after a back-off). The worker loop **does not run
> triage / interrupt logic**, so the `deferred`, `dropped`, and `preempt` outcomes below are
> produced by the **serial** loop only. A worker's terminal outcomes are: *completed*,
> *requeued* (backstop timeout / non-user failure), or *completed-incomplete* for user items.

### Terminal Outcomes (all mailbox items)

After `processFocusedItem` runs, exactly one terminal outcome is chosen (implemented in
[`attention.ts`](../../packages/core/src/attention.ts) `processFocusedItem`):

| Outcome | Trigger | Persistence effect | Resumable? |
|---------|---------|--------------------|-----------|
| **completed** | Normal finish (marker present, or accepted without-retry case) | `complete(id)` | No (done) |
| **bounced** | Explicit `cancel` decision / `[cancelled]` reply / abnormal terminal | `drop(id, why, dropReason)` → `bounced` → `catch_all` | No (reason queryable) |
| **deferred** | `preempt` decision / `[preempted]` reply | `deferDequeued(item)` | Yes — `resurfaceDue()` re-queues when idle |
| **requeued** | Backstop **timeout**, agent stopped mid-flight, or abnormal reply on a background type (< max retries) | `requeue(item)` | Yes — re-processed from queue |
| **completed (incomplete)** | Marker still missing after in-session continuation, or abnormal reply on a user-interaction item | `complete(id)` | No |

**Specs that refine these outcomes** (behavior/invariants/tests live in
[mailbox-system.md](./mailbox-system.md)):

- **Timeout → requeue must be single-flight**: on backstop timeout the in-flight processing
  is cancelled and any late result is discarded, so a requeue cannot double side effects.
  Status: planned.
- **completed (incomplete) must be visible**: the marker-missing terminal emits a structured
  `incomplete` event / activity entry rather than resolving silently. Status: planned.

### `callback_result` Specifics

| Stage | Behaviour |
|-------|-----------|
| **Enqueue** | Priority 1 (high); `invokesLLM: true`; payload includes `callbackId`, `originSessionId`, `callbackType` in `extra` |
| **Process** | Routed to originating session when known; falls back to system session |
| **Complete** | Activity recorded; item marked `completed` in persistence |

Unlike informational `task_status_update` items, `callback_result` always invokes an LLM call — the agent must act on async operation outcomes.

---

## 14. A2A DM Channel States

A2A messaging routes through **deterministic DM channels** (`dm:a2a:{sorted_id_1}:{sorted_id_2}`). Channels are created lazily on the first message and persist indefinitely — there is no explicit close state.

### State Diagram

```
(first agent_send_message between pair)
              │
              ▼
          created ──► active ◄──────┐
                        │           │
                        │  messages │  new message
                        ▼           │
                      idle ─────────┘
                 (no recent traffic)
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| — | `created` | First A2A message; `ensureDmChannel()` creates group-chat record with deterministic `channelKey` |
| `created` | `active` | Message sent/received; persisted to `channel_messages`, target agent mailbox enqueued (`a2a_message`) |
| `active` | `idle` | No messages for a period (implicit — channel remains open) |
| `idle` | `active` | New `agent_send_message` or inbound `a2a_message` |

### Key Rules

1. **One channel per agent pair** — IDs sorted lexicographically; same key regardless of sender
2. **Stable sessions** — session ID derived from `channel_{channelKey}_{agentId}`; history recallable via `recall_context`
3. **Fire-and-forget** — `agent_send_message` is always async; no `wait_for_reply`
4. **No teardown** — channels survive agent restarts and idle periods; see [mailbox-system.md](./mailbox-system.md) §11.1

---

## 15. Notebook Lifecycle

`NOTEBOOK.md` is the agent's persistent cognitive workspace. Entry lifecycle is separate from task/requirement FSMs but follows the agent runtime.

### State Diagram

```
agent start
    │
    ▼
loadNotebook() ──► in-memory Map (keyed entries)
    │
    ├── session: updateWorkingMemory / triage
    │       │
    │       └── scheduleNotebookPersist (2s debounce)
    │               │
    │               ▼
    │         saveNotebook() → NOTEBOOK.md on disk
    │
agent stop
    │
    └── flush debounce → persistNotebookSync()
```

### Entry Managed Types

| Tag | Writer | Purpose |
|-----|--------|---------|
| `agent` | `notebook_upsert` / `notebook_clear` / `notebook_read` | Agent-chosen keys (priorities, blockers, decisions) |
| `system` | Triage, mechanical retrieval | `triage-decision`, `relevant-context` |

### Transitions

| Event | Effect |
|-------|--------|
| Agent start | `loadNotebook(dataDir)` populates in-memory workspace; injected as `## Notebook` in every turn |
| Entry upsert | `updateWorkingMemory(key, content, managed?)` — agent-managed entries capped at 4 keys / 6000 chars each |
| Entry clear | `clearWorkingMemory(key?)` — single key or all entries |
| Debounced persist | 2s after last mutation → `saveNotebook()` |
| Agent stop | Cancel debounce timer; synchronous final `persistNotebookSync()` |

See [memory-system.md](./memory-system.md) and [cognitive-architecture.md](./cognitive-architecture.md) for storage format and deterministic context assembly.

---

## 16. WorkUnit Lifecycle

A `WorkUnit` is the identity object for **one piece of work** — one chat turn, one task execution epoch, or one A2A delivery. Before cut 7 the same work was described by five mechanisms and had no queryable identity: "what is this agent doing" could only be inferred from a context block assembled per turn, so the answer could drift from what was actually running.

Everything below is taken from the code, not from the design plan:

| Fact | Source of truth |
|---|---|
| State set and transition matrix | `packages/shared/src/work-unit.ts` (`WU_TRANSITIONS`) |
| Schema and the only SQL writes | `packages/storage/src/sqlite-storage.ts` (`SqliteWorkUnitRepo`) |
| Business writer and event contract | `packages/org-manager/src/work-unit-service.ts` (`WorkUnitService`) |

### State Set (closed)

| State | Meaning |
|---|---|
| `running` | executing right now |
| `idle` | turn settled; the work is still alive and waiting for its next input |
| `paused_budget` | paused because the budget line was reached (no producer in C7-A) |
| `terminated` | cancelled or closed as failed |
| `archived` | terminal; takes part in no scheduling afterwards |

Every state is answerable from structure. None of them is inferred from a payload or from prose.

### State Diagram

```
        (new turn)
             │
             ▼
   ┌──► running ──────────► idle
   │      │  │                │
   │      │  └──► paused_budget ──┐
   │      │                       │ (budget topped up)
   │      └──────────────┐        │
   │                     ▼        ▼
   │                 terminated ◄─┘
   │                     │
   │                     ▼
   └───── refused ──── archived   (terminal — no outgoing edge)
```

### Transitions

Copied verbatim from `WU_TRANSITIONS` — this table is a read of that constant, never a second definition of it.

| from | allowed to | trigger |
|---|---|---|
| `running` | `idle` / `paused_budget` / `terminated` | turn settled / budget line reached / cancelled |
| `idle` | `running` / `terminated` | new turn / cancelled |
| `paused_budget` | `running` / `terminated` | budget topped up / cancelled |
| `terminated` | `archived` | archived |
| `archived` | — | terminal |

`archived` has no outgoing edge on purpose: archiving is the only way to say "this is over". Resuming the work means a **new** WorkUnit (new `ref`, or a new round) — never resurrecting the old one. Allowing `archived → running` would make archiving a revocable decoration and historical readings would start to drift. The enforcement is a guard fixture, not a convention: `work-unit-single-writer` fails if `archived` stops being `[]`.

### Single Writer

Three layers, one responsibility each, and no layer reaches into another's:

| Layer | File | Owns |
|---|---|---|
| Concept | `packages/shared/src/work-unit.ts` | State set, matrix, `ref` format — pure functions, no I/O |
| Storage | `SqliteWorkUnitRepo` | The **only** SQL that writes `work_units` and `status_transitions` rows for `entity_type='work_unit'` |
| Business | `WorkUnitService` | The **only** caller of those write methods; decides whether a failed write may interrupt the business path |

Both entry points are idempotent or conditional by construction:

- `ensure(ref)` uses `INSERT ... ON CONFLICT(ref) DO NOTHING` and then reads back by `ref`. Check-then-insert is not equivalent: under concurrency both workers observe "absent" and the execution epoch ends up with two identities, or the unique index aborts a real delivery. Exactly one row per `ref` is decided by `uq_work_units_ref`, not by caller discipline.
- `transition(ref, to)` is an optimistic conditional update (`WHERE id = ? AND status = ?`). An unconditional update would overwrite a terminal state back to `running` when two writers race, and the state machine would become decoration.

`scripts/architecture-guard.mjs` enforces the boundary as rule group `work-unit-single-writer`, with six checks — each carrying its own compliant/violating fixture, so the detector cannot silently stop detecting:

| # | Check |
|---|---|
| 1 | `work_units` table and `uq_work_units_ref` unique index exist (identity decided by the index) |
| 2 | `ensure()` is the atomic `ON CONFLICT(ref) DO NOTHING` insert, not check-then-insert |
| 3 | `transition()` is the conditional update `WHERE id = ? AND status = ?` |
| 4 | `WU_TRANSITIONS` is defined in one place and `archived` is terminal |
| 5 | `task-service.ts` contains no `INSERT INTO work_units` / `UPDATE work_units` |
| 6 | `api-server.ts` contains no `work_units` SQL and no `entityType: 'work_unit'` |

Checks 5 and 6 exist because the realistic regression is not "someone rewrites the repo" — it is "someone adds one convenient UPDATE in the service that already has the data". That is a second writer, and it bypasses both the matrix and the unique index.

### Producers and `ref` formats

Three producers, one generator (`WORK_UNIT_REF` in `packages/shared/src/work-unit.ts`). A second generator would mean the same execution epoch can grow two WorkUnits, and nobody could later say which one it was.

| Producer | Call site | `ref` |
|---|---|---|
| Chat turn | `persistChatTurn()` in `org-manager/src/api-server.ts` | `session:<dbSessionId>:r<round>` |
| Task execution epoch | `TaskService.createTask()` in `org-manager/src/task-service.ts` | `task_<taskId>_r<round>` |
| A2A delivery | `AgentDelivery.deliver()` in `org-manager/src/agent-delivery.ts` | `a2a:<channelKey>:<deliveryId>` |

`task_<taskId>_r<round>` is **reused, not invented**: that string is already the execution-epoch identity (the in-flight registry key and the execution session id). Giving the same epoch a second naming scheme would hand it two identity cards, so this cut only routes the existing format through a single generator.

The A2A producer binds the row to the **recipient** (`agentId: targetId`, `contextRef: channelKey`), because the WorkUnit answers "which work is this delivery part of" for the side that owns the delivered mailbox row. `deliveryId` is the same value as the envelope `messageId`, so a retried hop cannot produce a second WorkUnit.

### Fact-Source Boundary

A message's WorkUnit identity is written in exactly one place: the `mailbox_items.work_unit_ref` column. `DeliveryEnvelope.workUnitRef` stays `null` in cut 7.

The reason is structural: two writers of the same fact always drift, and of the two the column is the one that can be indexed and joined while the envelope is a JSON projection. If a projection is ever needed (cross-org delivery carrying WU identity inside the envelope), derive it from the column — do not write both.

The write order is fixed and must not be reversed: `ensure()` first, `linkMailboxItem()` second. Writing the reference before the entity exists is precisely the dangling reference that cut 6 avoided by adding the column and writing zero rows.

### Current State in C7-A (what is deliberately not in force)

| Thing | State in C7-A |
|---|---|
| `work_units.budget` / `used` | Columns only. No producer writes `budget`; `used` stays `0`. No budget semantics exist. |
| `paused_budget` | Expressible in the matrix, **no producer**. Nothing reaches it in this cut. |
| `parent_id` | Column exists, written `NULL` only. Parent/child delegation is C7-B. |
| Subagent budget | `DEFAULT_MAX_SUBAGENT_ITERATIONS` is still `Infinity` (`packages/core/src/tools/subagent.ts`); the aggregate breaker is still `SUBAGENT_MAX_AGGREGATE_ITERATIONS` (`packages/shared/src/limits.ts`). Two budget notions still exist. |

Budget unification, `paused_budget` production, `sessionLockKey` derivation from `context_ref`, and parent/child rows all belong to **C7-B**. This section must not describe a single budget semantic until that code exists — a document that runs ahead of the code teaches the next reader that the work is already done.

### Failure Semantics

Observation must never become a business fault, and it must never fail silently either — cut 6's lesson was a column that stayed empty with nothing to notice it. All business-path writers swallow write errors and emit a structured event. The four event names are the contract; tests assert on names and counters, never on log text:

| Event | Meaning |
|---|---|
| `work_unit.created` | A row was actually inserted (an idempotent hit is **not** this) |
| `work_unit.ensure_failed` | The row could not be created; business proceeds without identity, and the miss is counted |
| `work_unit.transition_failed` | Status update failed for a non-matrix reason (storage, or a concurrent write won) |
| `work_unit.link_failed` | The WorkUnit exists but the mailbox row could not be pointed at it |

One deliberate exception: an illegal transition is a program error, not a recoverable branch. `transition()` throws with `code='invalid_work_unit_transition'` and leaves the state unchanged. Returning `false` instead would let callers believe "the transition failed but the world is fine", which makes the matrix decorative.

### Reading It Back

`work_status()` answers "which WorkUnits does this agent have" from `work_units` alone, returning `ref / status / parentId / claimedBy / leaseUntil / budget / used`.

It reads no payload and no session text. A structural question must be answered by structure: the pre-cut-7 answer was recomputed from an injected text block every turn, which is a snapshot that can drift from what is really executing.

See [mailbox-system.md](./mailbox-system.md) for the delivery envelope and mailbox columns this identity is attached to.

### C7-B — budget has exactly one meaning now

C7-A deliberately left `budget` / `used` as empty columns. C7-B gives them semantics, and
the point of writing it here is that **there must never be a second budget notion**.

| Fact | Single source | What is forbidden |
|---|---|---|
| Unit of `budget` / `used` | **iteration count** (same unit as today's loop caps) | A second unit (e.g. tokens) computed anywhere; token quota is a future column, not a reinterpretation |
| Who writes `used` | `WorkUnitService.recordUsage()` → `SqliteWorkUnitRepo.addUsage()` (`used = used + ?`) | Any delegation path computing or writing its own tally |
| Who decides "budget reached" | `WorkUnitService.settle()` → the matrix | A path letting a child stop without a state + transition row |

Token accounting is not in this cut. When it arrives it gets its own columns; reusing
`budget` for tokens would silently rewrite the meaning of every existing row.

#### `paused_budget` — entry and exit

| Direction | Condition | Transition |
|---|---|---|
| Enter | the child's own iteration budget is exhausted (`used >= budget`, reported as `budgetHit: 'own'`) | `running → paused_budget` |
| Leave | budget is topped up | `paused_budget → running` |
| Leave | the work is cancelled | `paused_budget → terminated` |

`idle` and `paused_budget` are **not** the same fact: `idle` means "this unit finished its
turn", `paused_budget` means "this unit was stopped by money, not by completion". That
distinction lives in the state (and in the `status_transitions` row), never only in the
result text — otherwise "why did it stop" has to be re-derived from prose.

#### The circuit breaker is a breaker again

`SUBAGENT_MAX_AGGREGATE_ITERATIONS` (100) is **not** a schedule. The history is worth
recording because the prompt text was already right and the code was not: the fan-out used
to pre-allocate it as a shared pool (`{ remaining: 100 }`), so a wide fan-out consumed it as
its budget and siblings starved each other — the "zero-product fan-out" failure. The prompt
said `circuit breaker` the whole time.

What is true now:

- each child gets a **finite, independent** per-child budget (`iteration_budget`, else
  `SUBAGENT_DEFAULT_ITERATION_BUDGET`); no child can spend a sibling's rope;
- scheduling lives in `work_units.budget` / `used` — one ledger, one writer;
- the aggregate constant survives only as an **abnormal fallback ceiling**, and the per-child
  default is derived from it (`breaker / max parallel`), so a correctly configured full-width
  fan-out lands exactly on the ceiling instead of silently exceeding it;
- an exhausted child returns a structured result (`status`, `budgetHit`, `iterations`,
  `filesTouched`, `toolCalls`, and — from C7-B — its `workUnitRef`), never an empty success.

#### Delegation produces the parent/child chain

All **three** delegation paths create the child before running it, and all three land
`parent_id`. They differ only in where the parent comes from, and in each case it is a
structural fact, never an inference:

| Path | Child is created by | `parent_id` source | `ref` |
|---|---|---|---|
| `spawn_subagent` | `DelegationWorkUnitPort.ensureChild()` | the current turn's WorkUnit (`onFocusChanged`) | `WORK_UNIT_REF.delegation(parentRef, childKey)` |
| `spawn_subagents` (fan-out) | same port, once per child | same; `childKey` = caller's `task.id` | same generator |
| cross-team (A2A `deliver()`) | `DeliveryDeps.workUnits.ensure()` | the **sender** agent's current turn WorkUnit (`currentWorkUnitRef`) | `WORK_UNIT_REF.a2a(channelKey, deliveryId)` |

There is no "guess the most recent row". When a turn has no WorkUnit identity the child is
created with `parent_id = NULL` and its `ref` says so explicitly
(`delegation:root:<agentId>#<childKey>`); a delivery sent outside any turn (scheduled,
background) does the same.

The two inputs a caller may hand over are `parentId` (a handle it already holds) and
`parentRef` (it only knows *which* WorkUnit) — and `WorkUnitService.ensure()` owns the
`ref → id` resolution, with `parentId` winning when both are present. That keeps one
resolver: if every call site looked the parent up itself, the same fact would grow several
translations and they would drift.

Re-running the same fan-out collapses onto the same rows instead of multiplying identity —
the ref is idempotent by construction (`uq_work_units_ref` is the arbiter).

#### Where each chain's mailbox item comes from

`mailbox_items.work_unit_ref` is only honest when the item identity comes from the enqueue
that actually created it. Each chain has exactly one such moment:

| Chain | Item enqueued by | Linked at |
|---|---|---|
| chat | the turn's entry enqueue | `openChatTurnWorkUnit()` (turn **start**) |
| task | the enqueue **inside** `Agent.sendTaskExecution()` | `TaskService` run / retry call sites, via that call's `onItemEnqueued` |
| a2a | `AgentDelivery.deliver()` | `deliver()` itself, right after the enqueue |

The task chain is worth stating because the obvious guess is wrong: the item is **not**
produced by TaskService's notification enqueues (`task_comment`, `requirement_comment`,
`task_status_update`). Those address *other* agents or can be sent many times per execution
round, so they cannot identify "the item that triggered this round" — one epoch, many items.
The trigger item is the one `sendTaskExecution()` enqueues, and its id exists only as that
call's return value, which is why the callback is a required parameter rather than an
optional one: an optional callback would let a caller silently leave the column NULL again.

#### `sessionLockKey` derives from `context_ref`

The concurrency lock key answers "which memory session will this turn write to". C7-B takes
it from the WorkUnit ledger (`mailbox_items.work_unit_ref → work_units.context_ref`) instead
of re-deriving it from the payload, and a pure function
(`sessionLockKeyOfContextRef`) owns the rule: **only a memory session identity (`sess_*`)
can be a session lock key**. Anything else (`cs_*` database session ids, `task_…`,
`delegation:…`) returns `undefined` and the caller falls back to the legacy
`peekTurnSessionId` path.

Two properties follow, and both are load-bearing:

- **Equivalence**: for the same memory session, ledger and legacy paths produce the same key
  (`session:<sess_*>`). Semantic drift is the only real risk of this change, so a test pins
  the two paths to each other rather than testing the new one alone.
- **Fallback is mandatory**: an empty `work_unit_ref` (old rows, non-WorkUnit paths, a chat
  item enqueued before its WorkUnit exists) must fall back, never return `undefined`, because
  a missing lock key silently disables mutual exclusion — the worst possible regression
  (2026-10-22 shape).

One benefit is structural: deriving from the ledger does not read the in-memory workspace
pointer, so it is safe outside the worker's ALS context — the trap the legacy path had to
document. The legacy path is kept as the fallback and stays the one that must be evaluated
inside ALS.

#### Current state after C7-B (honest boundaries)

| Thing | State |
|---|---|
| `budget` / `used` | Produced by delegation; unit = iterations; single writer as above |
| `paused_budget` | Reachable (child budget exhaustion) |
| `parent_id` | Written for all three delegation paths (subagent, fan-out, cross-team A2A) when the turn has a WorkUnit |
| `sessionLockKey` | Derived from `context_ref` for chat turns (memory session id, adopted at turn close), `task`/`a2a`/`delegation` context refs fall back |
| chat WorkUnit creation point | **Turn start** (`openChatTurnWorkUnit`), so `work_status()` can read `running` mid-turn; the close path only settles it to `idle` |
| task mailbox link | Written from `sendTaskExecution()`'s enqueue callback |
