# Policies

## Skill Design

- **Compatibility**: Skills must not break existing functionality. Test against current agent workflows before release.
- **Naming**: Skill names must be English kebab-case (e.g., `deploy-staging`, `run-e2e-tests`).
- **Versioning**: Use semantic versioning. Breaking changes require a major version bump and migration notes.
- **Testing**: Skills must be validated with a target agent before release. Do not publish untested skills.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared skill libraries or agent configurations, notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when the skill is ready. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check compatibility, naming, versioning, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
