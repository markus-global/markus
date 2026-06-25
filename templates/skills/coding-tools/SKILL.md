---
name: coding-tools
description: Use external coding tools (Claude Code, Codex, Cursor) via invoke_coding_tool and coding_tool_apply to implement, debug, and refactor code
---

# Coding Tools

Markus can delegate hands-on coding work to external CLI tools. You have two built-in tools for this workflow:

| Tool | Purpose |
|---|---|
| `invoke_coding_tool` | Run Claude Code, Codex, or Cursor Agent against a repository with a prompt |
| `coding_tool_apply` | Commit the changes produced by a coding tool session |

Use these when the task requires substantial code changes across multiple files, when you want a specialized coding agent to explore a codebase, or when direct editing would be slower or less reliable than delegating to a dedicated tool.

## Available Coding Tools

| Tool name | CLI binary | Best for |
|---|---|---|
| `claude-code` | `claude` | Complex refactors, multi-file changes, deep exploration, architecture-level edits |
| `codex` | `codex` | Quick fixes, targeted patches, scripted automation, fast iteration |
| `cursor-agent` | `cursor` | IDE-heavy work, projects with `.cursor/rules`, repo-specific conventions |

Check availability with `markus doctor` before relying on a tool. If a tool is not installed, the handler returns an `installHint`.

## When to Use External Tools vs Write Code Directly

**Use external coding tools when:**

- The change spans many files or requires broad codebase exploration
- You need an autonomous agent to iterate (edit → test → fix) inside the repo
- The task is well-scoped with clear acceptance criteria but large implementation surface
- You are coordinating work and want a specialist tool to execute while you review results

**Write code directly (file_edit, shell_execute) when:**

- The change is small — a few lines in one or two files
- You already know exactly what to change and where
- You need fine-grained control over every edit
- The task is configuration, documentation, or non-code work

**Rule of thumb:** If you would open an IDE and spend 15+ minutes navigating and editing, prefer `invoke_coding_tool`. If you can describe the exact diff in one paragraph, edit directly.

## How to Invoke a Coding Tool

```
invoke_coding_tool({
  tool: "claude-code",       // or "codex" | "cursor-agent"
  prompt: "<clear instruction>",
  workdir: "/absolute/path/to/repo",
  task_id: "<optional-task-id>"   // injects task context when provided
})
```

### Prompt Best Practices

Write prompts as if briefing a senior engineer who has never seen the ticket:

1. **Goal** — What outcome is required? Link to acceptance criteria.
2. **Scope** — Which directories, modules, or files are in/out of scope.
3. **Constraints** — Coding standards, test requirements, patterns to follow or avoid.
4. **Verification** — How to confirm success (tests to run, commands, expected behavior).
5. **Context** — Upstream dependencies, related PRs, or prior attempts.

Keep prompts focused. One coding tool invocation = one coherent unit of work. Split large tasks into sequential invocations rather than one mega-prompt.

### Task Context Injection

When you pass `task_id`, Markus fetches full task context (requirement, project, upstream/downstream dependencies) and injects it into the tool's working directory:

- **Claude Code** → `CLAUDE.md`
- **Cursor Agent** → `.cursor/rules/markus-task.mdc`
- **Codex** → `.agent_context/task_context.md`

The injected context also includes progress-reporting instructions for the Markus CLI. Always pass `task_id` when working on an assigned task.

### Reading Results

The tool returns JSON:

```json
{
  "status": "success",
  "sessionId": "...",
  "tool": "claude-code",
  "result": {
    "success": true,
    "summary": "...",
    "diffStats": { "filesChanged": 3, "additions": 42, "deletions": 7 },
    "modifiedFiles": ["src/foo.ts"],
    "testResult": { "passed": 10, "failed": 0, "success": true }
  },
  "cost": { "estimatedCostUsd": 0.12, "inputTokens": 5000, "outputTokens": 1200 }
}
```

**Always review before applying:**

1. Read `result.summary` and `modifiedFiles`
2. Check `result.testResult` if present
3. If needed, inspect the repo with `git diff` via `shell_execute` in `workdir`
4. If results are incomplete, iterate with a follow-up `invoke_coding_tool` call referencing what still needs fixing

## Applying Changes

After reviewing and approving the tool's work:

```
coding_tool_apply({
  session_id: "<sessionId from invoke_coding_tool>",
  workdir: "/absolute/path/to/repo",
  commit_message: "feat: implement user auth middleware"
})
```

This stages all changes and creates a git commit. If there are no changes, it returns success with `filesChanged: 0`.

**Do not apply blindly.** Verify tests pass and the diff matches expectations first.

## Choosing the Right Tool

| Scenario | Recommended tool | Why |
|---|---|---|
| Large refactor across packages | `claude-code` | Strong multi-turn reasoning, `--max-turns 50`, stream-json progress |
| One-file bug fix or typo | `codex` | Fast, `exec --full-auto`, minimal overhead |
| Repo with `.cursor/rules` | `cursor-agent` | Reads project rules natively |
| Need cost/token visibility | `claude-code` | Reports tokens and USD in stream-json result events |
| Long-running exploratory task | `claude-code` | Best at sustained codebase navigation |
| CI/automation-friendly run | `codex` | Designed for non-interactive full-auto mode |

When unsure, start with `claude-code` for complexity and `codex` for speed. Switch tools if the first attempt stalls or produces poor results.

## Reporting Progress via Markus CLI

Keep the task board updated while coding tools run. Use `shell_execute`:

```bash
markus task progress <task-id> -t "Claude Code implementing auth middleware" --percent 40
markus task note <task-id> -t "Coding tool modified 3 files, running tests"
markus task context <task-id>    # refresh full context if needed
```

Report progress at these milestones:

