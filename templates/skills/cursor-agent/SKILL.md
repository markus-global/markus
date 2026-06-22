---
name: cursor-agent
description: Use the Cursor CLI agent mode for IDE-integrated coding with project rules and repo-aware edits
---

# Cursor Agent

Cursor Agent (`cursor` binary) runs the Cursor IDE's agent mode from the command line. Markus invokes it via `invoke_coding_tool({ tool: "cursor-agent", ... })`. Use it when the project has Cursor-specific configuration (`.cursor/rules`) or when IDE-integrated, project-aware editing is the best fit.

## Installation

Install Cursor from [https://cursor.sh](https://cursor.sh), then enable the shell command:

1. Open Cursor → Command Palette → "Install 'cursor' command in PATH"
2. Verify: `cursor --version`

Check availability with `markus doctor`.

## How Markus Invokes Cursor Agent

Markus runs Cursor in CLI agent mode:

```bash
cursor agent --prompt "<prompt>"
```

The command executes in the specified `workdir`. Additional args can be configured via `CodingToolConfig.defaultArgs`.

Unlike Claude Code's stream-json output, Cursor Agent emits plain-text progress lines that Markus surfaces as progress events.

## .cursor/rules Context Files

Cursor projects use **`.cursor/rules/`** for persistent agent instructions. Rule files (`.mdc` or `.md`) define:

- Coding standards and naming conventions
- Architecture decisions and patterns to follow
- Test requirements and deployment procedures
- Files or areas agents should not modify

Cursor Agent reads these rules automatically when operating in a project directory. Well-maintained rules significantly improve output quality.

### Markus Task Context Injection

When you pass `task_id` to `invoke_coding_tool`, Markus writes task-specific context to:

```
.cursor/rules/markus-task.mdc
```

This file contains the full Markus task context (title, description, subtasks, dependencies, progress-reporting CLI commands). It sits alongside your project's permanent rules and takes effect for the coding session.

**Important:**

- Markus creates the `.cursor/rules/` directory if it doesn't exist
- The `markus-task.mdc` file is regenerated each invocation — do not store permanent rules there
- Keep long-lived project rules in separate files (e.g., `coding-standards.mdc`, `architecture.mdc`)

### Example Project Rules Structure

```
.cursor/rules/
├── coding-standards.mdc    # permanent — naming, formatting, test requirements
├── architecture.mdc        # permanent — module boundaries, patterns
└── markus-task.mdc         # ephemeral — injected by Markus per task
```

## Working Directory Considerations

The `workdir` parameter is critical for Cursor Agent:

### Use the Repository Root

Always pass the **absolute path to the git repository root** as `workdir`:

```
workdir: "/Users/agent/projects/my-app"
```

Cursor Agent resolves `.cursor/rules/` relative to this directory. Pointing at a subdirectory may cause rules to be missed.

### Multi-Repo Projects

If the task spans multiple repositories, invoke Cursor Agent **once per repository** with repo-specific prompts:

```
invoke_coding_tool({
  tool: "cursor-agent",
  prompt: "Implement the API client changes described in the task context.",
  workdir: "/path/to/backend-repo",
  task_id: "task-789"
})
```

### Git State

Ensure the working directory is a clean git checkout (or at least understand existing uncommitted changes). Cursor Agent edits files in-place. Review with `git status` and `git diff` before applying.

### Environment Variables

Markus injects these env vars during context injection:

| Variable | Purpose |
|---|---|
| `MARKUS_API_URL` | API server for task operations |
| `MARKUS_TASK_ID` | Current task ID |
| `MARKUS_CLI` | Path to the markus CLI binary |

Cursor Agent subprocesses can use these if the injected context references CLI commands for progress reporting.

## Usage Patterns

### Rule-Driven Feature Implementation

```
invoke_coding_tool({
  tool: "cursor-agent",
  prompt: "Implement the user settings page following the patterns in .cursor/rules/frontend.mdc. Use existing component library imports. Add unit tests.",
  workdir: "/path/to/frontend-repo",
  task_id: "task-789"
})
```

### Convention-Heavy Refactor

```
invoke_coding_tool({
  tool: "cursor-agent",
  prompt: "Migrate all API routes in src/routes/ to the new error-handling pattern defined in .cursor/rules/api-conventions.mdc. Update tests accordingly.",
  workdir: "/path/to/repo",
  task_id: "task-789"
})
```

### Monorepo Package Work

```
invoke_coding_tool({
  tool: "cursor-agent",
  prompt: "Add the coding-tools skill templates under templates/skills/. Follow the existing skill.json + SKILL.md pattern from templates/skills/self-evolution/.",
  workdir: "/path/to/markus-monorepo",
  task_id: "task-789"
})
```

## Model and Mode Selection

Cursor Agent supports per-invocation model and mode overrides:

```
invoke_coding_tool({
  tool: "cursor-agent",
  prompt: "...",
  model: "claude-sonnet-4-6",  // optional: specify a model
  mode: "plan",                 // optional: plan | ask
})
```

### Critical cost fact: Auto Mode vs Max Mode

**Not specifying `--model` uses Auto mode** — this is unlimited on paid Cursor plans and very cheap (or free). The moment you specify a model name, Cursor enters **Max Mode**, which bills per-token from the monthly credit pool.

| Mode | Cost | When to use |
|---|---|---|
| Auto (no `--model`) | Free / unlimited on paid plans | Default for most tasks |
| Max Mode (explicit `--model`) | Per-token billing, varies by model | Only when task needs specific model capabilities |

**Warning:** Opus in Max Mode consumes credits approximately 20x faster than Auto mode. **Only specify `--model` when the task genuinely needs a specific model's capabilities.** For most tasks, Auto mode is the correct and cost-effective choice.

### Mode guidance

- `plan` — Analyze architecture first, don't make changes yet. Good as a first step for complex tasks.
- `ask` — Answer questions about the codebase without making changes.
- Default (no mode) — Full agent mode, makes edits. Use for implementation.

### Mode chaining pattern

For complex tasks:

1. `mode: "plan"` — "Analyze the codebase and propose an implementation plan for..."
2. Default agent mode — "Implement the plan: [paste plan from step 1]"
3. `mode: "ask"` — "Review the changes and identify any issues"

### Cost strategy

- **Default to no model override** (Auto mode) — it handles most tasks well and is free/cheap
- Only specify a model when Auto mode produces poor results or the task clearly needs specific capabilities
- **Voluntarily call `request_user_approval` before specifying expensive models** (Opus) since it enables Max Mode billing

## When to Choose Cursor Agent

| Choose Cursor Agent | Choose something else |
|---|---|
| Project has rich `.cursor/rules/` | No Cursor config, generic repo → `claude-code` |
| Team standardized on Cursor conventions | Need stream-json cost tracking → `claude-code` |
| IDE-style project-aware edits | Quick one-file fix → `codex` |
| Frontend/UI work with component rules | Deep backend exploration → `claude-code` |

## Error Handling

Cursor Agent may include some token data in result events. Evaluate results by:

1. `result.success` and `result.summary`
2. `result.modifiedFiles` — do they match expected scope?
3. `result.testResult` from quality verification
4. Manual `git diff` review in `workdir`

If Cursor Agent ignores project rules, verify:

- `workdir` points to the repo root (where `.cursor/rules/` lives)
- Rule files use correct `.mdc` format and are not empty
- The prompt explicitly references relevant rule files

If output quality is poor after 2 attempts, switch to `claude-code` with equivalent prompt and CLAUDE.md context.

## Best Practices

- Maintain `.cursor/rules/` with clear, actionable project conventions
- Always pass absolute repo root as `workdir`
- Pass `task_id` so `markus-task.mdc` carries task context
- Reference specific rule files in prompts when multiple rules exist
- Review diffs carefully — Cursor Agent may interpret rules differently than expected
- **Default to Auto mode (no model override) for cost-effectiveness**
- Only specify models when Auto mode is insufficient

## Rules

- **DO** use when the project has Cursor rules configured
- **DO** pass the repository root as `workdir`
- **DO** keep permanent rules separate from `markus-task.mdc`
- **DO** default to Auto mode (no `--model`) for cost savings
- **DO** request approval before using expensive models in Max Mode
- **DO NOT** store permanent instructions in `markus-task.mdc`
- **DO NOT** use for repos with no Cursor configuration unless other tools are unavailable
- **DO NOT** apply changes without reviewing diffs against project rules
- **DO NOT** specify `--model` by default — it triggers Max Mode billing
