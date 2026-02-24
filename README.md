# Markus

**AI Native Digital Employee Platform** — Build and manage autonomous digital employees that truly work, not just chat.

Markus enables organizations to hire, onboard, and manage AI-powered digital employees. Each agent has its own compute environment, role definition, proactive behaviors, and integrates natively with communication platforms like Feishu, WhatsApp, and Slack.

## Why Markus?

Existing AI assistants are **personal tools** — one person, one chatbot. Markus is an **organizational platform** — one organization, N digital employees working together.

| | Personal AI Assistants | Markus |
|---|---|---|
| **Scope** | Individual productivity | Organization-wide |
| **Behavior** | Reactive (you ask, it answers) | Proactive (heartbeat-driven) |
| **Environment** | Shared host machine | Isolated Docker/VM per agent |
| **Management** | Edit config files | Hire/onboard/review lifecycle |
| **Tasks** | CLI/API only | CLI + API + GUI automation |
| **Collaboration** | Single agent | Multi-agent teams |

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for agent sandboxes)
- An LLM API key (Anthropic or OpenAI)

### Install & Run

```bash
git clone https://github.com/your-org/markus.git
cd markus
pnpm install
pnpm build

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the server
node packages/cli/dist/index.js start
```

The API server starts on `http://localhost:3001`. Open `packages/web-ui/index.html` in a browser for the management dashboard.

### Create Your First Agent

```bash
# List available roles
node packages/cli/dist/index.js role:list

# Create a developer agent
node packages/cli/dist/index.js agent:create --name Alice --role developer

# Chat with the agent
node packages/cli/dist/index.js agent:chat
```

### Docker Compose Deployment

```bash
cd deploy
cp ../.env.example .env
# Edit .env with your API keys

docker compose up -d
```

## Architecture

```
markus/
├── packages/
│   ├── shared/          # Shared types, utilities, config
│   ├── core/            # Agent runtime, LLM routing, memory, MCP tools
│   ├── compute/         # Docker/VM sandbox management
│   ├── comms/           # Communication adapters (Feishu, WebUI, etc.)
│   ├── org-manager/     # Organization management + REST API
│   ├── web-ui/          # Web management dashboard
│   └── cli/             # Command-line interface
├── templates/
│   └── roles/           # Built-in role templates
│       ├── developer/
│       ├── product-manager/
│       └── operations/
└── deploy/              # Docker Compose + Kubernetes configs
```

### Core Concepts

**Agents** are digital employees, each with:
- `ROLE.md` — Role definition and system prompt
- `SKILLS.md` — Capabilities and tool access
- `HEARTBEAT.md` — Proactive tasks (checked periodically)
- `POLICIES.md` — Behavioral rules and boundaries

**Organizations** manage agents like a company manages employees — creating teams, assigning roles, and tracking task progress.

**Compute Environments** give each agent an isolated Docker container or VM where they can execute commands, read/write files, and perform work without affecting other agents or the host.

**Communication Hub** connects agents to messaging platforms. Agents can receive messages, respond, and proactively reach out to push work forward.

### System Flow

```
User Message (Feishu/WebUI/API)
        ↓
  Message Router  →  Route to Agent
        ↓
  Agent Runtime   →  Build context (ROLE + Memory + Policies)
        ↓
    LLM Router    →  Send to Claude/GPT/Gemini
        ↓
  Tool Execution  →  Shell, Files, Web, MCP tools
        ↓
    Response       →  Send back via same channel
```

## Configuration

Create a `markus.json` in your project root:

```json
{
  "org": {
    "name": "My Company"
  },
  "llm": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-20250514",
    "providers": {
      "anthropic": { "apiKey": "sk-ant-..." },
      "openai": { "apiKey": "sk-..." }
    }
  },
  "compute": {
    "defaultType": "docker",
    "docker": {
      "defaultImage": "node:20-slim"
    }
  },
  "server": {
    "apiPort": 3001,
    "webPort": 3000
  }
}
```

## API Reference

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Create (hire) a new agent |
| POST | `/api/agents/:id/start` | Start an agent |
| POST | `/api/agents/:id/stop` | Stop an agent |
| POST | `/api/agents/:id/message` | Send a message to an agent |
| DELETE | `/api/agents/:id` | Remove (fire) an agent |

### Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List tasks (filter by status, orgId) |
| POST | `/api/tasks` | Create a new task |
| GET | `/api/taskboard` | Get kanban board view |

### Roles

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | List available role templates |
| GET | `/api/roles/:name` | Get role template details |

## Creating Custom Roles

Create a directory under `templates/roles/` with the following files:

```
templates/roles/my-role/
├── ROLE.md         # Required: Role definition and system prompt
├── SKILLS.md       # Optional: List of skills/tools
├── HEARTBEAT.md    # Optional: Proactive task definitions
└── POLICIES.md     # Optional: Behavioral rules
```

## Deployment Options

### Self-hosted (VPS / Local)

Single-machine deployment with Docker Compose. Minimum 4 CPU / 8GB RAM.

```bash
cd deploy && docker compose up -d
```

### Enterprise (Kubernetes)

Production deployment with Kubernetes manifests in `deploy/k8s/`.

```bash
kubectl apply -f deploy/k8s/
```

### Managed (Coming Soon)

Markus Cloud — fully managed service with bundled AI tool subscriptions.

## MCP Integration

Markus agents support the Model Context Protocol (MCP) for connecting to external tools. Configure MCP servers in your agent's setup or via the API.

Built-in tools:
- `shell_execute` — Run shell commands
- `file_read` / `file_write` — File operations
- `web_fetch` — HTTP requests

## Roadmap

- [ ] GUI automation via VNC + OmniParser
- [ ] A2A protocol for inter-agent communication
- [ ] External agent marketplace
- [ ] WhatsApp / Slack / Telegram adapters
- [ ] PostgreSQL persistent storage
- [ ] Agent performance metrics and reviews
- [ ] Managed cloud offering

## License

Apache 2.0
