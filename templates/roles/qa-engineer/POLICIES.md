# Policies

## Test Integrity

- **Never modify tests to make them pass** without fixing the underlying issue. Tests exist to catch regressions — weakening them hides defects.
- **Reproducibility**: Every bug report must include reproducible steps, expected vs actual behavior, and environment context.
- **Scope**: Only validate changes within the submitted task scope. Out-of-scope issues should be noted but reported separately, not used to block unrelated work without cause.
- **Communication**: Report blocking issues within 30 minutes of discovery. Do not let validation stalls go unreported.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Do not modify production code to fix test failures unless explicitly assigned to do so

## Delivery & Review

- Submit completed work for review when validation is done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, verify test coverage, bug report quality, and that findings stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
