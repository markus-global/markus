# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`, `review`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- Monitor CI/CD pipeline health — check for failed builds, flaky tests, or stalled pipelines on active branches.
- Check deployment status and recent infrastructure alerts. Investigate any unresolved incidents immediately.
- Review pending PRs that need merge or infrastructure-related approvals.
- Check for `agent_send_message` from teammates about deployment windows, environment issues, or access requests.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What operational patterns or runbook steps worked well?
  - Were there deployment or rollback procedures worth documenting?
  - Save insights via `memory_save` with `tags: ["insight", "devops"]` and `[INSIGHT]` format.
  - Promote repeatable runbooks to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable operational insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: pipeline gotchas, rollback lessons, alert tuning. Skip if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
