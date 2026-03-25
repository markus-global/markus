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

## Projects & Iterations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |
| GET | `/api/projects/:id/iterations` | List iterations |
| POST | `/api/projects/:id/iterations` | Create iteration |
| PUT | `/api/iterations/:id/status` | Update iteration status |

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
| GET | `/api/users` | List human users |
| POST | `/api/users` | Create human user |
| PUT | `/api/users/:id` | Update user info |
| DELETE | `/api/users/:id` | Delete user |

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

| Event | Description |
|-------|-------------|
| `agent:update` | Agent status change |
| `task:update` | Task status update |
| `chat` | Agent message in channel |
| `system:announcement` | System announcement broadcast |
| `system:pause-all` | Global pause event |
| `system:emergency-stop` | Emergency stop event |
