# Development Squad — Working Norms

## Workflow Phases

### 1. Plan (Tech Lead)
- Decompose requirements into tasks with clear acceptance criteria.
- Define **file/module ownership** per developer — each task must specify which directories or modules are in scope. Overlap causes merge conflicts.
- Set task dependencies via `blockedBy` — a task that needs another's API or schema should depend on it.
- Use `spawn_subagent` for deep architecture analysis before committing to a plan: codebase exploration, dependency audits, risk assessment.
- Target **5–6 tasks per developer** per sprint cycle. Too few = idle time. Too many = context switching overhead.

### 2. Implement (Developers)
- Each developer works in an **isolated worktree** — the system creates `task/<id>` branches automatically.
- Write tests first (TDD) for new features. For bug fixes, write a failing test that reproduces the issue before fixing.
- Use `spawn_subagent` for focused subtasks: generating boilerplate, analyzing a complex function, researching an API. This keeps your main context clean.
- Run `background_exec` for test suites and builds — you'll be notified when they complete.
- Use `subtask_create` to track progress within a task. Complete subtasks as you go.
- Submit via `task_submit_review` when done. Include a summary of changes in task notes.

### 3. Review & Merge (Code Reviewer)
- **Stage 1 — Spec compliance**: Does the implementation match the task's acceptance criteria? Are edge cases handled?
- **Stage 2 — Code quality**: Architecture alignment, naming, error handling, test coverage, performance concerns.
- Use `spawn_subagent` to deeply analyze complex changes without polluting your review context.
- Leave structured notes via `task_note` — every review produces a trail.
- **On approval**: Merge the task branch via `shell_execute` (`git merge` or `gh pr create` + `gh pr merge`), then complete the task.
- **On merge conflict**: Reject the task with conflict details. The developer resolves conflicts in their worktree and re-submits for review.
- **On rejection**: Task returns to `in_progress` with specific change requests.

### 4. Validate (QA Engineer)
- For tasks marked with QA requirements, run integration and regression tests.
- Verify functional correctness, edge cases, and cross-browser/cross-platform behavior.
- Report bugs as new tasks with `blockedBy` referencing the original task.
- Use `background_exec` for long-running test suites.

## File Ownership Rules

This is the most important rule for parallel development:
- **Each developer owns different directories/modules.** Overlap = conflicts.
- Tech Lead defines ownership in the task description. Example: "Backend Dev owns `src/api/` and `src/models/`. Frontend Dev owns `src/components/` and `src/pages/`."
- Shared files (e.g., types, configs) should be changed in a dependency task that others `blockedBy`.
- If you must edit a file outside your scope, coordinate via `agent_send_message` first.

## Communication Protocols

- **Status broadcasts**: Use `agent_broadcast_status` when starting/finishing a task.
- **Blocking issues**: Message the Tech Lead immediately via `agent_send_message`. Don't wait for heartbeat.
- **Interface contracts**: When one developer's API is needed by another, publish the interface as a `deliverable_create` (type: "convention") before implementing.
- **Review requests**: Submit via `task_submit_review`. The reviewer is notified automatically.

## Quality Standards

- All new code must have test coverage. No exceptions for production paths.
- Follow existing code conventions — use `spawn_subagent` to analyze the project's patterns if unsure.
- Commits must be focused (one logical change) and well-described.
- Security-sensitive changes (auth, crypto, input validation) require explicit review notes.
- Performance-critical paths should include benchmark data in task notes.

## Knowledge Capture

- Document non-obvious decisions as `deliverable_create` (type: "architecture_decision").
- Save reusable patterns and gotchas via `memory_save` with appropriate tags.
- After completing a complex task, record lessons learned during the self-evolution reflection.
