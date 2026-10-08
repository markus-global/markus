# Markus Local Development Guide

This document is for developers who want to work on the Markus source code (get it running, change code, submit PRs). For the full contribution workflow, see [CONTRIBUTING.md](../../CONTRIBUTING.md) in the repository root.

---

## 1. Environment Requirements

| Dependency | Minimum version | Description |
|------|---------|------|
| Node.js | 22.0.0+ | Runtime (LTS recommended; manage with `nvm`/`fnm`) |
| pnpm | 9.0.0+ | Package manager (`npm install -g pnpm`) |
| Docker | 24.0+ | Optional; only needed for agent sandbox containers and some integration tests |
| Git | Any | Version control |

> On macOS with Homebrew: `brew install node pnpm`. On Windows, WSL2 or Git Bash is recommended; the core scripts are cross-platform, but `scripts/install.sh` and the like are bash.

---

## 2. Quick Start

```bash
# 1. Clone
git clone https://github.com/markus-global/markus.git
cd markus

# 2. Install dependencies (the workspace installs all packages in one shot)
pnpm install

# 3. Build all TypeScript packages
pnpm build

# 4. Start the development environment (API 8056 + Web UI 8057)
pnpm dev
```

After a successful start:

- **Web UI**: http://localhost:8057
- **API**: http://localhost:8056
- **First login**: `admin@markus.local` / `markus123`; the onboarding wizard will ask you to set your own credentials
- **Storage**: SQLite (zero external dependencies); data lives under `~/.markus/` by default

> `pnpm dev` runs `pnpm build` first, then starts the API and Vite together. The first start takes a minute or two; when you see both processes (the `api` one in blue, the `ui` one in green), it has succeeded.

---

## 3. dev Scripts in Detail

All commands are defined in the `scripts` section of the root [package.json](../../package.json).

| Command | Purpose and internal behavior |
|------|---------------|
| `pnpm dev` | **Recommended for day-to-day development**. `pnpm build` → starts the API (`node packages/cli/dist/index.js start`) and the Web UI (Vite, with `/api` `/ws` proxies) together. The UI starts automatically once the API is ready (`scripts/wait-for-api.mjs`) |
| `pnpm dev:api` | Starts only the API service. **Requires a prior `pnpm build`** (it runs the `dist/` output; pair it with the tsc watcher from `pnpm dev:watch` for hot reload) |
| `pnpm dev:ui` | Starts only the Web UI Vite dev server (assumes the API is already running on 8056 or on the port specified in `~/.markus/markus.json`) |
| `pnpm dev:watch` | The ultimate development setup: `pnpm -r --parallel --filter=!@markus/web-ui dev` has every package rebuild in tsc watch mode + starts the API + starts the UI. Editing `packages/*/src` triggers automatic recompile and restart |
| `pnpm dev:desktop` | Electron desktop development: runs API + Vite + Electron together (`ELECTRON_DEV=1 electron .`, inside `packages/desktop/`) |
| `pnpm build` | Builds all packages (`pnpm -r build`); output goes to each package's `dist/` |
| `pnpm test` | Full Vitest test suite |
| `pnpm typecheck` | `tsc -b` (monorepo referenced build) + a separate `tsc --noEmit` for the Web UI |
| `pnpm lint` | ESLint over `packages/*/src/` |
| `pnpm quality` | `typecheck` + `test` combined |
| `pnpm clean` | Cleans all build output |
| `pnpm markus` | Runs the CLI directly from source (equivalent to `node packages/cli/dist/index.js`) |
| `pnpm build:publish` | Full publish build (build + web-ui + cli bundle) |
| `pnpm build:desktop` | Desktop installer (Electron builder) |

### Ports and Configuration

- Default ports: API **8056**, Web UI **8057**; change them via `server.apiPort` in `~/.markus/markus.json` (`scripts/wait-for-api.mjs` reads this automatically).
- LLM configuration: copy `markus.json.example` to `~/.markus/markus.json` and fill in your LLM provider API key (Anthropic / OpenAI / DeepSeek / Ollama / OpenRouter, etc.). You can also configure it on the Web UI settings page.
- Note: the root `markus.json.example` is a configuration sample — do **not** commit real keys to the repository.

---

## 4. Project Structure at a Glance

The repository is a pnpm workspace monorepo:

```
packages/
├── shared/           Shared types/constants/utilities
├── core/             Agent runtime: LLM routing, tools, skills, memory, heartbeat, workspace isolation
├── storage/          SQLite/PostgreSQL repository layer
├── org-manager/      REST API + WebSocket + org governance + task lifecycle
├── web-ui/           React + Vite + Tailwind frontend
├── desktop/          Electron desktop app
├── cli/              Command-line entry point (@markus-global/cli)
├── comms/            Slack / Feishu / WhatsApp / Telegram external bridges
├── a2a/              Inter-agent communication protocol
├── gui/              GUI automation (VNC + OmniParser)
├── remote/           Remote access (Cloudflare Tunnel / Tailscale / FRP / ngrok)
├── chrome-extension/  Browser extension
├── scripts/          Build/release/utility scripts
├── templates/        Agent role (ROLE.md) and skill (SKILL.md) templates
├── docs/             Design documents (architecture, API, memory, skill ecosystem...)
└── examples/         Runnable examples
```

