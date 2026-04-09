---
name: markus-project-cli
description: Manage projects, tasks, requirements, deliverables, reports, reviews, and approvals via markus CLI.
---

# Project & Task Management via CLI

Operate projects, tasks, requirements, deliverables, reports, reviews, and approvals through `shell_execute` with `markus` commands. Always use `--json` for parseable output.

## Projects

```bash
markus project list --json
markus project get proj_xxx --json
markus project create --name "Web App v2" --org-id default --description "Next version"
markus project update proj_xxx --description "Updated scope"
markus project delete proj_xxx
```

| Command | Key Options |
|---------|-------------|
| `project list` | `--org <id>` |
| `project get <id>` | |
| `project create` | `--name` (required) `--org` `--description` `--repositories` `--team-ids` |
| `project update <id>` | `--name` `--description` `--status` `--repositories` `--team-ids` |
| `project delete <id>` | |

## Tasks (nested under project)

```bash
markus project task list --status in_progress --json
markus project task create --title "Implement login page" --priority high --assignee agt_xxx --project-id proj_xxx
markus project task run tsk_xxx
markus project task get tsk_xxx --json
markus project task approve tsk_xxx
markus project task accept tsk_xxx
markus project task revision tsk_xxx --reason "Tests are missing"
```

### CRUD

| Command | Options |
|---------|---------|
| `project task list` | `--status` `--agent-id` `--project-id` `--requirement-id` `--org-id` `--limit` |
| `project task get <id>` | |
| `project task create` | `--title` (required) `--description` `--priority` `--assignee` `--reviewer` `--project-id` `--blocked-by` `--type` |
| `project task update <id>` | `--title` `--description` `--priority` `--status` `--assignee` `--reviewer` `--project-id` `--blocked-by` |
| `project task dashboard` | `--org-id` |
| `project task board` | `--org-id` `--project-id` |

### Lifecycle Actions

| Command | Options |
|---------|---------|
| `project task approve <id>` | |
| `project task reject <id>` | |
| `project task run <id>` | |
| `project task pause <id>` | |
| `project task resume <id>` | |
| `project task retry <id>` | |
| `project task cancel <id>` | `--cascade` |
| `project task accept <id>` | |
| `project task revision <id>` | `--reason` |
| `project task archive <id>` | |

### Subtasks & Comments

| Command | Options |
|---------|---------|
| `project task subtasks <id>` | |
| `project task subtask-add <id>` | `--title` (required) |
| `project task comment <id>` | `--content` (required) `--author-id` `--author-name` |
| `project task logs <id>` | |

### Task State Flow

```
pending → in_progress → review → completed → archived
         (blocked / failed / cancelled along the way)
```

## Requirements (nested under project)

```bash
markus project requirement list --project proj_xxx --json
markus project requirement create --title "User auth" --project proj_xxx --priority high
markus project requirement approve req_xxx
markus project requirement reject req_xxx --reason "Out of scope"
```

| Command | Key Options |
|---------|-------------|
| `project requirement list` | `--org` `--status` `--project` `--source` |
| `project requirement get <id>` | |
| `project requirement create` | `--title` (required) `--description` `--priority` `--project` `--org` `--tags` |
| `project requirement update <id>` | `--title` `--description` `--priority` `--tags` |
| `project requirement approve <id>` | |
| `project requirement reject <id>` | `--reason` |
| `project requirement delete <id>` | |

### Requirement State Flow

```
pending → in_progress → completed
       → rejected / cancelled
```

## Deliverables (nested under project)

```bash
markus project deliverable list --project-id proj_xxx --json
markus project deliverable create --title "API Design Doc" --type knowledge --project-id proj_xxx
markus project deliverable update dlv_xxx --status verified
markus project deliverable delete dlv_xxx
```

| Command | Key Options |
|---------|-------------|
| `project deliverable list` | `--query` `--project` `--agent` `--task` `--type` `--status` `--limit` `--offset` |
| `project deliverable create` | `--title` (required) `--type` `--summary` `--reference` `--tags` `--task` `--agent` `--project` |
| `project deliverable update <id>` | `--title` `--summary` `--reference` `--tags` `--status` `--type` |
| `project deliverable delete <id>` | |

## Reports & Usage (nested under project)

```bash
markus project report generate --period weekly --scope org
markus project report usage --json
```

| Command | Key Options |
|---------|-------------|
| `project report list` | `--scope` `--scope-id` `--type` |
| `project report generate` | `--period` (required: daily/weekly/monthly) `--scope` `--org` |
| `project report usage` | `--org` |

## Code Reviews (nested under project)

```bash
markus project review run --task-id tsk_xxx --agent-id agt_xxx --description "PR review"
markus project review list --task-id tsk_xxx --json
markus project review get rev_xxx --json
```

| Command | Key Options |
|---------|-------------|
| `project review run` | `--task` (required) `--agent` (required) `--description` `--changed-files` |
| `project review list` | `--task` `--limit` |
| `project review get <id>` | |

## Approvals (nested under project)

```bash
markus project approval list --task-id tsk_xxx --json
markus project approval process apv_xxx --action approve
```

| Command | Key Options |
|---------|-------------|
| `project approval list` | `--task` `--status` |
| `project approval process <id>` | `--action` (approve/reject) `--reason` |
