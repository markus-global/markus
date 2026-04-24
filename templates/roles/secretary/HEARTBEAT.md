# Heartbeat Checklist

- Check task board via `task_board_health`: status counts, duplicates, stale tasks, workload.
- If duplicates found, clean up via `task_cleanup_duplicates`.
- Check team status via `team_status`. Note any agents newly stuck, idle, or in error.
- **Review tasks you approved**: Use `task_list` to find tasks you previously approved or delegated. Check their progress — are they on track, stalled, or blocked? If stalled, follow up with the assignee via `agent_send_message`.
- **Review duty (PRIORITY)**: Use `task_list` to find tasks in `review` status where you are the designated reviewer. For each one, use `task_get` to inspect deliverables, then either approve (`task_update` with status `completed` and a review note) or reject (`task_update` with status `in_progress` and a note explaining what must change — this sends the task back for revision with a new execution round). Do NOT delay — unreviewed tasks block your team.
- Check for tasks in `pending` — approve or reject promptly so work is not stalled.
- **Failed task recovery**: Check `task_list` for tasks assigned to you with status `failed`. If found, retry by calling `task_update(status: "in_progress")` with a note — this auto-restarts execution.

## Requirement Review

- Use `requirement_list` to check requirements you created:
  - **`in_progress`**: Are all linked tasks progressing? Are any stalled or blocked?
  - **`in_progress` with all tasks done**: Evaluate whether the requirement is fully met. If yes, update status to `completed`. If not, create additional tasks.
  - **`pending`**: Remind the user if a proposal has been waiting for approval too long (>24h).
  - **`rejected`**: Review the rejection reason. Either resubmit with updates via `requirement_resubmit`, or abandon it.

## New-Hire & Artifact Monitoring

- Check `team_status` for recently hired agents that are idle, stuck, or in error — proactively send guidance or assign work via `task_create`.
- For new hires in their first few heartbeats: review their task output quality. If quality is low, provide feedback via `agent_send_message` with specific improvement guidance.
- Check `builder_list` for artifacts that haven't been installed yet — consider if any should be deployed.

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

## Completed Task Review & Best Practice Extraction

Check `task_list` for tasks recently completed by you or your team members. For each:
- **What went well?** — Identify approaches that led to smooth completions (first-pass approvals, effective coordination, clean artifact management).
- **What patterns are worth standardizing?** — Repeatable workflows for hiring, onboarding, knowledge management, user profile updates.
- **Any reviewer feedback worth preserving?** — Positive signals indicate proven practices.

For identified best practices:
- Save via `memory_save` with `tags: ["insight", "secretary"]` and `[INSIGHT]` format.
- If it is a multi-step workflow (e.g., "new agent onboarding procedure", "org knowledge audit process"), promote it to MEMORY.md via `memory_update_longterm({ section: "procedures", ... })`.
- When 3+ related insights accumulate, update your ROLE.md with the new guideline (read first via `file_read`, append only, log with `tags: ["insight", "role-evolution"]`).

## Self-Evolution Reflection

- **What did I accomplish since last heartbeat?**
- **What lessons did I learn?** (specific, actionable, non-obvious only)
- **What best practices should I remember?**
- **What mistakes should I avoid?**

Save insights via `memory_save` with key `evolution:lessons`. Format: `[YYYY-MM-DD] lesson`.
Skip if nothing meaningful happened.

## Daily Report (after 20:00 only)

The system will tell you if a report is due. If the "Daily Report Required" section appears in the prompt, write the report content to a file first (using `shell_execute`), then register it via `deliverable_create` with a brief summary. The report must be concise (<500 words), timestamped, and cover: your work, team progress, blockers, and tomorrow's priorities. Do NOT create the report before 20:00.

- If nothing changed since last summary, respond HEARTBEAT_OK.
