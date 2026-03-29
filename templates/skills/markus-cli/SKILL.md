---
name: markus-cli
description: Core knowledge for operating the Markus platform via CLI. Prerequisite for domain-specific markus-*-cli skills.
---

# Markus CLI

The `markus` command-line tool lets you operate the Markus platform programmatically.
Use it via `shell_execute` to manage agents, projects, tasks, teams, and more.

## How to invoke

Use `markus` via `shell_execute`. The binary is automatically available in PATH when the Markus server is running (the server injects `node_modules/.bin` into PATH at startup).

```bash
markus agent list --json
markus project task get tsk_abc123 --json
markus admin system status --json
```

**Important**: Do NOT use `npx markus` — there is an unrelated `markus` package on npm. Always use `markus` directly.

## Prerequisites

- The Markus server must be running (started via `markus start`).
- `markus start` auto-detects first run and initializes everything (DB, config wizard).
- The CLI connects to `http://localhost:8056` by default. Override with `--server <url>` or `MARKUS_API_URL`.
- For authenticated access use `--api-key <key>` or `MARKUS_API_KEY`.

## Output format

**Always use `--json` when parsing results programmatically.** Without `--json`, output is human-readable tables.

```bash
# Machine-readable — use this in automation
markus agent list --json

# Human-readable table
markus agent list
```

## Command structure

Commands follow the pattern: `markus <domain> [sub] <action> [id] [options]`

```bash
markus agent list                        # List agents
markus project list --json               # List projects
markus project task create --title "..."  # Create a task
markus admin system status               # System health
markus <domain> --help                   # See all subcommands
```

## Command hierarchy

| Command | Description | Skill |
|---------|-------------|-------|
| `start` | Start server (auto-init on first run) | — |
| `agent` | Agent lifecycle, config, memory, skills | markus-agent-cli |
| `team` | Team CRUD, members, lifecycle | markus-team-cli |
| `skill` | Skill registry, install, scaffold | markus-skill-cli |
| `project` | Project CRUD | markus-project-cli |
| `project task` | Task CRUD, lifecycle, subtasks, comments | markus-project-cli |
| `project requirement` | Requirement CRUD, approval | markus-project-cli |
| `project deliverable` | Deliverable CRUD | markus-project-cli |
| `project report` | Report generation, usage stats | markus-project-cli |
| `project review` | Code / task reviews | markus-project-cli |
| `project approval` | HITL approvals | markus-project-cli |
| `admin` | Platform administration & system controls | markus-admin-cli |
| `admin system` | Global controls, governance, storage | markus-admin-cli |
| `admin system audit` | Audit log and summary | markus-admin-cli |
| `admin user` | Human user management | markus-admin-cli |
| `admin key` | API key management | markus-admin-cli |
| `admin role` | Role templates | markus-admin-cli |
| `admin template` | Agent/team templates | markus-admin-cli |
| `admin builder` | Builder artifacts | markus-admin-cli |
| `admin gateway` | External agent gateway | markus-admin-cli |
| `admin settings` | LLM and platform settings | markus-admin-cli |
| `admin external-agent` | External agent registration | markus-admin-cli |

## Tips

- Always use `--json` and parse the JSON output for reliable automation.
- When creating tasks, always specify `--project-id` if projects exist.
- Use `markus <domain> --help` to discover available subcommands and options.
