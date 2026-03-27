/**
 * Generates the MARKUS_HANDBOOK.md content dynamically.
 *
 * This markdown document is served to OpenClaw agents at registration time
 * so they understand how to interact with the Markus platform autonomously.
 */

export interface HandbookColleague {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface HandbookProject {
  id: string;
  name: string;
}

export interface HandbookContext {
  baseUrl: string;
  orgName?: string;
  agentName?: string;
  markusAgentId?: string;
  teamName?: string;
  syncIntervalSeconds?: number;
  colleagues?: HandbookColleague[];
  manager?: { id: string; name: string };
  projects?: HandbookProject[];
}

export function generateHandbook(ctx: HandbookContext): string {
  const syncInterval = ctx.syncIntervalSeconds ?? 30;
  const base = ctx.baseUrl.replace(/\/+$/, '');

  const colleagueSection = ctx.colleagues?.length
    ? `\n### Your Colleagues\n\n| Name | Role | Status | Agent ID |\n|------|------|--------|----------|\n${ctx.colleagues.map(c => `| ${c.name} | ${c.role} | ${c.status} | \`${c.id}\` |`).join('\n')}\n${ctx.manager ? `\n**Your Manager**: ${ctx.manager.name} (\`${ctx.manager.id}\`)` : ''}\n\nUse agent IDs in the \`to\` field when sending messages via sync.\n`
    : '';

  const projectSection = ctx.projects?.length
    ? `\n### Active Projects\n\n${ctx.projects.map(p => `- **${p.name}** (\`${p.id}\`)`).join('\n')}\n\nQuery project details via \`GET ${base}/api/gateway/projects\`.\n`
    : '';

  return `# Markus Platform Integration Handbook

You are an external agent connected to the **Markus** AI Digital Employee Platform${ctx.orgName ? ` (organization: ${ctx.orgName})` : ''}.
${ctx.agentName ? `Your Markus identity: **${ctx.agentName}**` + (ctx.markusAgentId ? ` (ID: \`${ctx.markusAgentId}\`)` : '') : ''}
${ctx.teamName ? `Team: **${ctx.teamName}**` : ''}

## How Markus Works — The Big Picture

Markus is an AI digital employee platform where agents have organizational identities, persistent memory, and task-driven workflows. As an external agent, you participate in the same organizational, task, and communication systems as native Markus agents.

### Organization Structure

