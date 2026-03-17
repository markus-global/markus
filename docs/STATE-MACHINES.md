# Task & Requirement State Machines

This document defines the complete Finite State Machine (FSM) specifications for standard tasks, scheduled (recurring) tasks, and requirements in Markus.

## 1. Standard Task FSM

### States

| State | Description |
|-------|-------------|
| `pending` | Created, awaiting assignment or approval |
| `pending_approval` | Awaiting human or manager approval before work begins |
| `assigned` | Assigned to an agent, ready to start |
| `in_progress` | Agent is actively working |
| `blocked` | Blocked by unfinished dependencies |
| `review` | Agent submitted deliverables, awaiting reviewer evaluation |
| `revision` | Reviewer requested rework |
| `accepted` | Review passed (transient — auto-transitions to `completed`) |
| `completed` | Task done, branch merged, worktree cleaned up |
| `failed` | Task failed due to unrecoverable error |
| `cancelled` | Task cancelled |
| `archived` | Historical, no longer active |

### Transitions

```
                          ┌───────────────────────────┐
                          │                           ▼
pending ──► pending_approval ──► assigned ──► in_progress ──► review ──► accepted ──► completed ──► archived
                                    │              │            │
                                    │              │            └──► revision ──► in_progress
                                    │              │
                                    ▼              ▼
                                 blocked      failed / cancelled
```

| From | To | Trigger | Notes |
|------|----|---------|-------|
| `pending` | `pending_approval` | Task created with governance requiring approval | Auto on create |
| `pending` | `assigned` | Agent assigned (auto-approve or no governance) | |
| `pending_approval` | `assigned` | Human/manager approves task | Only via `approveTask()` |
| `pending_approval` | `cancelled` | Human/manager rejects task | Only via `rejectTask()` |
| `assigned` | `in_progress` | Agent starts working | Auto-starts execution |
| `in_progress` | `review` | Agent calls `task_submit_review` with `reviewer_id` | System notifies reviewer |
| `in_progress` | `blocked` | Dependencies not met | |
| `in_progress` | `failed` | Unrecoverable error | |
| `in_progress` | `cancelled` | Agent/human cancels | |
| `blocked` | `in_progress` | All blockers resolved | Auto-checked |
| `review` | `accepted` | Reviewer approves | Via `task_update(accepted)` or `acceptTask()` |
| `review` | `revision` | Reviewer requests rework | Via `task_update(revision)` or `requestRevision()` |
| `revision` | `in_progress` | Agent starts rework | Auto-starts execution |
| `accepted` | `completed` | **Automatic** — branch merged, worktree cleaned | `setImmediate` in `updateTaskStatus`/`acceptTask` |
| `completed` | `archived` | Manual archival | |
| `failed` | `archived` | Manual archival | |
| `cancelled` | `archived` | Manual archival | |

### Key Rules

1. **Workers cannot set their own task to `completed`** — they must use `task_submit_review`.
2. **`accepted → completed` is automatic** — the system merges branches and cleans up worktrees.
3. **`task_submit_review` requires `reviewer_id`** — the agent must specify who reviews.
4. **Reviewer must differ from worker** — self-review is blocked.
5. **Choosing a reviewer**: if the task was delegated, the delegator reviews; if self-created, the team manager reviews.

---

## 2. Scheduled (Recurring) Task FSM

Scheduled tasks follow the same review pipeline as standard tasks, but **cycle back to `pending` after acceptance** instead of completing.

### States

Same as standard tasks, except:
- `completed` is only reached when `maxRuns` is exhausted or the task is manually completed.
- `accepted` is transient — auto-transitions to `pending` (not `completed`).

### Lifecycle

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                  │
                    ▼                                                  │
pending ──► assigned ──► in_progress ──► review ──► accepted ──► pending (next run)
                              │            │
                              │            └──► revision ──► in_progress
                              ▼
                         failed / cancelled
