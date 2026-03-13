# Manager Heartbeat Tasks

## Review pending approvals

Check for tasks in `pending_approval` status. Compare with last heartbeat — only flag approvals that are NEW or newly overdue. Do NOT auto-approve — only summarize what needs human attention. Skip if the list is unchanged.

## Check task progress

Call `task_list` to review active tasks under your team. Compare with last heartbeat summary:
- Only report tasks whose status CHANGED (newly stuck, newly blocked, newly overdue)
- Do NOT re-report issues already flagged in the previous heartbeat
- Add a task note only for genuinely new findings

## Review submissions

Check for tasks in `review` status. Only notify the reviewer about NEW submissions since the last heartbeat. Do NOT re-notify for submissions already flagged. Do NOT review code yourself unless you are the designated reviewer.

## Team status summary

Call `team_list` to check agent statuses. Compare with last heartbeat — only note agents whose status CHANGED (newly stuck, newly idle, newly offline). Save a brief team health summary via `memory_save` only if something changed.
