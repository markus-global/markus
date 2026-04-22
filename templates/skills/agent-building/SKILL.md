---
name: agent-building
description: Design and create AI agent packages — manifest format, directory structure, file writing workflow
---

# Agent Building

This skill teaches you how to create Markus agent packages — self-contained directory-based artifacts that define an AI agent's identity, capabilities, and constraints.

## Artifact Directory

**CRITICAL**: Agent artifacts MUST be saved under this exact path — the Builder page, install system, and deliverable detection all depend on it:

```
~/.markus/builder-artifacts/agents/{agent-name}/
├── agent.json       # Manifest (auto-created from your JSON output)
├── ROLE.md          # Primary identity (you write via file_write)
├── POLICIES.md      # Constraints & guardrails (you write via file_write, optional)
└── CONTEXT.md       # Domain context & references (you write via file_write, optional)
```

**Do NOT write artifacts to `~/.markus/shared/`, your working directory, or any other location.** Only `~/.markus/builder-artifacts/agents/` is recognized by the system.

When the user **installs** the artifact, files are deployed to `~/.markus/agents/{agentId}/role/`. The `ROLE.md` becomes the agent's system prompt — it IS the agent's identity, not an override of a template.

## Two-Step Workflow

Output the agent in two steps — manifest first, then content files. **Never put file content inline in the JSON.**

### Chat Mode vs Task Mode

