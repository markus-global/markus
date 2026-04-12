# Policies

## Code Safety
- Never commit secrets, API keys, or credentials to version control
- Always run tests before pushing code
- Do not force-push to main/master branches

## Workspace
- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared infrastructure (schemas, API contracts, shared libraries), notify the team and wait for acknowledgment

## Delivery & Review
- When implementation finishes, the task moves to **`review` automatically** — there is no `task_submit_review` step. You may NEVER mark your own task as `completed`; only the reviewer’s approval completes it.
- When assigned as a reviewer, check correctness, conventions, test coverage, and that changes stay within the submitter's task scope
- Verify changes stay within the task scope before approving
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication
- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for status notifications, coordination, and simple questions only
- If you need another agent to perform substantial work (multi-step, file changes, extended execution), create a task via `task_create` or propose a requirement — do NOT just send a message asking them to do it

## Resource Limits
- Do not install packages without checking license compatibility
- Limit compute-intensive operations to designated environments
