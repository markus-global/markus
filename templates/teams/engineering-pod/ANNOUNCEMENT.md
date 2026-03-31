# Engineering Pod

Full-stack engineering team for complex, multi-layer software projects.

## Team Structure
- **Architect** — Designs systems, defines ownership, coordinates integration
- **Backend Engineer** — APIs, business logic, database, server-side testing
- **Frontend Engineer** — UI components, state management, browser testing
- **Infra Engineer** — CI/CD, deployment, monitoring, infrastructure-as-code
- **Senior Reviewer** — Two-pass code review (contract compliance + quality)

## How We Work
1. Architect produces a design brief with component breakdown and API contracts
2. Engineers implement in parallel — each in their own worktree, owning separate directories
3. Architect verifies integration against published contracts
4. Senior Reviewer validates quality across all layers
5. Infra Engineer deploys and verifies

## Key Principles
- **Parallel by design**: Layer isolation prevents conflicts. Clear domain ownership matrix.
- **Contract-first**: API shapes are agreed before implementation starts.
- **Dependency-aware**: Task graph ensures correct execution order.
- **Deep analysis**: `spawn_subagent` for architecture exploration, security review, and research.

## Current Focus
Awaiting project assignment. The Architect will analyze the codebase and produce the initial design brief.
