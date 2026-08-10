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
├── team.json                    # Manifest (you write via file_write)
├── README.md                    # Public-facing team overview for Hub/Builder (REQUIRED)
├── ANNOUNCEMENT.md              # Team announcement (you write via file_write)
├── NORMS.md                     # Working norms (you write via file_write)
├── images/                      # Team-level images (icon, etc.)
│   └── icon.png                 # Team icon — used as avatar after install
├── workflows/                   # Workflow templates (optional)
│   └── {workflow-name}.yaml     # YAML workflow DAG definition
└── members/
    ├── {manager-slug}/
    │   ├── ROLE.md              # Identity and system prompt (REQUIRED)
    │   ├── HEARTBEAT.md         # Periodic self-check checklist (RECOMMENDED)
    │   ├── POLICIES.md          # Constraints and guardrails (optional)
    │   ├── CONTEXT.md           # Domain context and references (optional)
    │   └── images/              # Member avatar images (e.g. avatar.jpg)
    └── {worker-slug}/
        ├── ROLE.md              # Identity and system prompt (REQUIRED)
        ├── HEARTBEAT.md         # Periodic self-check checklist (RECOMMENDED)
        ├── POLICIES.md          # Constraints and guardrails (optional)
        ├── CONTEXT.md           # Domain context and references (optional)
        └── images/              # Member avatar images (e.g. avatar.jpg)
