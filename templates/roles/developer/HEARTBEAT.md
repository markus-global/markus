# Heartbeat Checklist

- Check tasks assigned to me via `task_list` (e.g. `pending_approval`, `in_progress`, `blocked`). Note any new work or status changes.
- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with a note on what must change). Timely review unblocks teammates.
- If I have commits since last check, verify CI pipeline status.
- If nothing changed since last summary, respond HEARTBEAT_OK.