- **Chat mode** (user conversation): Output the manifest JSON in a ```json code block → system auto-saves and creates the directory → then use `file_write` for each content file.
- **Task mode** (assigned task): Use `file_write` to write the manifest JSON file directly (e.g., `file_write("~/.markus/builder-artifacts/agents/{name}/agent.json", ...)`) → then use `file_write` for each content file. When submitting deliverables, set the reference to the artifact directory path.
- **A2A mode** (agent-to-agent): Same as task mode — write all files via `file_write`.

### Step 1: Output Manifest JSON

**In chat mode**: Output the agent configuration as a JSON code block. The system auto-saves it.
**In task/A2A mode**: Write the manifest JSON file directly via `file_write`.

This JSON contains ONLY metadata — **no file content**.

```json
{
  "type": "agent",
  "name": "agent-name-kebab-case",
  "displayName": "Agent Display Name",
  "version": "1.0.0",
  "description": "What this agent does",
  "author": "",
  "category": "development | devops | management | productivity | general",
  "tags": ["tag1", "tag2"],
  "dependencies": {
    "skills": ["skill-id-1", "skill-id-2"],
    "env": ["git", "node"]
  },
  "agent": {
    "agentRole": "manager | worker",
    "llmProvider": "anthropic | openai | google | (empty for default)",
    "llmModel": "model name or empty for default",
    "temperature": 0.7
  }
}
```

The system automatically saves this JSON and creates the directory. After that, you proceed to write files.

### Step 2: Write Files with file_write

After the JSON is saved, write each file individually using `file_write`. The base path is `~/.markus/builder-artifacts/agents/{agent-name}/` (use the `name` from your JSON).

**Write files in this order:**

1. **ROLE.md** (REQUIRED) — The agent's primary identity document. **Before writing, read the existing base role template** via `file_read` (path shown in dynamic context) to understand expected depth and conventions. At least 5 substantive paragraphs covering:
   - Who this agent is (identity, personality, expertise)
   - Core responsibilities and capabilities
   - **Workflow with platform capabilities** — when and how to use `spawn_subagent` (focused subtasks), `background_exec` (long-running commands with auto-notifications), `shell_execute` (git/gh operations), `web_search`/`web_fetch` (research), `deliverable_create` (artifacts), `memory_save` (persistent knowledge)
   - For code-writing agents: workspace setup (git worktree for isolation), TDD, submit-for-review flow, file ownership rules
   - For review agents: review-then-merge workflow using `shell_execute` with `git merge` or `gh pr create/merge`
   - Output standards and quality criteria
   - Domain-specific knowledge and context

2. **POLICIES.md** (recommended) — Safety constraints and guardrails:
   - What the agent should NOT do
   - Tool usage guidelines
   - Quality gates and review requirements

3. **CONTEXT.md** (optional) — Additional domain context, references, or knowledge.

**Example file_write calls:**

```
file_write("~/.markus/builder-artifacts/agents/code-reviewer/ROLE.md", "# Code Reviewer\n\nYou are **Code Reviewer** — an expert...\n\n## Responsibilities\n...\n\n## Workflow\n...\n\n## Output Standards\n...")
file_write("~/.markus/builder-artifacts/agents/code-reviewer/POLICIES.md", "# Policies\n\n- Only use shell_execute for read-only commands...\n- Always show file contents before overwriting...")
```

## Field Reference

### Top-level fields
- **`type`**: Always `"agent"`
- **`name`**: **MUST be English kebab-case** (e.g., `code-reviewer`, `paper-mentor`). Even if the user speaks Chinese, use an English slug. This is the directory name.
- **`displayName`**: Human-readable name, can be in any language (e.g., `"论文学习导师"`, `"Code Reviewer"`)
- **`version`**: Semver (default `"1.0.0"`)
- **`description`**: What this agent does (can be in any language)
- **`category`**: One of `development`, `devops`, `management`, `productivity`, `general`
- **`tags`**: Array of descriptive tags
- **`dependencies.skills`**: Skill IDs from the dynamic context. **Actively assign — don't leave empty!**
- **`dependencies.env`**: Required CLI tools (e.g., `["git", "node"]`). Omit if none needed.

### `agent` section (REQUIRED)
- **`agentRole`**: `"worker"` (executes tasks) or `"manager"` (coordinates, assigns, reviews)
- **`llmProvider`**, **`llmModel`**, **`temperature`**: LLM configuration. Leave empty for system defaults.

**Note**: The `roleName` field is **not needed**. The agent's identity is fully defined by its `ROLE.md` file. Do NOT include `roleName` unless you specifically want to inherit default tools from a built-in role template (rare).

## Tool Access Philosophy

**All agents have access to all built-in tools.** Security is controlled through the agent's `ROLE.md` and `POLICIES.md`, not through tool restrictions.

If an agent needs to be cautious with certain tools, write that into `POLICIES.md`:
- "Only use `shell_execute` for read-only commands unless explicitly asked"
- "Always show the user file contents before overwriting"
- "Never run `rm -rf` or other destructive commands"

## After Creation

> **CRITICAL**: Creating an artifact is NOT the same as installing/deploying it. Creating writes files to `builder-artifacts/`; installing deploys a live agent that consumes resources and joins the org. **NEVER auto-install.** Only install when the user explicitly says "install", "deploy", or "hire". This applies to ALL modes (chat, task, A2A).

Once all files are written, tell the user:

1. **The agent has been created and saved** — summarize what was created (name, purpose, key skills).
2. **Ready to install** — the user can install from the Builder page, or ask you to install it (you would use `builder_install`). Do NOT install unless asked.
3. **To modify or improve** this agent (e.g., update the role, change skills, adjust policies), just continue the conversation here — describe what you want to change and I'll update the files directly.

## Rules

- **DO NOT** invent skill IDs. Only use values from the dynamic context.
- **DO NOT** put file content in the JSON. Always use `file_write` for files.
- **DO NOT** default skills to `[]` when relevant skills are available. Check the skills list!
- **DO NOT** write artifacts to `~/.markus/shared/` or your working directory. Always use `~/.markus/builder-artifacts/agents/{name}/`.
- **The `name` field MUST be English kebab-case**.
- The `ROLE.md` is what makes the agent unique — write at least 5 substantive paragraphs. A generic one-liner is useless.
- Default `temperature` to 0.7 for general tasks, lower (0.3-0.5) for precision tasks, higher (0.8-1.0) for creative tasks.
- After outputting the JSON, immediately proceed to write files via `file_write` — announce what you're writing.
