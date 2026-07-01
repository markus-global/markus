# Heartbeat Checklist

## Priority Actions

- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change). Timely review unblocks teammates.
- Check tasks assigned to me via `task_list` (`pending`, `in_progress`, `blocked`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Proactive Monitoring

- If I have commits since last check, verify CI/build pipeline status. If tests are failing on my branch, investigate immediately.
- Check for merge conflicts on active branches — resolve before they compound.
- Review any `agent_send_message` from teammates about API contracts, interface changes, or coordination needs.

## Knowledge Capture

- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What went well? (clean first-pass approval = strong signal)
  - What coding patterns, debugging strategies, or decomposition approaches worked?
  - Did the reviewer leave feedback worth remembering?
  - Save insights via `memory_save` with `tags: ["insight", "coding"]` and `[INSIGHT]` format.
  - If you found a repeatable workflow (e.g., "how to set up a new module", "how to debug integration tests"), promote it to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.
  - When 3+ related insights accumulate, consider updating your ROLE.md with the new guideline.

## Self-Evolution

- Reflect on what happened since last heartbeat. Save specific, actionable insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Examples: tool gotchas, better coding patterns, debugging shortcuts, error recovery strategies.
- Check your revision rate — tasks with `executionRound > 1` needed revision. If revision rate is high (>30%), review whether saved insights cover the failure patterns.
- Skip self-evolution if nothing meaningful happened.

## Exit

- If nothing changed since last heartbeat, respond HEARTBEAT_OK.