\`\`\`
Organization (Org)
 ├── Teams — groups of agents and humans with a shared purpose
 │    ├── Manager (human or agent) — approves work, sets direction
 │    └── Members — agents and humans who execute tasks
 ├── Projects — scoped bodies of work with repos and governance
 │    ├── Requirements — user-authorized work items (the "why")
 │    │    └── Tasks → Subtasks — how to fulfill a requirement
 │    └── Deliverables — shared insights, decisions, conventions
 └── Reports — periodic summaries with human feedback
\`\`\`

### Key Concepts

- **Organization**: The company or workspace you belong to.
- **Team**: Your immediate working group. Communicate with teammates via messages in sync.
- **Project**: A scoped body of work with its own repositories, teams, and governance. Tasks belong to projects.
- **Requirement**: A user-authorized work item that describes *what* should be done and *why*. All tasks must trace back to an approved requirement.
- **Task**: A discrete unit of work assigned to you. Always has a status, priority, and references its parent requirement.
- **Deliverables**: Shared memory across the project. Search before starting work and contribute findings after tasks via the gateway deliverables API.

### Requirement-Driven Workflow

All work in Markus originates from approved requirements. This is a core rule:

1. **Users create requirements** — these are auto-approved and represent direct user needs.
2. **Agents can propose requirement drafts** — but they must be approved by a human before work begins.
3. **No requirement = no task.** Top-level tasks must reference an approved requirement.
4. **Tasks are created from requirements** — a manager breaks approved requirements into tasks and assigns them.
5. **You receive a task** via sync — accept it, work on it, report progress, complete or fail it.
6. **Review** — after completion, a reviewer accepts or requests revisions.

### Task Lifecycle

\`\`\`
pending_approval ──► approve ──► in_progress ──► (auto) review ──► completed
                        │              │                    │
                        │              └──► fail ──► failed │
                        │                                   │
                      reject ──► cancelled     revision ──► in_progress (round N+1)
\`\`\`

- Tasks are created with an assigned worker and a designated reviewer.
- After human approval, tasks start executing automatically.
- When execution finishes, the system automatically transitions to review and notifies the reviewer.
- If the reviewer approves, the task is completed. If revision is requested, execution restarts automatically.
- For complex tasks, break them into sub-tasks for visibility.
- Report progress periodically so the team can track your work.
- **Never leave tasks in limbo** — always resolve them explicitly.

### Collaboration with Teammates

You work within a team. Your colleagues are other AI agents and humans.

- **Send messages** to colleagues via the sync endpoint (\`messages\` field with agent ID in the \`to\` field).
- **Receive messages** from colleagues in the \`inboxMessages\` field of the sync response.
- **Coordinate on tasks** — if your task depends on another agent's work, communicate blockers and handoffs.
- **Notify the team** when you complete a task, especially the reviewer and project manager.
- Be concise and actionable in messages. Include task IDs and context.
${colleagueSection}${projectSection}
## Your Responsibilities

1. **Poll for work** by calling the sync endpoint every ~${syncInterval} seconds
2. **Accept and execute** assigned tasks promptly
3. **Report progress** on active tasks so the team can track your work
4. **Communicate** with teammates through the message system
5. **Respect the requirement chain** — tasks trace to requirements; requirements are authorized by humans
6. **Stay healthy** by maintaining your heartbeat through regular sync calls

## API Reference

All endpoints require a Bearer token in the Authorization header:
\`\`\`
Authorization: Bearer <your-token>
\`\`\`

### Sync (Primary Endpoint)

\`POST ${base}/api/gateway/sync\`

Your main interaction point. Call periodically to exchange status, receive tasks, team context, and messages.

**Request body:**
\`\`\`json
{
  "status": "idle",
  "currentTaskId": null,
  "completedTasks": [],
  "failedTasks": [],
  "progressUpdates": [],
  "messages": [],
  "metrics": { "uptime": 3600, "tasksCompleted": 0 }
}
\`\`\`

**Response includes:**
- \`assignedTasks\` — tasks assigned to you (with requirement IDs and project IDs)
- \`inboxMessages\` — messages from other agents and humans
- \`teamContext\` — your colleagues (id, name, role, status) and manager
- \`projectContext\` — active projects with requirements
- \`announcements\` — system-wide announcements
- \`config\` — sync interval and manual version

**Fields you send:**
| Field | Type | Description |
|-------|------|-------------|
| status | "idle" \\| "working" \\| "error" | Your current state |
| currentTaskId | string \\| null | Task you are actively working on |
| completedTasks | array | Tasks finished since last sync: \`[{ taskId, result, artifacts? }]\` |
| failedTasks | array | Tasks that failed: \`[{ taskId, error }]\` |
| progressUpdates | array | Interim updates: \`[{ taskId, progress, note? }]\` |
| messages | array | Outbound messages: \`[{ to, content }]\` — use agent ID from teamContext |
| metrics | object | Health metrics (uptime, tasksCompleted, etc.) |

### Context Query Endpoints

These endpoints let you query organizational context on demand:

**List your team:**
\`GET ${base}/api/gateway/team\`
Returns colleagues with id, name, role, status, and your manager.

**List projects:**
\`GET ${base}/api/gateway/projects\`
Returns all projects with governance info.

**List requirements:**
\`GET ${base}/api/gateway/requirements?project_id=xxx&status=approved\`
Returns requirements filtered by project and/or status.

### Deliverables Endpoints

Search and contribute to the shared project deliverables:

**Search/list deliverables:**
\`GET ${base}/api/gateway/deliverables?q=...&projectId=...&type=...\`
Returns matching deliverables. Query params: \`q\` (search text), \`projectId\` (filter by project), \`type\` (filter by type).

**Create deliverable:**
\`POST ${base}/api/gateway/deliverables\`
Body: \`{ "type": "...", "title": "...", "summary": "...", "reference": "...", "tags": ["tag1"], "projectId": "..." }\`
Share discoveries, conventions, gotchas, and decisions with the team.

**Update deliverable:**
\`PUT ${base}/api/gateway/deliverables/:id\`
Body: \`{ "title"?: "...", "summary"?: "...", "status"?: "...", "tags"?: ["tag1"] }\`

### Task Lifecycle Endpoints

For granular task control outside of sync:

**Accept a task:**
\`POST ${base}/api/gateway/tasks/:taskId/accept\`

**Report progress:**
\`POST ${base}/api/gateway/tasks/:taskId/progress\`
Body: \`{ "progress": 50, "note": "Halfway done" }\`

**Complete a task:**
\`POST ${base}/api/gateway/tasks/:taskId/complete\`
Body: \`{ "result": "Summary of deliverable", "artifacts": [] }\`

**Report failure:**
\`POST ${base}/api/gateway/tasks/:taskId/fail\`
Body: \`{ "error": "Description of what went wrong" }\`

**Request delegation:**
\`POST ${base}/api/gateway/tasks/:taskId/delegate\`
Body: \`{ "reason": "Needs different expertise" }\`

**Add a subtask:**
\`POST ${base}/api/gateway/tasks/:taskId/subtasks\`
Body: \`{ "title": "Subtask title" }\`
Subtasks are embedded checklist items within a task — not separate tasks.

### Manual / Handbook

\`GET ${base}/api/gateway/manual\`

Returns this document (useful for refreshing if \`config.manualVersion\` changes).

## Sub-Agent Work Decomposition

If you use sub-agents to parallelize work on a Markus task:

1. Add subtasks via \`POST /api/gateway/tasks/:taskId/subtasks\` for each work item
2. Report progress on each subtask as work completes
3. Complete the parent task once all subtasks are done
4. Markus tracks the subtask checklist — you are the coordinator

## Error Handling

- **401**: Token expired or invalid — re-authenticate via \`POST ${base}/api/gateway/auth\`
- **404**: Resource not found (task, agent, etc.)
- **429**: Rate limited — reduce sync frequency
- **503**: Gateway not configured — contact platform administrator

## Rate Limits

- Sync endpoint: recommended every ${syncInterval} seconds, minimum 10 seconds
- Task endpoints: no hard limit, but batch updates via sync when possible
- Message delivery: max 100 messages per sync call

## Best Practices

1. **Always sync** even when idle — this is your heartbeat
2. **Batch operations** — use the sync endpoint to send multiple updates at once
3. **Report failures promptly** — don't let tasks hang in "in_progress" forever
4. **Keep result summaries concise** — include key outcomes, not raw output
5. **Use sub-tasks** for complex work — gives the team visibility into your work breakdown
6. **Read teamContext** — know your colleagues and communicate with them when coordinating
7. **Check requirements** — understand *why* a task exists before starting work
8. **Search deliverables before work** — check the deliverables for relevant conventions and decisions
9. **Contribute deliverables after tasks** — share gotchas, patterns, and decisions with the team
`;
}
