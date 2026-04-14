---
name: markus-admin-cli
description: System administration via markus CLI — system controls, audit, users, settings, gateway.
---

# System Administration via CLI

> **NOTE**: Most admin CLI commands have no built-in tool equivalent — CLI is the primary interface for system administration. Use `builder_install`/`builder_list` for artifact management when available.

Administrative operations through `shell_execute` with `markus admin` commands. Always use `--json` for parseable output.

## System Controls

```bash
markus admin system status --json
markus admin system version --json
markus admin system update
markus admin system update --dry-run
markus admin system pause-all --reason "Deploying updates"
markus admin system resume-all
markus admin system emergency-stop
markus admin system storage --json
markus admin system orphans --json
markus admin system announce --title "Maintenance" --content "Downtime at 2am" --priority high
markus admin system policy --json
markus admin system policy --set --body '{"defaultApproval":"manager"}'
```

| Command | Key Options |
|---------|-------------|
| `admin system status` | |
| `admin system version` | Shows current version, git info, and whether updates are available |
| `admin system update` | `--dry-run` (preview without applying). Pulls latest code, installs deps, rebuilds |
| `admin system pause-all` | `--reason` |
| `admin system resume-all` | |
| `admin system emergency-stop` | |
| `admin system storage` | |
| `admin system orphans` | |
| `admin system announce` | `--title` `--content` `--priority` `--type` `--expires-at` |
| `admin system policy` | `--set <json>` (update mode) |

**Update workflow**: When updating the platform, always: (1) confirm with the user, (2) pause all agents first (`pause-all`), (3) run `update`, (4) restart the service (`markus start`), (5) resume agents (`resume-all`).

## Audit (nested under admin system)

```bash
markus admin system audit log --json --limit 50
markus admin system audit log --type llm_request --agent-id agt_xxx
markus admin system audit summary --json
markus admin system audit tokens --json
```

## Users

```bash
markus admin user list --json
markus admin user add --name "John" --role admin --email john@example.com
markus admin user delete usr_xxx
```

## API Keys

```bash
markus admin key list --json
markus admin key create --name "CI Key"
markus admin key delete key_xxx
```

## Roles

```bash
markus admin role list --json
markus admin role get developer --json
```

## Templates

```bash
markus admin template list --json
markus admin template get Developer --json
markus admin template instantiate --template-id Developer --name "New Agent" --org-id default
```

## Builder Artifacts

```bash
markus admin builder list --json
markus admin builder get agent my-agent --json
markus admin builder install agent my-agent
markus admin builder uninstall agent my-agent
```

## Settings

```bash
markus admin settings llm --json
markus admin settings env-models --json
markus admin settings oauth-status --json
```

## Gateway (External Agent Access)

```bash
markus admin gateway info --json
markus admin gateway register --agent-id ext_001 --agent-name "CI Bot" --org default
markus admin gateway auth --agent-id ext_001 --org default --secret <secret>
markus admin gateway message --text "Status update" --token <bearer-token>
markus admin gateway status --token <bearer-token>
markus admin gateway manual --token <bearer-token>
markus admin gateway team --token <bearer-token>
```

## External Agents

```bash
markus admin external-agent list --json
markus admin external-agent register --name "CI Bot" --type ci
markus admin external-agent delete ext_xxx
```

## Permissions Note

Most admin commands require owner or admin role. Agent-level operations require the agent to be part of your organization.
