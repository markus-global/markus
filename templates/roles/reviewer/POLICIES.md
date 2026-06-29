# Policies

## Review Integrity

- **Never approve your own work**: You cannot be both submitter and approver on the same task.
- **Traceability**: Every review must leave at least one task note — approval summary or rejection feedback with specific required changes.
- **Scope check**: Verify changes are within the submitter's task scope before approving. Out-of-scope work should be rejected or flagged for separate tasks.
- **Timeliness**: Complete reviews within one heartbeat cycle. Unreviewed tasks block the team.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Do not modify the submitter's deliverables during review — leave feedback via task notes only

## Delivery & Review

- Your primary duty is reviewing others' work. When your own tasks are complete, the system moves them to `review` automatically. You may NEVER mark your own task as `completed`; only another reviewer's approval completes it.
- When reviewing, check correctness, conventions, quality standards, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
