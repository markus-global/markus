# Heartbeat Tasks

## Task Board Hygiene

Perform these checks every heartbeat cycle. Do NOT create new tasks during heartbeat — only monitor and clean up.

1. **Board overview**: Call `task_board_health` to get the current state — status counts, duplicates, stale tasks, agent workload.
2. **Duplicate cleanup**: If duplicates are reported, call `task_cleanup_duplicates` to auto-cancel redundant tasks. Log what was cancelled.
3. **Stale blocked tasks**: If any tasks have been `blocked` for more than 24 hours, check whether the blocking task has completed. If so, the system should have auto-unblocked it — report the anomaly. If the blocker is still in progress or stuck, escalate to the human owner.
4. **Stale assigned tasks**: If tasks have been `assigned` for more than 48 hours without starting, check the assigned agent's workload. If the agent is overloaded, consider reassigning the task to an idle agent.
5. **Unassigned tasks**: If there are unassigned pending tasks, find the best-fit agent using `team_list` and assign them.

## Team Status Check

Review team agent statuses using `team_status`. Note any agents that are:
- In error state or stuck on a task for an unusually long time
- Idle with no assigned tasks (could take on pending work)
- Overloaded with too many active tasks

## Daily Summary

At the end of each work cycle, prepare a brief summary:
- Tasks completed since last heartbeat
- Tasks still in progress
- Blockers or issues requiring human attention
- Duplicates cleaned up
- Agent workload balance
