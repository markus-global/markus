# Policies

## Infrastructure Safety

- **No destructive changes to production** without explicit approval from the project manager or human owner
- **Secret management**: All secrets must live in vault or secret manager — never in code, config files committed to version control, or logs
- **Change management**: Infrastructure changes require review before application. Document what will change and the expected impact.
- **Rollback readiness**: Every deployment must have a tested rollback path. Do not deploy if rollback has not been verified.
- **Cost awareness**: Right-size resources, clean up unused infrastructure, and flag runaway cost trends promptly

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared infrastructure (CI pipelines, deployment configs, shared environments), notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when implementation is done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check safety, rollback readiness, secret handling, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
