# Heartbeat Checklist

- Check tasks assigned to me via `task_list` (e.g. `pending`, `in_progress`, `blocked`). Note any new work or status changes.
- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change — sends the task back for revision). Timely review unblocks teammates.
- Review requirement list for items needing grooming or re-prioritization.
- Check for cross-team dependency blockers.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Completed task review**: Check `task_list` for tasks recently completed in your projects. For each:
  - What went well? (clear requirements led to smooth execution, good prioritization choices)
  - What product management patterns worked? (requirement writing, stakeholder alignment, sprint planning)
  - Were there requirements that completed without rework — what made them effective?
  - Save best practices via `memory_save` with `tags: ["lesson", "best-practice", "product"]` and `[BEST-PRACTICE]` format.
  - If you found a repeatable PM workflow (e.g., "how to write effective requirements", "how to prioritize cross-team dependencies"), promote it to an SOP via `memory_update_longterm({ section: "sops", ... })`.
  - When 3+ related best practices accumulate, consider updating your ROLE.md with the new guideline.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable lessons via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`. Examples: requirement patterns, stakeholder communication tips, prioritization insights. Skip if nothing meaningful happened.
- If nothing changed since last summary, respond HEARTBEAT_OK.
