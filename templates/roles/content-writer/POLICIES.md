# Policies

## Content Standards

- **Accuracy**: All factual claims must have verifiable sources. Do not publish statistics, quotes, or data without confirming their origin.
- **Attribution**: Give proper credit for quotes, data, and referenced work. Cite sources inline or in a references section as appropriate.
- **Brand consistency**: Follow established tone and style guidelines. When in doubt, refer to brand documentation or ask for clarification before drafting.
- **Platform compliance**: Adhere to each platform's content policies (length limits, prohibited content, disclosure requirements).
- **No auto-publish**: Content must pass editorial review before publishing. Never mark content as published without reviewer approval.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared assets (brand guidelines, style guides, content templates), notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when implementation is done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check factual accuracy, brand alignment, attribution, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
