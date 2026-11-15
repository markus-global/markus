# Markus Documentation

Entry point for all Markus technical documentation. Every domain has **one authoritative document**;
a mechanism is described in full only in its home document and cross-referenced everywhere else.

- **Start here** → [Architecture](./architecture/architecture.md) — system overview, then follow its map.
- **Just want to run it?** → [User Guide](./guides/guide.md).
- **Want to contribute?** → [Development Guide](./guides/development.md) + [CONTRIBUTING.md](../CONTRIBUTING.md).

## Layout

Docs are grouped by **kind**, not by package. A file's folder tells you how much to trust it:| Folder | What lives here | Lifetime |
|---|---|---|
| [`architecture/`](./architecture/) | How the system is designed and built — canonical description of each subsystem | Living |
| [`api/`](./api/) | REST + WebSocket reference | Living |
| [`guides/`](./guides/) | Setup, development, operations, packaging, community | Living |
| [`records/`](./records/) | Dated engineering records — audits, post-mortems, hardening logs | **Historical, frozen** |
| `images/` | Assets referenced by the top-level README | — |

**Conventions**

- Docs are written in **English**. A doc describes the *current* behaviour; history belongs in
  `records/` or in git.
- Source comments point at the specific doc **and section** that justifies the code, so a reader can
  always get from the code to its rationale.
- When a doc contradicts the code, the code wins — and the doc gets a PR.
- A proposal that is **not settled yet** goes in `docs/design/` (create it when needed). A design doc
  leaves that folder in the same PR that implements it — `docs/design/` holding only shipped work is
  how a folder stops meaning anything.

---

## architecture/

The canonical description of how Markus works. Read `architecture.md` first; it maps the rest.

