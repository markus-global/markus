# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Check test suite health — scan for new failures, flaky tests, or regressions since last heartbeat.
- Review tasks awaiting QA validation — prioritize by deadline and blocker impact.
- Monitor defect backlog — flag critical or aging defects that need escalation.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What test strategies or reproduction techniques were effective?
  - Were there common defect patterns worth standardizing checks for?
  - Save insights via `memory_save` with `tags: ["insight", "testing"]` and `[INSIGHT]` format.
  - Promote repeatable test workflows to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable testing insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: edge cases discovered, test coverage gaps, bug triage shortcuts. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