- Before invoking a coding tool (what you're delegating)
- After the tool completes (summary + file count)
- After applying changes (commit created)
- On failure (error details + retry plan)

Coding tools also receive these CLI instructions in their injected context file when `task_id` is provided.

## Error Handling and Retry Strategies

### Tool Not Installed

```json
{ "error": "Claude Code is not installed. npm install -g @anthropic-ai/claude-code", "installHint": "..." }
```

**Action:** Try a different installed tool, or report the blocker via `task note` and escalate.

### Execution Failed or Incomplete

1. Read `result.error` and `result.rawOutput` (truncated)
2. Check whether partial changes exist in `workdir` (`git status`, `git diff`)
3. Retry with a **narrower prompt** that references the failure:
   - "The previous attempt failed because X. Fix only Y in file Z."
4. After 2 failed attempts with the same tool, switch to a different tool or fall back to direct editing

### Timeout

Long tasks may hit configured `timeoutMs`. Split the work into smaller invocations with explicit checkpoints.

### Apply Failures

If `coding_tool_apply` fails (merge conflict, git error):

1. Inspect `git status` in `workdir`
2. Resolve conflicts manually with `file_edit`
3. Commit manually via `shell_execute` if needed
4. Document what happened in a task note

### Quality Verification

When `result.testResult` shows failures, **do not apply**. Re-invoke with:

```
The following tests failed: <output>. Fix the failures without changing unrelated code.
```

## Workflow Summary

```
1. Scope the work → write a clear prompt
2. invoke_coding_tool({ tool, prompt, workdir, task_id })
3. Review result (summary, diff, tests)
4. Iterate if needed (step 2 with refined prompt)
5. coding_tool_apply({ session_id, workdir, commit_message })
6. Report progress via markus task progress/note
7. Submit task for review
```

## Model, Mode, and Effort Overrides

The `invoke_coding_tool` handler accepts per-invocation overrides:

```
invoke_coding_tool({
  tool: "claude-code",
  prompt: "...",
  model: "opus",       // optional: override the user's default model
  mode: "plan",        // optional: tool-specific execution mode
  effort: "high",      // optional: reasoning effort level
  approved: true       // required when approvalRequired is enabled for this tool
})
```

### Model selection strategy

- If the user has set a `defaultModel` in settings, respect it unless you have a specific reason to override
- When overriding, explain why in your progress notes (e.g., "Using Opus for complex architecture task")
- For simple tasks, prefer cheaper models; for complex multi-file work, consider more capable models

### Mode chaining pattern

Many tasks benefit from a multi-step approach:

1. **Plan first** — `invoke_coding_tool({ tool: "claude-code", mode: "plan", prompt: "Analyze the codebase and create an implementation plan for..." })` or `invoke_coding_tool({ tool: "cursor-agent", mode: "plan", ... })`
2. **Execute** — Follow up with the default agent mode (no `mode` override) using the plan output as context
3. **Review/ask** — If results need refinement, use `mode: "ask"` (Cursor) for targeted questions

### Approval workflow

If a tool has `approvalRequired: true`, the handler returns an `approval_required` error. You must:

1. Call `request_user_approval` explaining what you want to do and why
2. After receiving approval, retry with `approved: true`

**Voluntarily request approval** (even without `approvalRequired`) when:

- You're about to use an expensive model (Opus, gpt-5.5) for a long-running task
- The task scope is unclear and might consume significant resources
- The user's cost profile suggests caution (check the tool-specific skill for guidance)

## Cost-Aware Practices

Cost awareness is your responsibility as the agent. The UI provides enforceable controls (default model, budget cap for Claude Code, approval toggle), but strategic cost optimization is up to you.

### General principles

- **Start cheap, escalate if needed** — Try the default or cheaper model first. Only reach for expensive models when the cheaper attempt fails or the task clearly requires deep reasoning
- **Scope tightly** — One focused invocation is cheaper than a broad one that explores unnecessarily
- **Monitor results** — After each invocation, check `cost.estimatedCostUsd` (if available) and note it in progress updates
- **Split rather than retry** — If a task partially completes, split the remainder into a new focused invocation rather than re-running the entire thing

### Cost visibility varies by tool

| Tool | Cost data available? |
|---|---|
| `claude-code` | Yes — tokens and USD in every result |
| `codex` | Limited — no structured cost data from CLI |
| `cursor-agent` | Limited — may include tokens in result events |

When cost data is unavailable, estimate by task duration and complexity. Report what you know.

## Related Skills

For tool-specific details, activate the matching skill:

- **claude-code** — CLI flags, stream-json, CLAUDE.md, cost tracking, model/effort guidance
- **codex** — full-auto mode, AGENTS.md, sandbox behavior, model/effort guidance
- **cursor-agent** — agent mode, `.cursor/rules`, working directory setup, Auto vs Max Mode

Use `discover_tools({ name: ["claude-code"] })` to load a tool-specific skill before invoking that tool.

## Rules

- **DO** pass `task_id` for assigned tasks
- **DO** review diffs and test results before applying
- **DO** split large work into focused invocations
- **DO** report progress to the task board
- **DO** respect the user's `defaultModel` setting unless you have a clear reason to override
- **DO** voluntarily request user approval before expensive operations
- **DO NOT** apply changes when tests fail unless explicitly acceptable
- **DO NOT** run coding tools outside the project's repository path
- **DO NOT** retry the same broad prompt more than twice — refine or switch tools
- **DO NOT** default to expensive models when cheaper ones can handle the task
- **NEVER** call coding tool CLIs (`cursor`, `claude`, `codex`) directly via `shell_execute`. Always use `invoke_coding_tool` — it handles binary resolution, argument building, context injection, streaming, cost tracking, and session management. Direct shell calls bypass all of this and will likely use wrong arguments.
