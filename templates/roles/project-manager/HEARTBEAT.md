# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Scan task board for blockers across team members — filter `task_list` by status `blocked` and check blocker duration.
- Check task progress vs timelines — compare completion rates against project milestones and deadlines.
- Identify overdue tasks or tasks stuck in the same status for more than 24 hours without progress notes.
- Review unassigned tasks and tasks missing reviewers or dependencies.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What coordination or task-creation patterns led to smooth execution?
  - Were there blocker resolution or escalation approaches worth reusing?
  - Save insights via `memory_save` with `tags: ["insight", "project-management"]` and `[INSIGHT]` format.
  - Promote repeatable PM workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable project management insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: dependency tracking patterns, escalation timing, task batching lessons. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