**Getting started**: read `docs/architecture/ARCHITECTURE.md` (system architecture) and `docs/architecture/AGENT-RUNTIME.md` (agent lifecycle) first, then look at the package you want to change.

---

## 5. Testing

- Framework: **Vitest**. The root `vitest.config.ts` defines two projects — `node` (backend packages) and `web-ui` (frontend, `happy-dom`) — so run `pnpm test:node` or `pnpm test:web-ui` to target one side.
- Run just one package/file (faster for local development):
  ```bash
  pnpm test -- packages/core          # filter by path
  pnpm test -- src/foo.test.ts        # single file
  pnpm test:node                      # backend (node project) only
  pnpm test:web-ui                    # frontend (web-ui project) only
  pnpm test:watch                     # watch mode
  pnpm test:coverage                  # coverage
  ```
- Always run the full `pnpm test` before committing.

> ⚠️ **Known environment-dependent failures**: a handful of cases in the full suite need external resources (local port 8056 in use, search/image API keys, external model calls, etc.); they pass in a clean environment/CI but may fail locally. If you hit a failure before committing, compare against the baseline to confirm whether you introduced it: `git stash && pnpm test -- <failing file> && git stash pop`.

### 5.1 Coverage Baseline and CI Gates

> Last updated: 2026-09 (evergreen baseline after the v0.9.9 release assessment).

- **Backend thresholds** (`packages/core` / `org-manager` / `storage` / combined): **71 / 61 / 73 / 74**.
  The whole repo has roughly **360 test files**; the backend tests are solid and a trustworthy precondition for a release.
- **CI gate composition**: 3 architecture-gate rules, session invariants as their own step, a coverage ratchet (only up, never down),
  HOME isolation (`MARKUS_*` environment variables are not isolated — a known gap).
- **Frontend coverage history lesson**: it was once shut out entirely (vitest include omitted `.tsx`, exclude ruled out
  `packages/web-ui`), showing up as a fake 0% — a **wrong denominator**, not broken collection. The frontend must explicitly collect
  `.tsx` and configure its own coverage include.
- **Gap inventory**: roughly 20 high-risk, untested frontend files (the exact list changes over time; defer to the CI gap report).

### 5.2 Test Quality Conventions (Preventing Fake Green)

- **Assumed green needs reverse verification**: a passing test is not a valid test — introduce a bug on purpose and confirm it turns red.
- **Behavior-level assertions > text sniffing**: assert on function/semantic results, not on output text fragments.
- **Environment isolation**: tests must not depend on host environment variables; CI's wui-check / separate configs must isolate explicitly.
- **Skipped cases need auditing**: `it.skip` / `describe.skip` must have a reason, otherwise treat it as debt.
- **Coverage ratchet**: only up, never down; guards against fake 0% green / silent failure (a broken coverage config must be able to raise an alarm).
- **Real defect patterns to remember** (past fixes, to prevent recurrence): Gemini reasoning content silently dropped, async transaction callbacks
  not rolling back, provider timeouts with no fallback, watchdog with no signal — regress against these patterns when fixing.

### 5.3 Notes on vitest Multi-project Configuration

- `coverage.include` / `exclude` are **project-level** settings; root-level settings are not automatically inherited by child projects —
  an omission makes a child project's coverage silently 0 or makes it run the wrong file set (one root cause of the frontend's fake 0%).
- When adding a project, you must check all of the following at the same time: whether include covers the target extension (`.tsx`),
  whether exclude accidentally kills the target package, and whether the coverage gate is in effect (deliberately lower the threshold to confirm it turns red).

---

## 6. Debugging and Common Issues

| Problem | Solution |
|------|---------|
| Port 8056 is in use | Find the process holding it (`lsof -i :8056`), or change `server.apiPort` in `~/.markus/markus.json`; the UI proxy follows along |
| Changes to `packages/*/src` have no effect | Use `pnpm dev:watch` (tsc watch); under plain `pnpm dev`, changing the API requires restarting the API process |
| Frontend changes don't refresh | Vite usually hot-reloads; if you changed `locales` or constants, just refresh the browser |
| `pnpm install` reports a peer conflict | Use `pnpm install --fix-lockfile` (do not delete the lockfile) |
| Development data got dirty | Delete and recreate the corresponding database file under `~/.markus/` (acceptable during development; back up production data first) |
| Want to connect a real LLM | Configure a provider key in `~/.markus/markus.json` or on the Web UI settings page |
| Debugging the API | `curl http://localhost:8056/api/health` to check liveness; for REST endpoints see `docs/api/API.md` |

---

## 7. Pre-commit Checklist

```bash
pnpm typecheck   # all types pass
pnpm lint        # no new warnings/errors
pnpm test        # all tests green (compare against the baseline first to rule out environment failures)
git commit -s    # DCO-signed commit (important! see CONTRIBUTING.md)
```

For more workflow (PR conventions, code standards, License and DCO), see [CONTRIBUTING.md](../../CONTRIBUTING.md).
