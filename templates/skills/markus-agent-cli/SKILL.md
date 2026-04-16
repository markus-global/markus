---
name: markus-agent-cli
description: Manage agents via markus CLI — lifecycle, messaging, config, memory, skills.
---

# Agent Management via CLI

> **IMPORTANT**: Prefer built-in tools (`team_hire_agent`, `builder_install`, `agent_send_message`, `task_create`, `task_assign`, `memory_save`, etc.) over CLI commands. Only use CLI when no built-in tool provides the needed operation (e.g., `agent delete`, `agent config`, `agent role-sync`).

Operate agents through `shell_execute` with `markus agent` commands. Always use `--json` for parseable output.

## Quick examples

```bash
# List all agents
markus agent list --json

# Get agent details
markus agent get agt_xxx --json

# Create an agent
markus agent create --name "Alice" --role developer --team team_xxx

# Start / stop agents
markus agent start agt_xxx
markus agent stop agt_xxx

# Send a message
markus agent message agt_xxx --text "Please review the API changes"

# Update config
markus agent config agt_xxx --skills "self-evolution,chrome-devtools"

# View memory
markus agent memory agt_xxx --json

# Manage skills
markus agent skill-add agt_xxx --skill-name chrome-devtools
markus agent skill-remove agt_xxx --skill-name chrome-devtools

# Trigger heartbeat or daily report
markus agent heartbeat agt_xxx
markus agent daily-report agt_xxx

# Sync role from template
markus agent role-sync agt_xxx
```

## Command Reference

| Command | Key Options |
|---------|-------------|
| `agent list` | |
| `agent get <id>` | |
| `agent create` | `--name` (required) `--role` (required) `--org` `--team` `--agent-role` `--skills` |
| `agent delete <id>` | `--purge` |
| `agent start <id>` | |
| `agent stop <id>` | |
| `agent message <id>` | `--text` (required) `--sender` `--session` |
| `agent chat <id>` | Interactive REPL mode |
| `agent config <id>` | `--name` `--agent-role` `--skills` `--heartbeat` |
| `agent memory <id>` | |
| `agent files <id>` | |
| `agent skill-add <id>` | `--skill-name` (required) |
| `agent skill-remove <id>` | `--skill-name` (required) |
| `agent activities <id>` | `--type` `--limit` |
| `agent heartbeat <id>` | |
| `agent daily-report <id>` | |
| `agent role-sync <id>` | |
