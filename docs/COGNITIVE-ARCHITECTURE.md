# Cognitive Architecture: Unified Agent Cognition

This document describes the unified cognitive architecture that governs how Markus agents perceive stimuli, prepare context, deliberate, act, and learn. It replaces the previous model — mechanical prompt assembly plus volatile in-memory working memory — with a **continuous cognitive cycle** backed by persistent stores (`NOTEBOOK.md`, `knowledge.md` / `state.md`) and an optional **Cognitive Preparation Pipeline (CPP)** for deliberate context preparation.

> **Memory SSOT**: Prefer [`MEMORY-SYSTEM.md`](./MEMORY-SYSTEM.md) — durable knowledge is `knowledge.md`, short TTL state is `state.md`; legacy `MEMORY.md` migrates once. Below, historical “MEMORY.md” references mean that dual-store model.
>
> **Implementation status**: Core cycle, Notebook, knowledge/state memory, Attention Controller, Goal/Loop heartbeat integration, A2A DM channels, and `PendingCallbackRegistry` are implemented. CPP (Phases 1–3, depth D0–D3) lives in `packages/core/src/cognitive.ts`. CPP is opt-in via `agent.cognitive.enabled` in `markus.json` (default `false` until explicitly enabled). D2+ retrieval requires a `RetrievalBackend` adapter.

---

## 1. Unified Cognitive Cycle

Every agent interaction follows the same loop. Heartbeat checks keep the cycle running when no external stimulus arrives.

```
                    ┌─────────────────────────────────────┐
                    │         Heartbeat (patrol)          │
                    │  goals · callbacks · failed tasks │
                    └──────────────┬──────────────────────┘
                                   │
Stimulus ──► Triage / Appraisal ──► Context Assembly ──► Deliberation ──► Action ──► Reflection / Update
(Mailbox)    (AttentionController   (NOTEBOOK.md +         (main LLM +      (tools)    (memory_save,
              + optional CPP)        MEMORY.md)             tools)                      notebook, dream)
```

| Stage | What happens | Primary components |
|-------|--------------|-------------------|
| **Stimulus** | Message, task, heartbeat, A2A, callback result enters the mailbox | `Mailbox`, `AttentionController` |
| **Triage / Appraisal** | Decide what to focus on; optionally run CPP appraisal | `AttentionController`, `CognitivePreparation` |
| **Context Assembly** | Load procedural identity, curated knowledge, notebook workspace, mailbox state | `ContextEngine`, `NOTEBOOK.md`, `MEMORY.md` |
| **Deliberation** | Main LLM reasons with assembled context and available tools | `Agent`, tool loop |
| **Action** | Execute tool calls (tasks, files, A2A, memory writes) | Tool handlers |
| **Reflection / Update** | Persist observations, update notebook, consolidate via dream cycle | `memory_save`, `update_notebook`, dream cycle |

The cycle is **continuous**: heartbeat patrols re-enter the loop, checking active goals, timed-out callbacks, and stalled work even when the mailbox is quiet.

---

## 2. Cognitive Science Foundations

The architecture maps directly to established cognitive models:

| Model | Concept | Markus mapping |
|-------|---------|----------------|
| **Baddeley — Working Memory** | Central executive coordinates subsidiary systems; episodic buffer integrates sources | `NOTEBOOK.md` = central executive + visuospatial sketchpad (active workspace); `MEMORY.md` = episodic buffer (integrates curated knowledge with experience) |
| **Cowan — Embedded Processes** | Focus of attention (4±1 chunks) within activated long-term memory | `## _observations` buffer = focus of attention (raw, not in prompt); curated `MEMORY.md` sections = activated LTM (always injected) |
| **Kahneman — Dual Process** | System 1 (fast, automatic) vs System 2 (slow, deliberate) | System 1 = triage, fast `memory_search`, mechanical retrieval fallback; System 2 = CPP (appraisal → retrieval → reflection) |
| **Boyd — OODA Loop** | Observe → Orient → Decide → Act | **Observe**: mailbox items; **Orient**: CPP + notebook updates; **Decide**: main LLM deliberation; **Act**: tool execution |

