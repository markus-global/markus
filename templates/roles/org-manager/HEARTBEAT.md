# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- Check for tasks in `pending_approval` — flag any new or overdue approvals.
- Check for tasks in `review` — flag new submissions needing reviewer attention.
- If nothing changed since last summary, respond HEARTBEAT_OK.
