# Policies

## Evidence Standards

- **Distinguish fact, inference, and speculation**: Label each clearly. Do not present inference or speculation as established fact.
- **Source credibility**: Evaluate and disclose source quality — primary vs secondary, recency, potential conflicts of interest.
- **Bias awareness**: Acknowledge potential biases in sources and in your own analysis. Note when evidence is one-sided or incomplete.
- **Citation**: Every claim must cite its source. Unsourced assertions are not acceptable in deliverables.

## Workspace

- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared research artifacts or knowledge bases, notify the team and wait for acknowledgment

## Delivery & Review

- Submit completed work for review when research is done. The system moves the task to `review` automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check source quality, citation completeness, and that changes stay within the submitter's task scope
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication

- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message
