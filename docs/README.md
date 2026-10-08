# Markus Documentation

Entry point for all Markus technical documentation. Every domain has **one authoritative document**;
a mechanism is described in full only in its home document and cross-referenced everywhere else.

- **Start here** → [Architecture](./architecture/architecture.md) — system overview, then follow its map.
- **Just want to run it?** → [User Guide](./guides/guide.md).
- **Want to contribute?** → [Development Guide](./guides/development.md) + [CONTRIBUTING.md](../CONTRIBUTING.md).

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

The canonical description of how Markus works. Read `architecture.md` first; it maps the rest.

| Document | Domain |
|---|---|
| [architecture.md](./architecture/architecture.md) | System overview, package structure, channels, deployment, observability |
| [architecture-fragility.md](./architecture/architecture-fragility.md) | Why this system produces fragile bugs, and the structural rules that prevent it |
| [agent-runtime.md](./architecture/agent-runtime.md) | Agent lifecycle, execution model, workspace isolation |
| [cognitive-architecture.md](./architecture/cognitive-architecture.md) | Cognitive cycle, deterministic context assembly, heartbeat integration |
| [memory-system.md](./architecture/memory-system.md) | Memory layers, storage compaction, memory flush |
| [prompt-engineering.md](./architecture/prompt-engineering.md) | Prompt & context assembly, LLM call taxonomy, context packing, caching |
| [mailbox-system.md](./architecture/mailbox-system.md) | Mailbox priority queue + attention controller (focus, interrupts, yield, cancel) |
| [state-machines.md](./architecture/state-machines.md) | FSMs for tasks, requirements, callbacks, mailbox items, notebook |
| [state-ownership.md](./architecture/state-ownership.md) | State-ownership contract: who owns what, who may read it, in which execution context |
| [concurrent-processing.md](./architecture/concurrent-processing.md) | How one agent handles multiple sessions / mailbox items in parallel |
| [tool-system.md](./architecture/tool-system.md) | Tool selection, tool result envelope, execution loop, subagent budgets |
| [streaming-and-reattach.md](./architecture/streaming-and-reattach.md) | SSE streaming, soft-disconnect, reattach, client resilience |
| [llm-provider-timeouts.md](./architecture/llm-provider-timeouts.md) | Per-provider timeout/retry governance matrix, known risk inventory |
| [learning-loop.md](./architecture/learning-loop.md) | Agent self-improvement, distillation, memory consolidation |
| [frontend/team-chat.md](./architecture/frontend/team-chat.md) | Team Chat page (web-ui): state model and interaction reliability contracts |

## api/

| Document | Domain |
|---|---|
| [api.md](./api/api.md) | REST endpoints and WebSocket events |

## guides/

| Document | Domain |
|---|---|
| [guide.md](./guides/guide.md) | Setup, configuration, Web UI walkthrough |
| [development.md](./guides/development.md) | Local setup, dev scripts, testing, debugging |
| [coding-tools.md](./guides/coding-tools.md) | External coding CLI integration (Claude Code / Codex / Cursor) |
| [skill-ecosystem.md](./guides/skill-ecosystem.md) | Import/export skills from skills.sh, SkillHub, OpenClaw, AgentScope, MCP |
| [remote-access.md](./guides/remote-access.md) | Cloudflare Tunnel, Tailscale, FRP, ngrok |
| [release-and-distribution.md](./guides/release-and-distribution.md) | Build, packaging, publishing pipeline |
| [community.md](./guides/community.md) | Community channels, rules, and launch plan |

## design/

| Document | Status |
|---|---|
| [deliverable-sharing.md](./design/deliverable-sharing.md) | Sharing deliverables to Markus Hub (desktop + cloud) |

## records/

Dated engineering records. These are **not** maintained as living documentation — they preserve the
rationale, evidence and decision trail behind changes that are now in the code. Read them when you
want to know *why*, not *what*.

| Record | Subject |
|---|---|
| [platform-hardening-2026-10.md](./records/platform-hardening-2026-10.md) | Agent self-management boundaries; memory-subsystem hardening (H1–H11) |
| [message-stop-cancel-fix-plan.md](./records/message-stop-cancel-fix-plan.md) | Message stop / cancel / resend + frontend streaming flicker |
| [session-identity-plan.md](./records/session-identity-plan.md) | Session identity and message pipeline audit |
| [file-edit-literal-replacement-fix.md](./records/file-edit-literal-replacement-fix.md) | Edit tools silently duplicating file content (literal replacement) |
| [audit-fixes-2026-09.md](./records/audit-fixes-2026-09.md) | 2026-09 core-mechanism audit → concentrated fix batch |
| [branch-consolidation.md](./records/branch-consolidation.md) | Branch consolidation of `refactor/team-chat-state-machine` |
| [settings-model-routing-first-visit-fix.md](./records/settings-model-routing-first-visit-fix.md) | Settings page: model routing options empty on first visit |
