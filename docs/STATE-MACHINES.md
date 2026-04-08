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

**All state transitions go through `updateTaskStatus()`** — no direct status mutation.

| From | To | Trigger | Method |
|------|----|---------|--------|
| `pending` | `in_progress` | Human approves (no blockers) | `approveTask()` |
| `pending` | `blocked` | Human approves (has unmet blockers) | `approveTask()` |
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
| → `completed` / `failed` / `cancelled` / `rejected` | Set `completedAt`; check dependent tasks for unblocking |
| → `review` | Notify reviewer agent automatically |

### Key Rules

1. **Single entry point**: All status changes go through `updateTaskStatus()`. Methods like `approveTask`, `acceptTask`, `requestRevision` prepare the task then delegate to `updateTaskStatus`.
2. **Workers cannot self-complete**: Execution finish → `review`, not `completed`. A reviewer must approve.
3. **Reviewer ≠ Worker**: Self-review is blocked. `reviewerAgentId` is mandatory at task creation.
4. **Retry = fresh start**: Retry increments `executionRound`, creates a new LLM session, discards previous execution context. Only the task description and notes carry over.
5. **Pause = blocked**: Pausing a running task sets it to `blocked` and cancels execution. Resume calls `runTask` with full previous context.
6. **Rejected ≠ Cancelled**: `rejectTask()` sets `rejected` (proposal denied before work). `cancelTask()` sets `cancelled` (work stopped after starting). `rejected` is a terminal state — the proposal was not approved.

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
2. Sends a structured review request message to the reviewer agent via `handleMessage`
3. The message includes: task description, deliverables, subtask status, recent notes, and instructions

### Reviewer Actions

- **Approve**: Calls `acceptTask(taskId)` → task moves to `completed`
- **Request Revision**: Calls `requestRevision(taskId, reason)` → task moves to `in_progress` with incremented `executionRound`

---

## 6. Cancellation

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

## 7. Requirement FSM

Requirements represent high-level work items fulfilled by one or more tasks.

### State Transition Diagram

```
 (agent)              (human approves)       (all tasks done)
    │                       │                       │
    ▼                       ▼                       ▼
  pending ──────────► in_progress ──────────► completed
    │
    ▼
  rejected
               
  any ──► cancelled
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| (new, agent) | `pending` | Agent proposes via `requirement_propose` |
| (new, human) | `in_progress` | User creates directly (auto-approved) |
| `pending` | `in_progress` | User approves |
| `pending` | `rejected` | User rejects |
| `in_progress` | `completed` | All linked tasks reach terminal state |
| any | `cancelled` | Manual cancellation |

### Key Rules

1. **User-created requirements auto-approve** — start at `in_progress`
2. **Agent proposals need user approval** — start at `pending`
3. **Max 3 pending proposals per agent** — prevents spam
4. **Completion is automatic** — when all linked tasks terminate
5. **No `approved` intermediate state** — approval goes directly to `in_progress`, same as tasks
6. **No `draft` state** — items are created directly as `pending`; there is no separate drafting phase

---

## 8. Migration from Legacy Statuses

On startup, the following data migrations run automatically:

| Table | Old Value | New Value | Reason |
|-------|-----------|-----------|--------|
| `tasks` | `pending_approval` | `pending` | Unified naming |
| `requirements` | `draft` | `pending` | `draft` state eliminated |
| `requirements` | `pending_review` | `pending` | Unified naming |
| `requirements` | `approved` | `in_progress` | `approved` state eliminated |
