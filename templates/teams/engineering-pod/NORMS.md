# Engineering Pod — Working Norms

## Architecture: Design → Contract → Implement → Integrate → Review → Deploy

### Phase 1: Design (Architect)
- Analyze the requirement and codebase using `spawn_subagent` for targeted exploration.
- Produce an architecture brief as a `deliverable_create` (type: "architecture_decision") covering:
  - Component breakdown and ownership mapping
  - API contracts between layers (backend ↔ frontend, services ↔ infra)
  - Data flow and state management strategy
  - Risk assessment and mitigation plan
- Create tasks with explicit **layer ownership** and **dependency graph**:
  - Shared types/interfaces → `blockedBy: []` (first)
  - Backend API → `blockedBy: [shared-types-task]`
  - Frontend UI → `blockedBy: [shared-types-task]`
  - Infra/deploy → `blockedBy: [backend-task]`
  - Integration test → `blockedBy: [backend-task, frontend-task]`

### Phase 2: Contract (All Engineers)
- Before implementation, agree on interface contracts:
  - API schemas (request/response shapes, status codes, error formats)
  - Component props and event signatures
  - Configuration and environment variable naming
- Publish contracts as `deliverable_create` (type: "convention"). All parties reference these during implementation.

### Phase 3: Implement (Engineers, Parallel)
- Each engineer works in a **dedicated worktree** on their layer. No cross-layer file edits without coordination.
- **Backend Engineer**: API endpoints, business logic, database schema, server-side tests.
- **Frontend Engineer**: Components, pages, state management, client-side tests. Use `chrome-devtools` skill for browser debugging.
- **Infra Engineer**: CI/CD pipelines, deployment configs, monitoring, infrastructure-as-code.
- Use `spawn_subagent` for isolated analysis tasks — don't let research pollute your implementation context.
- Run tests in `background_exec` to stay productive while suites execute.

### Phase 4: Integrate (Architect coordinates)
- Architect verifies that layer implementations satisfy the published contracts.
- Use `spawn_subagent` to diff each layer's output against the contract deliverables.
- Create integration test tasks if not already done. These validate cross-layer communication.

### Phase 5: Review & Merge (Senior Reviewer)
- Review each layer independently, then the integration points.
- Two-pass review:
  1. **Contract compliance**: Do implementations match published API contracts?
  2. **Quality and security**: Error handling, input validation, performance, test coverage.
- Use `spawn_subagent` for deep security analysis on auth/payment/data-handling code.
- **On approval**: Merge each task branch via `shell_execute`:
  - Local: `cd <repo> && git checkout <base_branch> && git merge <task_branch> --no-ff`
  - Or via GitHub: `gh pr create` then `gh pr merge`
- **On merge conflict**: Reject the task with conflict details — the engineer resolves in their worktree and re-submits.
- Merge order matters: merge dependency tasks first (shared types → backend → frontend → integration).

### Phase 6: Deploy (Infra Engineer)
- Verify all task branches are merged to the target branch.
- Run deployment pipeline via `background_exec`.
- Verify deployment health via smoke tests.

## Domain Ownership Matrix

| Engineer | Primary Scope | Shared (coordinate first) |
|----------|--------------|--------------------------|
| Backend | `src/api/`, `src/services/`, `src/models/`, `src/db/` | `src/types/`, `package.json` |
| Frontend | `src/components/`, `src/pages/`, `src/hooks/`, `src/styles/` | `src/types/`, `package.json` |
| Infra | `infra/`, `deploy/`, `.github/`, `Dockerfile`, CI configs | `package.json`, env configs |

Edit anything in the "Shared" column only after notifying the team via `agent_send_message`.

## Communication Protocols

- **Contract changes**: Broadcast to all via `agent_send_message` before modifying any published contract.
- **Blocking dependencies**: If you need another layer's work, check if the dependency task is complete. If not, message that engineer directly.
- **Integration issues**: Create a task with `blockedBy` referencing both layers involved. Assign to the Architect for triage.

## Quality Gates

- Every implementation task must include tests covering the happy path and at least one error path.
- API endpoints must handle malformed input gracefully (400, not 500).
- Frontend components must handle loading, error, and empty states.
- Infra changes must be idempotent and rollback-safe.
- Security-critical code (auth, permissions, data access) requires explicit review notes.
