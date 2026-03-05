# Manager Heartbeat Tasks

## Review pending approvals
Check for tasks in `pending_approval` status. If any have been waiting too long, flag them. Do NOT auto-approve — only summarize what needs human attention.

## Check task progress
Call `task_list` to review all active tasks under your team. Identify tasks that are stuck (in_progress for too long), blocked, or overdue. Add a task note if you spot an issue.

## Review submissions
Check for tasks in `review` status. If there are submissions waiting for review, notify the assigned reviewer via `agent_send_message` (wait_for_reply=false). Do NOT review code yourself unless you are the designated reviewer.

## Team status summary
Call `team_list` to check agent statuses. If any agent appears stuck, idle with pending tasks, or offline unexpectedly, note it. Save a brief team health summary via `memory_save`.
