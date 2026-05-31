---
name: markus-admin-cli
description: System administration via markus CLI — system status, emergency stop, version, and updates.
---

# System Administration via CLI

> **NOTE**: The CLI is intentionally minimal. Most operations should be done through built-in agent tools or the Web UI. The CLI is reserved for infrastructure bootstrap, human-agent communication, and emergency operations.

## How to invoke

Use `markus` via `shell_execute`. The binary is automatically available in PATH.

```bash
markus admin system status --json
```

**Always use `--json` when parsing results programmatically.** The CLI connects to `http://localhost:8056` by default. Override with `--server <url>` or `MARKUS_API_URL`. For authenticated access use `--api-key <key>` or `MARKUS_API_KEY`.

## Available Admin Commands

```bash
markus admin system status --json
markus admin system version --json
markus admin system update
markus admin system update --dry-run
markus admin system emergency-stop
```

| Command | Description |
|---------|-------------|
| `admin system status` | System and health status |
| `admin system version` | Current version, git info, and whether updates are available |
| `admin system update` | Pull latest code, install deps, rebuild. `--dry-run` to preview |
| `admin system emergency-stop` | Immediately stop all agents |

## Update Workflow

When updating the platform: (1) confirm with the user, (2) run `markus admin system update`, (3) restart the service with `markus start`.

## Other CLI Commands (non-admin)

```bash
markus start                  # Start the server
markus doctor                 # Diagnose configuration
markus model                  # Configure LLM providers
markus models [provider]      # List available models
markus auth list|add|remove   # Manage API credentials
markus install <platform>     # Install external agent platform
markus agent list             # List agents
markus agent get <id>         # Get agent details
markus agent chat <id>        # Interactive chat
markus agent message <id>     # Send one-shot message
```

## Prefer Built-in Tools

For project, task, requirement, deliverable, team, and skill management, **always use built-in agent tools** (`task_create`, `list_projects`, `requirement_propose`, `team_list`, etc.) instead of CLI commands. The CLI does not provide these commands — they are agent-only operations.
