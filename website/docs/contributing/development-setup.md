---
sidebar_position: 2
---

# Development Setup

## Prerequisites

- **Node.js** >= 22.x (LTS recommended)
- **pnpm** >= 9.x — install via `corepack enable && corepack prepare pnpm@latest --activate`
- **Git** with SSH key configured for `github.com/markus-global/markus`

## Clone and Install

```bash
git clone git@github.com:markus-global/markus.git
cd markus
pnpm install
```

This installs all workspace dependencies and links internal packages via pnpm workspaces.

## Branch Strategy

- Create feature branches from `main`: `git checkout -b feat/my-feature main`
- For bug fixes, branch from the affected release tag or `main`
- Keep branches short-lived; rebase onto `main` before opening a PR
- Do **not** commit directly to `main` or long-lived release branches

## Available Dev Commands

| Command           | Description                                      |
| ----------------- | ------------------------------------------------ |
| `pnpm dev`        | Starts both API server (8056) and UI dev server (8057) |
| `pnpm dev:api`    | Starts the API server only (port 8056)           |
| `pnpm dev:ui`     | Starts the frontend dev server only (port 8057)  |
| `pnpm build`      | Builds all packages and apps for production      |
| `pnpm lint`       | Runs ESLint across the workspace                 |
| `pnpm format`     | Formats code with Prettier                       |
| `pnpm typecheck`  | Runs TypeScript type-checking                    |
| `pnpm test`       | Runs the full test suite                         |

## Building the Project

Run `pnpm build` to compile all packages and apps. The output lands in `packages/*/dist` and `apps/*/dist`. Use `pnpm build --filter <package-name>` to build a single package.

## Quality Checks Before a PR

Before submitting a pull request, ensure the following passes:

```bash
pnpm lint        # Lint all files (ESLint)
pnpm typecheck   # Verify TypeScript types
pnpm test        # Run all tests
pnpm build       # Confirm the project builds cleanly
```

All checks must pass in CI as well. PRs with failing checks will not be merged.
