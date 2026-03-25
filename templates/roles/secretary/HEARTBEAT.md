# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- **Review tasks you approved**: Use `task_list` to find tasks you previously approved or delegated. Check their progress — are they on track, stalled, or blocked? If stalled, follow up with the assignee via `agent_send_message`.
- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For each one, use `task_get` to inspect deliverables, then either approve (`task_update` with status `completed` and a review note) or reject (`task_update` with a note explaining what must change — this auto-restarts execution). Do NOT delay — unreviewed tasks block your team.
- Check for tasks in `pending_approval` — approve or reject promptly so work is not stalled.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Correction & Learning Capture

Scan your recent interactions for correction signals (inspired by OpenClaw's Reflect skill):
- **HIGH confidence**: Owner said "never", "always", "wrong", "stop", "the rule is" — save immediately
- **MEDIUM confidence**: Owner approved output ("perfect", "exactly", "that's right") — note the pattern
- **LOW confidence**: Something worked well but wasn't explicitly validated — observe but don't save yet

For HIGH/MEDIUM signals, save via `memory_save` with key `self:corrections` and tag `self-improvement`.
Format: `[YYYY-MM-DD] [HIGH/MED] lesson-text`
Always check `memory_search("self:corrections")` first to avoid duplicates.

## Shared User Profile Update

Check if recent interactions revealed new information about the owner:
- New communication preference? New project focus? New pet peeve?
- If yes, update the shared `USER.md` in the shared workspace via `file_write`. This file is loaded by **all agents**, so keep it concise (<50 lines).
- Also save detailed observations to your private memory: `memory_save` with key `user:profile` and tag `user-preference`.
- Check `memory_search("user:profile")` first to avoid duplicates.

## Org Knowledge Update

Check if team dynamics, agent capabilities, or project context changed:
- New agent hired? Agent struggling? Team conflict? Architecture decision?
- Save via `memory_save` with key `org:knowledge` and tag `team,org`.

## Self-Evolution Reflection

- **What did I accomplish since last heartbeat?**
- **What lessons did I learn?** (specific, actionable, non-obvious only)
- **What best practices should I remember?**
- **What mistakes should I avoid?**

Save insights via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`.
Skip if nothing meaningful happened.

## Daily Report (after 20:00 only)

The system will tell you if a report is due. If the "Daily Report Required" section appears in the prompt, produce the report via `deliverable_create`. The report must be concise (<500 words), timestamped, and cover: your work, team progress, blockers, and tomorrow's priorities. Do NOT create the report before 20:00.

- If nothing changed since last summary, respond HEARTBEAT_OK.
