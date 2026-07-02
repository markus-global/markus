---
sidebar_position: 1
---

# How to Contribute

Thank you for considering contributing to Markus! This guide outlines the contribution process, development workflow, and standards we uphold.

## Ways to Contribute

- **Report bugs** — Open a GitHub issue with a clear description, steps to reproduce, expected vs. actual behavior, and your environment details (OS, Node.js version, etc.).
- **Suggest features** — Open a feature request issue describing the problem you want to solve and your proposed solution. We encourage community discussion before implementation.
- **Submit PRs** — For bug fixes, improvements, or new features, follow the pull request process below.
- **Improve documentation** — Fix typos, clarify wording, add examples, or translate content.

## Development Workflow (Git Flow)

We follow a simplified git flow:

```
# Create a feature branch from main
git checkout main
git pull origin main
git checkout -b feat/my-feature

# Make changes and commit
git add .
git commit -m "feat: add my feature"

# Keep your branch up to date
git fetch origin
git rebase origin/main

# Push and open a PR
git push origin feat/my-feature
```

Branch naming conventions:
- `feat/*` — New features
- `fix/*` — Bug fixes
- `docs/*` — Documentation changes
- `chore/*` — Tooling, dependencies, CI
- `refactor/*` — Code restructuring without behavior changes

## Pull Request Process

1. Ensure your branch is rebased onto the latest `main`.
2. Run the full test suite and lint checks locally before opening.
3. Open a PR with a descriptive title and link the related issue (if any).
4. A reviewer will be assigned within 2–3 business days.
5. Address review feedback with additional commits — avoid force-pushing during review.
6. Once approved, the reviewer will squash-merge your PR.

**Review standards:**
- PRs must not introduce regressions — all existing tests must pass.
- New features require corresponding tests (unit and/or integration).
- Changes to public APIs must include updated type definitions.
- Reviewer approval is required before merge.

## Code Conventions

- **TypeScript strict mode** — All code must compile with `strict: true` in `tsconfig.json`. Avoid `any` whenever possible; use `unknown` and type guards instead.
- **No default exports** — Use named exports exclusively. This improves tree-shaking and import consistency.
- **Functional style** — Prefer pure functions and immutable data. Avoid classes unless necessary.
- **Async conventions** — Use `async/await` over raw promises. Always handle errors with try/catch.
- **Formatting** — We use Prettier with the project's `.prettierrc` config. Run `pnpm format` before committing.
- **Linting** — ESLint enforces rules. Run `pnpm lint` to verify.

## Testing Requirements

```bash
# Run the full test suite
pnpm test

# Run tests in watch mode during development
pnpm test:watch

# Check types
pnpm typecheck

# All quality checks in one command
pnpm quality
```

- All new code must include tests (Vitest preferred).
- Test files should be placed alongside the source file (e.g., `src/utils/parser.ts` → `src/utils/parser.test.ts`).
- Use `describe`/`it` blocks with clear assertions — avoid snapshot tests, prefer explicit expectations.
- Aim for meaningful coverage on new code (statements ≥ 30%, branches ≥ 25% as baseline).

## Getting Help

If you have questions, open a discussion on GitHub or reach out in our community chat. We welcome contributors of all experience levels!
