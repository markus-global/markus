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

Initial credentials (before onboarding):
- Email: `admin@markus.local`
- Password: `markus123`

**On first login, the onboarding wizard will guide you to set your real name, email, and a new password.** You should complete the profile setup step to replace these default credentials.

After onboarding, you can add more human members or hire AI agents from the Team page.

---

## Multi-User Collaboration

Markus supports small team collaboration with multiple human users and AI agents.

### Inviting Users

1. Go to **Settings > User Management**
2. Click **Create User** — provide name, email, and role (`admin`, `member`, or `guest`)
3. The system generates an **invite link** (valid for 7 days)
4. Share the link with the new user — they set their own password via the link
5. Once joined, the invite button disappears and the user shows as active

### Roles & Permissions

| Role | Manage Users | Manage Agents | Manage Teams | View All Data |
|------|-------------|--------------|-------------|--------------|
| `owner` | Yes | Yes | Yes | Yes |
| `admin` | Yes | Yes | Yes | Yes |
| `member` | No | No | No | Yes |
| `guest` | No | No | No | Limited |

### Communication Channels

| Channel | How to Access | Description |
|---------|--------------|-------------|
| **Agent Chat** | Team page > click agent | One-on-one conversation with an AI agent (session isolated per user) |
| **DM** | Team page > People > click user | Private messages between two humans |
| **Team Group** | Team page > select team channel | Group chat for all team members (auto-created per team) |
| **Custom Group** | Team page > Create Group Chat | Manually managed group with selected humans and agents |
| **@Mention** | Task/Requirement comments | Mention humans or agents in comment threads — triggers bell notification |

### Notification Bell

The notification bell (top-right) shows:
- **Agent reports**: Proactive messages from agents (`notify_user`)
- **DM notifications**: New direct messages from other humans
- **Group messages**: New messages in group chats you belong to
- **@Mentions**: When someone mentions you in task/requirement comments
- **Approval requests**: Pending items requiring your decision
- **Task updates**: Status changes on tasks you're involved with

Click any notification to navigate directly to the relevant page.

### Chat Session Isolation

Each human user has their own private chat sessions with agents:
- Your conversations with an agent are not visible to other users
- Agent "Activity Logs" (main sessions) are shared — visible to all users
- Group chats and channel messages are visible to all channel members

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

The Team page serves dual purposes: team management and communication hub.

**Sidebar (left):**
- **Smart Route** — System routes messages to the most suitable Agent
- **People** — Human users list (DM and notes)
- **Agents** — All AI agents with online status indicators
- **Group Chats** — Team channels and custom group chats (create, manage members)

**Team Management:**
- Displays all teams and their members (humans and AI Agents) as cards
- Members without a team appear in the "Ungrouped" area
- Owners and Admins can:
  - Create or delete teams
  - Hire new AI Agents in a team (specify role and position: Worker or Manager)
  - Set a Manager for a team (via the member `...` menu)
  - Remove a member from a team or from the org entirely

**Group Chat Management:**
- Each team automatically gets a group channel
- Create custom group chats with any combination of humans and agents
- Add or remove members from custom group chats (via the member management panel)
- Creator is automatically added as a member

---

## REST API Reference

For the full REST API reference (all endpoints, request/response formats, and WebSocket events), see **[API.md](./API.md)**.

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

**Q: Does the paused state persist after restarting Markus?**
A: Yes. Individual agent, team-level, and global pause states are all persisted in the database. When Markus restarts, paused agents remain paused and the UI correctly reflects the paused state. You can also pause/resume individual agents or teams from the Team page.

**Q: Do tasks created by Agents need approval?**
A: This depends on the governance policy. By default, standard tasks need Manager approval and high-priority tasks need human approval. Configure this on the Governance page.

**Q: What happens when I (a human) create a task?**
A: Human-created tasks start in `pending` status. You will not receive a self-notification or approval request. Click "Start Execution" in the task detail page to begin execution. This differs from agent-created tasks, which show an "Approve" button and go through the HITL approval flow.

**Q: How do Agents share knowledge?**  
A: Agents contribute via the `knowledge_contribute` tool to the project knowledge base; other Agents search with `knowledge_search`. Humans can view and manage entries on the Knowledge page.

**Q: How do I assign Agents to different projects?**  
A: Create projects on the Projects page and link them to Teams. When Agents are assigned to tasks within a project, they automatically get project context and isolated workspaces.

**Q: Can other users see my conversations with an Agent?**  
A: No. Each user's chat sessions with agents are private, scoped by your user ID. Only the agent's "Activity Log" (main session) is shared across all users.

**Q: How do I add someone to a group chat?**  
A: Open the group chat, click the member management icon, and add or remove humans and agents. Team group chats include all team members automatically; custom group chats allow manual member management.

**Q: How do Agents know who they're talking to?**  
A: The system injects the current user's identity into the agent's context. Agents also have access to per-user profile files (`USER.md`) maintained by the Secretary, allowing personalized interactions.
