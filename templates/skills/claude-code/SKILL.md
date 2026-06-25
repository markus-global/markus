---
name: claude-code
description: Use the Claude Code CLI for complex refactors, multi-file changes, and sustained codebase exploration
---

# Claude Code

Claude Code (`claude` binary) is Anthropic's agentic coding CLI. Markus invokes it via `invoke_coding_tool({ tool: "claude-code", ... })`. Use it for complex, multi-turn coding tasks where deep reasoning and broad file exploration are needed.

## Installation

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Verify with `markus doctor`. Requires authentication via one of: `ANTHROPIC_API_KEY` env var, `ANTHROPIC_BASE_URL` for custom endpoints, or interactive `claude` login.

## How Markus Invokes Claude Code

Markus runs Claude Code in non-interactive print mode with structured streaming output:

```bash
claude --print --output-format stream-json --verbose --max-turns 50 --permission-mode bypassPermissions "<prompt>"
```

| Flag | Purpose |
|---|---|
| `--print` | Non-interactive mode — runs to completion without user input |
| `--output-format stream-json` | Emits structured JSON events for progress parsing |
| `--verbose` | Detailed progress output |
| `--max-turns 50` | Allows up to 50 agent turns for complex tasks |
| `--permission-mode bypassPermissions` | Auto-approves all file edits and commands — required because `--print` mode has no interactive stdin for approval prompts |

Additional args can be configured per-deployment via `CodingToolConfig.defaultArgs`.

## Stream-JSON Output

Each stdout line is a JSON event. Key event types:

| Event type | Meaning |
|---|---|
| `assistant` with `text` content | Progress message / reasoning summary |
| `assistant` with `tool_use` | File edit, shell command, or other tool invocation |
| `result` | Final outcome with cost and token data |

The `result` event includes:

- `result` — Final summary text
- `input_tokens`, `output_tokens` — Token usage
- `cache_read_tokens`, `cache_write_tokens` — Prompt cache stats
- `cost_usd` — Estimated cost in USD

Markus parses these into progress events (`file_edit`, `progress`, `completed`) and extracts cost reports automatically.

## CLAUDE.md Context File

When you pass `task_id` to `invoke_coding_tool`, Markus writes a `CLAUDE.md` file in the repository root before invoking Claude Code. This file contains:

- Task title, description, status, and priority
- Subtasks, notes, and deliverables
- Requirement and project context
- Upstream/downstream dependency summaries
- Markus CLI commands for reporting progress

Claude Code reads `CLAUDE.md` automatically as project context. **Do not delete or overwrite it** during a session — it is regenerated each invocation.

If the repo already has a permanent `CLAUDE.md`, Markus overwrites it for the session. Consider restoring project-level content after the task if needed.

## Usage Patterns

### Complex Refactor

```
invoke_coding_tool({
  tool: "claude-code",
  prompt: "Refactor the auth module to use dependency injection. Move AuthService to src/services/, update all imports, keep existing test behavior. Run the test suite when done.",
  workdir: "/path/to/repo",
  task_id: "task-123"
})
```

### Debug and Fix

```
invoke_coding_tool({
  tool: "claude-code",
  prompt: "Tests in packages/core/test/auth.test.ts are failing with 'token expired'. Find the root cause in src/auth/ and fix without changing the public API. Show which tests pass after the fix.",
  workdir: "/path/to/repo",
  task_id: "task-123"
})
```

### Explore Then Implement

For unfamiliar codebases, ask Claude Code to explore first:

```
"Read the codebase structure under src/coding-tools/. Then implement the feature described in the task context. Start by listing the files you plan to modify."
```

## Retry Strategies for Long Tasks

Claude Code supports up to 50 turns, but long tasks can still stall or partially complete.

### If the session completes but work is incomplete

Re-invoke with explicit remaining scope:

```
"Previous session modified src/foo.ts and src/bar.ts but did not update tests. Complete the test coverage for the changes in src/foo.ts. Do not re-modify files that are already correct."
```

### If the session fails or times out

