# Heartbeat Checklist

- Check tasks assigned to me via `task_list` (e.g. `pending`, `in_progress`, `blocked`). Note any new work or status changes.
- **Review duty**: Check `task_list` for tasks in `review` status where you are the designated reviewer. If found, use `task_get` to inspect deliverables, then approve (`task_update` status `completed` with a note) or reject (`task_update` with status `in_progress` and a note on what must change — sends the task back for revision). Timely review unblocks teammates.
- Check for new messages or action items.
- Verify operational tool and service health (only report changes).
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Completed task review**: Check `task_list` for tasks you recently completed. For each:
  - What went well? (clean incident resolution, effective monitoring, smooth deployments)
  - What operational patterns worked? (troubleshooting approaches, automation strategies, monitoring setups)
  - Did the review process reveal better operational practices?
  - Save best practices via `memory_save` with `tags: ["lesson", "best-practice", "operations"]` and `[BEST-PRACTICE]` format.
  - If you found a repeatable operational workflow (e.g., "incident response runbook", "service health check procedure"), promote it to an SOP via `memory_update_longterm({ section: "sops", ... })`.
  - When 3+ related best practices accumulate, consider updating your ROLE.md with the new guideline.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable lessons via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`. Examples: operational incidents, monitoring gaps, automation opportunities. Skip if nothing meaningful happened.
- Once per day, compile a daily summary (check memory to avoid duplicates).
- If nothing changed since last summary, respond HEARTBEAT_OK.
