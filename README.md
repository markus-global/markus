<p align="center">
  <img src="logo.png" width="160" alt="Markus Logo" />
</p>

<h1 align="center">Markus</h1>

<p align="center">
  <strong>Build AI teams that actually deliver.</strong>
</p>

<p align="center">
  Open-source AI workforce platform — role-based agents that plan, execute, review each other's work,<br />
  and deliver finished results. Runs around the clock on your machine or a small cloud server.
</p>

<p align="center">
  <a href="https://github.com/markus-global/markus/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/markus-global/markus/ci.yml?branch=main&label=CI" alt="CI Status" />
  </a>
  <a href="https://github.com/markus-global/markus/releases">
    <img src="https://img.shields.io/github/v/release/markus-global/markus?include_prereleases&label=Version" alt="Version" />
  </a>
  <a href="https://github.com/markus-global/markus/stargazers">
    <img src="https://img.shields.io/github/stars/markus-global/markus?style=flat" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/markus-global/markus/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" />
  </a>
  <a href="https://github.com/markus-global/markus/issues">
    <img src="https://img.shields.io/github/issues/markus-global/markus" alt="Issues" />
  </a>
</p>

<p align="center">
  <a href="https://www.markus.global"><strong>Website</strong></a> ·
  <a href="https://markus.global/blog">Blog</a> ·
  <a href="docs/GUIDE.md">Documentation</a> ·
  <a href="https://github.com/markus-global/markus/discussions">Discussions</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="docs/images/markus-og.jpg" alt="Markus dashboard — manage your AI workforce from desktop or mobile" width="820" />
</p>

---

## What is Markus?

**Markus is an open-source platform that runs complete AI teams** — not a wrapper around someone else's agents, and not just another framework.

Describe what you want done in plain language. Markus assembles the right roles (developer, reviewer, researcher, writer, analyst, ops), breaks the work into tasks, delegates to specialists, runs them in parallel, applies quality review, and ships the finished result.

It's the **organizational layer** that single-agent copilots are missing:

- **Full agent runtime built in** — every agent talks directly to LLM APIs and uses built-in tools: shell, file I/O, git, web search, code analysis, GUI & browser automation, and any MCP server. No proxying through external CLI tools.
- **Zero config to start** — SQLite storage, bundled web UI, one command. Nothing extra to install, nothing to configure.
- **Manage from anywhere** — a responsive dashboard for desktop and mobile, plus an Electron desktop app for macOS, Windows, and Linux. Deploy on any cloud server and run your AI company from your phone.

---

## 🚀 Quick Start

Pick whichever path is easiest.

