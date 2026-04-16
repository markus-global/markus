---
name: team-building
description: Design and create AI team packages — manifest format, member structure, directory layout
---

# Team Building

This skill teaches you how to create Markus team packages — self-contained directory-based artifacts that define a group of specialized AI agents with shared norms and coordination structure.

## Core Philosophy

**Every agent in a team must be a specialist.** Do NOT simply pick generic templates and give them names. Design each agent with a unique identity, expertise, and detailed role documentation. Safety constraints are defined in each agent's `POLICIES.md`, not through tool restrictions.

## Artifact Directory

**CRITICAL**: Team artifacts MUST be saved under this exact path — the Builder page, install system, and deliverable detection all depend on it:

```
~/.markus/builder-artifacts/teams/{team-name}/
├── team.json                    # Manifest (auto-created from your JSON output)
├── ANNOUNCEMENT.md              # Team announcement (you write via file_write)
├── NORMS.md                     # Working norms (you write via file_write)
└── members/
    ├── {manager-slug}/
    │   ├── ROLE.md              # Manager identity (you write via file_write)
    │   └── POLICIES.md          # Manager constraints (you write via file_write, optional)
    └── {worker-slug}/
        ├── ROLE.md              # Worker identity (you write via file_write)
        └── POLICIES.md          # Worker constraints (you write via file_write, optional)
```

**Do NOT write artifacts to `~/.markus/shared/`, your working directory, or any other location.** Only `~/.markus/builder-artifacts/teams/` is recognized by the system.

### Where files are deployed on install

| Package location | Deployed to | Purpose |
|---|---|---|
| `ANNOUNCEMENT.md` | `~/.markus/teams/{teamId}/ANNOUNCEMENT.md` | Injected into every member's context |
| `NORMS.md` | `~/.markus/teams/{teamId}/NORMS.md` | Injected into every member's context |
| `members/{name}/ROLE.md` | `~/.markus/agents/{agentId}/role/ROLE.md` | Overrides base role template prompt |
| `members/{name}/POLICIES.md` | `~/.markus/agents/{agentId}/role/POLICIES.md` | Additional agent constraints |

## Two-Step Workflow

Output the team in two steps — manifest first, then content files. **Never put file content inline in the JSON.**

### Chat Mode vs Task Mode