Additional influences preserved from earlier design:

- **Tulving's memory systems**: Procedural (ROLE.md + skills), Semantic (MEMORY.md), Episodic (sessions + activity index).
- **Metacognition (Flavell)**: CPP appraisal asks "do I know enough?" before acting.
- **Global Workspace Theory (Baars)**: Notebook is the broadcast workspace — selected context competes for limited prompt capacity.

See [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) for storage-layer detail.

---

## 3. Cognitive Preparation Pipeline (CPP)

CPP is the System 2 layer. It runs **between triage and the main LLM call**, using 0–3 lightweight LLM calls to prepare persona-aware context before deliberation.

```
Stimulus → Triage → CPP (optional) → Context Assembly → Main LLM
                         │
                         ├─ Phase 1: Appraisal      ("What is this? What do I need?")
                         ├─ Phase 2: Retrieval      (directed queries — no LLM)
                         └─ Phase 3: Reflection     ("What does this mean for me?")
```

### Output destination: Notebook, not prompt sections

When the notebook writer is active (normal agent runtime), CPP output is written directly to **`NOTEBOOK.md`** entries rather than injected as separate system-prompt sections:

| CPP phase | Notebook key | Managed tag |
|-----------|--------------|-------------|
| Appraisal | `cognitive-context` | `cpp` |
| Retrieval | `relevant-context` | `cpp` |
| Reflection | `reflection` | `cpp` |

Mechanical memory retrieval (when CPP is off or at D0) writes `relevant-context` with managed tag `system`. Triage decisions write `triage-decision` (`system`).

### Cognitive depth levels

| Level | Name | Phases | When | Extra LLM calls |
|-------|------|--------|------|-----------------|
| D0 | Reflexive | None | Heartbeat OK, memory consolidation | 0 |
| D1 | Reactive | Appraisal | Most chats, A2A, comments | 0–1 |
| D2 | Deliberative | Appraisal + Retrieval + Reflection | Task execution, complex questions | 2 |
| D3 | Meta-cognitive | Full pipeline + post-response eval (future) | High-stakes, blockers, novel situations | 2–3 |

Depth is selected by scenario (`selectCognitiveDepth`) and clamped by `maxDepth` config. Triage outcome influences the effective depth (e.g., failed tasks upgrade heartbeat from D0 → D1).

### Configuration

Opt-in via settings (`markus.json` → `agent.cognitive`, REST `/api/settings/agent`):

```typescript
interface CognitiveConfig {
  enabled: boolean;           // master switch (default: false)
  maxDepth?: CognitiveDepth;  // cap depth during rollout (default allows D1)
  appraisalModel?: string;    // model for appraisal/reflection (defaults to cheapest)
  timeoutMs?: number;         // CPP timeout (default: 15000)
}
```

When CPP times out or errors, the agent falls back to mechanical retrieval without blocking the cycle.

---

## 4. Notebook (NOTEBOOK.md)

The Notebook is the agent's **persistent cognitive workspace** — Baddeley's central executive rendered as markdown on disk. It replaces the former volatile in-memory working memory.

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/NOTEBOOK.md` |
| Prompt injection | Always loaded as `## Notebook` |
| Format | `## key` headings with `<!-- managed: … -->` and `<!-- updated: … -->` metadata |

### Managed entry types

| Tag | Writer | Purpose |
|-----|--------|---------|
| `agent` | Agent via `update_notebook` / `clear_notebook` | Explicit notes, priorities, blockers |
| `system` | Runtime (triage, deliberation, mechanical retrieval) | Triage decisions, fallback context |
| `cpp` | Cognitive Preparation Pipeline | Appraisal, retrieval, reflection outputs |

**Lifecycle**: Loaded at startup → updated in-process → debounced persist (2s) → survives restarts. Limits: 15 agent-managed entries, 6000 chars each.

The Notebook holds *situational* state. Durable knowledge flows to `MEMORY.md` via `memory_save` / `memory_update`.

---

## 5. Memory (MEMORY.md)