```

### Schedule Mechanism

1. **`ScheduledTaskRunner`** polls on a fixed interval (default 60s).
2. On each tick, checks `nextRunAt` against current time.
3. When `nextRunAt` has passed and task is in a fireable state (`pending`, `completed`, `failed`):
   - Calls `advanceScheduleConfig()` — increments `currentRuns`, sets `lastRunAt`, computes `nextRunAt` for the next cycle.
   - Resets task from terminal states (if needed) via `resetTaskForRerun()`.
   - Auto-starts execution via `runTask()`.
4. Tasks in `in_progress`, `assigned`, `review`, `revision`, `blocked`, `pending_approval` are **skipped** (a run is already active).
5. Paused tasks (`config.paused = true`) are skipped.

### Transitions (differences from standard)

| From | To | Trigger | Notes |
|------|----|---------|-------|
| `accepted` | `pending` | **Automatic** after review acceptance | Resets `result`, `startedAt`, `completedAt` |
| `pending` | `in_progress` | `ScheduledTaskRunner` fires when `nextRunAt` arrives | Via `runTask()` |

### Key Rules

1. **Same review pipeline** — scheduled tasks go through `review → accepted`, not directly to `completed`.
2. **After acceptance → `pending`** — the task waits for the next scheduled run.
3. **`nextRunAt` is computed before each run** — so after acceptance, the next run time is already set.
4. **Branch merge is skipped** — scheduled tasks keep their worktree across iterations.
5. **Deliverables accumulate** — each run's deliverables are tagged with run number and appended.
6. **`maxRuns` limit** — when `currentRuns >= maxRuns`, the runner stops firing.

---

## 3. Requirement FSM

Requirements represent high-level work items that are fulfilled by one or more tasks.

### States

| State | Description |
|-------|-------------|
| `draft` | Agent-proposed, awaiting user review |
| `pending_review` | Submitted for user review (equivalent to `draft` for approval purposes) |
| `approved` | User approved, tasks can be created against it |
| `in_progress` | At least one task has been linked |
| `completed` | All linked tasks are done |
| `rejected` | User rejected the proposal |
| `cancelled` | Manually cancelled |

### Transitions

```
draft ──► pending_review ──► approved ──► in_progress ──► completed
                          │
                          └──► rejected
                          └──► cancelled
```

| From | To | Trigger | Notes |
|------|----|---------|-------|
| (new) | `draft` | Agent proposes via `requirement_propose` | Max 3 pending per agent |
| (new) | `approved` | User creates directly | Auto-approved |
| `draft` | `approved` | User approves | Via `approveRequirement()` |
| `draft` | `rejected` | User rejects | Via `rejectRequirement()` |
| `pending_review` | `approved` | User approves | |
| `pending_review` | `rejected` | User rejects | |
| `approved` | `in_progress` | First task linked | Auto via `linkTask()` |
| `in_progress` | `completed` | All linked tasks completed/accepted/cancelled | Auto via `checkCompletion()` |
| any | `cancelled` | Manual cancellation | Via `cancelRequirement()` |

### Key Rules

1. **User-created requirements auto-approve** — they start at `approved`.
2. **Agent proposals need user approval** — they start at `draft`.
3. **Max 3 pending proposals per agent** — prevents proposal spam.
4. **Completion is automatic** — when all linked tasks reach a terminal state.
5. **`approved` and `in_progress` both authorize task creation** — `isApproved()` checks both.

---

## 4. Review Flow

The review flow is shared between standard and scheduled tasks:

```
Worker                                  System                          Reviewer
  │                                       │                               │
  │── task_submit_review(reviewer_id) ──►│                               │
  │                                       │── notify reviewer ──────────►│
  │                                       │   (handleMessage)             │
  │                                       │                               │
  │                                       │◄── task_update(accepted) ─────│
  │                                       │    OR                         │
  │                                       │◄── task_update(revision) ─────│
  │                                       │                               │
  │◄── (revision: restart work) ─────────│                               │
  │                                       │                               │
```

### Reviewer Selection Rules

| Scenario | Reviewer |
|----------|----------|
| Task was delegated by another agent | The delegating agent |
| Task was self-created | Team manager |
| Neither available | Agent must find one via `team_list` |

The agent is responsible for choosing the right reviewer via the `reviewer_id` parameter.
The system does NOT auto-detect reviewers — this is intentional to keep the logic in the agent's prompt, not in hardcoded service code.