- **Chat mode** (user conversation): Output the manifest JSON in a ```json code block → system auto-saves and creates the directory → then use `file_write` for each content file.
- **Task mode** (assigned task): Use `file_write` to write the manifest JSON file directly (e.g., `file_write("~/.markus/builder-artifacts/teams/{name}/team.json", ...)`) → then use `file_write` for each content file. When submitting deliverables, set the reference to the artifact directory path.
- **A2A mode** (agent-to-agent): Same as task mode — write all files via `file_write`.

### Step 1: Output Manifest JSON

**In chat mode**: Output the team structure as a JSON code block. The system auto-saves it.
**In task/A2A mode**: Write the manifest JSON file directly via `file_write`.

This JSON contains ONLY metadata and structure — **no file content**.

```json
{
  "type": "team",
  "name": "team-name-kebab-case",
  "displayName": "Team Display Name",
  "version": "1.0.0",
  "description": "Team purpose and goals",
  "author": "",
  "category": "development | devops | management | productivity | general",
  "tags": ["tag1", "tag2"],
  "team": {
    "members": [
      {
        "name": "Manager Name",
        "role": "manager",
        "roleName": "project-manager",
        "count": 1,
        "skills": ["skill-id-1"]
      },
      {
        "name": "Worker Name",
        "role": "worker",
        "roleName": "developer",
        "count": 1,
        "skills": ["skill-id-1", "skill-id-2"]
      }
    ],
    "workflow": {
      "phases": ["plan", "implement", "review", "validate"],
      "parallelImplementation": true,
      "worktreeIsolation": true,
      "requireReviewBeforeComplete": true
    }
  }
}
```

The system automatically saves this JSON and creates the directory. After that, you proceed to write files.

### Step 2: Write Files with file_write

After the JSON is saved, write each file individually using `file_write`. The base path is `~/.markus/builder-artifacts/teams/{team-name}/` (use the `name` from your JSON).

**Write files in this order:**

1. **ANNOUNCEMENT.md** — Team mission, member introduction, how the team works, key capabilities. At least 3 paragraphs.

2. **NORMS.md** — Phase-based workflow documentation aligned with `team.workflow.phases`. This is critical for team effectiveness. Structure it as:
   - A section for each workflow phase (e.g., "### 1. Plan", "### 2. Implement", "### 3. Review & Merge")
   - Each phase explains what happens, who is responsible, and which platform capabilities to use
   - Include file/module ownership rules if the team does parallel development
   - Include communication protocols (when to use `agent_send_message`, `agent_broadcast_status`)
   - Reference platform capabilities: `spawn_subagent`, `background_exec`, `shell_execute` (git/gh), worktree isolation, `deliverable_create`, etc.

3. **Each member's ROLE.md** — Write one at a time. **Before writing, read the existing base role template** via `file_read` to understand the expected depth and conventions. Each ROLE.md should be at least 5 paragraphs, covering:
   - Who this agent is (identity, personality)
   - Core expertise and responsibilities
   - **Workflow with platform capabilities** — when to use `spawn_subagent`, `background_exec`, `shell_execute`, etc.
   - Output standards and quality criteria
   - Collaboration expectations within the team
   - For developers: worktree isolation, TDD, submit-for-review flow
   - For reviewers: review-then-merge workflow (git merge or gh pr)
   - For managers: file ownership planning, dependency graphs, `spawn_subagent` for analysis

4. **POLICIES.md** (optional) — For members that need specific constraints.

**Example file_write calls:**

```
file_write("~/.markus/builder-artifacts/teams/research-team/ANNOUNCEMENT.md", "# Research Team — Team Announcement\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/NORMS.md", "# Research Team — Working Norms\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/research-director/ROLE.md", "# Research Director\n\nYou are **Research Director** — ...\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/senior-researcher/ROLE.md", "# Senior Researcher\n\nYou are **Senior Researcher** — ...\n\n...")
```

**IMPORTANT**: The member directory slug is derived from the member's `name` field — lowercased, spaces to hyphens, non-alphanumeric removed.

## Field Reference

### Top-level fields
- **`type`**: Always `"team"`
- **`name`**: **MUST be English kebab-case** (e.g., `frontend-squad`, `research-team`). Even for Chinese teams, use English slug.
- **`displayName`**: Human-readable name, any language (e.g., `"前端开发小队"`)
- **`version`**: Semver (default `"1.0.0"`)
- **`description`**: Team purpose (any language)
- **`category`**: One of `development`, `devops`, `management`, `productivity`, `general`
- **`tags`**: Descriptive tags

### `team.members[]` — Member Specifications (REQUIRED)
- **`name`**: Display name (the slug for file paths is derived from this)
- **`role`**: `"manager"` or `"worker"`
- **`roleName`**: Base role template from the dynamic context
- **`count`**: Number of instances (default 1)
- **`skills`**: Skill IDs from the dynamic context. **Actively assign skills — don't leave empty!**

### `team.workflow` — Workflow Configuration (recommended)
- **`phases`**: Array of phase names defining the team's workflow (e.g., `["plan", "implement", "review", "validate"]`)
- **`parallelImplementation`**: `true` if multiple members work in parallel during implementation
- **`worktreeIsolation`**: `true` if developers should work in isolated git worktrees (recommended for coding teams)
- **`requireReviewBeforeComplete`**: `true` if tasks must pass review before completion

## After Creation

> **CRITICAL**: Creating an artifact is NOT the same as installing/deploying it. Creating writes files to `builder-artifacts/`; installing deploys live agents that consume resources and join the org. **NEVER auto-install.** Only install when the user explicitly says "install", "deploy", or "hire". This applies to ALL modes (chat, task, A2A).

Once all files are written, tell the user:

1. **The team has been created and saved** — summarize the team composition (name, members, their roles).
2. **Ready to install** — the user can install from the Builder page, or ask you to install it (you would use `builder_install`). Do NOT install unless asked.
3. **To modify or improve** this team (e.g., add new members, update roles, change team norms), just continue the conversation here — describe what you want to change and I'll update the files directly.

## Rules

- **DO NOT** invent role names or skill IDs. Only use values from the dynamic context.
- **DO NOT** leave skills empty when relevant skills are available. Review the skills list!
- **DO NOT** put file content in the JSON. Always use `file_write` for files.
- **DO NOT** write artifacts to `~/.markus/shared/` or your working directory. Always use `~/.markus/builder-artifacts/teams/{name}/`.
- **The `name` field MUST be English kebab-case**.
- Every team MUST have exactly **one** member with `"role": "manager"` and at least **one** `"worker"`.
- Write each ROLE.md with **full attention** — at least 5 substantive paragraphs per member.
- Do NOT rush through members. Each one deserves careful, tailored content.
- After outputting the JSON, write files one by one — announce what you're writing each time.
