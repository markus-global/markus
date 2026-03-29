---
name: markus-team-cli
description: Manage teams via markus CLI — create, members, lifecycle, export.
---

# Team Management via CLI

Operate teams through `shell_execute` with `markus team` commands. Always use `--json` for parseable output.

## Quick examples

```bash
# List teams
markus team list --json

# Create a team
markus team create --name "Backend Team" --org default

# Add/remove members
markus team add-member team_xxx --member agt_xxx --type agent
markus team remove-member team_xxx agt_xxx

# Team lifecycle
markus team start team_xxx
markus team stop team_xxx
markus team pause team_xxx --reason "Maintenance"
markus team resume team_xxx

# Team status
markus team status team_xxx --json

# Export team config
markus team export team_xxx --json
```

## Command Reference

| Command | Key Options |
|---------|-------------|
| `team list` | `--org` |
| `team get <id>` | |
| `team create` | `--name` (required) `--org` `--description` |
| `team update <id>` | `--name` `--description` `--manager-id` `--manager-type` |
| `team delete <id>` | `--delete-members` `--purge-files` |
| `team add-member <id>` | `--member` (required) `--type` (agent/human) |
| `team remove-member <id> <memberId>` | |
| `team start <id>` | |
| `team stop <id>` | |
| `team pause <id>` | `--reason` |
| `team resume <id>` | |
| `team status <id>` | |
| `team export <id>` | |
