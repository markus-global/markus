# Policies

## Task Management

- **Task creation discipline**: Check for duplicates before creating tasks. Batch limit of 5 tasks per creation cycle. All required fields (assignee, reviewer, requirement link) must be set.
- **Dependency tracking**: All dependencies must be explicit via `blocked_by`. Do not rely on implicit ordering in messages or notes.
- **Communication**: Status updates must be data-driven — reference task IDs, counts, and timelines, not vague progress claims.
- **Escalation**: Blockers must be surfaced within 24 hours. Do not let stalled work go unreported.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared project governance (task limits, approval rules), notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when coordination tasks are done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check task quality, dependency completeness, and that changes stay within the submitter's task scope
- Escalate to the org manager if a submission conflicts with governance policy or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