| Document | Domain |
|---|---|
| [architecture.md](./architecture/architecture.md) | System overview, package structure, channels, deployment, observability |
| [architecture-fragility.md](./architecture/architecture-fragility.md) | Why this system produces fragile bugs, and the structural rules that prevent it |
| [agent-runtime.md](./architecture/agent-runtime.md) | Agent lifecycle, execution model, workspace isolation; state-ownership contract (Appendix A) |
| [cognitive-architecture.md](./architecture/cognitive-architecture.md) | Cognitive cycle, deterministic context assembly, heartbeat integration |
| [memory-system.md](./architecture/memory-system.md) | Memory layers, storage compaction, memory flush |
| [prompt-engineering.md](./architecture/prompt-engineering.md) | System prompt architecture, LLM call taxonomy incl. provider timeout governance (§1.3), prompt caching, output token resolution |
| [context-assembly.md](./architecture/context-assembly.md) | Message assembly & context compression — token budget, compaction pipeline, ContextOS fixed/variable split |
| [tool-loop-harness.md](./architecture/tool-loop-harness.md) | Tool loop harness + scenario-specific prompt assembly (scenario × context matrix, scenario × tool face) |
| [mailbox-system.md](./architecture/mailbox-system.md) | Mailbox priority queue + attention controller (focus, interrupts, yield, cancel); triage, restart recovery, addresses, delivery envelopes and bounce/catch-all (§28) |
| [a2a-communication.md](./architecture/a2a-communication.md) | Agent-to-agent communication — DM/group channels, one-message-one-delivery-fact invariant, reply sink, entry-point inventory |
| [remote-access.md](./architecture/remote-access.md) | Remote access refactor — frozen contract v1.0.0 (user-supplied tunnel, Hub as entry/registry/auth gate) |
| [notification-delivery.md](./architecture/notification-delivery.md) | Notification delivery to humans — user/IM notification contract, agent→user messages, dedup and context truth |
| [state-machines.md](./architecture/state-machines.md) | FSMs for tasks, requirements, callbacks, mailbox items, notebook |
| [concurrent-processing.md](./architecture/concurrent-processing.md) | How one agent handles multiple sessions / mailbox items in parallel |
| [tool-system.md](./architecture/tool-system.md) | Tool selection, tool result envelope, execution loop, subagent budgets |
| [streaming-and-reattach.md](./architecture/streaming-and-reattach.md) | SSE streaming, soft-disconnect, reattach, client resilience |
| [learning-loop.md](./architecture/learning-loop.md) | Agent self-improvement, distillation, memory consolidation |
| [facts.md](./architecture/facts.md) | C9 fact layer — contract (predicates, single writer, rejection matrix, schema, prompt surface) + independent verification (terminal hooks, dream suggestions, read-only audit page) |
| [derived-views.md](./architecture/derived-views.md) | C9 derived views — thread stage, inbox derivation, and the four observation tables; all derived, never a second decider |
| [team-chat.md](./architecture/team-chat.md) | Team Chat page (web-ui): state model and interaction reliability contracts |
| [messaging-gateway.md](./architecture/messaging-gateway.md) | Comms layer: platform manifests, bot instances, inbound routing, outbound & notifications, capability model |

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
| [cut6-mailbox-address-envelope-design-2026-11-12.md](./records/cut6-mailbox-address-envelope-design-2026-11-12.md) | Cut 6 execution: address format, delivery envelope, bounce/catch-all (durable contract now in architecture/mailbox-system.md §28) |
| [cut6-c4-verification-2026-11-12.md](./records/cut6-c4-verification-2026-11-12.md) | Cut 6 C4 verification: full regression, real-instance probes, rebuild |
| [agent-stop-intent-audit-2026-11-08.md](./records/agent-stop-intent-audit-2026-11-08.md) | "Stop means stop": twelve start paths, two writers for one intent (rule now in architecture/agent-runtime.md Appendix B) |
| [remote-access-handoff.md](./records/remote-access-handoff.md) | Remote-access refactor delivery notes and manual verification (contract now in architecture/remote-access.md) |
| [remote-access-fast-path-plan-2026-10-17.md](./records/remote-access-fast-path-plan-2026-10-17.md) | Why remote access was slow, and the fast-path plan that became the frozen contract |
| [overview-attention-redesign.md](./records/overview-attention-redesign.md) | Overview "needs your attention" redesign — code facts, slices, landing status |
| [approval-tri-state-handoff.md](./records/approval-tri-state-handoff.md) | Approval tri-state: handoff and verification, per-gate re-initiation |
| [notify-user-context-truth-2026-10-28.md](./records/notify-user-context-truth-2026-10-28.md) | Twelve `notify_user` calls in 90s — receipt lost between tool_call and tool_result |
| [2026-11-12-session-expiry-and-mention-thinking.md](./records/2026-11-12-session-expiry-and-mention-thinking.md) | Session expiry and mention-thinking: two root causes, one fix branch |
| [deliverable-sharing-2026-08-12.md](./records/deliverable-sharing-2026-08-12.md) | Deliverable sharing to Markus Hub — design, and as-built for both ends |
| [2026-10-29-a2a-cache-hit-rate.md](./records/2026-10-29-a2a-cache-hit-rate.md) | A2A cache hit rate — first-principles analysis over 741 real calls |
| [cut9-inbox-dual-run-diff-2026-11-15.md](./records/cut9-inbox-dual-run-diff-2026-11-15.md) | Inbox dual run — legacy `buildAttentionQueue` vs `deriveInbox` |
| [team-chat-stream-transport-vs-turn-2026-10-08.md](./records/team-chat-stream-transport-vs-turn-2026-10-08.md) | Team Chat streaming: "transport ended" mistaken for "turn ended" |
| [animation-budget-focus-vs-visibility-2026-10-08.md](./records/animation-budget-focus-vs-visibility-2026-10-08.md) | Streaming bubble border vanished: focus mistaken for visibility |
| [page-switch-jank-2026-10-23.md](./records/page-switch-jank-2026-10-23.md) | Desktop page-switch jank: root cause, measurement, fix |
| [agent-platform-friction-2026-10.md](./records/agent-platform-friction-2026-10.md) | Agent platform friction — field notes from a working agent |
| [cut7-workunit-execution-plan-2026-11-13.md](./records/cut7-workunit-execution-plan-2026-11-13.md) | Cut 7 execution plan: WorkUnit + FSM-3 + budget merge |
| [cut7-c7a-workunit-implementation-2026-11-13.md](./records/cut7-c7a-workunit-implementation-2026-11-13.md) | Cut 7 / C7-A — WorkUnit lands: chat, task and a2a get an identity |
| [cut7-c7a-red-green-evidence-2026-11-13.md](./records/cut7-c7a-red-green-evidence-2026-11-13.md) | C7-A red-then-green evidence (review-time reproduction) |
| [cut7-c7b-verification-2026-11-14.md](./records/cut7-c7b-verification-2026-11-14.md) | Cut 7 / C7-B — delegation has a parent, budget has one unit |
| [cut7-live-verification-2026-11-14.md](./records/cut7-live-verification-2026-11-14.md) | C7 live acceptance: full readings after four repair rounds |
| [cut7-wiring-negative-cache-2026-11-14.md](./records/cut7-wiring-negative-cache-2026-11-14.md) | C7 live incident: wiring order + negative cache silently disabled the whole WorkUnit |
| [cut8-a-entity-keys-design-2026-11-14.md](./records/cut8-a-entity-keys-design-2026-11-14.md) | Cut 8 / C8-A — entity identity converges on the WorkUnit |
| [cut8-b-turn-delta-injection-2026-11-14.md](./records/cut8-b-turn-delta-injection-2026-11-14.md) | Cut 8 / C8-B — in-turn delta injection: a contradicting fact wins |
| [cut8-c-single-clock-design-2026-11-14.md](./records/cut8-c-single-clock-design-2026-11-14.md) | Cut 8-C — single clock: heartbeat as a liveness tick, one driver |
| [cut8-c-single-clock-2026-11-14.md](./records/cut8-c-single-clock-2026-11-14.md) | Cut 8-C — readings and evidence |
| [cut8-d-2026-11-14.md](./records/cut8-d-2026-11-14.md) | C8-D — action-tool reachability: always present, and eviction-safe |
| [cut8-live-verification-2026-11-14.md](./records/cut8-live-verification-2026-11-14.md) | Cut 8 live verification: four cards cross-checked on one tree |
| [cut9-identity-declaration-2026-11-15.md](./records/cut9-identity-declaration-2026-11-15.md) | C9 follow-up — identity declaration for `task_status_update` |
| [cut9-adjacent-identity-paths-2026-11-15.md](./records/cut9-adjacent-identity-paths-2026-11-15.md) | C9 adjacent paths — shutdown re-queue identity + gateway records |
