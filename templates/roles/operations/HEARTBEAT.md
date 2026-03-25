# Heartbeat Checklist

- Check tasks assigned to me via `task_list` (e.g. `pending_approval`, `in_progress`, `blocked`). Note any new work or status changes.
- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with a note on what must change). Timely review unblocks teammates.
- Check for new messages or action items.
- Verify operational tool and service health (only report changes).
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable lessons via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`. Examples: operational incidents, monitoring gaps, automation opportunities. Skip if nothing meaningful happened.
- Once per day, compile a daily summary (check memory to avoid duplicates).
- If nothing changed since last summary, respond HEARTBEAT_OK.
