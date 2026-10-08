# Markus Documentation

Entry point for all Markus technical documentation. Every domain has **one authoritative document**;
a mechanism is described in full only in its home document and cross-referenced everywhere else.

- **Start here** → [Architecture](./architecture/ARCHITECTURE.md) — system overview, then follow its map.
- **Just want to run it?** → [User Guide](./guides/GUIDE.md).
- **Want to contribute?** → [Development Guide](./guides/DEVELOPMENT.md) + [CONTRIBUTING.md](../CONTRIBUTING.md).

## Layout

Docs are grouped by **kind**, not by package. A file's folder tells you how much to trust it:

| Folder | What lives here | Lifetime |
|---|---|---|
| [`architecture/`](./architecture/) | How the system is designed and built — canonical description of each subsystem | Living |
| [`api/`](./api/) | REST + WebSocket reference | Living |
| [`guides/`](./guides/) | Setup, development, operations, packaging, community | Living |
| [`design/`](./design/) | Design documents and proposals (built or pending) | Living until implemented |
| [`records/`](./records/) | Dated engineering records — audits, post-mortems, hardening logs | **Historical, frozen** |
| `images/` | Assets referenced by the top-level README | — |

**Conventions**

- Docs are written in **English**. A doc describes the *current* behaviour; history belongs in
  `records/` or in git.
- Source comments point at the specific doc **and section** that justifies the code, so a reader can
  always get from the code to its rationale.
- When a doc contradicts the code, the code wins — and the doc gets a PR.

---

## architecture/

The canonical description of how Markus works. Read `ARCHITECTURE.md` first; it maps the rest.

| Document | Domain |
|---|---|
| [ARCHITECTURE.md](./architecture/ARCHITECTURE.md) | System overview, package structure, channels, deployment, observability |
| [ARCHITECTURE-FRAGILITY.md](./architecture/ARCHITECTURE-FRAGILITY.md) | Why this system produces fragile bugs, and the structural rules that prevent it |
| [AGENT-RUNTIME.md](./architecture/AGENT-RUNTIME.md) | Agent lifecycle, execution model, workspace isolation |
| [COGNITIVE-ARCHITECTURE.md](./architecture/COGNITIVE-ARCHITECTURE.md) | Cognitive cycle, deterministic context assembly, heartbeat integration |
| [MEMORY-SYSTEM.md](./architecture/MEMORY-SYSTEM.md) | Memory layers, storage compaction, memory flush |
| [PROMPT-ENGINEERING.md](./architecture/PROMPT-ENGINEERING.md) | Prompt & context assembly, LLM call taxonomy, context packing, caching |
| [MAILBOX-SYSTEM.md](./architecture/MAILBOX-SYSTEM.md) | Mailbox priority queue + attention controller (focus, interrupts, yield, cancel) |
| [STATE-MACHINES.md](./architecture/STATE-MACHINES.md) | FSMs for tasks, requirements, callbacks, mailbox items, notebook |
| [STATE-OWNERSHIP.md](./architecture/STATE-OWNERSHIP.md) | State-ownership contract: who owns what, who may read it, in which execution context |
| [CONCURRENT-PROCESSING.md](./architecture/CONCURRENT-PROCESSING.md) | How one agent handles multiple sessions / mailbox items in parallel |
| [TOOL-SYSTEM.md](./architecture/TOOL-SYSTEM.md) | Tool selection, tool result envelope, execution loop, subagent budgets |
| [STREAMING-AND-REATTACH.md](./architecture/STREAMING-AND-REATTACH.md) | SSE streaming, soft-disconnect, reattach, client resilience |
| [LLM-PROVIDER-TIMEOUTS.md](./architecture/LLM-PROVIDER-TIMEOUTS.md) | Per-provider timeout/retry governance matrix, known risk inventory |
| [LEARNING-LOOP.md](./architecture/LEARNING-LOOP.md) | Agent self-improvement, distillation, memory consolidation |
| [frontend/TEAM-CHAT.md](./architecture/frontend/TEAM-CHAT.md) | Team Chat page (web-ui): state model and interaction reliability contracts |

## api/

| Document | Domain |
|---|---|
| [API.md](./api/API.md) | REST endpoints and WebSocket events |

## guides/

| Document | Domain |
|---|---|
| [GUIDE.md](./guides/GUIDE.md) | Setup, configuration, Web UI walkthrough |
| [DEVELOPMENT.md](./guides/DEVELOPMENT.md) | Local setup, dev scripts, testing, debugging |
| [CODING-TOOLS.md](./guides/CODING-TOOLS.md) | External coding CLI integration (Claude Code / Codex / Cursor) |
| [SKILL-ECOSYSTEM.md](./guides/SKILL-ECOSYSTEM.md) | Import/export skills from skills.sh, SkillHub, OpenClaw, AgentScope, MCP |
| [REMOTE-ACCESS.md](./guides/REMOTE-ACCESS.md) | Cloudflare Tunnel, Tailscale, FRP, ngrok |
| [RELEASE-AND-DISTRIBUTION.md](./guides/RELEASE-AND-DISTRIBUTION.md) | Build, packaging, publishing pipeline |
| [COMMUNITY.md](./guides/COMMUNITY.md) | Community channels, rules, and launch plan |

## design/

| Document | Status |
|---|---|
| [DELIVERABLE-SHARING-DESIGN.md](./design/DELIVERABLE-SHARING-DESIGN.md) | Sharing deliverables to Markus Hub (desktop + cloud) |

## records/

Dated engineering records. These are **not** maintained as living documentation — they preserve the
rationale, evidence and decision trail behind changes that are now in the code. Read them when you
want to know *why*, not *what*.

| Record | Subject |
|---|---|
| [PLATFORM-HARDENING-2026-10.md](./records/PLATFORM-HARDENING-2026-10.md) | Agent self-management boundaries; memory-subsystem hardening (H1–H11) |
| [MESSAGE-STOP-CANCEL-FIX-PLAN.md](./records/MESSAGE-STOP-CANCEL-FIX-PLAN.md) | Message stop / cancel / resend + frontend streaming flicker |
| [SESSION-IDENTITY-PLAN.md](./records/SESSION-IDENTITY-PLAN.md) | Session identity and message pipeline audit |
| [FILE-EDIT-LITERAL-REPLACEMENT-FIX.md](./records/FILE-EDIT-LITERAL-REPLACEMENT-FIX.md) | Edit tools silently duplicating file content (literal replacement) |
| [AUDIT-FIXES-2026-09.md](./records/AUDIT-FIXES-2026-09.md) | 2026-09 core-mechanism audit → concentrated fix batch |
| [BRANCH-CONSOLIDATION.md](./records/BRANCH-CONSOLIDATION.md) | Branch consolidation of `refactor/team-chat-state-machine` |
| [SETTINGS-MODEL-ROUTING-FIRST-VISIT-FIX.md](./records/SETTINGS-MODEL-ROUTING-FIRST-VISIT-FIX.md) | Settings page: model routing options empty on first visit |
