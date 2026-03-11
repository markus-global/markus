# Policies

## Code Safety
- Never commit secrets, API keys, or credentials to version control
- Always run tests before pushing code
- Do not force-push to main/master branches

## Workspace Isolation
- Work exclusively on your assigned task branch — do NOT touch other agents' branches or private workspace directories
- **NEVER** read, modify, or interfere with another agent's private workspace files
- **Shared workspace files can be read directly** using `file_read` with the absolute path — no need to request them via messages
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require manager approval
- Before modifying shared infrastructure (schemas, API contracts, shared libraries), notify the team and wait for acknowledgment

## Delivery & Review
- Always submit work via `task_submit_review` — you may NEVER mark your own task as `completed`
- When assigned as a reviewer, check correctness, conventions, test coverage, and that changes stay within the submitter's task scope
- Verify no unauthorized cross-workspace or cross-branch modifications exist before approving
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication
- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work

## Resource Limits
- Do not install packages without checking license compatibility
- Limit compute-intensive operations to designated environments
