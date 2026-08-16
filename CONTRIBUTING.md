# Contributing to Markus

Thank you for your interest in contributing to **Markus — the open-source AI workforce platform**. Whether you are a human developer or an AI coding assistant, this guide helps you contribute effectively to the project.

Every contribution matters: bug reports, documentation, tests, examples, new adapters, and code reviews all make Markus better. We read every issue and PR, and we do our best to answer quickly.

> **Read this first**: before contributing, please read our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to keep this community open, respectful, and welcoming.

---

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Community & Getting Help](#community--getting-help)
- [Your First Contribution](#your-first-contribution)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Commands](#development-commands)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Code Review Expectations](#code-review-expectations)
- [License & Contributor Sign-off](#license--contributor-sign-off)
- [Resources](#resources)

---

## Ways to Contribute

| Way | What it means | How to start |
|-----|---------------|--------------|
| 🐛 **Report bugs** | Tell us what breaks, with a reproducible case | [Open an issue](https://github.com/markus-global/markus/issues/new) and use the bug template |
| 💡 **Suggest features** | Share ideas that make Markus more useful | Start a [Discussion](https://github.com/markus-global/markus/discussions) or open a feature issue |
| 📝 **Improve docs** | Fix typos, add examples, translate guides, fill gaps | Look for [`documentation`](https://github.com/markus-global/markus/labels/documentation) issues; docs live in `docs/` and `packages/*/README.md` |
| 💻 **Write code** | Fix bugs, add tests, build new adapters and tools | Start with [`good first issue`](https://github.com/markus-global/markus/labels/good%20first%20issue) |
| 🎨 **Design** | Improve UI/UX, icons, or visual assets | Ping us in Discussions before starting large design work |
| ✅ **Review PRs** | Help maintainers ship faster | Pick any open PR and leave constructive feedback |
| 📢 **Spread the word** | Star the repo, write blog posts, share case studies | Tell us about your Markus story in [Discussions](https://github.com/markus-global/markus/discussions) |

> **Not a developer?** You can still help a lot: use Markus, report what felt awkward, translate documentation, or share how you use it. All of that is contribution.

---

## Community & Getting Help

- **GitHub Discussions** — questions, show & tell, feature ideas, and case studies: <https://github.com/markus-global/markus/discussions>
- **Issues** — bugs and concrete feature requests: <https://github.com/markus-global/markus/issues>
- **Blog** — tutorials and product updates: <https://markus.global/blog>

We are building dedicated community channels:

- **Discord (English/global)** — real-time help and community chat. *Coming soon — see [docs/COMMUNITY.md](docs/COMMUNITY.md) for the launch plan and invite.*
- **微信群 (Chinese / WeChat)** — 中文用户交流群，获取帮助、反馈与内测资格。*建设中，加入方式见 [docs/COMMUNITY.md](docs/COMMUNITY.md)。*

Maintainers and regular contributors are most responsive in GitHub Discussions.

---

## Your First Contribution

The best way to start is with an issue explicitly sized for newcomers. Look for these labels:

| Label | Description | Link |
|-------|-------------|------|
| 🌱 `good first issue` | Beginner-friendly, usually small scope with clear instructions | [View issues](https://github.com/markus-global/markus/labels/good%20first%20issue) |
| 🙋 `help wanted` | Work the core team wants help with | [View issues](https://github.com/markus-global/markus/labels/help%20wanted) |
| 📝 `documentation` | Doc improvements — great for first-time contributors | [View issues](https://github.com/markus-global/markus/labels/documentation) |

**Not sure where to start?** Anything in our curated backlog is fair game:

- **Add example workflows** to `examples/` — turn real use cases ("research a competitor", "write release notes") into runnable scripts.
- **Expand API docs** — `docs/API.md` needs more endpoint examples, request/response shapes, and error codes.
- **Add unit tests** — `packages/comms`, `packages/storage` and `packages/a2a` have untested paths. Pick a function, write deterministic tests, watch the coverage go up.
- **Add a locale** — the Web UI ships `en` and `zh-CN`; adding `ja`, `es`, or `de` follows the same pattern (`packages/web-ui/src/locales/`).
- **Build a communication adapter** — a Discord adapter following the Slack/Telegram/WhatsApp pattern in `packages/comms/` also unlocks our community plan.
- **New skill format support** — `markus skill import` already normalizes skills.sh, SkillHub, OpenClaw, SOUL.md, AgentScope and MCP formats; known gaps are listed in `docs/SKILL-ECOSYSTEM.md` §7.

1. Comment on the issue that you are taking it (or open a draft PR).
2. Read [Development Setup](#development-setup) below.
3. When your PR is ready, follow the [Pull Request Process](#pull-request-process).

Need help picking an issue or getting started? Ask in [Discussions](https://github.com/markus-global/markus/discussions) — nobody starts knowing the whole codebase.

---

## Development Setup

We wrote a full walkthrough: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — prerequisites, first run, each `dev` script, debugging tips, and common issues.

The short version:

```bash
# 1. Clone and install
git clone https://github.com/markus-global/markus.git
cd markus
pnpm install

# 2. Build TypeScript packages
pnpm build

# 3. Start API + Web UI in dev mode
pnpm dev
```

- Web UI: http://localhost:8057
- API: http://localhost:8056
- Initial admin: `admin@markus.local` / `markus123` (the onboarding wizard will prompt you to set your own credentials)
- Storage: SQLite by default — zero external dependencies. PostgreSQL is optional for production.

**Requirements:** Node.js ≥ 22, pnpm ≥ 9. See `docs/DEVELOPMENT.md` for exact setup on macOS / Linux / Windows.

---

## Project Structure

```
packages/
├── shared/          Shared types, constants, utilities
├── core/            Agent runtime engine — LLM routing, tools, skills, memory, heartbeat, workspace isolation
├── storage/         Database schema + repository layer (SQLite / PostgreSQL)
├── org-manager/     Organization management + REST API + governance
├── web-ui/          React + Vite + Tailwind management interface
├── desktop/         Electron desktop app (macOS / Windows / Linux)
├── cli/             CLI entry point + service assembly (@markus-global/cli)
├── comms/           External messaging bridges (Slack, Feishu, WhatsApp, Telegram)
├── a2a/             Agent-to-Agent communication protocol
├── gui/             GUI automation (VNC, screenshots, input control, visual analysis)
├── remote/          Remote access (Cloudflare Tunnel, Tailscale, FRP, ngrok)
├── chrome-extension/# Browser automation extension
└── shared/          Shared types, constants, utilities

docs/        # Architecture, API, user, and design documentation
templates/   # Agent roles (ROLE.md), skills (SKILL.md), shared handbook
examples/    # Runnable example workflows
scripts/     # Build, release, and utility scripts
```

> New to the runtime? Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (system design) and [docs/AGENT-RUNTIME.md](docs/AGENT-RUNTIME.md) (agent lifecycle) first — they are short and will save you hours.

---

## Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install all workspace dependencies |
| `pnpm build` | Build all TypeScript packages (`pnpm -r build`) |
| `pnpm dev` | Build + start API (8056) and Web UI (8057) with hot reload |
| `pnpm dev:api` | Start only the API server (requires prior `pnpm build`) |
| `pnpm dev:ui` | Start only the Web UI dev server (requires a running API) |
| `pnpm dev:watch` | Build in watch mode + run API and Web UI together |
| `pnpm dev:desktop` | Run the Electron desktop app in dev mode (API + Vite + Electron) |
| `pnpm test` | Run all tests (Vitest) |
| `pnpm test --filter @markus/<pkg>` | Run tests for one package, e.g. `pnpm test --filter @markus/core` |
| `pnpm test -- <pattern>` | Run tests matching a file pattern |
| `pnpm typecheck` | TypeScript type checking across monorepo + Web UI |
| `pnpm lint` | ESLint across `packages/*/src/` |
| `pnpm quality` | `typecheck` + full test suite in one go |
| `pnpm clean` | Remove build artifacts |
| `pnpm markus` | Run the CLI directly from source |

**Hot reload:** `pnpm dev` runs the API in watch mode; edits to `packages/*/src/**` are rebuilt automatically. The Web UI hot-reloads via Vite. Change API types? Restart the API process (`Ctrl+C`, then `pnpm dev:api`) to pick up new schema.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details on each command, debugging tips, and troubleshooting.

---

## Code Standards

### TypeScript

- All packages use `strict: true`
- ESM modules only (`import` / `export`) — no CommonJS
- No default exports — use named exports
- Use `import type { X }` for type-only imports so the type is erased at build time
- Prefix intentionally unused variables with `_` (e.g., `_unused`)
- Avoid `any` — prefer precise types, generics, or `unknown` + narrowing

### Formatting & Lint

- Run `pnpm lint` before pushing; zero new warnings is the bar
- We use ESLint flat config (`eslint.config.js`) — no Prettier config is required, keep formatting consistent with surrounding code

### Commits

We use [Conventional Commits](https://www.conventionalcommits.org/). This keeps the changelog meaningful and lets tooling derive releases.

```
feat(scope): add user authentication
fix(api): handle null response in /api/agents
docs(readme): update installation instructions
chore(deps): upgrade to Node.js 22
refactor(core): simplify task delegation logic
test(agent): add unit tests for role assignment
```

- `scope` is usually the package or area, e.g. `core`, `api`, `web-ui`, `comms`, `docs`
- Use `docs(...)` for documentation-only changes, `test(...)` for test-only changes, `chore(...)` for maintenance
- Keep commits focused; a PR can have multiple commits, but each commit should be coherent on its own

### Testing

- **Framework**: Vitest (`vitest.config.ts` at repo root)
- **Location**: tests live beside source or in `packages/<pkg>/test/**` with `*.test.ts` files
- Run a single file during development: `pnpm test -- packages/core` or `pnpm vitest run packages/core/src/foo.test.ts`
- New features must ship with tests; bug fixes should include a regression test
- Keep tests fast, deterministic, and free of external network dependencies

---

## Pull Request Process

> **AI-assistant contributions**: we welcome them! Please (1) disclose in the PR description that the code was AI-assisted, and (2) verify the full suite (`pnpm typecheck && pnpm lint && pnpm test`) before submitting. AI-generated PRs without verification are usually rejected at review.

1. **Find or create an issue** — comment on it that you are working on it to avoid duplicate work.
2. **Fork & branch** – create a branch with a clear name:
   ```bash
   git checkout -b feat/your-feature   # or fix/..., docs/..., test/...
   ```
3. **Make your changes** — follow [Code Standards](#code-standards). Keep the change focused on the issue; unrelated edits belong in their own PR.
4. **Verify locally** (all must pass):
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   For a narrow change you may run the relevant package's tests first, but the full suite must pass before submission.
5. **Commit** with a Conventional Commit message (see above).
6. **Push and open a PR** against `main` with:
   - A clear description: **what** changed, **why**, and **how you tested** it
   - The issue number it closes (e.g. `Closes #123`)
   - Screenshots/GIFs for UI changes
   - Notes for the reviewer (e.g., "I followed `docs/DEVELOPMENT.md` on macOS 14, Node 22")
7. **Keep the PR small** — maintainers review faster; large PRs are split on request.
8. **Address review feedback** — push fix commits (no force-push to your PR branch).
9. **Merge** — a maintainer merges after approval. Two approvals required for core-runtime changes (`core`, `org-manager`).

**PR checklist (copy-paste into your PR body):**

```markdown
- [ ] Tests pass (`pnpm test`)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] Added tests for new behavior / regression tests for bug fixes
- [ ] Docs updated if user-facing behavior changed
- [ ] No secrets or credentials in code
```

---

## Code Review Expectations

Reviewers check that the change:

- Aligns with the project structure and conventions in this guide
- Has tests where appropriate — new features and bug fixes
- Avoids unnecessary dependencies and scope creep
- Uses correct TypeScript types (no `any` leakage)
- Keeps API changes backward-compatible, or documents/migrates them
- Contains no security regressions (secrets, injection paths, privilege escalation)

**Everyone can review.** If you see a PR you can verify, leave a comment. Constructive, kind feedback is a contribution too.

---

## License & Contributor Sign-off

Markus is **dual-licensed**:

- **Open Source**: [Apache-2.0](LICENSE) — free to use, modify, distribute, and self-host for any purpose, including commercial use.
- **Commercial**: [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) — for teams needing enterprise support (SLA), indemnification, OEM embedding, or custom terms. The commercial license covers only the additional enterprise terms; the Apache-2.0 open-source license always governs the public code as published.

### Contributor License Agreement (CLA) & DCO

To keep the codebase legally clean for all users, we use the **Developer Certificate of Origin (DCO)** (the same lightweight mechanism used by the Linux kernel, Kubernetes, and most of the Apache ecosystem):

- Every commit you submit must be signed:
  ```bash
  git commit -s
  ```
  This adds a `Signed-off-by: Your Name <you@example.com>` trailer, certifying that you have the right to submit the change under the project license.
- **No separate CLA is required** for source-code contributions — the DCO sign-off on each commit covers it.
- By opening a PR with signed commits, you agree that your contributions are licensed under the [Apache-2.0 License](LICENSE) (and, where applicable, the commercial terms in [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) on the same code).

If you forget to sign a commit, the simplest fix is:

```bash
# amend the last commit
git commit --amend -s
# or rebase-sign a range
git rebase --signoff HEAD~N
```

---

## Resources

- [Architecture](docs/ARCHITECTURE.md) — system design, agent runtime, memory, governance
- [User Guide](docs/GUIDE.md) — setup, configuration, Web UI walkthrough
- [API Reference](docs/API.md) — REST API endpoints and WebSocket events
- [Skill Ecosystem](docs/SKILL-ECOSYSTEM.md) — import/export external skill formats
- [Development Guide](docs/DEVELOPMENT.md) — local setup, dev scripts, debugging
- [Release Notes](RELEASELOG.md) — what changed in each release

---

<p align="center">
  <strong>Questions?</strong> Open an issue or start a <a href="https://github.com/markus-global/markus/discussions">Discussion</a>.<br />
  We welcome all contributions, big or small! 🎉
</p>