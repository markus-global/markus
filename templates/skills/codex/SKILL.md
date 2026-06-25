---
name: codex
description: Use the OpenAI Codex CLI for quick fixes, targeted edits, and non-interactive automation
---

# Codex

Codex (`codex` binary) is OpenAI's agentic coding CLI. Markus invokes it via `invoke_coding_tool({ tool: "codex", ... })`. Use it for fast, focused changes where speed and non-interactive automation matter more than deep multi-turn exploration.

## Installation

```bash
npm install -g @openai/codex
codex --version
```

Verify with `markus doctor`. Requires authentication via `codex login` or `CODEX_API_KEY` env var for non-interactive mode.

## How Markus Invokes Codex

Markus runs Codex in fully automated, non-interactive mode:

```bash
codex exec --full-auto --json --skip-git-repo-check "<prompt>"
```

| Flag | Purpose |
|---|---|
| `exec --full-auto` | Non-interactive mode — auto-approves all file edits and shell commands |
| `--json` | Emits JSONL events for structured progress parsing |
| `--skip-git-repo-check` | Allows running outside strict git repo requirements |

Additional args can be configured via `CodingToolConfig.defaultArgs`.

## Full-Auto Approval Mode

In a Markus agent session, there is no human at the terminal to approve Codex actions. The `exec --full-auto` mode is essential:

- Codex can edit files and run commands without prompting
- All actions happen within the sandbox (see below)
- If Codex would normally ask "Allow this edit?", it proceeds automatically

**Note:** `OPENAI_BASE_URL` is deprecated and no longer supported by Codex CLI. Custom endpoint configuration should use `~/.codex/config.toml`.

**Implication:** Write precise prompts with clear scope boundaries. Codex will act autonomously on whatever the prompt authorizes.

## AGENTS.md Context File

Codex reads project-level instruction files to understand repo conventions. The standard file is **`AGENTS.md`** in the repository root — a markdown file describing:

- Project structure and architecture
- Coding conventions and patterns
- Test commands and CI expectations
- Areas that are off-limits or require caution

If the repo already has `AGENTS.md`, Codex uses it automatically. Ensure it stays accurate for the project.

### Markus Task Context Injection

When you pass `task_id` to `invoke_coding_tool`, Markus additionally writes task-specific context to:

```
.agent_context/task_context.md
```

This file contains the full Markus task context (title, description, dependencies, progress-reporting CLI commands). Codex can read it during execution alongside any existing `AGENTS.md`.

**Best practice:** Keep permanent project guidance in `AGENTS.md`. Task-specific instructions come from Markus injection — do not manually duplicate task details into `AGENTS.md`.

## Sandbox Behavior

Codex runs in a sandboxed environment that restricts what the agent can access:

- File edits are scoped to the working directory (`workdir`)
- Network access may be limited depending on Codex configuration
- Shell commands run within sandbox constraints

**Implications for prompts:**

- Specify the exact files or directories to modify
- Include the test command to run (e.g., `pnpm test packages/core`)
- Do not assume Codex can reach external APIs unless sandbox allows it
- If a task requires installing new dependencies, mention it explicitly in the prompt

If Codex fails due to sandbox restrictions, note the error and either adjust the prompt to work within constraints or switch to `claude-code` for less restrictive execution.

## Usage Patterns

### Quick Bug Fix

```
invoke_coding_tool({
  tool: "codex",
  prompt: "Fix the off-by-one error in src/utils/pagination.ts line 42. The page size should default to 20, not 21. Run tests in that package after fixing.",
  workdir: "/path/to/repo",
  task_id: "task-456"
})
```

### Targeted Feature Addition

```
invoke_coding_tool({
  tool: "codex",
  prompt: "Add a --json flag to the task list command in packages/cli/src/commands/task.ts. Follow the existing output pattern used by other commands. Add a test case.",
  workdir: "/path/to/repo",
  task_id: "task-456"
})
```

### Config or Script Update

```
invoke_coding_tool({
  tool: "codex",
  prompt: "Update the GitHub Actions workflow in .github/workflows/test.yml to add a matrix entry for Node 22. Do not change other jobs.",
  workdir: "/path/to/repo",
  task_id: "task-456"
})
```

## When to Choose Codex vs Other Tools

| Choose Codex | Choose something else |
|---|---|
| Single-file or few-file fix | Multi-package refactor → `claude-code` |
| Clear, narrow prompt | Exploratory "figure out how this works" → `claude-code` |
| Speed is priority | Need token/cost reporting → `claude-code` |
| Repo has good `AGENTS.md` | Heavy `.cursor/rules` setup → `cursor-agent` |

## Model and Effort Selection

Codex supports per-invocation model and effort overrides:

```
invoke_coding_tool({
  tool: "codex",
  prompt: "...",
  model: "gpt-5-codex",    // default if not specified
  effort: "medium",         // sets CODEX_REASONING_EFFORT env var
})
```

### Model guidance

| Model | Best for | Cost note |
|---|---|---|
| `gpt-5.4-mini` | Trivial fixes, typos, config | Cheapest option |
| `gpt-5-codex` | Standard coding work | Cost-effective default for coding |
| `gpt-5.5` | Complex reasoning, architecture | ~4x more expensive than gpt-5-codex |

**Strategy:** `gpt-5-codex` is the right default for most Codex work. Only use `gpt-5.5` when the task involves complex reasoning that simpler models fail at. Prefer `gpt-5.4-mini` for trivial, low-risk changes.

### Effort levels

- `minimal` / `low` — Simple fixes with minimal reasoning
- `medium` — Standard development (default)
- `high` / `xhigh` — Complex problem solving, only when needed

### Cost note

Codex does not expose structured cost data through Markus. Estimate cost by:
- Task complexity and expected duration
- Model choice (gpt-5.5 is ~4x more expensive)
- Number of turns the agent takes

**Voluntarily call `request_user_approval` before using `gpt-5.5` for tasks that might run long.**

## Error Handling

Focus on result quality:

1. Check `result.success` and `result.summary`
2. Review `result.modifiedFiles` — should match expected scope
3. Inspect `result.testResult` if quality verification ran
4. On failure, read `result.error` and retry with a narrower prompt

If Codex modifies unexpected files, discard changes (`git checkout -- .` in `workdir`) and re-invoke with explicit file boundaries:

```
"Modify ONLY packages/cli/src/commands/task.ts. Do not touch any other files."
```

## Best Practices

- Keep prompts short and specific — Codex excels at targeted tasks
- Ensure `AGENTS.md` exists for project conventions (create or update if missing)
- Always pass `task_id` for task context injection
- Verify changes with `git diff` before `coding_tool_apply`
- Use `gpt-5-codex` as the default — escalate only when justified
- `exec --full-auto` is handled by Markus — do not try to run Codex interactively from an agent

## Rules

- **DO** use for quick fixes and well-scoped edits
- **DO** maintain an accurate `AGENTS.md` in project repos
- **DO** set explicit file boundaries in prompts
- **DO** default to `gpt-5-codex` for cost-effectiveness
- **DO NOT** use for large exploratory refactors — use `claude-code`
- **DO NOT** assume network or install permissions — check sandbox errors
- **DO NOT** apply changes that touch files outside the stated scope
- **DO NOT** use `gpt-5.5` by default — its cost is ~4x higher
