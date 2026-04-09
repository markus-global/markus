# Heartbeat Checklist

- Check tasks assigned to me via `task_list` (e.g. `pending`, `in_progress`, `blocked`). Note any new work or status changes.
- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change — sends the task back for revision). Timely review unblocks teammates.
- Review requirement list for items needing grooming or re-prioritization.
- Check for cross-team dependency blockers.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable lessons via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`. Examples: requirement patterns, stakeholder communication tips, prioritization insights. Skip if nothing meaningful happened.
- If nothing changed since last summary, respond HEARTBEAT_OK.