**Desktop app** (macOS / Windows / Linux) — download from [Releases](https://github.com/markus-global/markus/releases/latest).

**npm** (requires Node.js 22+):

```bash
npm install -g @markus-global/cli
markus start
```

**Linux one-liner** (works without Node.js):

```bash
curl -fsSL https://markus.global/install.sh | bash
```

**From source**:

```bash
git clone https://github.com/markus-global/markus.git && cd markus
pnpm install && pnpm build && pnpm dev
```

Open **http://localhost:8056** — the onboarding wizard walks you through name, email, and password (initial login: `admin@markus.local` / `markus123`).

That's it. SQLite database, bundled web UI, zero external dependencies.

---

## 🎬 See It in Action

![Markus dashboard live preview](docs/images/dashboard-preview.gif)

Real-time task board, agent chat, deliverable review, and team status — on desktop and mobile.

---

## 💼 What You Can Run on Markus

| Area | Example |
|------|---------|
| **Research & analysis** | Scan competitor products, compile a competitive analysis, and draft a go-to-market strategy |
| **Software engineering** | Build a feature end-to-end — requirements, code, tests — with built-in peer review |
| **Content & publishing** | Draft, edit, review, and schedule articles, reports, and social posts |
| **Operations** | Daily briefings, issue triage, scheduled monitoring, blocker escalation |
| **Data & reporting** | Pull data, analyze it, and deliver finished reports on a schedule |
| **Personal research** | Deep-dive any topic and get a structured, cited deliverable back |

The same team keeps working after you close the laptop — heartbeats keep agents moving while you sleep.

---

## ✨ Key Features

| | |
|---|---|
| **🤖 Autonomous Agent Runtime** &nbsp;&nbsp;&nbsp; | Each agent is a full LLM-powered worker with built-in tools — shell, file I/O, git, web search, code analysis, GUI & browser automation, and any MCP server. Works with **any LLM provider**: Anthropic, OpenAI, Google, DeepSeek, MiniMax, Ollama, OpenRouter, SiliconFlow, Moonshot — with automatic failover. |
| **🧠 Persistent Memory** | Three-layer memory (procedural, semantic, episodic) that accumulates knowledge across sessions and consolidates it automatically — agents get smarter the longer you run them. |
| **⏰ Proactive Heartbeat** | Agents don't wait for instructions. The heartbeat scheduler patrols open tasks, processes completions, and surfaces blockers — your team works while you sleep. |
| **🤝 Team Collaboration & A2A** | Role-based organization: managers, workers, subagents, and structured agent-to-agent messaging. Humans join via DMs, group chats, and @mentions. |
| **✅ Governance & Trust** | Progressive trust levels (probation → standard → trusted → senior), formal submit–review–merge delivery, emergency pause, and a full audit trail for every action. |
| **💬 Multi-Channel Messaging** | Native bridges to Slack, Feishu, WhatsApp, and Telegram — agents meet your team where they already talk. |
| **🛠 Skills Marketplace** | Browse and install agent templates, team configurations, and reusable skills from Markus Hub. Share what works with the community. |
| **📱 Desktop + Mobile** | Electron desktop app for macOS / Windows / Linux, plus a responsive web dashboard. Review deliverables on the train, approve tasks from the couch. |
| **🔒 Self-Hosted, Data Yours** | Runs entirely on your infrastructure with SQLite by default (PostgreSQL supported). Remote access via Cloudflare Tunnel, Tailscale, FRP, or ngrok. |

---

## How It Works

### 1. Describe what you need
Tell the built-in Secretary agent your goal in plain language. It assembles the right team, breaks down requirements into tasks, and sets up the project.

> *"I need a research team to scan competitor products, write a competitive analysis, and draft a go-to-market strategy."*

### 2. Agents execute in parallel

Agents delegate, spawn subagents, review each other's work, and escalate only when they should. Each agent works in an isolated workspace with its own context. Developers write code, researchers compile findings, writers produce drafts — all at the same time.

### 3. Review and deliver

You review the final deliverables, not the process. Every output passes through quality gates, and the full audit trail shows exactly what each agent did, when, and why.

---

## Single Agent vs. Markus Team

A single agent — Claude Code, Codex, ChatGPT, or any copilot — is great at executing one task at a time. But one employee doesn't make a company.

| | Single AI agent | Markus AI team |
|---|---|---|
| **Scale** | One task at a time | Parallel work across specialist roles |
| **Memory** | Context evaporates when the session ends | Persistent, consolidating long-term memory |
| **Proactivity** | Waits for your prompt, every time | Works 24/7 via heartbeat, even while you sleep |
| **Quality** | "Done" is self-reported | Peers review, catch mistakes, and gate delivery |
| **Visibility** | 10 agents = 10 windows | One dashboard showing everyone's status |

You manage a workforce, not individual prompts.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Web UI (React) · Desktop (Electron)        │
│      Dashboard · Chat · Projects · Builder · Hub        │
└──────────────────────┬──────────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────┴──────────────────────────────────┐
│                  Org Manager (API Server)               │
│     Auth · Tasks · Governance · Projects · Reports      │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────┐
│                  Agent Runtime (Core)                   │
│  Agent · LLM Router · Tools · Memory · Heartbeat · A2A  │
└──────────┬────────────────────────────┬─────────────────┘
           │                            │
┌──────────┴──────────┐    ┌────────────┴─────────────────┐
│  Storage (SQLite /  │    │  Comms (Slack, Feishu,       │
│   PostgreSQL)       │    │   WhatsApp, Telegram)        │
└─────────────────────┘    └──────────────────────────────┘
```

TypeScript monorepo with modular packages:

| Package | Role |
|---------|------|
| **core** | Agent runtime — LLM routing, tools, memory, heartbeat, workspace isolation |
| **org-manager** | REST API, WebSocket, governance, task lifecycle |
| **web-ui** | React + Vite + Tailwind dashboard |
| **desktop** | Electron desktop app (macOS / Windows / Linux) |
| **cli** | `@markus-global/cli` — one-command install and launch |
| **storage** | SQLite persistence (zero external dependencies) |
| **gui** | GUI automation — VNC, screenshots, input control, visual analysis |
| **comms** | Slack / Feishu / WhatsApp / Telegram bridges |
| **a2a** | Agent-to-Agent communication protocol |
| **remote** | Remote access — tunnels and zero-config networking |
| **chrome-extension** | Browser automation via the Markus extension |
| **shared** | Shared types, constants, utilities |

---

## Documentation

| Guide | Description |
|-------|-------------|
| [User Guide](docs/GUIDE.md) | Setup, configuration, Web UI walkthrough |
| [Architecture](docs/ARCHITECTURE.md) | System design, agent runtime, memory, governance |
| [Agent Runtime](docs/AGENT-RUNTIME.md) | Agent lifecycle, execution model, workspace isolation |
| [Tool System](docs/TOOL-SYSTEM.md) | Built-in tools, MCP integration, tool contracts |
| [Memory System](docs/MEMORY-SYSTEM.md) | Three-layer memory architecture (Tulving) |
| [Cognitive Architecture](docs/COGNITIVE-ARCHITECTURE.md) | Cognitive Preparation Pipeline (CPP) design |
| [Mailbox System](docs/MAILBOX-SYSTEM.md) | Agent attention model, priority queue, triage |
| [Prompt Engineering](docs/PROMPT-ENGINEERING.md) | System prompt assembly, tool loop, compression |
| [State Machines](docs/STATE-MACHINES.md) | Task & requirement FSM specification |
| [API Reference](docs/API.md) | REST API endpoints and WebSocket events |
| [Coding Tools](docs/CODING-TOOLS.md) | Claude Code / Codex / Cursor integration |
| [Learning Loop](docs/LEARNING-LOOP.md) | Agent self-improvement and memory consolidation |
| [Remote Access](docs/REMOTE-ACCESS.md) | Cloudflare Tunnel, Tailscale, FRP, ngrok setup |
| [Release & Distribution](docs/RELEASE-AND-DISTRIBUTION.md) | Build, packaging, publishing pipeline |
| [Blog](https://markus.global/blog) | Articles and tutorials on Markus and AI agents |

---

## Contributing

```bash
pnpm install && pnpm build
pnpm dev          # API + Web UI in dev mode
pnpm test         # Run tests
pnpm typecheck    # TypeScript check
pnpm lint         # ESLint
```

Looking for a way to contribute?

- [Good first issues](https://github.com/markus-global/markus/labels/good%20first%20issue) — beginner-friendly tasks
- [Help wanted](https://github.com/markus-global/markus/labels/help%20wanted) — features the community needs
- [Bug reports](https://github.com/markus-global/markus/issues) — help us fix issues

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

---

## License

Markus is dual-licensed:

- **Open Source**: [Apache-2.0](LICENSE) — free to use, modify, distribute, and self-host for any purpose, including commercial use
- **Commercial**: [Available](LICENSE-COMMERCIAL.md) — for teams needing enterprise support, indemnification, OEM embedding, or custom terms

Agent templates and skills shared through the marketplace may use their own licenses (typically MIT).

---

<p align="center">
  <a href="https://www.markus.global">Website</a> ·
  <a href="https://markus.global/blog">Blog</a> ·
  <a href="https://github.com/markus-global/markus/discussions">Discussions</a> ·
  <a href="https://github.com/markus-global/markus/issues">Issues</a>
</p>

<p align="center">
  <sub>Markus — Where AI Agents Work as a Team</sub>
</p>