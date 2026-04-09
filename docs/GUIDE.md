# Markus User Guide

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
- [Docker Compose Deployment](#docker-compose-deployment)
- [Environment Variables](#environment-variables)
- [First Login](#first-login)
- [Web UI Usage](#web-ui-usage)
- [REST API Reference](#rest-api-reference)
- [Custom Role Templates](#custom-role-templates)
- [Remote Access](#remote-access)
- [FAQ](#faq)

---

## Prerequisites

| Dependency | Minimum Version | Purpose |
|------------|-----------------|---------|
| Node.js | 22.0.0+ | Runtime |
| pnpm | 9.0.0+ | Package manager |
| Docker | 24.0+ | Agent sandbox containers (optional) |

---

## Local Development Setup

### 1. Install Dependencies

```bash
git clone <repo-url> markus
cd markus
pnpm install
```

### 2. Build All Packages

```bash
pnpm build
```

You should see 11 workspace packages compile successfully.

### 3. Configure

```bash
cp markus.json.example ~/.markus/markus.json
# Edit ~/.markus/markus.json and add your LLM API key
```

### 4. Start the Backend Service

In a **first terminal**, run:

```bash
node packages/cli/dist/index.js start
```

When the backend API is ready, it will display `API server listening on port 8056`.

### 5. Start the Frontend Dev Server

In a **second terminal**, run:

```bash
pnpm --filter @markus/web-ui dev
```

Default ports:
- Web UI: `http://localhost:8057` (Vite dev server; proxies `/api` to the backend)
- API Server: `http://localhost:8056`

> **Note:** The frontend Vite dev server is a separate process and must be started independently. `node packages/cli/dist/index.js start` runs only the backend API, not the frontend.

---

## Docker Compose Deployment

```bash
cd deploy
docker compose up -d
```

This starts the Markus services automatically.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Recommended | OpenAI API key (primary LLM) |
| `ANTHROPIC_API_KEY` | Optional | Anthropic API key |
| `DEEPSEEK_API_KEY` | Optional | DeepSeek API key (fallback) |
| `DATABASE_URL` | Optional | SQLite path override (default: `~/.markus/data.db`, format: `sqlite:/path/to/db`) |
| `JWT_SECRET` | Recommended for production | JWT signing secret |
| `AUTH_ENABLED` | Optional | Enable login (default: true) |
| `API_PORT` | Optional | API port (default: 8056) |
| `WEB_PORT` | Optional | Web UI port (default: 8057) |
| `LLM_DEFAULT_PROVIDER` | Optional | Default LLM provider (openai/anthropic/deepseek) |
| `LLM_DEFAULT_MODEL` | Optional | Default model (e.g. gpt-4o-mini) |

---

## First Login

Default credentials:
- Email: `admin@markus.local`
- Password: `markus123`

**You will be required to change the password on first login.**

After changing the password, you can add more human members or hire AI agents from the Team page.

---

## Web UI Usage

### Chat Page

The left sidebar lets you choose a conversation target:
- **Smart Route** — System routes messages to the most suitable Agent
- **#Channels** — Send to a public channel; you can @mention specific Agents
- **Agent List** — Direct conversation with a specific Agent
- **People** — My Notes (personal scratchpad) or DM other human users

### Agents Page

- Click an Agent row to open the Profile panel on the right
- In the Profile you can view role, status, memory, and tools
- Start / Stop buttons switch based on state (only one is visible at a time)

### Tasks Page

- Kanban view with columns by status (pending, assigned, in_progress, review, revision, accepted, completed, archived, etc.)
- Click a task card for details, progress notes, and subtasks
- In the task detail you can run governance actions: Submit for Review, Accept, Request Revision, Archive
- Tasks can be created manually; Agents can also create them (subject to governance policy approval)

### Governance Page

- **System Status** — See whether the system is in pause or emergency-stop mode
- **Global Controls** — Pause all Agents, Resume, or Emergency Stop
- **Governance Policy** — Configure default approval levels, max concurrent tasks, approval rules
- **Announcements** — Create and view system-wide broadcast messages

### Projects Page

- Left panel lists all projects; right side shows the selected project details
- Create projects (name, description, repository URL)
- View project status, requirements, and linked Teams

### Knowledge Page

- Browse and search project knowledge bases
- Filter by scope (org, project, personal)
- View knowledge entry details (Markdown rendering)
- Create entries (title, content, category, tags, scope)

### Reports Page

- View generated reports (daily/weekly/monthly)
- Manually trigger report generation (choose type and range)
- View report details: metrics, task summary, cost summary
- Approve or reject work plans
- Add feedback on reports (comments, instructions, annotations)

### Team Page

- Displays all teams and their members (humans and AI Agents) as cards
- Members without a team appear in the "Ungrouped" area
- Owners and Admins can:
  - Create or delete teams
  - Hire new AI Agents in a team (specify role and position: Worker or Manager)
  - Add human members or assign existing members to teams
  - Set a Manager for a team (via the member `...` menu)
  - Remove a member from a team (member stays in the org) or remove from the org entirely
  - All delete/remove actions use a confirmation dialog

---

## REST API Reference

Requests must include a Cookie (set after login) or an `Authorization: Bearer <token>` header.

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login; returns JWT in Cookie |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/change-password` | Change password |

### Agent Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all Agents |
| POST | `/api/agents` | Hire a new Agent `{ name, role, description }` |
| GET | `/api/agents/:id` | Get Agent details |
| DELETE | `/api/agents/:id` | Dismiss Agent |
| POST | `/api/agents/:id/start` | Start Agent |
| POST | `/api/agents/:id/stop` | Stop Agent |
| GET | `/api/agents/:id/profile` | Get full Agent profile (memory, tools, etc.) |

### Messages and Conversations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agents/:id/message` | Send message to Agent (SSE stream) |
| GET | `/api/sessions` | List conversation sessions |
| GET | `/api/sessions/:id/messages` | Get session message history |
| GET | `/api/channels/:channel/messages` | Get channel history |
| POST | `/api/channels/:channel/messages` | Send channel message (SSE stream supported) |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (supports `?status=`, `?assignedAgentId=` filters) |
| POST | `/api/tasks` | Create task |
| GET | `/api/taskboard` | Get Kanban board data |
| PATCH | `/api/tasks/:id` | Update task (status, notes, etc.) |

### Governance and System Control

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system/status` | Global status (pause/emergency mode) |
| POST | `/api/system/pause-all` | Pause all Agents |
| POST | `/api/system/resume-all` | Resume all Agents |
| POST | `/api/system/emergency-stop` | Emergency stop |
| GET/POST | `/api/system/announcements` | Announcements CRUD |
| GET/PUT | `/api/governance/policy` | View or update governance policy |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/projects` | List or create projects |
| GET/PUT/DELETE | `/api/projects/:id` | Project detail, update, or delete |

### Delivery and Review

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tasks/:id/accept` | Accept task delivery |
| POST | `/api/tasks/:id/revision` | Request revision |
| POST | `/api/tasks/:id/archive` | Archive task |

### Reports and Knowledge

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports` | List reports |
| POST | `/api/reports/generate` | Trigger report generation |
| GET | `/api/reports/:id` | Report detail |
| POST | `/api/reports/:id/plan/approve` | Approve plan |
| POST | `/api/reports/:id/plan/reject` | Reject plan |
| GET/POST | `/api/reports/:id/feedback` | Report feedback CRUD |
| POST | `/api/knowledge` | Contribute knowledge |
| GET | `/api/knowledge/search` | Search knowledge base |

### User Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List human users |
| POST | `/api/users` | Create human user |
| DELETE | `/api/users/:id` | Delete user |
| PUT | `/api/users/:id` | Update user info |

### Role Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/roles` | List available role templates |
| GET | `/api/roles/:name` | Get role template details |

---

## Custom Role Templates

Built-in roles are in `templates/roles/`:
- `manager` — Organization lead; handles routing and coordination
- `developer` — Software development engineer
- `product-manager` — Product manager
- `operations` — Ops/DevOps

### Creating a Custom Role

Create a directory under `templates/roles/`:

```
templates/roles/my-role/
├── ROLE.md         # Required: role definition and system prompt
├── SKILLS.md       # Optional: skills and tool permissions
├── HEARTBEAT.md    # Optional: scheduled proactive tasks
└── POLICIES.md     # Optional: behavior rules
```

Example `ROLE.md`:

```markdown
# Legal Advisor

You are a legal assistant focused on corporate compliance and contract review for companies.

## Responsibilities
- Review contract terms and flag risk areas
- Answer compliance questions from employees
- Track important compliance deadlines

## Principles
- For uncertain legal issues, state clearly: "Consult a qualified lawyer"
- Do not provide final legal opinions on specific cases
```

After creating the role, you can hire Agents with that role via the API or the Web UI "Hire Agent" button.

---

## Remote Access

To access Markus from the internet (remote teams, external agents, mobile), see the dedicated **[Remote Access Guide](./REMOTE-ACCESS.md)** which covers Cloudflare Tunnel, Tailscale, FRP, ngrok, and security best practices.

---

## FAQ

**Q: Data is lost after restarting the service?**  
A: Data is stored in SQLite at `~/.markus/data.db` by default. If that directory is missing or unwritable, the system may fall back to in-memory mode.

**Q: Agent is not responding?**  
A: Check that the LLM API key is correctly configured and that the Agent is in `online` status (green dot).

**Q: Can I use the system without logging in?**  
A: Set `AUTH_ENABLED=false` in the environment variables to disable auth (suitable only for trusted internal networks).

**Q: How do I view an Agent's work logs?**  
A: Open the Agents page, click an Agent row, and use the Profile panel on the right. You can also @mention the Agent in the `#general` channel to have it report its current state.

**Q: How do I give an Agent scheduled tasks?**  
A: Create a `HEARTBEAT.md` file in the Agent's role directory describing what the Agent should do on a schedule. The heartbeat interval can be configured at startup.

**Q: How do I pause all Agents?**  
A: On the Governance page, click "Pause All Agents", or call `POST /api/system/pause-all`. Use "Emergency Stop" for critical situations.

**Q: Do tasks created by Agents need approval?**  
A: This depends on the governance policy. By default, standard tasks need Manager approval and high-priority tasks need human approval. Configure this on the Governance page.

**Q: How do Agents share knowledge?**  
A: Agents contribute via the `knowledge_contribute` tool to the project knowledge base; other Agents search with `knowledge_search`. Humans can view and manage entries on the Knowledge page.

**Q: How do I assign Agents to different projects?**  
A: Create projects on the Projects page and link them to Teams. When Agents are assigned to tasks within a project, they automatically get project context and isolated workspaces.
