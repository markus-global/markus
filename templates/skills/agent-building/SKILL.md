---
name: agent-building
description: Design and create AI agent packages — manifest format, directory structure, image asset generation (avatar/thumbnail/screenshots), file writing workflow, comprehensive field reference
---

# Agent Building

This skill teaches you how to create Markus agent packages — self-contained directory-based artifacts that define an AI agent's identity, capabilities, constraints, and visual assets.

## Artifact Directory

**CRITICAL**: Agent artifacts MUST be saved under this exact path — the Builder page, install system, and deliverable detection all depend on it:

```
~/.markus/builder-artifacts/agents/{agent-name}/
├── agent.json       # Manifest (auto-created from your JSON output)
├── README.md        # Public-facing overview for Hub/Builder (REQUIRED)
├── ROLE.md          # Identity and system prompt (REQUIRED)
├── HEARTBEAT.md     # Periodic self-check checklist (RECOMMENDED)
├── POLICIES.md      # Constraints & guardrails (optional)
├── CONTEXT.md       # Domain context & references (optional)
└── images/          # Image assets (avatar, screenshots)
    └── avatar.jpg   # Agent avatar/thumbnail image
```

**Do NOT write artifacts to `~/.markus/shared/`, your working directory, or any other location.** Only `~/.markus/builder-artifacts/agents/` is recognized by the system.

When the user **installs** the artifact, files are deployed to `~/.markus/agents/{agentId}/role/`. The `ROLE.md` becomes the agent's system prompt — it IS the agent's identity, not an override of a template.

## Package Slug (`name`) — REQUIRED

The manifest `name` is the **package slug**: directory name, Hub URL segment (`/@user/{slug}`), and share/publish id.

**Rules (hard — invalid manifests are rejected on write / save / share):**
- English **kebab-case** only: lowercase letters `a-z`, digits `0-9`, hyphens `-`
- 2–64 characters; must **start with a letter**
- Pattern examples: `code-reviewer`, `paper-mentor`, `seo-auditor`
- **NOT allowed**: Chinese (`智库研究团队`), spaces, underscores, UPPERCASE, emoji, or empty
- Put the human-readable title (any language) in **`displayName`**, never in `name`

| User language | `name` (slug) | `displayName` |
|---|---|---|
| Chinese "论文导师" | `paper-mentor` | `论文导师` |
| English "Code Reviewer" | `code-reviewer` | `Code Reviewer` |

If the user only gives a Chinese title, **you invent an English kebab slug** that captures the meaning, set `displayName` to their title, and use the slug for the directory path `~/.markus/builder-artifacts/agents/{name}/`.

## Two-Step Workflow

Output the agent in two steps — manifest first, then content files. **Never put file content inline in the JSON.**

### All modes (chat / task / A2A) — same rule

There is **no** chat auto-save. A JSON code block in your reply does **not** create files.

1. `file_write("~/.markus/builder-artifacts/agents/{name}/agent.json", ...)` for the manifest
2. `file_write` for each content file (ROLE.md, HEARTBEAT.md, …)
3. In task mode, set deliverable references to the artifact directory path

You may preview JSON in chat **in addition to** writing files — never instead of `file_write`.

### Step 1: Write Manifest JSON via file_write

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
  "icon": "images/avatar.jpg",
  "thumbnail": "images/avatar.jpg",
  "screenshots": ["images/avatar.jpg"],
  "license": "MIT",
  "originalSource": "https://github.com/...",
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

After `agent.json` is written, proceed to write the remaining files with `file_write`.

### Step 2: Write Files with file_write

After the JSON is saved, write each file individually using `file_write`. The base path is `~/.markus/builder-artifacts/agents/{agent-name}/` (use the `name` from your JSON).

**Write files in this order:**

1. **README.md** (REQUIRED) — The public-facing overview displayed on Markus Hub and the Builder detail page. This is what users see first when browsing artifacts. Write 2-4 paragraphs covering:
   - What this agent does and what problem it solves
   - Key capabilities and features
   - Example use cases or when to use this agent
   - Any requirements or setup notes

2. **ROLE.md** (REQUIRED) — The agent's primary identity document. **Before writing, read the existing base role template** via `file_read` (path shown in dynamic context) to understand expected depth and conventions. At least 5 substantive paragraphs covering:
   - Who this agent is (identity, personality, expertise)
   - Core responsibilities and capabilities
   - **Workflow with platform capabilities** — when and how to use `spawn_subagent` (focused subtasks), `background_exec` (long-running commands with auto-notifications), `shell_execute` (git/gh operations), `web_search`/`web_fetch` (research), `deliverable_create` (artifacts), `memory_save` (persistent knowledge)
   - For code-writing agents: workspace setup (git worktree for isolation), TDD, submit-for-review flow, file ownership rules
   - For review agents: review-then-merge workflow using `shell_execute` with `git merge` or `gh pr create/merge`
   - Output standards and quality criteria
   - Domain-specific knowledge and context

