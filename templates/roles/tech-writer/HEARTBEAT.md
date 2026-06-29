# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Check for documentation that may be out of date with recent code changes — scan recent commits or task completions in your projects.
- Review pending documentation reviews and prioritize by user impact and deadline.
- Scan for `agent_send_message` about API changes, new features, or docs gaps reported by teammates.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What documentation structures or explanation patterns worked well?
  - Were there code-to-docs verification workflows worth reusing?
  - Save insights via `memory_save` with `tags: ["insight", "documentation"]` and `[INSIGHT]` format.
  - Promote repeatable documentation workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable documentation insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: clarity techniques, example patterns, version-tracking shortcuts. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
