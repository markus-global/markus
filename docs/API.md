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
| `chat:message` | Server → Client | Channel/DM/group message (targeted to members) |
| `chat:proactive_message` | Server → Client | Agent activity log or proactive message |
| `chat:group_created` | Server → Client | Group chat created |
| `chat:group_updated` | Server → Client | Group chat membership changed |
| `chat:group_deleted` | Server → Client | Group chat deleted |
| `notification` | Server → Client (targeted) | User notification (targeted by userId) |
| `system:announcement` | Server → Client | System announcement broadcast |
| `system:pause-all` | Server → Client | Global pause event |
| `system:resume-all` | Server → Client | Global resume event |
| `system:emergency-stop` | Server → Client | Emergency stop event |
