<p align="center">
  <img src="logo.png" width="200" alt="Markus Logo" />
</p>

<h1 align="center">Markus</h1>

<p align="center"><strong>Build AI Teams That Actually Work</strong></p>

<p align="center">
  An open-source platform for building AI Agent teams with role assignment, task delegation, and visual tracking.
</p>

<p align="center">
  <a href="https://github.com/markus-global/markus/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/markus-global/markus/ci.yml?branch=main&label=CI" alt="CI Status">
  </a>
  <a href="https://github.com/markus-global/markus/releases">
    <img src="https://img.shields.io/github/v/release/markus-global/markus?include_prereleases&label=Version" alt="Version">
  </a>
  <a href="https://github.com/markus-global/markus/stargazers">
    <img src="https://img.shields.io/github/stars/markus-global/markus?style=flat" alt="Stars">
  </a>
  <a href="https://github.com/markus-global/markus/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="https://github.com/markus-global/markus/issues">
    <img src="https://img.shields.io/github/issues/markus-global/markus" alt="Issues">
  </a>
</p>

[English](README.md) | [中文](README.zh-CN.md)

---

## What is Markus?

> **Stop building isolated AI agents. Start building AI teams.**

Most AI agents work in isolation — they don't know what other agents are doing, can't delegate tasks, and you can't easily track what's happening.

Markus is an **open-source platform for building AI Agent teams that actually work together**. Unlike single-agent solutions, Markus is designed from the ground up for collaboration.

### The Difference

|  | Single AI Agent | Markus |
|---|---|---|
| **Scope** | Individual productivity | Organization-wide AI teams |
| **Collaboration** | Work in silos | Role assignment, task delegation, dependency management |
| **Visibility** | Black box, hard to track | Visual dashboard, real-time status |
| **Enterprise Features** | Build it yourself | Built-in: code review, permissions, sprint management |
| **Deployment** | Locked to one provider | Open source, any LLM, self-hostable |

---

## Key Features

### 🤝 Team Collaboration First
- **Role-based architecture**: Define clear roles (researcher, writer, reviewer) for each agent
- **Task delegation**: Agents assign subtasks to other agents based on capabilities
- **Dependency management**: Tasks wait for prerequisites to complete
- **Team-level state sync**: Agents share context and progress

### 🏢 Enterprise-Ready from Day One
- **Code & deliverable review**: Every change goes through formal review
- **Permission controls**: Define who can create, modify, or delete agents
- **Iteration management**: Sprint and Kanban boards for AI team progress
- **Full audit trail**: Know exactly what each agent did and when

### 👁️ Visual + Open Source
- **Hub interface**: Browse and manage all agents and teams
- **Task board**: Visual kanban for tracking team progress
- **100% open source**: AGPL-3.0 licensed, deploy on your infrastructure
- **No vendor lock-in**: Use any LLM provider

---

## Quick Start

### 5-Minute Setup

```bash
git clone https://github.com/markus-global/markus.git
cd markus

# Install dependencies
pnpm install && pnpm build

# Configure — copy example config to ~/.markus/markus.json
cp markus.json.example ~/.markus/markus.json
# Edit ~/.markus/markus.json and add your LLM API key

# Start everything
pnpm dev
```

**Open your browser:**
- Web UI: [http://localhost:3000](http://localhost:3000)
- API: [http://localhost:3001](http://localhost:3001)

**Default login:** `admin@markus.local` / `markus123`

### Docker Deployment

```bash
cd deploy
# Mount your ~/.markus/markus.json into the container (see docker-compose.yml)
docker compose up -d
```

---

## Architecture

Markus is a TypeScript monorepo with modular packages:

```
packages/
├── core/          Agent runtime engine — the heart of autonomous behavior
├── storage/       SQLite/PostgreSQL persistence layer
├── org-manager/   REST API + governance services
├── web-ui/        React + Vite + Tailwind management interface
├── cli/           CLI entry point for local development
├── a2a/           Agent-to-Agent communication protocol
├── comms/         External integrations (Feishu, Slack, WhatsApp)
├── gui/           GUI automation (VNC + OmniParser)
└── shared/        Shared types, constants, utilities
```

---

## Why Markus?

### vs AutoGen
- ✅ Simpler onboarding — no complex configuration
- ✅ Built for team collaboration, not just multi-agent chat
- ✅ Enterprise features included, not add-ons

### vs CrewAI
- ✅ Enterprise-grade features out of the box
- ✅ Visual management interface
- ✅ Requirement-driven task system

### vs Dify
- ✅ More flexible multi-agent orchestration
- ✅ Complete development lifecycle
- ✅ Fully open source — no paid enterprise tier

### vs LangGraph
- ✅ Zero learning curve with visual UI
- ✅ Team collaboration first
- ✅ Built-in task management

---

## Documentation

| Guide | Description |
|-------|-------------|
| [User Guide](docs/GUIDE.md) | Setup, configuration, Web UI usage |
| [Architecture](docs/ARCHITECTURE.md) | System design, package structure |
| [API Reference](docs/API.md) | REST API endpoints |
| [Contributing](CONTRIBUTING.md) | Development setup, PR process |

All docs available in [English](docs/ARCHITECTURE.md) and [Chinese](docs/ARCHITECTURE.zh-CN.md).

---

## Contributing

We welcome contributions! Here's how to get started:

### Development Setup

```bash
pnpm install && pnpm build
pnpm dev        # Start API + Web UI
pnpm test       # Run tests
pnpm typecheck  # TypeScript check
pnpm lint       # ESLint
```

### Good First Issues

Looking for a way to contribute? Check out:
- [Good first issues](https://github.com/markus-global/markus/labels/good%20first%20issue) — Beginner-friendly tasks
- [Help wanted](https://github.com/markus-global/markus/labels/help%20wanted) — Features we need help with
- [Bug reports](https://github.com/markus-global/markus/issues) — Help us fix issues

### Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes and add tests
4. Ensure all checks pass: `pnpm typecheck && pnpm lint && pnpm test`
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
6. Open a PR with a clear description

See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

---

## Community & Support

- 📖 [Documentation](docs/GUIDE.md) — Getting started guides
- 🐛 [GitHub Issues](https://github.com/markus-global/markus/issues) — Bug reports & feature requests
- 💬 [GitHub Discussions](https://github.com/markus-global/markus/discussions) — Questions & ideas
- 🌐 [Website](https://www.markus.global) — Official website

---

## License

Markus is dual-licensed:

- **Open Source**: [AGPL-3.0](LICENSE) — Free for self-hosting and community contributions
- **Commercial**: [Available](LICENSE-COMMERCIAL.md) — For SaaS deployments and proprietary modifications

Agent templates and skills shared through the marketplace may use their own licenses (typically MIT).

---

<p align="center">
  <strong>Built with ❤️ by developers, for developers</strong><br>
  <sub>Markus — Where AI Agents Work Together</sub>
</p>
