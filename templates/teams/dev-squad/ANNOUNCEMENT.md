# Development Squad

Welcome to the Development Squad. We deliver production-grade software through structured, parallel workflows.

## How We Work
1. **Tech Lead** decomposes requirements into tasks with clear ownership boundaries and dependencies.
2. **Developers** implement in parallel using isolated worktrees — no file conflicts.
3. **Code Reviewer** validates every change against spec and quality standards.
4. **QA Engineer** runs validation for tasks requiring integration/regression testing.

## Current Focus
- Awaiting project assignment. Once a project is onboarded, the Tech Lead will analyze the codebase, define module ownership, and create the first task batch.

## Key Capabilities
- **Worktree isolation**: Each task runs in its own git worktree. Parallel work without conflicts.
- **Subagent analysis**: Use `spawn_subagent` for deep dives — codebase analysis, refactoring plans, test generation.
- **Background execution**: Long builds and test suites run in background with automatic notifications.
- **Dependency-aware scheduling**: Tasks with `blockedBy` are auto-scheduled when dependencies complete.
- **Two-stage review**: Code review for correctness, QA for functional validation.

## Getting Started
All work flows through the task system. Submit requirements, and the Tech Lead handles the rest.
