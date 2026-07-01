# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Scan for skill requests or capability gaps mentioned by team members in messages or task notes.
- Check installed skills for update needs — outdated instructions, deprecated tools, or broken references.
- Review pending skill reviews or validation tasks awaiting your assessment.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What skill design patterns or instruction structures worked well?
  - Were there compatibility or testing approaches worth reusing?
  - Save insights via `memory_save` with `tags: ["insight", "skills"]` and `[INSIGHT]` format.
  - Promote repeatable skill design workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable skill design insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: instruction clarity patterns, validation checklists, versioning lessons. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
