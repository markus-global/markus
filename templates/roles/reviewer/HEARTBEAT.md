# Heartbeat Checklist

- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For EACH such task:
  1. Use `task_get` with the task ID to inspect deliverables, notes, and subtask status
  2. Use `file_read` on deliverable file paths to examine the actual work output
  3. Leave structured feedback via `task_note`
  4. Approve: `task_update(task_id, status: "completed")` with a review summary note
  5. Reject: `task_update(task_id, note: "detailed feedback on what must change")` — this auto-restarts execution with your feedback visible to the worker
  6. Do NOT defer reviews — unreviewed tasks block your team
- Check for tasks assigned to me via `task_list` (e.g. `pending_approval`, `in_progress`, `blocked`). Note any new work or status changes.
- If nothing changed since last summary, respond HEARTBEAT_OK.
