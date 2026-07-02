---
sidebar_position: 2
---

# Module Reference

The Markus platform is composed of nine packages organised in a strict layered architecture. Packages at layer `L0` have zero internal dependencies; each higher layer may depend only on packages from its own or lower layers.

## Dependency Diagram

```
┌───────────────────────────────────────────────────────┐
│                    @markus/web-ui                      │
│  (React SPA — Vite, TailwindCSS, i18n)                │
├───────────────────────────────────────────────────────┤
│                   @markus-global/cli                   │
│  (CLI tool — 25 commands)                              │
├───────────────────────────────────────────────────────┤
│                  @markus/org-manager                   │
│  (API server — native http, WebSocket, 24 services)    │
├───────────────────────────────────────────────────────┤
│                     @markus/core                       │
│  (Engine — lifecycle, LLM router, tools, memory,       │
│   mailbox, workflow)                                   │
├───────────┬───────────┬───────────┬───────────────────┤
│@markus/gui│@markus/a2a│@markus/   │  @markus/storage   │
│(VNC, OCR, │(agent-to- │  comms    │  (SQLite,           │
│ screen rec)│ agent)   │(Slack,    │   node:sqlite,      │
│           │           │ Feishu,   │   repository        │
│           │           │ Telegram, │   pattern)          │
│           │           │ WhatsApp) │                    │
├───────────┴───────────┴───────────┴───────────────────┤
│                    @markus/shared                      │
│  (L0 — shared types, validation schemas, utilities)    │
└───────────────────────────────────────────────────────┘
```

## Package Overview

### `@markus/shared` — L0 Foundation

Shared types (TypeScript interfaces, enums, discriminated unions), validation schemas (Zod), logging utilities, and constants used by every other package. **Dependencies:** none.

### `@markus/storage` — Persistence Layer

Thin wrapper around `node:sqlite` implementing the repository pattern. Each entity (agents, tasks, sessions, memories) has a dedicated repository class with standardised CRUD operations. Transactions are managed at the service level. **Dependencies:** `@markus/shared`.

### `@markus/a2a` — Agent-to-Agent Communication

Typed message bus for inter-agent communication. Supports direct messages, group broadcasts, and pub/sub channels. Messages are serialised over WebSocket or in-process bridges depending on deployment topology. **Dependencies:** `@markus/shared`, `@markus/storage`.

### `@markus/comms` — IM Integrations

Adapter-based integration with external messaging platforms: Slack (Block Kit), Feishu/Lark (card messages), Telegram (bot API), and WhatsApp (Cloud API). Each adapter implements a common `CommAdapter` interface for send/receive/webhook handling. **Dependencies:** `@markus/shared`, `@markus/storage`.

### `@markus/gui` — Screen & UI Recognition

Headless GUI automation capabilities: VNC client for remote desktop control, OCR (Tesseract.js) for text extraction from screen captures, and screen-recognition heuristics for identifying UI elements. **Dependencies:** `@markus/shared`.

### `@markus/core` — Engine

The central orchestration package. Manages the full agent lifecycle (instantiation → task execution → teardown), routes LLM requests through a configurable provider chain with fallback, provides the tool registry and execution sandbox, implements persistent memory (episodic + semantic), manages the agent mailbox (priority-queued messages with defer/drop), and drives multi-agent workflows via a state-machine-based workflow engine. **Dependencies:** `@markus/shared`, `@markus/storage`, `@markus/a2a`, `@markus/gui`, `@markus/comms`.

### `@markus/org-manager` — API Server

Serves the Markus REST API and WebSocket endpoint using Node's native `http` module (no Express). Exposes 24 services grouped into: agent management, task lifecycle, tool execution, team configuration, project management, system administration, and real-time event streaming. Implements JWT-based authentication and role-based access control. **Dependencies:** `@markus/core`.

### `@markus-global/cli` — CLI Tool

Standalone command-line interface exposing 25 commands covering project initialisation, agent deployment, task submission, log tailing, and system diagnostics. Built with `commander` and `inquirer` for interactive prompts. Communicates with the org-manager API via HTTP. **Dependencies:** `@markus/core` (library usage).

### `@markus/web-ui` — React SPA

Single-page application built with Vite, TailwindCSS, and `react-i18next` for internationalisation (en, zh, ja). Provides dashboards for agents, tasks, teams, and system health. Communicates with the org-manager API over REST + WebSocket. **Dependencies:** none (standalone SPA; talks to org-manager over the network).

## Key Technologies

| Concern | Technology |
|---------|-----------|
| Runtime | Node.js 22, TypeScript 5.7 (strict mode throughout) |
| Database | SQLite via `node:sqlite` (built-in, no ORM) |
| LLM Routing | OpenRouter, Anthropic, OpenAI, Google — pluggable provider chain |
| CLI | `commander` + `inquirer` |
| Web UI | Vite, React 19, TailwindCSS, `react-i18next` |
| API Server | Native `http` module + `ws` (WebSocket) |
| Validation | Zod schemas (shared across frontend and backend) |
| GUI Automation | Tesseract.js (OCR), `@novnc/novnc` (VNC client) |