```

**Do NOT write artifacts to `~/.markus/shared/`, your agent `workspace/`, or any other location.** Only `~/.markus/builder-artifacts/teams/` is recognized by `package_list` / `package_install`. The `agents/`, `teams/`, and `skills/` subdirs are created automatically at startup — still write files yourself with `file_write`.

## Package Slug (`name`) — REQUIRED

The manifest `name` is the **package slug**: directory name, Hub URL segment (`/@user/{slug}`), and share/publish id.

**Rules (hard — invalid manifests are rejected on write / save / share):**
- English **kebab-case** only: lowercase letters `a-z`, digits `0-9`, hyphens `-`
- 2–64 characters; must **start with a letter**
- Pattern examples: `frontend-squad`, `research-team`, `think-tank-research`
- **NOT allowed**: Chinese (`智库研究团队`), spaces, underscores, UPPERCASE, emoji, or empty
- Put the human-readable title (any language) in **`displayName`**, never in `name`

| User language | `name` (slug) | `displayName` |
|---|---|---|
| Chinese “智库研究团队” | `think-tank-research` | `智库研究团队` |
| English “Frontend Squad” | `frontend-squad` | `Frontend Squad` |

If the user only gives a Chinese title, **you invent an English kebab slug** that captures the meaning, set `displayName` to their title, and use the slug for `~/.markus/builder-artifacts/teams/{name}/`. Member folder slugs under `members/` must also be English kebab-case.

### Where files are deployed on install

| Package location | Deployed to | Purpose |
|---|---|---|
| `ANNOUNCEMENT.md` | `~/.markus/teams/{teamId}/ANNOUNCEMENT.md` | Injected into every member's context |
| `NORMS.md` | `~/.markus/teams/{teamId}/NORMS.md` | Injected into every member's context |
| `members/{name}/ROLE.md` | `~/.markus/agents/{agentId}/role/ROLE.md` | Agent's identity and system prompt |
| `members/{name}/HEARTBEAT.md` | `~/.markus/agents/{agentId}/role/HEARTBEAT.md` | Periodic self-check checklist (every ~30 min) |
| `members/{name}/POLICIES.md` | `~/.markus/agents/{agentId}/role/POLICIES.md` | Additional agent constraints |
| `members/{name}/CONTEXT.md` | `~/.markus/agents/{agentId}/role/CONTEXT.md` | Domain context and references |
| `members/{name}/images/` | `~/.markus/agents/{agentId}/role/images/` | Member avatar images (copied on install; first image used as agent avatar) |
| `workflows/*.yaml` | `~/.markus/teams/{teamId}/workflows/*.yaml` | Workflow templates (runnable as task DAGs) |

## Creation Workflow

Write the team in up to three steps — manifest first, then content files, then optional workflow YAML. **Never put file content inline in the JSON.**

### All modes (chat / task / A2A) — same rule

There is **no** chat auto-save. A JSON code block in your reply does **not** create files.

1. `file_write("~/.markus/builder-artifacts/teams/{name}/team.json", ...)` for the manifest
2. `file_write` for each content file (README, ANNOUNCEMENT, NORMS, member ROLE.md, …)
3. In task mode, set deliverable references to the artifact directory path

You may show the user a preview JSON in chat **in addition to** writing files — never instead of `file_write`.

### Step 1: Write Manifest JSON via file_write

This JSON contains ONLY metadata and structure — **no file content**.

```json
{
  "type": "team",
  "name": "team-name-kebab-case",
  "displayName": "Team Display Name",
  "version": "1.0.0",
  "description": "Team purpose and goals",
  "author": "",
  "icon": "images/icon.png",
  "category": "development | devops | management | productivity | general",
  "tags": ["tag1", "tag2"],
  "team": {
    "members": [
      {
        "name": "Manager Name",
        "role": "manager",
        "count": 1,
        "skills": ["skill-id-1"]
      },
      {
        "name": "Worker Name",
        "role": "worker",
        "count": 1,
        "skills": ["skill-id-1", "skill-id-2"]
      }
    ],
    "workflow": {
      "phases": ["plan", "implement", "review", "validate"],
      "parallelImplementation": true,
      "worktreeIsolation": true,
      "requireReviewBeforeComplete": true
    },
    "workflows": ["workflows/my-workflow.yaml"]
  }
}
```

> ⚠️ **CRITICAL — manifest field rules:**
> - `members` MUST be nested under `team`, NOT at the root level.
> - `role` MUST be exactly `"manager"` or `"worker"` — no descriptions, no other values. The UI uses this to color-code tabs and determine sidebar counts.
> - `count` is REQUIRED for every member (typically `1`).
> - `category` MUST be one of: `development`, `devops`, `management`, `productivity`, `general`.
> - The root level should NOT contain `members` or `skills` directly — put `skills` under `dependencies.skills`.

After `team.json` is written, proceed to write the remaining files with `file_write`.

### Step 2: Write Files with file_write

After the JSON is saved, write each file individually using `file_write`. The base path is `~/.markus/builder-artifacts/teams/{team-name}/` (use the `name` from your JSON).

**Write files in this order:**

1. **README.md** (REQUIRED) — The public-facing overview displayed on Markus Hub and the Builder detail page. This is what users see first when browsing the team. Write 2-4 paragraphs covering:
   - What this team does and what problem it solves
   - Team composition overview (who the key members are)
   - Key capabilities and workflow highlights
   - Example use cases or when to deploy this team

2. **ANNOUNCEMENT.md** — Team mission, member introduction, how the team works, key capabilities. At least 3 paragraphs.

3. **NORMS.md** — Phase-based workflow documentation aligned with `team.workflow.phases`. This is critical for team effectiveness. Structure it as:
   - A section for each workflow phase (e.g., "### 1. Plan", "### 2. Implement", "### 3. Review & Merge")
   - Each phase explains what happens, who is responsible, and which platform capabilities to use
   - Include file/module ownership rules if the team does parallel development
   - Include communication protocols (when to use `agent_send_message`, `agent_broadcast_status`)
   - Reference platform capabilities: `spawn_subagent`, `background_exec`, `shell_execute` (git/gh), worktree isolation, `deliverable_create`, etc.

4. **Each member's ROLE.md** — Write one at a time. **Before writing, read the existing base role template** via `file_read` to understand the expected depth and conventions. Each ROLE.md should be at least 5 paragraphs, covering:
   - Who this agent is (identity, personality)
   - Core expertise and responsibilities
   - **Workflow with platform capabilities** — when to use `spawn_subagent`, `background_exec`, `shell_execute`, etc.
   - Output standards and quality criteria
   - Collaboration expectations within the team
   - For developers: worktree isolation, TDD, submit-for-review flow
   - For reviewers: review-then-merge workflow (git merge or gh pr)
   - For managers: file ownership planning, dependency graphs, `spawn_subagent` for analysis

5. **Each member's HEARTBEAT.md** (RECOMMENDED) — Defines what the agent proactively checks every ~30 minutes. Without this file, the agent is purely reactive and will only respond to direct messages. Write a role-specific checklist covering:
   - Check mailbox for new messages and respond to urgent items
   - Review assigned tasks — update progress, unblock if possible
   - Check team announcements and norms for updates
   - Role-specific patrol items (e.g., managers: check team task board and unblock members; developers: check build status and PR reviews; reviewers: check tasks awaiting review)
   - Scan recent channel messages for anything requiring attention

6. **POLICIES.md** (optional) — For members that need specific constraints.

7. **CONTEXT.md** (optional) — Additional domain context, references, or knowledge specific to a member.

## Image Assets

Teams use **two kinds of images**, stored in separate locations:

| Image | Location | Style | Purpose |
|:------|:---------|:------|:--------|
| **Team icon** | `images/icon.png` | Abstract logo / icon | Team card in UI, published to Hub as `icon` |
| **Member avatar** | `members/{slug}/images/avatar.jpg` | Realistic digital portrait | Agent card in UI (same as agent-building) |

### Team Icon

A team icon should represent the team's **identity as a whole** — like a department logo or squad badge. Use abstract, geometric, or emblematic styles. **Do NOT use portraits for the team icon** (portraits belong on individual member agents).

Prompt style guide for `generate_image`:
```
Good prompt (do this):
  "Clean vector-style icon for a research team, geometric shapes forming a magnifying glass
   over interconnected nodes, modern flat design, blue and indigo palette, square format"
  "Minimalist tech squad badge, circuit board pattern forming a shield, clean lines,
   dark blue and cyan accents, flat vector illustration, square format"

Bad prompt (don't do this):
  "A group of people sitting around a conference table" ✗ — this is a scene, not an icon
  "Smiling project manager portrait" ✗ — portraits are for members, not the team
  "Abstract colorful blob" ✗ — too vague, no recognizable meaning
```

Key rules:
- **Style**: vector / flat design / geometric / emblematic — NOT photographic
- **Subject**: abstract concept (shield, gear, nodes, stars, etc.) — NOT people
- **Format**: square, clean background, recognizable at small sizes (64×64)
- **Match team purpose**: research → magnifying glass / beaker, dev → code brackets / gear, ops → shield / cog

### Member Avatars

Member avatars follow the **same rules as agent-building** — they are **digital employee portraits**. Each member gets a realistic headshot that matches their role.

Prompt style guide:
```
Good prompt (do this):
  "Professional headshot of a friendly male research director in business casual attire,
   warm blue tones, clean background, realistic digital portrait"
  "Creative female content strategist with glasses, warm orange tones, looking thoughtful,
   realistic digital portrait, professional yet approachable"

Bad prompt (don't do this):
  "Abstract icon of a roadmap with sticky notes" ✗ — not a person
  "A laptop with writing bubbles floating above it" ✗ — not a person
```

Key rules (same as agent-building):
- **Subject is always a person** — realistic digital portrait
- **Match the role's personality** — manager = organized/strategic, creator = creative/warm
- **Color palette** aligns with the role (blue = analytical, orange = creative, green = growth)
- **Background**: clean, professional, non-distracting
- **Style**: `"realistic digital portrait", "professional headshot", "digital art style"`

### Image Size & Compression

Same specs as agent-building:

| Property | Value |
|:---------|:------|
| **Final resolution** | 512×512 (square) |
| **File format** | JPEG (members) / PNG (team icon — for transparency) |
| **Max file size** | ≤50KB |
| **Compression method** | Python Pillow (`pip3 install Pillow`) resize + save |

Compression procedure:
```python
# Using Python Pillow
python3 -c "
from PIL import Image
img = Image.open('source.jpg')
img = img.resize((512, 512), Image.LANCZOS)
img.save('avatar.jpg', 'JPEG', quality=85)
"
```

For team icons (PNG):
```python
python3 -c "
from PIL import Image
img = Image.open('source.png')
img = img.resize((512, 512), Image.LANCZOS)
img.save('icon.png', 'PNG', optimize=True)
"
```

**Always** place images under an `images/` subdirectory — NOT at the artifact root.

**Example file_write calls:**

```
file_write("~/.markus/builder-artifacts/teams/research-team/README.md", "# Research Team\n\nA collaborative AI research team that...\n\n## Team Composition\n- Research Director (manager)...\n- Senior Researcher (worker)...\n\n## Use Cases\n- Academic literature review and synthesis...")
file_write("~/.markus/builder-artifacts/teams/research-team/ANNOUNCEMENT.md", "# Research Team — Team Announcement\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/NORMS.md", "# Research Team — Working Norms\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/research-director/ROLE.md", "# Research Director\n\nYou are **Research Director** — ...\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/research-director/HEARTBEAT.md", "# Heartbeat Checklist\n\n- [ ] Check mailbox ...\n- [ ] Review team task board ...\n- [ ] Unblock members ...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/senior-researcher/ROLE.md", "# Senior Researcher\n\nYou are **Senior Researcher** — ...\n\n...")
file_write("~/.markus/builder-artifacts/teams/research-team/members/senior-researcher/HEARTBEAT.md", "# Heartbeat Checklist\n\n- [ ] Check mailbox ...\n- [ ] Review assigned tasks ...\n- [ ] Check build status ...")
```

**IMPORTANT**: The member directory slug is derived from the member's `name` field — lowercased, spaces to hyphens, non-alphanumeric removed.

### Step 3: Write Workflow YAML (optional)

If the team has repeatable multi-step processes that should run as automated DAGs, add workflow templates. Each workflow is a YAML file that defines a sequence of tasks with dependencies, role assignments, and optional scheduling.

**When to include workflows:**
- The team has a process that runs repeatedly (e.g., weekly content publishing, daily reports)
- Multiple members need to collaborate in a defined sequence
- You want steps to run in parallel where possible and wait on dependencies automatically

**Write each workflow YAML to `workflows/`:**

```
file_write("~/.markus/builder-artifacts/teams/{team-name}/workflows/content-publishing.yaml", "<YAML content>")
```

Make sure `team.workflows` in your manifest references the file:
```json
"workflows": ["workflows/content-publishing.yaml"]
```

**Minimal workflow example:**

```yaml
name: content-publishing
displayName: Content Publishing
description: Plan, write, and review content
version: "1.0.0"

params:
  - name: topic
    type: string
    required: true

steps:
  - id: plan
    name: Plan Content
    type: agent_task
    role: editor
    prompt: "Create a content plan for: {{topic}}"

  - id: write
    name: Write Draft
    type: agent_task
    role: writer
    depends_on: [plan]
    inputs: [{ from: plan, as: content_plan }]
    prompt: "Write content about {{topic}} following the plan."

  - id: review
    name: Review & Publish
    type: agent_task
    role: editor
    depends_on: [write]
    inputs: [{ from: write, as: draft }]
    prompt: "Review the draft and finalize for publishing."
```

For the full YAML format reference, DAG patterns, scheduling, and more examples, activate the **`workflow-building`** skill.

## Field Reference

### Top-level fields
- **`type`**: Always `"team"`
- **`name`**: **Package slug** — English kebab-case only (see [Package Slug](#package-slug-name--required)). Write/save/share reject Chinese or invalid slugs.
- **`displayName`**: Human-readable name, any language (e.g., `"前端开发小队"`)
- **`version`**: Semver (default `"1.0.0"`)
- **`description`**: Team purpose (any language)
- **`category`**: One of `development`, `devops`, `management`, `productivity`, `general`
- **`tags`**: Descriptive tags

### `team.members[]` — Member Specifications (REQUIRED)
- **`name`**: Display name — Chinese / any language is fine (e.g., "Agent 创建者")
- **`slug`** *(recommended)*: Explicit kebab-case slug matching the `members/{slug}/` directory name (e.g., `"agent-creator"`). **CRITICAL when `name` contains non-ASCII characters** — the auto-derived slug from `kebab(name)` strips Chinese/Unicode, causing directory mismatch and broken avatars.
- **`roleName`** *(recommended)*: English version of the display name (e.g., `"Agent Creator"`). Used as a fallback for directory matching when `slug` is not set. `kebab("Agent Creator")` → `"agent-creator"` matches the directory correctly.
- **`role`**: `"manager"` or `"worker"`
- **`count`**: Number of instances (default 1)
- **`skills`**: Skill IDs from the dynamic context. **Actively assign skills — don't leave empty!**

> ⚠️ **CRITICAL — Avatar Mapping**: The UI maps each manifest member to its on-disk `members/{slug}/` directory using slug matching. If the member name is in Chinese (e.g., "Agent 创建者"), `kebab()` strips all Unicode → produces `"agent"` which does NOT match `"agent-creator"`. **Always set `slug` (preferred) or `roleName` (fallback)** for members whose display names contain non-ASCII characters. Without this, member avatars, file tabs, and role colors will be mapped to the wrong members or not shown at all.

### `team.workflow` — Workflow Configuration (recommended)
- **`phases`**: Array of phase names defining the team's workflow (e.g., `["plan", "implement", "review", "validate"]`)
- **`parallelImplementation`**: `true` if multiple members work in parallel during implementation
- **`worktreeIsolation`**: `true` if developers should work in isolated git worktrees (recommended for coding teams)
- **`requireReviewBeforeComplete`**: `true` if tasks must pass review before completion

### `team.workflows` — Workflow Template Files (optional)
- Array of YAML file paths relative to the package root, e.g. `["workflows/content-publishing.yaml"]`
- These files are copied to `~/.markus/teams/{teamId}/workflows/` on install and become runnable via the Workflows UI or `workflow_run` tool
- See the `workflow-building` skill for the full YAML format

## After Creation

> **CRITICAL**: Creating an artifact is NOT the same as installing/deploying it. Creating writes files to `builder-artifacts/`; installing deploys live agents that consume resources and join the org. **NEVER auto-install.** Only install when the user explicitly says "install", "deploy", or "hire". This applies to ALL modes (chat, task, A2A).

Once all files are written, tell the user:

1. **The team has been created and saved** — summarize the team composition (name, members, their roles).
2. **Ready to install** — the user can install from the Builder page, or ask you to install it (you would use `package_install`). Do NOT install unless asked.
3. **To modify or improve** this team (e.g., add new members, update roles, change team norms), just continue the conversation here — describe what you want to change and I'll update the files directly.

## Rules

- **DO NOT** invent skill IDs. Only use values from the dynamic context.
- **DO NOT** leave skills empty when relevant skills are available. Review the skills list!
- **DO NOT** put file content in the JSON. Always use `file_write` for files.
- **DO NOT** write artifacts to `~/.markus/shared/` or your working directory. Always use `~/.markus/builder-artifacts/teams/{name}/`.
- **The `name` field MUST be a valid English kebab-case slug** (see Package Slug). Never use Chinese as `name`. Invalid `name` → write/save/share fails.
- **All top-level fields must be the correct type**: `author` must be a plain string (e.g. `"John"`) — NOT an object. `tags` must be an array of strings. `version` must be semver string. `description` must be a string. The system validates the manifest on write and will reject malformed files.
- Every team MUST have exactly **one** member with `"role": "manager"` and at least **one** `"worker"`.
- Write each ROLE.md with **full attention** — at least 5 substantive paragraphs per member.
- Do NOT rush through members. Each one deserves careful, tailored content.
- After outputting the JSON, write files one by one — announce what you're writing each time.
