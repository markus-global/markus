---
name: markus-skill-cli
description: Manage skills via markus CLI — list, install, uninstall, search, scaffold.
---

# Skill Management via CLI

Operate the skill registry through `shell_execute` with `markus skill` commands. Always use `--json` for parseable output.

## Quick examples

```bash
# List installed skills
markus skill list --json

# List built-in template skills
markus skill builtin --json

# Search remote registries
markus skill search --query "browser automation" --json

# Install a skill
markus skill install --name chrome-devtools --source builtin

# Uninstall a skill
markus skill uninstall chrome-devtools

# Scaffold a new custom skill
markus skill init --name my-skill
```

## Command Reference

| Command | Key Options |
|---------|-------------|
| `skill list` | |
| `skill builtin` | |
| `skill search` | `--query` |
| `skill install` | `--name` (required) `--source` |
| `skill uninstall <name>` | |
| `skill init` | `--name` `--dir` |

## Skill types

- **Built-in**: Ship with Markus (e.g. `chrome-devtools`, `self-evolution`)
- **Custom**: User-created, stored locally
- **Registry**: Discovered via `skill search`, installed from remote sources

## Scaffold structure

`markus skill init --name my-skill` creates:

```
my-skill/
  skill.json    # Metadata (name, version, category, tags)
  SKILL.md      # Instructions for the agent
```
