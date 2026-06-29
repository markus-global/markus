# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Check for content calendar updates and upcoming deadlines. Flag any items due within the next heartbeat cycle.
- Review pending content submissions awaiting editorial review or approval.
- Monitor published content performance if analytics data is available — note underperforming pieces for revision.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What writing approaches led to first-pass approval?
  - What tone, structure, or research patterns worked well?
  - Save insights via `memory_save` with `tags: ["insight", "writing"]` and `[INSIGHT]` format.
  - Promote repeatable workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable writing insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: audience tone preferences, effective hooks, research shortcuts. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