Unified long-term store for curated knowledge plus a raw observation buffer — Cowan's activated LTM plus focus-of-attention staging area.

```
MEMORY.md
├── ## conventions          ← agent-organized curated sections (in prompt)
├── ## procedures
├── ...
└── ## _observations        ← raw buffer (NOT in prompt)
```

| Layer | Role | Prompt |
|-------|------|--------|
| Curated sections | Distilled knowledge the agent maintains | Always injected as `## Your Knowledge` |
| `## _observations` | Raw observations from `memory_save` | Excluded from prompt; processed by dream cycle |

The **dream cycle** (`memory_consolidation`) consolidates observations into curated sections, prunes stale content, and maintains MEMORY.md hygiene. This is the long-term learning path at the end of the cognitive cycle.

---

## 6. Decision Mechanisms

Three interlocking mechanisms drive agent attention and sustained work:

### Attention Controller

Processes the **Mailbox** — the agent's unified stimulus queue. Responsibilities:

- Priority ordering and preemption
- LLM-driven triage (`performTriage`) and full-session deliberation
- Triage decisions persisted to notebook (`triage-decision`)
- Yields to higher-priority items (e.g., human chat during deliberation)

Triage decides **what** to process; CPP decides **how to prepare** for processing.

### Heartbeat

Periodic patrol re-enters the cognitive cycle without external stimulus. Each heartbeat checks:

- Active goals (Goal/Loop — see §7)
- Timed-out `PendingCallbackRegistry` entries
- Failed tasks and requirement monitoring
- Background operation completions
- Self-evolution and quality signals

Heartbeat uses D0 (reflexive) depth unless failed tasks or blockers upgrade it.

#### Spec: active-hours timezone (C1)

`HeartbeatScheduler` skips ticks outside `config.activeHours`. Previously
`isWithinActiveHours()` used the host machine's local clock (`new Date().getHours()`), which
could disagree with the agent's configured timezone.

- **Behavior**: `activeHours` is evaluated in the **configured timezone** (falling back to
  host local time only when none is configured or the id is invalid), so an agent set to
  `09:00–18:00` patrols during those hours in *its* timezone regardless of where the process
  runs.
- **Invariants**: same-instant evaluation yields the correct in/out-of-window result for a
  given configured timezone; the start minute is inclusive and the end minute exclusive; the
  midnight-wrap case (e.g. `22:00–06:00`) still works.
- **Testing** (`packages/core/test/heartbeat.test.ts` — the "C1:" cases): with a fixed
  instant (`2026-07-23T12:00:00Z`) and different configured timezones (UTC / Los_Angeles /
  Tokyo), assert the active-window decision matches the configured zone, plus the
  invalid-timezone fallback and midnight-wrap cases.
- **Status**: implemented (pure `isWithinActiveHours` / `minutesOfDayInTimeZone` via
  `Intl.DateTimeFormat`; `HeartbeatScheduler.isWithinActiveHours` delegates to them).

> Prompt-cache note: heartbeat situational content (mailbox meta, notebook, timestamps) is
> injected in Tier 3 (dynamic), never into the stable prefix — see the injection-point
> ownership audit in [PROMPT-ENGINEERING.md §2.2](./PROMPT-ENGINEERING.md).

### Goal / Loop Mechanism

Requirements can carry a `GoalConfig` that turns them into **persistent objectives**:

```typescript
interface GoalConfig {
  loopEnabled: boolean;
  completionCriteria: string;
  maxIterations: number;
  currentIteration: number;
  lastCheckedAt: string;
  autoResume: boolean;
}
```

When `goalConfig.loopEnabled` is set, the requirement acts as a standing goal. Heartbeat injects an **Active Goals** section listing each goal's title, iteration count, and completion criteria. The agent assesses progress, creates follow-up tasks, and marks requirements complete when criteria are met.

Goal state is fetched via `goalFetcher` (wired from org-manager requirement service) and managed through requirement/task tools.

---

## 7. A2A Communication

Agent-to-agent messaging is unified under **DM Channels** — deterministic keys derived from sorted agent IDs:

