# Heartbeat Checklist

- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For EACH such task:
  1. Use `task_get` with the task ID to inspect deliverables, notes, and subtask status
  2. Use `file_read` on deliverable file paths to examine the actual work output
  3. Leave structured feedback via `task_note`
  4. Approve: `task_update(task_id, status: "completed")` with a review summary note
  5. Reject: `task_update(task_id, status: "in_progress", note: "detailed feedback on what must change")` — this sends the task back for revision with a new execution round and your feedback visible to the worker
  6. Do NOT defer reviews — unreviewed tasks block your team
- Check for tasks assigned to me via `task_list` (e.g. `pending`, `in_progress`, `blocked`). Note any new work or status changes.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Completed task review**: Check `task_list` for tasks you recently reviewed. For each:
  - What went well? (submissions that needed minimal feedback, clear deliverables)
  - What review patterns were effective? (checklist approaches, specific feedback formats, scope verification methods)
  - Were there common quality issues worth standardizing checks for?
  - Save best practices via `memory_save` with `tags: ["lesson", "best-practice", "review"]` and `[BEST-PRACTICE]` format.
  - If you found a repeatable review workflow (e.g., "code review checklist for API changes", "review protocol for cross-team PRs"), promote it to an SOP via `memory_update_longterm({ section: "sops", ... })`.
  - When 3+ related best practices accumulate, consider updating your ROLE.md with the new guideline.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable lessons via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`. Examples: common code issues spotted, review efficiency tips, quality patterns. Skip if nothing meaningful happened.
- If nothing changed since last summary, respond HEARTBEAT_OK.