3. **HEARTBEAT.md** (RECOMMENDED) — Defines what the agent proactively checks every ~30 minutes via `HeartbeatScheduler`. **Without this file, the agent is purely reactive** — it will only respond to direct messages and task assignments, never proactively monitor its environment. Write a role-specific checklist:
   - Check mailbox for new messages and respond to urgent items
   - Review assigned tasks — update progress, unblock if possible
   - Check team announcements for new information
   - Role-specific patrol items (e.g., code agents: check build/CI status; review agents: check tasks awaiting review; managers: check team task board and unblock members)
   - Scan recent channel messages for anything requiring attention

4. **POLICIES.md** (recommended) — Safety constraints and guardrails:
   - What the agent should NOT do
   - Tool usage guidelines
   - Quality gates and review requirements

5. **CONTEXT.md** (optional) — Additional domain context, references, or knowledge.

6. **images/avatar.jpg** — Agent visual assets (see [Image Assets](#image-assets) section below).

**Example file_write calls:**

```
file_write("~/.markus/builder-artifacts/agents/code-reviewer/README.md", "# Code Reviewer\n\nA meticulous code review agent that ensures code quality...\n\n## Features\n- Automated PR review...\n- Security vulnerability detection...\n\n## Use Cases\n- Add to any development team for automated code review")
file_write("~/.markus/builder-artifacts/agents/code-reviewer/ROLE.md", "# Code Reviewer\n\nYou are **Code Reviewer** — an expert...\n\n## Responsibilities\n...\n\n## Workflow\n...\n\n## Output Standards\n...")
file_write("~/.markus/builder-artifacts/agents/code-reviewer/HEARTBEAT.md", "# Heartbeat Checklist\n\n- [ ] Check mailbox for new messages\n- [ ] Check tasks awaiting review — prioritize by deadline\n- [ ] Review assigned tasks and update progress\n- [ ] Scan team channels for review requests")
file_write("~/.markus/builder-artifacts/agents/code-reviewer/POLICIES.md", "# Policies\n\n- Only use shell_execute for read-only commands...\n- Always show file contents before overwriting...")
```

## Image Assets

Agent avatars are **digital employee portraits** — they should depict a person (realistic human style), not abstract icons, logos, or illustrations. Users should recognize the agent as a team member, not a mascot.

### Image Generation

Use the `generate_image` tool to create agent portraits. Prompt style guide:

```
Good prompt (do this):
  "Professional headshot of a friendly male product manager in a business casual attire, 
   warm blue tones, clean background, digital art style, realistic portrait"
  "Creative female content writer with glasses, warm orange tones, looking thoughtful,
   holding a notebook, realistic digital portrait, professional yet approachable"

Bad prompt (don't do this):
  "Abstract icon of a roadmap with sticky notes" ✗ — user said "不知所云"
  "A laptop with writing bubbles floating above it" ✗ — not a person
  "Logo design for a content creator" ✗ — not a digital employee
```

Key prompt rules:
- **Subject is always a person** — realistic digital portrait
- **Match the role's personality** — PM = organized/strategic, Creator = creative/warm
- **Use color palette** that aligns with the role (blue for analytical, orange for creative, green for growth)
- **Background**: clean, professional, non-distracting
- **Style**: `"realistic digital portrait", "professional headshot", "digital art style"`

### Image Size & Compression

The `generate_image` tool typically outputs large images (e.g., 2048x2048, 400KB+). **Always compress before saving to the artifact directory.**

Recommended specifications:

| Property | Value |
|:---------|:------|
| **Final resolution** | 512×512 (square) |
| **File format** | JPEG |
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

Typical result: 2048×2048 (426KB) → 512×512 (19KB), saving ~96%.

### File Placement

| File | Directory | Purpose |
|:----|:----------|:--------|
| `avatar.jpg` | `images/` | Agent avatar, used for both `icon` and `thumbnail` |
| Additional screenshots | `images/` | Optional, for feature showcase |

**Always** place images under an `images/` subdirectory — NOT at the artifact root. This follows the existing convention used by `paper-mentor`, `prompt-engineer`, and other agents.

### Local Path vs Hub CDN URL

This is a critical distinction:

| Phase | Field | Value | Where |
|:------|:------|:------|:------|
| **Local artifact (builder-artifacts/)** | `icon` | `"images/avatar.jpg"` | Relative path in agent.json |
| **Local artifact (builder-artifacts/)** | `thumbnail` | `"images/avatar.jpg"` | Relative path in agent.json |
| **Local artifact (builder-artifacts/)** | `screenshots` | `["images/avatar.jpg"]` | Relative paths in agent.json |
| **Published to Hub** | `icon` | Emoji or CDN URL | Hub DB field (`hub_items.icon`) |
| **Published to Hub** | `thumbnailUrl` | `"https://hub.markus.global/uploads/img_xxx.jpg"` | Hub DB field (`hub_items.thumbnail_url`) |
| **Published to Hub** | `images` | `[{"url":"...","alt":"...","order":0}]` | Hub DB field (`hub_items.images`) |

**Note:** Hub DB schema uses `thumbnailUrl` (not `thumbnail`), and `images` (not `screenshots`). The local artifact file uses `thumbnail` and `screenshots` for compatibility with the local install system. When publishing to Hub via API, map:
- Local `thumbnail` → Hub `thumbnailUrl`
- Local `screenshots` → Hub `images` (converted to `{url, alt, order}[]` format)

## Field Reference

### Top-level fields
- **`type`**: Always `"agent"`
- **`name`**: **Package slug** — English kebab-case only (see [Package Slug](#package-slug-name--required)). Invalid/save/share reject Chinese or invalid slugs.
- **`displayName`**: Human-readable name, can be in any language (e.g., `"论文学习导师"`, `"Code Reviewer"`)
- **`version`**: Semver (default `"1.0.0"`)
- **`description`**: What this agent does (can be in any language)
- **`category`**: One of `development`, `devops`, `management`, `productivity`, `general`, `marketing`, `engineering`, `product-management`
- **`tags`**: Array of descriptive tags
- **`icon`** (optional): Can be emoji OR image path. Emoji is lighter (zero network cost). Image path is visually richer. Both work in the Hub UI. Example: `"🚀"` or `"images/avatar.jpg"`
- **`thumbnail`** (optional): Relative path to avatar image in artifact. Shows as large preview. Must be under `images/` directory. Example: `"images/avatar.jpg"`
- **`screenshots`** (optional): Array of image paths for gallery/展示. Each path under `images/`. Example: `["images/avatar.jpg"]`
- **`license`** (optional): License type, e.g. MIT, Apache-2.0. Example: `"MIT"`
- **`originalSource`** (optional): URL to original source repository for attribution. Example: `"https://github.com/..."`
- **`dependencies.skills`**: Skill IDs from the dynamic context. **Actively assign — don't leave empty!**
- **`dependencies.env`**: Required CLI tools (e.g., `["git", "node"]`). Omit if none needed.

### `agent` section (REQUIRED)
- **`agentRole`**: `"worker"` (executes tasks) or `"manager"` (coordinates, assigns, reviews)
- **`llmProvider`**, **`llmModel`**, **`temperature`**: LLM configuration. Leave empty for system defaults. Temperature: 0.7 general, 0.3-0.5 precision, 0.8-1.0 creative.

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

1. **The agent has been created and saved** — summarize what was created (name, purpose, key skills, image asset).
2. **Visual asset included** — note the avatar image and its compressed size.
3. **Ready to install** — the user can install from the Builder page, or ask you to install it (you would use `package_install`). Do NOT install unless asked.
4. **To modify or improve** this agent (e.g., update the role, change skills, adjust policies, regenerate the avatar), just continue the conversation here — describe what you want to change and I'll update the files directly.

## Rules

- **DO NOT** invent skill IDs. Only use values from the dynamic context.
- **DO NOT** put file content in the JSON. Always use `file_write` for files.
- **DO NOT** default skills to `[]` when relevant skills are available. Check the skills list!
- **DO NOT** write artifacts to `~/.markus/shared/` or your working directory. Always use `~/.markus/builder-artifacts/agents/{name}/`.
- **The `name` field MUST be a valid English kebab-case slug** (see Package Slug). Never use Chinese as `name`. Invalid `name` → write/save/share fails.
- **All top-level fields must be the correct type**: `author` must be a plain string (e.g. `"John"`) — NOT an object. `tags` must be an array of strings. `version` must be semver string. `description` must be a string. The system validates the manifest on write and will reject malformed files.
- **Agent avatars MUST be human/digital employee portraits** — not abstract icons or logos. Users should see a person.
- **Always compress images** — from raw generation output (often ~400KB+) to ≤50KB (512×512 JPEG).
- **Images go in `images/` subdirectory** — never at the artifact root.
- The `ROLE.md` is what makes the agent unique — write at least 5 substantive paragraphs. A generic one-liner is useless.
- Default `temperature` to 0.7 for general tasks, lower (0.3-0.5) for precision tasks, higher (0.8-1.0) for creative tasks.
- After outputting the JSON, immediately proceed to write files via `file_write` — announce what you're writing.