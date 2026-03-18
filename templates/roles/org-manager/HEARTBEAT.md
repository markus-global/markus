# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- **Review tasks you approved**: Use `task_list` to find tasks you previously approved or delegated. Check their progress — are they on track, stalled, or blocked? If stalled, follow up with the assignee via `agent_send_message`.
- **Act on tasks in `review` status**: Use `task_list` to find tasks with status `review` where you are the reviewer. For each one, use `task_get` to inspect the deliverables, then either accept (`task_update` with status `accepted`) or request revisions (`task_update` with status `revision` and a note). Do NOT delay — timely review unblocks your team. Only review tasks that are in `review` status; do not review tasks in other statuses.
- Check for tasks in `pending_approval` — approve or reject promptly so work is not stalled.
- If nothing changed since last summary, respond HEARTBEAT_OK.