```
dm:a2a:{sorted_id_1}:{sorted_id_2}
```

This leverages existing group-chat infrastructure:

- **Persistent history** — both agents can recall past exchanges via `recall_context`
- **Stable sessions** — messages route through the channel rather than ephemeral session IDs
- **Mailbox integration** — `sendGroupMessage` persists, notifies WebSocket clients, and enqueues on the target agent's mailbox

`agent_send_message` is always asynchronous (fire-and-forget). Substantial work should use requirements + tasks, not A2A messages.

### PendingCallbackRegistry

Async operations (e.g., `background_exec`) register callbacks tracked by `PendingCallbackRegistry`. When complete, results enter the originating agent's mailbox as `callback_result` items — ensuring they flow through the attention loop rather than being injected directly into sessions. Timed-out callbacks surface in heartbeat for investigation.

Implementation: `packages/core/src/pending-callback.ts`, persisted via `SqlitePendingCallbackRepo`.

---

## 8. Integration Map

```
┌──────────────────────────────────────────────────────────────────┐
│                        Agent Runtime                              │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │  Mailbox    │──►│  Attention   │──►│  CPP (optional)     │  │
│  │             │   │  Controller  │   │  cognitive.ts       │  │
│  └─────────────┘   └──────────────┘   └──────────┬──────────┘  │
│                                                   │               │
│  ┌────────────────────────────────────────────────▼──────────┐  │
│  │                    ContextEngine                             │  │
│  │  ROLE.md · MEMORY.md · NOTEBOOK.md · mailbox · goals       │  │
│  └──────────────────────────────┬───────────────────────────────┘  │
│                                 ▼                                  │
│                          Main LLM + Tools                          │
└──────────────────────────────────────────────────────────────────┘
```

| Component | Location | Role in cycle |
|-----------|----------|---------------|
| `AttentionController` | `packages/core/src/attention.ts` | Triage, deliberation, focus management |
| `CognitivePreparation` | `packages/core/src/cognitive.ts` | CPP orchestration |
| `ContextEngine` | `packages/core/src/context-engine.ts` | Context assembly, notebook writer |
| `Agent` | `packages/core/src/agent.ts` | Cycle orchestration, heartbeat, notebook persistence |
| `MemoryStore` | `packages/core/src/memory/store.ts` | MEMORY.md + NOTEBOOK.md I/O |
| `PendingCallbackRegistry` | `packages/core/src/pending-callback.ts` | Async callback tracking |
| `AgentManager` | `packages/core/src/agent-manager.ts` | A2A DM routing, cognitive config |

Types: `packages/shared/src/types/cognitive.ts`, `requirement.ts` (`GoalConfig`).

---

## 9. Relationship to Other Documents

| Document | Relationship |
|----------|-------------|
| [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) | Two-file model detail, dream cycle, tool reference |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox types, priority, triage protocol |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | Prompt section taxonomy |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System-wide component overview |

---

## 10. Implementation Status

### Completed

- Unified cognitive cycle with persistent Notebook and MEMORY.md
- CPP Phases 1–3 with depth selection (D0–D3) and notebook output path
- Attention Controller triage + deliberation with notebook persistence
- Goal/Loop heartbeat integration with `GoalConfig` on requirements
- A2A DM channels (`dm:a2a:{sorted_ids}`) with group-chat persistence
- `PendingCallbackRegistry` with SQLite persistence
- Mechanical retrieval fallback writes `relevant-context` to notebook
- Unit tests in `packages/core/test/cognitive-enhancement.test.ts`

### In Progress / Not Yet Built

- `RetrievalBackend` adapter for D2+ directed retrieval (interface defined, no adapter)
- D2/D3 blocked by `maxDepth` default until retrieval backend exists
- D3 post-response evaluation (meta-cognitive feedback loop)
- Dream cycle integration with CPP activity index

### Future Work

- Enable D2 by default once `RetrievalBackend` ships
- Tune depth heuristics and appraisal prompts from production data
- Simplify compression pipeline (thinner sessions reduce pressure)
