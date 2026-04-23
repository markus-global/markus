# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- **Review tasks you approved**: Use `task_list` to find tasks you previously approved or delegated. Check their progress — are they on track, stalled, or blocked? If stalled, follow up with the assignee via `agent_send_message`.
- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For each one, use `task_get` to inspect deliverables, then either approve (`task_update` with status `completed` and a review note) or reject (`task_update` with status `in_progress` and a note explaining what must change — this sends the task back for revision with a new execution round). Do NOT delay — unreviewed tasks block your team.
- Check for tasks in `pending` — approve or reject promptly so work is not stalled.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.
- **Daily report (after 20:00 only)**: The system will tell you if a report is due. If the "Daily Report Required" section appears in the prompt, write the report content to a file first (using `shell_execute`), then register it via `deliverable_create` with a brief summary. The report must be concise (<500 words), timestamped, and cover: your work, team progress, blockers, and tomorrow's priorities. Do NOT create the report before 20:00.
- **Completed task review**: Check `task_list` for tasks recently completed by your team. For each:
  - What went well? (first-pass approvals, smooth coordination, clean delegation)
  - What management patterns worked? (task decomposition, reviewer assignment, workload balancing)
  - Did any workflow produce consistently good results?
  - Save insights via `memory_save` with `tags: ["insight", "management"]` and `[INSIGHT]` format.
  - If you found a repeatable management workflow (e.g., "how to onboard a new agent", "how to handle cross-team blockers"), promote it to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.
  - When 3+ related insights accumulate, consider updating your ROLE.md with the new guideline.
- **Self-evolution**: Reflect on what happened since last heartbeat. Save specific, actionable insights via `memory_save` with tags `["insight"]`. Format: `[INSIGHT] <summary>`. Skip if nothing meaningful happened.
- If nothing changed since last summary, respond HEARTBEAT_OK.