1. Check `git status` in `workdir` for partial changes
2. Either apply partial work with `coding_tool_apply` or discard with `git checkout -- .`
3. Retry with a **smaller scope** — one module or one feature at a time

### If Claude Code loops or over-edits

Add constraints to the prompt:

```
"Modify ONLY files under src/handlers/. Do not touch tests, config, or unrelated packages."
```

### Escalation after 2 retries

Switch to `codex` for a targeted fix, or edit directly with `file_edit`.

## Model and Effort Selection

Claude Code supports per-invocation model and effort overrides:

```
invoke_coding_tool({
  tool: "claude-code",
  prompt: "...",
  model: "sonnet",     // default: tool's own default (usually sonnet)
  effort: "medium",    // low | medium | high | xhigh | max
})
```

### Model guidance

| Model | Best for | Cost note |
|---|---|---|
| `haiku` | Simple subagent tasks, quick checks | Cheapest option |
| `sonnet` | Most coding work — default choice | Good balance of cost and capability |
| `opus` | Complex architecture, multi-file refactors, unfamiliar codebases | ~15x more expensive per token than Sonnet |
| `fable` | Creative or documentation tasks | Specialized |

**Strategy:** Start with `sonnet` (or the user's `defaultModel`). Only use `opus` when:

- Sonnet attempt failed or produced poor results
- The task involves complex reasoning across 10+ files
- Architecture decisions or trade-off analysis is required

**Warning:** Opus is approximately 15x more expensive than Sonnet per token. A task that costs $0.30 with Sonnet could cost $4.50 with Opus. **Voluntarily call `request_user_approval` before using Opus for any task expected to run more than a few turns.**

### Effort guidance

- `low` — Simple edits, typo fixes, config changes
- `medium` — Standard development tasks (default)
- `high` — Complex reasoning, multi-step problem solving

### Budget cap

If the user has set `maxBudgetPerSessionUsd`, Markus passes it as `--max-budget-usd` to Claude Code. This is a **hard limit enforced by Claude Code** — the session terminates if the budget is reached. Claude Code is the only tool with this enforced budget mechanism.

When working under a budget cap:
- Prefer `sonnet` over `opus` to stay within budget
- Split large tasks so each invocation stays within the per-session limit
- Monitor `cost.estimatedCostUsd` in results to gauge remaining budget capacity

## Cost Awareness

Claude Code is the most capable but potentially most expensive coding tool. It provides the **best cost visibility** — every result includes token counts and USD estimates:

```json
{
  "cost": {
    "estimatedCostUsd": 0.45,
    "inputTokens": 85000,
    "outputTokens": 12000,
    "cacheReadTokens": 40000,
    "source": "tool_output"
  }
}
```

**Cost-saving practices:**

- Scope prompts tightly — avoid "refactor everything"
- Split large tasks into sequential focused invocations
- Use `codex` for trivial fixes instead of Claude Code
- Leverage prompt caching (repeated context in CLAUDE.md is cache-friendly)
- Review `cost.estimatedCostUsd` before chaining multiple invocations
- Use `effort: "low"` for simple edits, `effort: "high"` only for complex reasoning
- Prefer `sonnet` — only escalate to `opus` when justified

Report unusually high costs (> $1 per invocation) in a task note for visibility.

## Best Practices

- Write prompts with explicit file boundaries and test commands
- Always pass `task_id` so CLAUDE.md carries full task context
- Watch progress output for `file_edit` events to track what's changing
- Verify `result.testResult` before calling `coding_tool_apply`
- Prefer Claude Code when the task requires reading 5+ files to understand context
- Check `cost.estimatedCostUsd` after each invocation and factor it into your next decision

## Rules

- **DO** use for multi-file refactors and exploratory coding
- **DO** monitor token/cost data in the response
- **DO** break very large tasks into sequential invocations
- **DO** start with `sonnet` and only escalate to `opus` when needed
- **DO** request user approval before using `opus` for long tasks
- **DO NOT** use for one-line fixes — use `codex` or direct edit instead
- **DO NOT** ignore failed tests in the result — iterate until they pass
- **DO NOT** use `opus` by default — its cost can surprise users
