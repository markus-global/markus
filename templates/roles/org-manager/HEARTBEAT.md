# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- **Review tasks you approved**: Use `task_list` to find tasks you previously approved or delegated. Check their progress — are they on track, stalled, or blocked? If stalled, follow up with the assignee via `agent_send_message`.
- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For each one, use `task_get` to inspect deliverables, then either approve (`task_update` with status `completed` and a review note) or reject (`task_update` with a note explaining what must change — this auto-restarts execution). Do NOT delay — unreviewed tasks block your team.
- Check for tasks in `pending_approval` — approve or reject promptly so work is not stalled.
- If nothing changed since last summary, respond HEARTBEAT_OK.
