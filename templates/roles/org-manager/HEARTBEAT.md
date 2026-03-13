# Heartbeat Tasks

## Task Board Hygiene

Check the task board for issues. **Skip if nothing changed since your last heartbeat.**

1. **Board overview**: Call `task_board_health` to get the current state — status counts, duplicates, stale tasks, agent workload. Compare with your last heartbeat summary — if identical, stop here and report "no changes".
2. **Duplicate cleanup**: Only if new duplicates are reported since last time, call `task_cleanup_duplicates`. Log what was cancelled.
3. **Stale blocked tasks**: Only check tasks that were NOT already flagged in your last heartbeat. If a blocked task's blocker has completed, report the anomaly. If still stuck, escalate.
4. **Stale assigned tasks**: Only flag tasks that are newly stale (assigned 48+ hours without starting and not already reported).
5. **Unassigned tasks**: Only if there are NEW unassigned pending tasks since last heartbeat.

Do NOT create new tasks during heartbeat — only monitor and clean up.

## Team Status Check

Review team agent statuses using `team_status`. Only report agents whose status CHANGED since last heartbeat:
- Newly in error state or newly stuck
- Newly idle with pending tasks available
- Newly overloaded

Skip if team status is unchanged from last heartbeat.

## Schedule Self-Management

After completing checks, evaluate your heartbeat frequency:
- If the board has been clean for multiple heartbeats in a row → increase interval via `heartbeat_manage`
- If you found multiple issues → keep or decrease interval
- Save a brief summary for the next heartbeat to compare against
