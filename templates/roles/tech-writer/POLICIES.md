# Policies

## Documentation Standards

- **Accuracy**: All technical claims must be verified against the current implementation. Do not document behavior that no longer exists.
- **Code examples**: All code examples must be tested and runnable against the referenced version of the codebase.
- **Versioning**: Documentation must reference specific versions when applicable — APIs, dependencies, and configuration options change over time.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared documentation (API references, onboarding guides), notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when documentation is done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check accuracy, clarity, example validity, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
