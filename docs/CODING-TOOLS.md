# Coding Tools Integration

> Last updated: 2026-06

Technical reference for Markus's external coding tool integration — delegating hands-on programming work to Claude Code, Codex, and Cursor Agent while keeping task context, progress, and governance inside Markus.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Supported Tools](#supported-tools)
- [Configuration](#configuration)
- [Usage Guide](#usage-guide)
  - [For Agents](#for-agents)
  - [For External Tools](#for-external-tools)
  - [For Users](#for-users)
- [Developing New Adapters](#developing-new-adapters)
- [Skills](#skills)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

Markus agents orchestrate work — scoping tasks, coordinating dependencies, and reviewing deliverables. For substantial code changes, agents can delegate implementation to specialized external CLIs rather than editing files directly.

The Coding Tools integration provides:

- **Unified invocation** — one agent tool (`invoke_coding_tool`) for all supported CLIs
- **Context injection** — task, requirement, project, and dependency data written into tool-native config files before execution
- **Streaming progress** — stdout parsed into structured events surfaced to the agent in real time
- **Change application** — `coding_tool_apply` commits tool-produced diffs via git
- **Bidirectional reporting** — external tools report progress back through Markus CLI commands
- **Settings UI** — detect, enable, and configure tools from the Web UI

**When to use coding tools vs direct editing:**

| Use coding tools | Edit directly (`file_edit`, `shell_execute`) |
|---|---|
| Multi-file refactors, broad exploration | Small, well-known diffs (1–2 files) |
| Autonomous edit → test → fix loops | Configuration, docs, non-code work |
| Large implementation surface with clear acceptance criteria | Fine-grained control over every change |

Coding tools are **opt-in**. Set `codingTools.enabled: true` in `markus.json` (or via Settings → Coding Tools) before agents receive `invoke_coding_tool` and `coding_tool_apply`.

---

## Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent Runtime (@markus/core)                                       │
│  ┌──────────────────┐    ┌──────────────────────────────────────┐  │
│  │ Tool Handlers    │───▶│ CodingToolRuntime                    │  │
│  │ invoke_coding_   │    │  1. Create session                   │  │
│  │ tool             │    │  2. injectContext()                  │  │
│  │ coding_tool_     │    │  3. adapter.buildArgs()              │  │
│  │ apply            │    │  4. spawn CLI, stream stdout         │  │
│  └──────────────────┘    │  5. adapter.parseOutput() / extractCost│  │
│                          └──────────────┬───────────────────────┘  │
└─────────────────────────────────────────┼──────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
     ┌────────▼────────┐       ┌─────────▼─────────┐       ┌────────▼────────┐
     │ Tool Adapters   │       │ Context Injector  │       │ Quality Verifier│
     │ claude-code     │       │ CLAUDE.md         │       │ detectProjectType│
     │ codex           │       │ .cursor/rules/    │       │ runTests         │
     │ cursor-agent    │       │ .agent_context/   │       │ (utility module) │
     └────────┬────────┘       └───────────────────┘       └─────────────────┘
              │
     ┌────────▼────────┐       ┌───────────────────┐       ┌─────────────────┐
     │ External CLIs   │       │ Markus CLI        │       │ API Server      │
     │ claude / codex  │◀─────▶│ task show/context │◀─────▶│ GET /tasks/:id/ │
     │ / cursor        │       │ progress / note   │       │     context     │
     └─────────────────┘       └───────────────────┘       └─────────────────┘
```

### Package Layout

| Path | Role |
|---|---|
| `packages/shared/src/types/coding-tool.ts` | Type contracts (`ToolAdapter`, `CodingToolSession`, `TaskContextResponse`, etc.) |
| `packages/core/src/coding-tools/adapters/` | Per-tool adapters (detect, args, parse, cost) |
| `packages/core/src/coding-tools/runtime.ts` | Session lifecycle and CLI spawning |
| `packages/core/src/coding-tools/context-injector.ts` | Writes tool-specific context files |
| `packages/core/src/coding-tools/quality-verifier.ts` | Project type detection and test runner |
| `packages/core/src/coding-tools/handlers.ts` | `invoke_coding_tool` / `coding_tool_apply` handlers |
| `packages/cli/src/commands/task.ts` | CLI for external tools to query and report |
| `packages/org-manager/src/api-server.ts` | `/api/tasks/:id/context`, `/api/settings/coding-tools` |
| `packages/web-ui/src/pages/CodingToolsSettings.tsx` | Admin settings UI |
| `templates/skills/coding-tools/` | Agent skill documentation |

### Execution Flow

1. Agent receives a coding task and calls `invoke_coding_tool` with `tool`, `prompt`, `workdir`, and optionally `task_id`.
2. Handler selects the adapter, verifies the CLI is installed (`adapter.detect()`), and fetches task context (when `getTaskContext` is configured).
3. `CodingToolRuntime.execute()` creates a session, calls `injectContext()` to write context files, builds CLI args via the adapter, and spawns the process.
4. Each stdout line is parsed by `adapter.parseOutput()` into `CodingToolEvent` objects; progress and file-edit events stream back to the agent.
5. On process exit, the adapter extracts cost data (when available) and the session transitions to `completed` or `failed`.
6. Agent reviews the result, then calls `coding_tool_apply` to stage and commit changes.

### Session States

| Status | Meaning |
|---|---|
| `created` | Session record initialized |
| `context_injected` | Context files written to workdir |
| `running` | CLI process active |
| `completed` | Exit code 0 |
| `failed` | Non-zero exit or error |
| `cancelled` | Manually cancelled via `runtime.cancel()` |
| `timeout` | Exceeded configured `timeoutMs` |

---

## Supported Tools

### Claude Code

| Property | Value |
|---|---|
| Tool name | `claude-code` |
| Binary | `claude` |
| Install | `npm install -g @anthropic-ai/claude-code` |
| Auth | Anthropic API key (`ANTHROPIC_API_KEY`), custom endpoint (`ANTHROPIC_BASE_URL`), or Claude subscription via CLI login |

Markus invokes:

```bash
claude --print --output-format stream-json --verbose --max-turns 50 --permission-mode bypassPermissions "<prompt>"
```

- **stream-json** output enables structured progress parsing and cost extraction from `result` events.
- **`--permission-mode bypassPermissions`** is required because `--print` mode has no interactive stdin for approval prompts. Markus-level approval is handled separately via the `approvalRequired` config flag.
- **Context file:** `CLAUDE.md` in the repository root.
- **Best for:** Complex refactors, multi-file changes, sustained codebase exploration.
- **Cost tracking:** Yes — input/output tokens, cache stats, and `cost_usd` from result events.

### Codex

| Property | Value |
|---|---|
| Tool name | `codex` |
| Binary | `codex` |
| Install | `npm install -g @openai/codex` |
| Auth | `codex login`, or `CODEX_API_KEY` env var for non-interactive mode |

Markus invokes:

```bash
codex exec --full-auto --json --skip-git-repo-check "<prompt>"
```

- **`exec --full-auto`** runs in non-interactive mode with automatic approval for all edits and commands.
- **`--json`** emits JSONL events for structured progress parsing.
- **`--skip-git-repo-check`** allows running outside strict git repo requirements.
- **Context file:** `.agent_context/task_context.md` (alongside any existing `AGENTS.md`).
- **Best for:** Quick fixes, targeted patches, fast iteration.
- **Cost tracking:** Not currently extracted from output.
- **Note:** `OPENAI_BASE_URL` env var is deprecated. Custom endpoints require `~/.codex/config.toml` configuration.

### Cursor Agent

| Property | Value |
|---|---|
| Tool name | `cursor-agent` |
| Binary | `cursor` |
| Install | [cursor.sh](https://cursor.sh) — enable "Install 'cursor' command in PATH" from the Command Palette |
| Auth | Cursor account via `cursor agent login`, or `CURSOR_API_KEY` env var |

Markus invokes:

```bash
cursor agent --print --output-format stream-json --workspace <workdir> --trust --force "<prompt>"
```

- **`--print`** runs in non-interactive mode.
- **`--output-format stream-json`** emits structured JSON events for progress parsing.
- **`--trust --force`** auto-trusts the workspace without prompting.
- **Context file:** `.cursor/rules/markus-task.mdc` (alongside permanent project rules).
- **Best for:** Repos with `.cursor/rules`, IDE-integrated conventions.
- **Cost tracking:** May include tokens in result events.
- **Note:** The CLI's `--model` flag only accepts CLI-specific models (`auto`, `composer-2.5`, etc.). Cursor Cloud API models (Claude, GPT) are not available via the local CLI.

### Version Requirements

Markus detects tools via `which <binary>` and optionally reads `<binary> --version`. There is no enforced minimum version — use the latest stable release of each CLI. Run `markus doctor` to verify installation.

---

## Configuration

### markus.json

```json
{
  "codingTools": {
    "enabled": true,
    "tools": {
      "claude-code": {
        "enabled": true,
        "timeoutMs": 1800000,
        "defaultModel": "sonnet",
        "maxBudgetPerSessionUsd": 5,
        "approvalRequired": false
      },
      "codex": {
        "enabled": true,
        "timeoutMs": 1800000
      },
      "cursor-agent": {
        "enabled": true,
        "timeoutMs": 600000
      }
    }
  }
}
```

| Field | Description | Default |
|---|---|---|
| `enabled` | Master switch — when `false`, agents do not receive coding tool handlers | `false` |
| `tools.<name>.enabled` | Per-tool enable flag (persisted; used in Settings UI) | `true` |
| `tools.<name>.timeoutMs` | Max execution time in milliseconds | `600000` (10 min) |
| `tools.<name>.defaultArgs` | Extra CLI arguments appended by the adapter | `[]` |
| `tools.<name>.binaryPath` | Override binary path (detection still uses `binaryName`) | auto-detected |
| `tools.<name>.defaultModel` | Default model for the tool (agent can override per invocation) | tool's own default |
| `tools.<name>.maxBudgetPerSessionUsd` | Hard budget cap per invocation (Claude Code only, via `--max-budget-usd`) | none |
| `tools.<name>.approvalRequired` | Agent must get user approval before each invocation | `false` |

Configuration is loaded at startup (`markus start`) and can be updated live via the Settings UI (`POST /api/settings/coding-tools`). Changes take effect immediately without restart.

### Environment Variables

Injected into external tool processes by the context injector:

| Variable | Set when | Purpose |
|---|---|---|
| `MARKUS_API_URL` | `serverUrl` configured | Base URL for API calls from within the tool session |
| `MARKUS_TASK_ID` | Task context available | Current task ID |
| `MARKUS_CLI` | CLI path configured | Path to `markus` binary for progress reporting |

CLI global options (for external tools calling Markus):

| Variable / Flag | Purpose |
|---|---|
| `MARKUS_API_URL` / `-s, --server <url>` | API server URL (default: `http://localhost:8056`) |
| `-k, --api-key <key>` | Authentication |
| `--json` | Machine-readable JSON output |

Tool-specific credentials are configured in each CLI's own auth flow — **not** managed in the Markus Settings UI:

- **Claude Code:** `ANTHROPIC_API_KEY` env var, `ANTHROPIC_BASE_URL` for custom endpoints, or `claude` interactive login
- **Codex:** `codex login`, or `CODEX_API_KEY` env var for non-interactive mode. Custom endpoints via `~/.codex/config.toml` (the `OPENAI_BASE_URL` env var is deprecated and no longer supported)
- **Cursor:** `cursor agent login` browser auth, or `CURSOR_API_KEY` env var

---

## Usage Guide

### For Agents

Agents with the `coding-tools` skill (or the `coding` tool group activated) receive two tools:

#### `invoke_coding_tool`

```json
{
  "tool": "claude-code",
  "prompt": "Implement JWT auth middleware in src/auth/. Run tests when done.",
  "workdir": "/absolute/path/to/repo",
  "task_id": "task-abc123"
}
```

| Parameter | Required | Description |
|---|---|---|
| `tool` | Yes | `claude-code`, `codex`, or `cursor-agent` |
| `prompt` | Yes | Instruction sent to the external CLI |
| `workdir` | Yes | Absolute path to the repository root |
| `task_id` | No | Enables full task context injection |

**Response shape:**

```json
{
  "status": "success",
  "sessionId": "uuid",
  "tool": "claude-code",
  "result": {
    "success": true,
    "summary": "Tool completed successfully",
    "rawOutput": "...",
    "exitCode": 0
  },
  "cost": {
    "inputTokens": 5000,
    "outputTokens": 1200,
    "estimatedCostUsd": 0.12,
    "source": "tool_output"
  }
}
```

Progress events (`file_edit`, `progress`) stream to the agent during execution via the tool output callback.

#### `coding_tool_apply`

```json
{
  "session_id": "uuid-from-invoke-response",
  "workdir": "/absolute/path/to/repo",
  "commit_message": "feat: add JWT auth middleware"
}
```

Stages all changes (`git add -A`) and creates a commit. Returns `{ status: "success", commitLog: "..." }` or an error if git operations fail.

#### Prompt Guidelines

1. State the **goal** and acceptance criteria.
2. Define **scope** — directories/files in and out of bounds.
3. List **constraints** — patterns, coding standards, test commands.
4. Specify **verification** — how to confirm success.
5. Keep each invocation focused — one coherent unit of work.

Always pass `task_id` when working on an assigned Markus task so context injection includes requirement, project, and dependency data.

#### Tool Selection

| Scenario | Tool |
|---|---|
| Large multi-package refactor | `claude-code` |
| One-file bug fix | `codex` |
| Repo with `.cursor/rules` | `cursor-agent` |
| Need cost/token visibility | `claude-code` |

### For External Tools

External CLIs running inside a Markus session can query task state and report progress using the Markus CLI. Context files injected before execution include these commands.

#### Task Commands

```bash
# View task details
markus task show <id>

# Full composite context (task + requirement + project + dependencies)
markus task context <id>

# List tasks (with filters)
markus task list --status in_progress --project <projectId>

# View dependency graph
markus task deps <id>

# Report progress (posted as a task comment)
markus task progress <id> -t "50% done — auth middleware implemented" --percent 50

# Add a note or comment
markus task note <id> -t "Found edge case in token refresh"
markus task comment <id> -t "Same as note — alias command"
```

Add `--json` for machine-readable output:

```bash
markus --json task context <id>
```

#### Requirement and Project Commands

```bash
markus requirement show <id>
markus requirement list --project <projectId>
markus req list                          # alias

markus project show <id>
markus project list
```

#### CLI Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error (bad args, not found) |
| `2` | Server error |
| `3` | Network error |

### For Users

#### Enabling Coding Tools

1. Open **Settings → Coding Tools** (admin only).
2. Toggle **Enable coding tools** globally.
3. For each tool, expand the card to review detection status and toggle enable/disable.
4. Use **Test Configuration** to verify the tool actually works (runs a real test prompt).
5. Optionally configure default model, timeout, budget cap, and CLI arguments.

Changes auto-save and apply immediately to the running agent manager.

#### Detection and Testing

- **Auto-detection:** On page load, Markus checks if CLIs are installed and authenticated. Results are cached for 24 hours with silent background refresh.
- **Test button:** Runs the actual CLI with a minimal prompt to verify end-to-end connectivity (not just env var checks). If the test succeeds, the status badge updates to "Ready" immediately.
- **Re-detect button:** Force-refreshes all tools' installation and auth status.
- **CLI:** Run `markus doctor` — the "Coding Tools" section reports each binary's path or install hint.

Detection checks system environment variables first (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `CURSOR_API_KEY`), then falls back to CLI auth commands. This ensures tools authenticated via env vars are correctly detected as ready.

#### CodingToolCard (Web UI)

The `CodingToolCard` component displays active coding tool sessions in the agent execution view:

- Tool badge (Claude Code / Codex / Cursor)
- Session status pipeline: Created → Context injected → Running → Completed/Failed
- Progress message, duration, and cost (when available)
- Diff stats and modified files on completion

#### Troubleshooting Quick Checks

1. `markus doctor` — are CLIs installed and on PATH?
2. Settings → Coding Tools — is global enable on?
3. Agent role — does the agent have the `coding-tools` skill?
4. `markus.json` — is `codingTools.enabled` true?
5. Restart Markus after config changes if tools don't appear.

---

## Developing New Adapters

To add support for a new external coding CLI:

### 1. Extend Types

Add the tool name to `CodingToolName` in `packages/shared/src/types/coding-tool.ts`:

```typescript
export type CodingToolName = 'claude-code' | 'codex' | 'cursor-agent' | 'my-tool';
```

Update `isCodingToolName()` accordingly.

### 2. Implement ToolAdapter

Create `packages/core/src/coding-tools/adapters/my-tool-adapter.ts`:

```typescript
import type { ToolAdapter, ToolAdapterDetectResult, ToolAdapterBuildArgsResult, CodingToolConfig, CodingToolEvent, ToolCostReport } from '@markus/shared';

export class MyToolAdapter implements ToolAdapter {
  readonly name = 'my-tool' as const;
  readonly displayName = 'My Tool';
  readonly binaryName = 'my-tool-cli';

  async detect(): Promise<ToolAdapterDetectResult> {
    // execSync('which my-tool-cli') — return { available, version, path, installHint }
  }

  buildArgs(opts: { prompt: string; workdir: string; config?: CodingToolConfig }): ToolAdapterBuildArgsResult {
    // Return { args: [...], env: {...} }
  }

  parseOutput(line: string): CodingToolEvent | null {
    // Parse one stdout line → CodingToolEvent or null
  }

  extractCost(output: string): ToolCostReport | null {
    // Best-effort cost extraction from full output
  }
}
```

### 3. Register the Adapter

In `packages/core/src/coding-tools/adapters/index.ts`:

```typescript
const adapters: Record<CodingToolName, () => ToolAdapter> = {
  // ...existing
  'my-tool': () => new MyToolAdapter(),
};
```

### 4. Add Context Injection Path

In `packages/core/src/coding-tools/context-injector.ts`, add a branch in `injectContext()` for where the new tool reads project context (e.g., a config file or directory the tool natively supports).

### 5. Wire Configuration and UI

- Add the tool name to detection lists in `api-server.ts` (`/api/settings/coding-tools`) and `doctor.ts`.
- Add UI metadata in `CodingToolsSettings.tsx` and locale strings.
- Add the tool to the `invoke_coding_tool` input schema enum in `handlers.ts`.

### 6. Create a Skill

Add `templates/skills/my-tool/SKILL.md` and `skill.json` documenting tool-specific usage for agents.

### 7. Test

Follow patterns in `packages/core/test/coding-tools/` — adapter unit tests, handler tests with mocked spawn, and integration tests for config loading.

### ToolAdapter Interface Reference

```typescript
interface ToolAdapter {
  readonly name: CodingToolName;
  readonly displayName: string;
  readonly binaryName: string;

  detect(): Promise<ToolAdapterDetectResult>;
  buildArgs(opts: { prompt: string; workdir: string; config?: CodingToolConfig }): ToolAdapterBuildArgsResult;
  parseOutput(line: string): CodingToolEvent | null;
  extractCost(output: string): ToolCostReport | null;
}
```

Event types: `progress`, `tool_use`, `file_edit`, `test_run`, `error`, `cost_update`, `completed`.

---

## Skills

Markus ships skill packages under `templates/skills/` that teach agents how to use coding tools effectively.

| Skill | Purpose | Agents |
|---|---|---|
| `coding-tools` | General workflow — when to delegate, invoke/apply, error handling, progress reporting | architect, ai-engineer, data-engineer, sre |
| `claude-code` | Claude Code specifics — stream-json, CLAUDE.md, cost tracking, retry strategies | loaded on demand via `discover_tools` |
| `codex` | Codex specifics — full-auto mode, AGENTS.md, sandbox behavior | loaded on demand |
| `cursor-agent` | Cursor specifics — `.cursor/rules`, working directory setup | loaded on demand |

### Installing Skills

Skills are installed like any Markus skill — via the Web UI skill manager or the Secretary agent's `package_install` tool. Role templates reference skills in `agent.json`:

```json
{
  "skills": ["coding-tools"]
}
```

### Customizing Skills

Copy a skill directory to your organization's skills path and edit `SKILL.md`. Skills are injected into context files when `getSkills` is configured on the coding tool handler. Tool-specific skills can also be loaded dynamically:

```
discover_tools({ name: ["claude-code"] })
```

### Tool Group Activation

The `coding` tool group in `packages/core/src/tool-selector.ts` auto-activates `invoke_coding_tool` and `coding_tool_apply` when conversation keywords match (e.g., "refactor", "implement", "debug", "claude code").

---

## API Reference

### Task Context

**`GET /api/tasks/:id/context`**

Returns composite context for a task — used by the context injector and available to external tools via CLI.

**Response:** `TaskContextResponse`

```typescript
{
  task: {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    subtasks: Array<{ id: string; title: string; status: string }>;
    notes?: string[];
    deliverables?: TaskDeliverable[];
    completionSummary?: string;
    assignedAgentId: string;
    reviewerId: string;
    executionRound: number;
    createdAt: string;
    updatedAt: string;
  };
  requirement?: { id: string; title: string; description: string; status: string };
  project?: {
    id: string;
    name: string;
    description: string;
    repositories: Array<{ url?: string; localPath?: string; role?: string }>;
  };
  upstream: Array<{ id: string; title: string; status: TaskStatus; notes?: string[]; completionSummary?: string; deliverables?: TaskDeliverable[] }>;
  downstream: Array<{ id: string; title: string; status: TaskStatus }>;
}
```

**Errors:** `404` if task not found, `500` on server failure.

### Coding Tools Settings

**`GET /api/settings/coding-tools`**

Returns current configuration:

```json
{
  "enabled": true,
  "tools": {
    "claude-code": { "tool": "claude-code", "enabled": true, "timeoutMs": 600000, "defaultArgs": [] },
    "codex": { "tool": "codex", "enabled": true, "timeoutMs": 600000, "defaultArgs": [] },
    "cursor-agent": { "tool": "cursor-agent", "enabled": false, "timeoutMs": 600000, "defaultArgs": [] }
  }
}
```

**`POST /api/settings/coding-tools`** (auth required)

Update configuration. Body: `{ enabled: boolean, tools: { "<name>": { enabled?, binaryPath?, defaultArgs?, timeoutMs?, defaultModel?, maxBudgetPerSessionUsd?, approvalRequired? } } }`.

**`GET /api/settings/coding-tools/detect/:tool`**

Detect a single tool. Returns installation, version, and authentication status.

**`POST /api/settings/coding-tools/:tool/test`** (auth required)

Run a real test against the tool CLI to verify end-to-end connectivity. Returns `{ success, detail?, error? }`.

**`GET /api/settings/coding-tools/detect`**

Detect installed CLIs:

```json
{
  "tools": [
    { "name": "claude-code", "displayName": "Claude Code", "binaryName": "claude", "available": true, "path": "/usr/local/bin/claude", "version": "1.0.0", "installHint": "npm install -g @anthropic-ai/claude-code" }
  ]
}
```

### Related Task Endpoints

| Method | Path | Used by |
|---|---|---|
| `GET` | `/api/tasks/:id` | `markus task show` |
| `GET` | `/api/tasks/:id/dependents` | `markus task deps` |
| `POST` | `/api/tasks/:id/comments` | `markus task note/progress/comment` |
| `GET` | `/api/requirements/:id` | `markus requirement show` |
| `GET` | `/api/projects/:id` | `markus project show` |

### Core Types

All coding tool types live in `packages/shared/src/types/coding-tool.ts`:

- `CodingToolName`, `CodingToolConfig`, `CodingToolSession`, `CodingToolResult`
- `CodingToolEvent`, `ToolCostReport`, `TestResult`
- `ToolAdapter`, `TaskContextResponse`
- `CliResponse`, `CLI_EXIT_CODES`

### Handler Options (Internal)

`CodingToolHandlerOptions` in `handlers.ts`:

| Option | Purpose |
|---|---|
| `getTaskContext(taskId)` | Fetch `TaskContextResponse` for context injection |
| `configs` | Per-tool `CodingToolConfig` from `markus.json` |
| `markusCli` | Path injected as `MARKUS_CLI` env var |
| `serverUrl` | Injected as `MARKUS_API_URL` env var |
| `getSkills(toolName)` | Skills appended to injected context files |

---

## Troubleshooting

### Tool Not Installed

**Symptom:** `invoke_coding_tool` returns `{ error: "Claude Code is not installed...", installHint: "..." }`.

**Fix:** Install the CLI per the install hint. Run `markus doctor` to verify. Ensure the binary is on the agent process PATH (same environment as `markus start`).

### Coding Tools Not Available to Agents

**Symptom:** Agent doesn't have `invoke_coding_tool` in its tool list.

**Checks:**
1. `codingTools.enabled` must be `true` in `markus.json` or Settings UI.
2. Restart or save settings to reload agent manager config.
3. Agent role must include the `coding-tools` skill or trigger the `coding` tool group.

### Timeout

**Symptom:** Session status `timeout`, error mentions exceeded `timeoutMs`.

**Fix:** Increase `timeoutMs` for the tool in Settings (default 600000 ms). Split large tasks into smaller focused invocations.

### Empty or Minimal Context Injection

**Symptom:** Injected `CLAUDE.md` contains only the prompt, missing requirement/project/deps.

**Cause:** `task_id` was passed but full context wasn't fetched. The handler supports a `getTaskContext` callback; when unavailable, it falls back to a minimal stub.

**Fix:** Ensure the task exists and use `markus task context <id>` to verify the API returns full data. External tools can always fetch context directly via CLI.

### Context File Overwrites

**Symptom:** Existing `CLAUDE.md` or project rules modified unexpectedly.

**Cause:** Markus writes ephemeral context files before each invocation (`CLAUDE.md`, `.cursor/rules/markus-task.mdc`, `.agent_context/task_context.md`).

**Fix:** Keep permanent project guidance in dedicated files (e.g., `.cursor/rules/coding-standards.mdc`, `AGENTS.md`). Markus task context goes in the tool-specific injected file. Review diffs before applying with `coding_tool_apply`.

### Apply Failures

**Symptom:** `coding_tool_apply` returns `{ error: "Failed to apply changes: ..." }`.

**Checks:**
1. `workdir` must be a git repository.
2. Run `git status` manually — resolve conflicts or untracked issues.
3. Ensure there are actual changes to commit.

### No Cost Data

**Symptom:** `cost` field is null or missing.

**Cause:** Only Claude Code's stream-json `result` events provide token/cost data. Codex and Cursor adapters return `null` from `extractCost()`.

### Progress Not Streaming

**Symptom:** Agent sees only start/end messages, no intermediate updates.

**Cause:** Tool output format may not match adapter parsing. Claude Code stream-json provides the richest events; Codex and Cursor emit simpler text lines.

**Fix:** Check `result.rawOutput` in the response for the full truncated stdout (max 50 KB).

### External CLI Can't Reach Markus API

**Symptom:** `markus task` commands fail with network errors from inside a tool session.

**Checks:**
1. `MARKUS_API_URL` env var is set (via context injection when server URL is configured).
2. API server is running and reachable from the tool's environment.
3. Authenticate CLI with `-k, --api-key` or login if required.

### Quality Verifier Not Running Automatically

**Symptom:** `result.testResult` is never populated.

**Cause:** `detectProjectType()` and `runTests()` are exported utilities but are not yet wired into `CodingToolRuntime.execute()`. Agents should run tests explicitly via prompts or `shell_execute` after tool completion.

---

## Related Documentation

- [Architecture](./ARCHITECTURE.md) — overall platform architecture
- [API Reference](./API.md) — full REST API
- [User Guide](./GUIDE.md) — setup and Web UI usage
