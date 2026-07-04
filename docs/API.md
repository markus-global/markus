# Markus API Reference

Base URL: `http://localhost:8056`

All requests require authentication via one of:
- **JWT Cookie**: `markus_token` (set automatically on login)
- **Header**: `Authorization: Bearer <token>`

---

## Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login, returns JWT Cookie |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user info |
| POST | `/api/auth/change-password` | Change password |

---

## Agent Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Hire a new agent `{ name, role, description }` |
| GET | `/api/agents/:id` | Get agent details |
| DELETE | `/api/agents/:id` | Fire agent |
| POST | `/api/agents/:id/start` | Start agent |
| POST | `/api/agents/:id/stop` | Stop agent |
| GET | `/api/agents/:id/profile` | Get agent full profile (memory, tools, etc.) |
| GET | `/api/agents/:id/mind` | Get agent mind state (attention, focus, mailbox, notebook) |
| POST | `/api/agents/:id/command` | Dispatch slash command to agent |

### POST `/api/agents/:id/command`

Dispatch slash commands to an agent.

**Body:**

```json
{
  "command": "goal",
  "args": "Improve test coverage to 80%",
  "senderId": "user-123",
  "senderName": "Alice"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Command name (without leading `/`) |
| `args` | string | No | Command arguments |
| `senderId` | string | No | Sender user ID (default: `system`) |
| `senderName` | string | No | Sender display name (default: `User`) |

**Supported commands:**

| Command | Behavior |
|---------|----------|
| `goal` | Creates a goal from `args` (prompts agent to use `goal_create`) |
| `status` | Returns agent status summary via chat |
| `notebook` | Returns notebook snapshot directly (no agent round-trip) |
| `task` | Creates a task from `args` (prompts agent to use `task_create`) |

**Response** (most commands):

```json
{ "status": "dispatched", "command": "goal" }
```

**Response** (`notebook`):

```json
{
  "status": "ok",
  "notebook": [
    { "key": "current-focus", "text": "...", "updatedAt": 1710000000000, "managed": "agent" }
  ]
}
```

### Agent MindState

Returned by `GET /api/agents/:id/mind`. Includes attention state, mailbox depth, queued/deferred items, recent decisions, and:

| Field | Type | Description |
|-------|------|-------------|
| `notebook` | `NotebookEntry[]` | Persistent cognitive workspace entries |

```typescript
interface NotebookEntry {
  key: string;
  text: string;
  updatedAt: number;
  managed: string;  // "agent" | "system" | "cpp"
}
```

---

## Messages & Conversations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agents/:id/message` | Send message to agent (SSE streaming) |
| GET | `/api/sessions` | List conversation sessions |
| GET | `/api/sessions/:id/messages` | Get session message history |
| GET | `/api/channels/:channel/messages` | Get channel history |
| POST | `/api/channels/:channel/messages` | Send channel message (supports SSE streaming) |

---

## Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (supports `?status=`, `?assignedAgentId=` filters) |
| POST | `/api/tasks` | Create task |
| GET | `/api/taskboard` | Get Kanban board data |
| PATCH | `/api/tasks/:id` | Update task (status, notes, etc.) |
| POST | `/api/tasks/:id/approve` | Approve a pending task |
| POST | `/api/tasks/:id/reject` | Reject a pending task |
| POST | `/api/tasks/:id/cancel` | Cancel a task (body: `{ cascade?: boolean }`) |
| POST | `/api/tasks/:id/schedule/pause` | Pause a scheduled task's recurring schedule |
| POST | `/api/tasks/:id/schedule/resume` | Resume a paused scheduled task |
| POST | `/api/tasks/:id/schedule/run-now` | Trigger an immediate run of a scheduled task |
| PUT | `/api/tasks/:id/schedule` | Update schedule configuration `{ every?, cron?, maxRuns?, timezone? }` |
| GET | `/api/tasks/:id/dependent-count` | Count tasks blocked by this task |
| POST | `/api/tasks/:id/comments` | Post a comment on a task. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |
| POST | `/api/requirements/:id/comments` | Post a comment on a requirement. Body: `{ content, mentions?, authorId?, authorType?, replyTo? }`. `replyTo` is a comment ID for structural reply linking. |

---

## Teams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams` | List teams |
| POST | `/api/teams` | Create team |
| GET | `/api/teams/:id` | Get team details |
| PUT | `/api/teams/:id` | Update team |
| DELETE | `/api/teams/:id` | Delete team |

---

## Governance & System Control

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system/status` | Global status (paused/emergency mode) |
| POST | `/api/system/pause-all` | Pause all agents |
| POST | `/api/system/resume-all` | Resume all agents |
| POST | `/api/system/emergency-stop` | Emergency stop |
| GET | `/api/system/announcements` | Get system announcements |
| POST | `/api/system/announcements` | Create system announcement |
| GET | `/api/governance/policy` | View governance policy |
| PUT | `/api/governance/policy` | Update governance policy |

---

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |

---

## Delivery & Review

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tasks/:id/accept` | Accept task delivery |
| POST | `/api/tasks/:id/revision` | Request revision |
| POST | `/api/tasks/:id/archive` | Archive task |

---

