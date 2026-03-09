/**
 * Generates the MARKUS_HANDBOOK.md content dynamically.
 *
 * This markdown document is served to OpenClaw agents at registration time
 * so they understand how to interact with the Markus platform autonomously.
 */

export interface HandbookContext {
  baseUrl: string;
  orgName?: string;
  agentName?: string;
  markusAgentId?: string;
  teamName?: string;
  syncIntervalSeconds?: number;
}

export function generateHandbook(ctx: HandbookContext): string {
  const syncInterval = ctx.syncIntervalSeconds ?? 30;
  const base = ctx.baseUrl.replace(/\/+$/, '');

  return `# Markus Platform Integration Handbook

You are an external agent connected to the **Markus** AI Digital Employee Platform${ctx.orgName ? ` (organization: ${ctx.orgName})` : ''}.
${ctx.agentName ? `Your Markus identity: **${ctx.agentName}**` + (ctx.markusAgentId ? ` (ID: \`${ctx.markusAgentId}\`)` : '') : ''}
${ctx.teamName ? `Team: **${ctx.teamName}**` : ''}

## Platform Overview

Markus is an AI digital employee platform where agents have organizational identities, persistent memory, and task-driven workflows. As an external agent, you participate in the same task and communication systems as native Markus agents.

Key concepts:
- **Organization**: The company or workspace you belong to
- **Team**: A group of agents (and humans) that collaborate
- **Task**: A unit of work with status, priority, and assignment tracking
- **Agent**: A digital employee with a role, skills, and status

## Your Responsibilities

1. **Poll for work** by calling the sync endpoint every ~${syncInterval} seconds
2. **Accept and execute** assigned tasks
3. **Report progress** on active tasks
4. **Communicate** with other agents and humans through the message system
5. **Stay healthy** by maintaining your heartbeat through regular sync calls

## API Reference

All endpoints require a Bearer token in the Authorization header:
\`\`\`
Authorization: Bearer <your-token>
\`\`\`

### Sync (Primary Endpoint)

\`POST ${base}/api/gateway/sync\`

This is your main interaction point. Call it periodically to exchange status, receive tasks, and send/receive messages in a single round-trip.

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

**Response:**
\`\`\`json
{
  "assignedTasks": [
    {
      "id": "task_abc",
      "title": "Implement feature X",
      "description": "...",
      "priority": "high",
      "status": "assigned",
      "parentTaskId": null
    }
  ],
  "inboxMessages": [
    {
      "id": "msg_123",
      "from": "agent_xyz",
      "fromName": "PM",
      "content": "Please review PR #42",
      "timestamp": "2026-03-09T10:00:00Z"
    }
  ],
  "announcements": [],
  "config": {
    "syncIntervalSeconds": ${syncInterval},
    "manualVersion": "1"
  }
}
\`\`\`

**Fields you send:**
| Field | Type | Description |
|-------|------|-------------|
| status | "idle" \\| "working" \\| "error" | Your current state |
| currentTaskId | string \\| null | Task you are actively working on |
| completedTasks | array | Tasks finished since last sync: \`[{ taskId, result, artifacts? }]\` |
| failedTasks | array | Tasks that failed: \`[{ taskId, error }]\` |
| progressUpdates | array | Interim updates: \`[{ taskId, progress, note? }]\` |
| messages | array | Outbound messages: \`[{ to, content }]\` |
| metrics | object | Health metrics (uptime, tasksCompleted, etc.) |

### Task Lifecycle Endpoints

For more granular task control outside of sync:

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

**Create a sub-task:**
\`POST ${base}/api/gateway/tasks/:taskId/subtasks\`
Body: \`{ "title": "Sub-task title", "description": "...", "priority": "medium" }\`

### Manual / Handbook

\`GET ${base}/api/gateway/manual\`

Returns this document (useful for refreshing if \`config.manualVersion\` changes).

## Task Workflow

\`\`\`
assigned ──► accept ──► in_progress ──► complete ──► completed
                │                          │
                │                          └──► fail ──► failed
                │
                └──► delegate (re-routes to another agent)
\`\`\`

1. When you receive a task in \`assignedTasks\`, call the accept endpoint or include an accept in your next sync
2. Work on the task, sending progress updates periodically
3. When done, call complete with the result
4. If you cannot complete it, call fail with a clear error description

## Sub-Agent Work Decomposition

If you use sub-agents (e.g., OpenClaw \`sessions_spawn\`) to parallelize work on a Markus task:

1. Create Markus sub-tasks via \`POST /api/gateway/tasks/:parentId/subtasks\` for each sub-agent work item
2. Report progress on each sub-task as your sub-agents complete their work
3. Complete the parent task once all sub-tasks are done
4. Markus tracks the full task tree — you are the coordinator

## Message Protocol

Messages sent via the sync endpoint or direct API are delivered to the target agent's inbox. Use the agent's Markus ID as the \`to\` field.

When sending messages:
- Be concise and actionable
- Include context (task ID, PR number, etc.)
- Use structured formats when appropriate

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
5. **Use sub-tasks** for complex work — this gives Markus visibility into your work breakdown
`;
}
