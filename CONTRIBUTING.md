# Contributing to Markus

This guide is written for AI coding assistants and human contributors. Follow it to contribute effectively to the Markus AI Digital Employee Platform.

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (optional; for sandbox features)

## Quick Development Setup

```bash
pnpm install
pnpm build
pnpm dev
```

- API server: `http://localhost:3001`
- Web UI: `http://localhost:3000`
- Default admin: `admin@markus.local` / `markus123`

Database: SQLite by default (zero config). PostgreSQL is optional.

## Project Structure

```
packages/
├── shared/       # Shared types, constants, utilities
├── core/         # Agent runtime (core engine)
├── storage/      # Database schema + repository layer
├── org-manager/  # Organization management + REST API + governance services
├── compute/      # Docker sandbox management (optional)
├── comms/        # Communication adapters (Feishu, etc.)
├── a2a/          # Agent-to-Agent protocol
├── gui/          # GUI automation (VNC + OmniParser)
├── web-ui/       # Web management UI (React + Vite + Tailwind)
└── cli/          # CLI entry point + service assembly
```

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install dependencies |
| `pnpm build` | Build all packages |
| `pnpm dev` | Start API + Web UI |
| `pnpm test` | Run tests (vitest) |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint |

## Code Style and Conventions

- **TypeScript strict mode**: All packages use `strict: true`.
- **ESM modules**: Use `import`/`export`. No CommonJS.
- **No default exports**: Use named exports only.
- **Type imports**: Use `import type { X }` for type-only imports (enforced by ESLint).
- **Unused vars**: Prefix with `_` to ignore (e.g., `_unused`).

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): description`
- `fix(scope): description`
- `docs(scope): description`
- `chore(scope): description`

Example: `feat(api): add GET /api/health endpoint`

## Adding a New Agent Role

1. Create a directory under `templates/roles/<role-name>/`.
2. Add `ROLE.md` with the role definition (responsibilities, competencies, style).
3. Optionally add `HEARTBEAT.md`, `POLICIES.md`, or other role-specific files.
4. Reference shared content from `templates/roles/SHARED.md` if needed.

## Adding a New Skill

1. Create a directory under `templates/skills/<skill-name>/`.
2. Add `manifest.json` with:
   - `name`, `version`, `description`, `author`, `category`, `tags`
   - `requiredPermissions`, `requiredEnv` (arrays)
   - `mcpServers` (if the skill uses MCP)
3. Add `SKILL.md` with instructions for the AI (when to use, how to use, tool reference).
4. Skills are discovered from `templates/skills/` and `WELL_KNOWN_SKILL_DIRS`.

## Adding a New API Endpoint

1. Open `packages/org-manager/src/api-server.ts`.
2. In the `route()` method, add a new branch for your path and HTTP method.
3. Pattern: `if (path === '/api/your-resource' && req.method === 'GET') { ... }`
4. Use `this.readBody(req)` for request body.
5. Use `this.json(res, statusCode, payload)` for JSON response.
6. Use `await this.requireAuth(req, res)` for authenticated endpoints.
7. Place new routes in logical order with similar endpoints.

## Testing Guidelines

- **Framework**: Vitest
- **Location**: `packages/<pkg>/test/*.test.ts` or colocated `*.test.ts` next to source
- **Run**: `pnpm test` (all) or `pnpm --filter @markus/<pkg> test` (single package)
- Add tests for new behavior. Keep tests focused and deterministic.

## Pull Request Process

1. Fork the repository.
2. Create a branch: `git checkout -b feat/your-feature`.
3. Make changes. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`.
4. Commit with conventional format.
5. Open a PR against the main branch.
6. Address review feedback.

## Code Review Expectations

- Changes align with project structure and conventions.
- New code has tests where appropriate.
- No unnecessary dependencies or complexity.
- TypeScript types are correct; avoid `any`.
- API changes are backward-compatible or documented.

## License

AGPL-3.0 (dual license with commercial option).