## Reports & Knowledge

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports` | List reports |
| POST | `/api/reports/generate` | Trigger report generation |
| GET | `/api/reports/:id` | Report details |
| POST | `/api/reports/:id/plan/approve` | Approve plan |
| POST | `/api/reports/:id/plan/reject` | Reject plan |
| GET | `/api/reports/:id/feedback` | Get report feedback |
| POST | `/api/reports/:id/feedback` | Create report feedback |
| POST | `/api/knowledge` | Contribute knowledge |
| GET | `/api/knowledge/search` | Search knowledge base |

---

## Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List human users (includes `hasJoined` flag) |
| POST | `/api/users` | Create human user `{ name, email, role }` — returns invite token |
| PATCH | `/api/users/:id` | Update user (name, role, email) |
| POST | `/api/users/:id/reset-password` | Admin password reset |
| DELETE | `/api/users/:id` | Delete user |

### Invite Flow

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/invite/:token` | Validate invite token — returns user info (name, email) |
| POST | `/api/auth/invite/:token/setup` | Complete registration `{ password, name?, email? }` |

---

## Group Chats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/group-chats` | List group chats for current user |
| POST | `/api/group-chats` | Create custom group chat `{ name, memberIds: [{id, type}] }` |
| GET | `/api/group-chats/:id` | Get group chat details (includes members) |
| PATCH | `/api/group-chats/:id` | Update group chat (name, add/remove members) |
| DELETE | `/api/group-chats/:id` | Delete group chat |
| POST | `/api/group-chats/:id/members` | Add member `{ userId, userType, userName }` |
| DELETE | `/api/group-chats/:id/members/:userId` | Remove member |

---

## Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications` | List notifications for current user (supports `?unreadOnly=true&limit=N&offset=N&type=T`) |
| GET | `/api/notifications/count` | Get unread notification count |
| POST | `/api/notifications/:id/read` | Mark a single notification as read |
| POST | `/api/notifications/read-all` | Mark all notifications as read |

---

## Roles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/roles` | List available role templates |
| GET | `/api/roles/:name` | Get role template details |

---

## Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings/agent` | Get agent runtime settings |
| POST | `/api/settings/agent` | Update agent runtime settings |

### POST `/api/settings/agent`

Persists agent settings to `markus.json`, including full cognitive config.

**Body:**

```json
{
  "maxToolIterations": 25,
  "cognitive": {
    "enabled": true,
    "maxDepth": 3,
    "appraisalModel": "gpt-4o-mini",
    "timeoutMs": 30000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `maxToolIterations` | number | Max tool-call loops per agent turn |
| `cognitive.enabled` | boolean | Enable cognitive appraisal loop |
| `cognitive.maxDepth` | number | Max deliberation depth |
| `cognitive.appraisalModel` | string | LLM model for appraisal steps |
| `cognitive.timeoutMs` | number | Appraisal timeout in milliseconds |

---

## Requirements & Goals

Requirements may include an optional `goalConfig` when acting as a persistent goal:

```typescript
interface GoalConfig {
  loopEnabled: boolean;
  completionCriteria: string;
  maxIterations: number;
  currentIteration: number;
  lastCheckedAt: string;
  autoResume: boolean;
}
```

| Field | Description |
|-------|-------------|
| `loopEnabled` | Heartbeat injects this requirement as an active goal |
| `completionCriteria` | Natural-language criteria for goal completion |
| `maxIterations` | Maximum heartbeat check iterations |
| `currentIteration` | Current iteration count |
| `lastCheckedAt` | ISO timestamp of last heartbeat check |
| `autoResume` | Resume goal loop after agent restart |

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (returns `{ status, version, agents }`) |

---

## WebSocket

**Connection**: `ws://localhost:8056`

| Event | Direction | Description |
|-------|-----------|-------------|
| `agent:update` | Server → Client | Agent status change |
| `agent:mailbox` | Server → Client | New item in agent mailbox |
| `agent:decision` | Server → Client | Agent attention decision |
| `agent:focus` | Server → Client | Agent switches focus |
| `task:update` | Server → Client | Task status update |
| `task:create` | Server → Client | New task created |
| `requirement:created` | Server → Client | New requirement proposed |
| `chat` | Server → Client | Agent message in channel |
| `task:comment` | Server → Client | New task comment (includes `replyTo`, `replyToAuthor`, `replyToContent` for reply-linked comments) |
| `requirement:comment` | Server → Client | New requirement comment (includes `replyTo`, `replyToAuthor`, `replyToContent`) |
| `chat:message` | Server → Client | Channel/DM/group message (targeted to members; includes `replyToId`, `replyToSender`, `replyToText` for reply-linked messages) |
| `chat:proactive_message` | Server → Client | Agent activity log or proactive message |
| `chat:group_created` | Server → Client | Group chat created |
| `chat:group_updated` | Server → Client | Group chat membership changed |
| `chat:group_deleted` | Server → Client | Group chat deleted |
| `notification` | Server → Client (targeted) | User notification (targeted by userId) |
| `system:announcement` | Server → Client | System announcement broadcast |
| `system:pause-all` | Server → Client | Global pause event |
| `system:resume-all` | Server → Client | Global resume event |
| `system:emergency-stop` | Server → Client | Emergency stop event |
