---
sidebar_position: 1
---

# Architecture Overview

Markus is a multi-agent orchestration platform built with a clean layered architecture. Each layer has well-defined boundaries and communicates through explicit interfaces.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│  L4 CLI Client                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │  L3 Organization Manager                           │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │  L2 Core Engine                               │  │  │
│  │  │  ┌──────────┬──────────┬──────────┬────────┐ │  │  │
│  │  │  │ Task     │ Agent    │ Tool     │ LLM    │ │  │  │
│  │  │  │ Engine   │ Runtime  │ Registry │ Router │ │  │  │
│  │  │  └──────────┴──────────┴──────────┴────────┘ │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Web UI (separate SPA)                             │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  L1 Infrastructure Layer                                 │
│  ┌──────────┬──────────┬──────────┬──────────────────┐  │
│  │ Storage  │ A2A Bus  │ Comms    │ GUI (Electron)   │  │
│  └──────────┴──────────┴──────────┴──────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  L0 Shared Foundation                                    │
│  ┌──────────┬──────────┬──────────┬──────────────────┐  │
│  │ Config   │ Logging  │ Errors   │ Utilities        │  │
│  └──────────┴──────────┴──────────┴──────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Layered Architecture

### L0 — Shared Foundation
Common utilities consumed by every other layer: configuration loading (YAML/JSON/env), structured logging, error types, and helper functions. Nothing in this layer depends on any other Markus module.

### L1 — Infrastructure Layer
Provides concrete services without business logic:
- **Storage** — file-based persistence for projects, tasks, requirements, and agent state. See [Storage](storage.md).
- **A2A Bus** — agent-to-agent message passing: async mailbox delivery, group chat channels, and topic-based routing. See [A2A](a2a.md).
- **Comms** — external communication adapters (Feishu/Lark, Slack, email) connecting Markus agents to human collaborators. See [Comms](comms.md).
- **GUI** — Electron-based desktop shell providing the native UI container (distinct from the Web UI SPA).

### L2 — Core Engine
The heart of Markus. All modules here are pure business logic:
- **Task Engine** — creates, schedules, tracks, and resolves tasks with dependency management (`blocked_by`), lifecycle transitions, and review workflows.
- **Agent Runtime** — manages agent lifecycle: spawning, mailbox processing, skill activation, and heartbeat-driven re-prioritization.
- **Tool Registry** — discovers, validates, and invokes tools (both built-in and custom MCP tools) with schema enforcement and timeout handling.
- **LLM Router** — routes model requests across providers (Anthropic, OpenAI, OpenRouter, etc.) with capability-based dispatching, fallback logic, and cost tracking.

### L3 — Organization Manager
Orchestrates multi-agent and multi-project concerns: project CRUD, team composition, repository bindings, governance policies, and agent skill assignments. Acts as the top-level coordinator for all organizational workflows.

### L4 — CLI Client
The primary user-facing interface. A TypeScript CLI that connects to the L3 layer and provides commands for all platform operations — task management, agent interaction, project configuration, and monitoring.

### Web UI
A standalone React SPA (Docusaurus-based documentation + separate dashboard) that communicates with L3 through a RESTful API bridge. It is architecturally separate — not stacked within the layer hierarchy — giving it independent deployability.

## Key Design Principles

- **Strict layering** — each layer depends only on layers below it. No circular dependencies.
- **Pluggable infrastructure** — L1 implementations (storage backends, comms channels, GUI shells) can be swapped without touching core logic.
- **Async-first agent communication** — agents never block on each other. All inter-agent messaging goes through the A2A mailbox bus.
- **Human-in-the-loop** — every critical workflow (task approval, requirement review, external action) requires explicit human confirmation or review.

## Key Modules

| Module | Layer | Purpose |
|---|---|---|
| `task-engine` | L2 | Task lifecycle, dependencies, scheduling |
| `agent-runtime` | L2 | Agent spawn/sleep, mailbox, heartbeat |
| `tool-registry` | L2 | Tool discovery, MCP integration, sandboxing |
| `llm-router` | L2 | Provider routing, fallback, cost tracking |
| `org-manager` | L3 | Projects, teams, governance, skills |
| `a2a-bus` | L1 | Async agent messaging, channels, routing |
| `storage-fs` | L1 | File-backed persistence layer |
| `comms` | L1 | External chat adapters (Feishu, Slack) |
| `gui-electron` | L1 | Native desktop shell |

## Deeper Reading

- [Project Structure](structure.md) — repository layout and module organization
- [Task Lifecycle](tasks.md) — how tasks are created, executed, and reviewed
- [Agent Communication](a2a.md) — the A2A bus protocol in detail
- [Storage Design](storage.md) — persistence model and data flows
- [LLM Routing](llm-routing.md) — model selection, fallback, and capability dispatch
