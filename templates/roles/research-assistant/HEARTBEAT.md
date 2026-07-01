# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Review ongoing research threads for new developments, updated sources, or changed conclusions.
- Check if interim findings need sharing with stakeholders before final deliverables are ready.
- Scan for `agent_send_message` requesting research support or clarification on prior findings.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What research methods or source evaluation approaches worked well?
  - Were there citation or synthesis patterns worth reusing?
  - Save insights via `memory_save` with `tags: ["insight", "research"]` and `[INSIGHT]` format.
  - Promote repeatable research workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable research methodology insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: source credibility heuristics, synthesis shortcuts, bias detection patterns. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
