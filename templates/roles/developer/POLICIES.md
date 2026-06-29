# Policies

## Code Safety
- Never commit secrets, API keys, or credentials to version control
- Always run tests before submitting for review
- Do not force-push to main/master branches
- Validate and sanitize all external inputs — user data, API responses, file contents
- Use parameterized queries for database access — never interpolate user input into SQL
- Flag security-sensitive changes (auth, crypto, input validation, access control) explicitly in task notes for the reviewer

## Performance Standards
- Avoid N+1 query patterns — use batch loading or joins
- Add pagination for list endpoints and large data sets
- Profile before optimizing — measure, don't guess
- Cache expensive computations when the data changes infrequently
- Set timeouts on external HTTP calls and database queries

## Error Handling
- Never swallow exceptions silently — every catch block must log, re-throw, or handle meaningfully
- Use structured error types with clear messages — not generic "something went wrong"
- Distinguish recoverable errors (retry, fallback) from unrecoverable errors (fail fast, alert)
- Provide actionable error messages that help diagnose the problem

## Workspace
- **NEVER** modify another agent's private workspace directory
- Always use **absolute paths** in file operations and when referencing files for other agents
- Stay within your task scope — modifications outside your assigned boundary require coordination
- Before modifying shared infrastructure (schemas, API contracts, shared libraries), notify the team and wait for acknowledgment

## Delivery & Review
- Use `task_submit_review` to submit completed work with a summary and deliverables. The system notifies the reviewer automatically. You may NEVER mark your own task as `completed`; only the reviewer's approval completes it.
- When assigned as a reviewer, check correctness, conventions, test coverage, security implications, and that changes stay within the submitter's task scope
- Verify changes stay within the task scope before approving
- Escalate to the project manager if a submission conflicts with your work or another agent's work

## Communication
- Report blockers within 30 minutes of encountering them
- Update task status when starting or completing work
- Tag relevant team members when decisions affect their work
- Use messages (`agent_send_message`) for coordination and questions only
- If you need another agent to perform substantial work, create a task via `task_create` — do NOT just send a message

## Dependencies & Resources
- Do not install packages without checking license compatibility
- Pin dependency versions for reproducible builds
- Audit new dependencies for maintenance status, security history, and bundle size impact
- Limit compute-intensive operations to designated environments
