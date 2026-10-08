# Skill Ecosystem Adapter

> **In one sentence**: Markus skills are "bidirectionally compatible" with mainstream external skill ecosystems — `markus skill import` normalizes
> external skills such as skills.sh / SkillHub / OpenClaw / SOUL.md / AgentScope / MCP-server into
> the Markus format (skill.json + SKILL.md), while `markus skill export` renders
> Markus skills back into external formats for publishing to the community. Together with the existing `discover_tools` modes (`activate` / `list_skills` / `search_registry` / `install`),
> the Markus ecosystem can directly consume **80,000+ community skills**, and your own skills can be published outward in return.

---

## 1. Supported Ecosystem Formats

| Format | Identifier | Detection signature | Description |
| --- | --- | --- | --- |
| Claude Code / skills.sh | `claude` | Directory contains `SKILL.md` (with YAML frontmatter) | The mainstream form of the 80,000+ skills on skills.sh |
| SkillHub / ClawHub | `skillhub` | `SKILL.md` or a `skills/` subdirectory, `clawhub.json` | Packages may include icons/assets/multiple skills |
| OpenClaw | `openclaw` | `config.json5` / `AGENTS.md` / `agents/` | OpenClaw skill directory, possibly with MCP config |
| OpenClaw SOUL | `soul` | Directory contains `SOUL.md` | Soul package (persona + instructions) |
| AgentScope | `agentscope` | `.py` decorated with `@tool` + `README.md` | Alibaba AgentScope tool-script skills (approximate adaptation) |
| Generic MCP-server | `mcp-server` | `mcp.json` / `.mcp.json` (containing `mcpServers`) | Pure MCP server config-style skills |

> **Note on AgentScope**: the AgentScope community has not yet settled on a unified "skill package" standard, so this adapter treats it approximately as
> "tool scripts + documentation": on import it keeps the `.py` tool files and writes the `@tool` functions into the
> instructions; on export it generates `README.md + SKILL.md (+ tool_stub.py)` for developers to plug into an AgentScope environment.

---

## 2. Field Mapping (External → Markus)

| External field | Markus field | Notes |
| --- | --- | --- |
| `SKILL.md` frontmatter `name` | `skill.json.name` | kebab-case normalized |
| `description` | `description` | |
| `version` / `license` / `author` | same names | Auto-detected from the `LICENSE` file / `package.json` |
| `allowed-tools` | `skill.requiredPermissions` | `shell*→shell`, `file/read/write→file`, `web/http→network`, `browser*→browser` |
| `mcp.json` / `config.json5.mcpServers` | `skill.mcpServers` | Auto-parses JSON5 (strips comments/trailing commas/key quotes) |
| `tags` | `tags` | |
| Description keywords | `category` | Keyword inference (development/devops/data/browser/...) |
| `SOUL.md` body | `SKILL.md` instructions | Preserve the original text |
| Icons / README / LICENSE / scripts | Attached files | Copied along on import |

---

## 3. CLI Usage

```bash
# List installed skills
markus skill list

# Import an external skill package (auto-detect format → normalize to the Markus format)
markus skill import ~/Downloads/clawhub-skill.zip  --force
markus skill import ./skills/pdf-tables          --name pdf-tools
markus skill import ~/projects/agent-scope-skill --to ~/.markus/skills/my-scope

# Export a Markus skill to an external ecosystem (default output ./<name>-<format>/)
markus skill export pdf-tools --format claude
markus skill export pdf-tools --format openclaw --out ~/publish
markus skill export pdf-tools --format soul
markus skill export pdf-tools --format mcp-server
markus skill export pdf-tools --format agentscope
markus skill export pdf-tools --from ~/.markus/skills/pdf-tools  # or specify a directory directly

# Show supported formats and detection rules
markus skill formats
```

All commands support `--json` machine-readable output.

---

## 4. Using Inside an Agent (discover_tools)

An agent activates an already-installed skill directly in a conversation — the skill's instructions (and any MCP
servers it ships) are injected on demand, no restart needed:

```json
{ "name": ["<skill-name>"] }
```

`"activate"` is the default `mode`, so the object above is enough. The other modes are
`{ "mode": "list_skills" }` (browse installed skills), `{ "mode": "search_registry", "query": "..." }`
(search remote registries such as SkillHub / skills.sh for uninstalled skills), and
`{ "mode": "install", "name": ["<skill-name>"], "source": "skillhub" }` (install one from a registry).

---

## 5. Architecture

```
packages/core/src/skills/codec/
├── types.ts            # Format enum + NormalizedSkill intermediate representation
├── detect.ts           # Detect format from directory signatures (priority order: see markus skill formats)
├── frontmatter.ts      # Minimal YAML frontmatter parse/render (no yaml dependency)
├── parse.ts            # Each format → NormalizedSkill (with permission mapping / JSON5 / MCP extraction)
├── render.ts           # NormalizedSkill → external format files (pure function)
├── import-export.ts    # Persistence: write skill.json + SKILL.md + attached files / render output
└── index.ts            # Public API
```

- The entry point is `packages/core/src/skills/codec/index.ts`, exported via `@markus/core`.
- Service-layer wrapping: `@markus/org-manager`'s `importSkillFromDirectory / exportSkillToFormat`
  (including runtime registry refresh); the CLI and the in-agent `discover_tools` flow share the same implementation.
- Adding a format only requires: add a signal in `detect.ts` → add a parse function in `parse.ts` → add a renderer in `render.ts`.

---

## 6. README Snippet (Ready to Copy)

```markdown
### 🌍 Ecosystem compatibility: 80,000+ community skills, plug and play

Markus ships with a skill ecosystem adapter that **connects both ways** with mainstream AI skill ecosystems:

- **Import**: `markus skill import <path>` automatically detects and normalizes
  skills.sh (80,000+ community skills), SkillHub/ClawHub, OpenClaw, SOUL.md, AgentScope,
  MCP-server, and other formats into Markus skills — no code changes, ready to use once installed.
- **Export**: `markus skill export <name> --format claude` renders a Markus skill into external
  standard formats, ready to publish to skills.sh / SkillHub / OpenClaw and other communities.
- **In-agent loop**: in a conversation, `discover_tools({ name: ["<skill-name>"] })` activates an installed
  skill's instructions immediately (and `mode: "install"` pulls one in from a registry), no restart needed.
```

---

## 7. Known Limitations

- An external skill's `mcpServers` depends on a working local runtime (e.g. `npx`/`uvx` installed) to take effect.
- AgentScope is an approximate adaptation (no community-wide standard); for MCP server instruction-style skills, prefer the `mcp-server` format.
- Import does not execute remote code — it only copies files and normalizes metadata; assess the trust boundary yourself before running an external skill's scripts.
