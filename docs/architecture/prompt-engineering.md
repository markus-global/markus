# Prompt Engineering & Cache Layout

> **Scope (this file)**: how a request is *built and cached* — LLM call taxonomy, the cache-scope layout principle, system-prompt architecture, prefix-cache invariants, ContextOS v2 volatile delivery, prompt profiles, fail-closed packing, and output-token resolution.
> **Split**: §3 (message assembly & compression) and §4–§5 (tool loop harness, scenario assembly) were split out of this document on **2026-11-15**. Section numbers were kept, so the gap at §3–§5 marks exactly the material that moved.
> **Siblings**: [context-assembly.md](./context-assembly.md) — how history is packed into the request and compressed; [tool-loop-harness.md](./tool-loop-harness.md) — how one call runs (tool loop) and how each scenario is assembled.

> **2026-11-15 重排章节编号** — §2 sub-sections were renumbered to be unique and monotonic (old duplicated `### 2.2 Section Details` → `2.3`, `2.3 Spec: Prompt profiles` → `2.4`, `2.4 Spec: Afford fail-closed packing` → `2.5`, the out-of-order `2.3 Skill Filtering` → `2.6`), and the `####` section-detail entries that had drifted below §2.4 (`Identity`, `Skills`, `Task Board`, `Mailbox`, `Concurrency`, `Scenario`, `Referencing`, `Async Work`, `Behavioral Policies`) were moved back under their parent §2.3 Section Details. No wording, table, threshold, date annotation, or invariant was changed.

This document specifies how Markus constructs prompts and keeps them cacheable, and how it orchestrates LLM interactions across all scenarios. It complements [state-machines.md](./state-machines.md) (task lifecycle), [memory-system.md](./memory-system.md) (storage layers), and [cognitive-architecture.md](./cognitive-architecture.md) (deterministic context assembly).

---

## 1. LLM Call Taxonomy

### 1.1 Two-Tier Call Model

LLM calls are organized in two tiers:

**Tier 1 -- (retired)**: the former Cognitive Preparation calls (Appraisal / Reflection / Evaluation) were **removed** — they were extra LLM calls before the main call. Context preparation is now **deterministic (no LLM)**: a small bounded block (recent activity + working-memory keys) plus the ContextEngine's own relevant-memory retrieval. Deeper recall is agent-driven via `memory_search` / `kb_search`.

| # | Phase | Status |
|---|-------|--------|
| P1 | **Appraisal** | **removed** — replaced by deterministic assembly |
| P3 | **Reflection** | **removed** |
| P5 | **Evaluation** (D3) | **removed** |

P2 (Directed Retrieval) and P4 (Assembly) are code-only phases with no LLM call.

**Tier 2 -- Main Processing Calls**: The primary LLM calls that produce agent actions and responses. These use the full model and have access to tools.

| # | Scenario | Entry Point | Method | Streaming | Tools | Network Retry | Loop Limit |
|---|----------|-------------|--------|-----------|-------|---------------|------------|
| 1 | **Human Chat** (non-stream) | API `/api/agents/:id/chat` | `handleMessage()` | No | Yes | Yes | 200 (safety net) |
| 2 | **Human Chat** (stream/SSE) | API `/api/agents/:id/chat?stream=1` | `handleMessageStream()` | Yes | Yes | Yes | 200 (safety net) |
| 3 | **Task Execution** | `TaskService.runTask()` → `_executeTaskInternal()` | `llmRouter.chatStream()` | Yes | Yes | Yes | **None** |
| 4 | **Respond-in-Session** | API `/api/agents/:id/sessions/:sid/messages` | `respondInSession()` | Yes | Yes | Yes | 200 (safety net) |
| 5 | **Heartbeat** | `HeartbeatScheduler` → `handleHeartbeat()` | `handleMessage(scenario:'heartbeat')` | No | Subset | Yes (via handleMessage) | 200 + 3 retries |
| 6 | **A2A Chat** | API `/api/agents/:id/a2a` / channel routing | `handleMessage(scenario:'a2a')` | No | Yes | Yes (via handleMessage) | 200 |
| 7 | **Comment Response** | Mailbox `task_comment` / `requirement_update` | `handleMessage(scenario:'comment_response')` | No | Yes | Yes (via handleMessage) | 200 |
| 8 | **Internal (Lightweight)** | Various | `handleMessage(scenario:'heartbeat')` | No | Varies | Yes (via handleMessage) | 200 |

**Cognitive depth (retired)** — the former D0–D3 ladder (`selectCognitiveDepth`) decided how many
Tier 1 calls preceded each Tier 2 call. It belonged to CPP and is **gone**: **every** Tier 2 call
now runs with **zero** preceding Tier 1 LLM calls; context is assembled deterministically instead.

### 1.2 Lightweight Internal Calls (Scenario 8)

These are `handleMessage()` calls with `scenario: 'heartbeat'` and typed session IDs (e.g. `sys_<agentId>_<ts>`). Each call creates a persisted session for full traceability.

| Sub-scenario | Trigger | Session ID Pattern | Purpose |
|-------------|---------|-------------------|---------|
| **Daily Report** | `consolidateMemory()` (once/day) | `sys_<agentId>_<ts>` | Generate brief status report → `daily-logs/` |
| **Memory Flush** | turn-level preflight when context usage is high (see [tool-loop-harness.md](./tool-loop-harness.md) §5.7) | `sys_<agentId>_<ts>` | Prompt agent to `memory_save` important info before the context window fills |
| **LLM Summarizer** | `contextEngine.smartSummarizeAndTruncate()` | N/A (internal) | Compress older conversation messages into a summary (no tools) |
| **Dream Consolidation** | `consolidateMemory()` (once/day, ≥50 entries) | `sys_<agentId>_<ts>` | LLM reviews memory entries, outputs prune/merge plan (no tools) |

---

### 2.0 Cache-Scope Layout Principle (design philosophy)

**The rule.** Prefix caches are *byte prefixes*: the first byte that differs discards
everything after it (Anthropic, OpenAI, DeepSeek, AWS, vLLM, SGLang all cache by leading
token sequence; DeepSeek's unit is 64 tokens and it is automatic). Therefore the request
must be ordered by **sharing scope, widest first** — content shared by more concurrent
requests must physically precede content shared by fewer.

Ordering by *stability alone* is not enough. Two agents can each be perfectly stable and
still share **nothing**, because their divergence point sits at byte 0. Stability decides
*when* a byte changes; scope decides *how many requests pay for it*.

The request is laid out in five scopes:

| Scope | Shared by | Content | Change cadence |
|---|---|---|---|
| **U** Universal | every agent in the installation | platform L0: Tool Usage, Search & Exploration, Learning Habits, Autonomy, Model Routing, Tool Error Recovery, Security, Referencing, User Language, Collaboration Rules, Task Workflow, Prompt Composition, Handbook | per release |
| **O** Org | every agent in the org | org context (`CONTEXT.md`), `## About the Owner` (`USER.md`) | days–weeks |
| **A** Agent | one agent | ROLE.md persona, policies, identity, workspace paths | per config |
| **S** Session | one session | trust level, environment probe, scenario instructions | per session |
| **V** Volatile | one LLM call | task board, knowledge, notebook, skills, team status, mailbox | per call (history tail) |

**Corollary 1 — the divergence point is the design target.** The system `text` is emitted
as two breakpoint segments. Segment 1 is **scope U only**; segment 2 carries A/S (and the
org/team blocks). For N agents, segment 1 is then *one* shared cache entry plus N short
agent-specific suffixes, instead of N fully independent entries.

**Corollary 2 — tools are prefix too.** Tool schemas serialise ahead of the messages on
OpenAI-compatible providers, so the `tools` array must also be *common-core-first* and
byte-stable per session (§2.1.1 inv. 6, §7).

**Corollary 3 — scope is decided by *who shares it*, not by subject matter.** `## About the
Owner` reads like agent context but is org-scoped. `## Your Environment` is session-scoped
even though most of it is machine-constant, because one field (free disk) churns.

**Corollary 4 — a scope's churn must not exceed its tier.** Any byte that changes faster
than its tier's cadence demotes the rest of that tier *and every later tier* to a cache
miss. Two live leaks of this kind were measured on 2026-09-16 across 30 agents / 901 calls:

| Leak | Effect |
|---|---|
| `ROLE.md` (agent-private) emitted as the **first bytes** of the system prompt, ahead of the ~19.7k-char universal L0 block | **cross-agent prefix overlap = 2–3 chars / 30k+ ≈ 0.0 %** |
| `## Your Environment` carrying a live `diskFreeMB` figure, and `docker --version` probes that intermittently timed out | only **4 of 150** consecutive same-agent call pairs were byte-identical |

**Corollary 5 — measure, or the invariant rots.** The only reason these survived four
audit rounds is that no cache-hit telemetry existed to falsify the "cache-friendly"
comments in the code. Every rule in §2.1.1 therefore ships with a guard test, and cache
hit rate is recorded per session ([context-assembly.md](./context-assembly.md) §3.9, RC4).

---

## 2. System Prompt Architecture

The system prompt is built by `ContextEngine.buildSystemPrompt()`. Under **Scheme A**, the
system prompt (`text`) is split into **two tiers**, both **byte-stable**; and all per-call
dynamic content is moved **out of the system prompt entirely** into a volatile tail message.

```
╔══════════════════════════════════════════════════════════╗
║  SYSTEM `text` — BYTE-STABLE (every segment = breakpoint)║
║  Identical byte-for-byte across turns for the same agent.║
║  This byte-stability IS the implicit prefix-cache key.   ║
║                                                          ║
║  TIER 1 — STABLE · SCOPE U (UNIVERSAL)                   ║
║   Byte-identical for EVERY agent (shared cache entry).   ║
║   Tool Usage / Search & Exploration / Learning /         ║
║   Autonomy / Model Routing / Tool Error Recovery /       ║
║   Security / Referencing / User Language /               ║
║   Collaboration Rules / Task Workflow / Prompt           ║
║   Composition / Platform Handbook.                       ║
║   ⟂ No agent-varying branch may appear here (§2.0 cor. 3)║
║                                                          ║
║  TIER 2 — SEMI-STABLE (cache_control: ephemeral ✓)       ║
║   SCOPE A (agent) FIRST: Role.md persona · Policies ·    ║
║   Identity · Workspace · Trust                           ║
║   then SCOPE O/T: Org (CONTEXT.md) · Team Announcements  ║
║   & Norms · User Profiles · Env · Scenario (LAST) ·      ║
║   Team Data Directory · Activated-skills body            ║
║   (agent-written memory — knowledge.md           —      ║
║    is NOT here: it rides the volatile tail, see §2.1.1)  ║
╚══════════════════════════════════════════════════════════╝
╔══════════════════════════════════════════════════════════╗
║  VOLATILE TAIL — `[SYSTEM] [Live context]` (NOT system)  ║
║  one `role: user` message appended as the LAST message,  ║
║  AFTER all history. Only this tail changes per call     ║
║  → cache across system+history persists.                ║
║   contextHint ([CONTEXT x% used …]) · Relevant Memories  ║
║   Channel History (recent msgs) · Date/locale · Mailbox  ║
║   & attention · Team Status · Working Memory ·           ║
║   Cognitive/Notebook context · task board · deliverables ║
║   · deferred-tool catalog (Afford.S2)                    ║
║   · Your Knowledge (knowledge.md) · Working State        ║
║     (notebook)  ← agent-written, see §2.1.1 inv. 5       ║
╚══════════════════════════════════════════════════════════╝
```

### 2.1 KV-Cache Optimization Strategy

`buildSystemPrompt()` returns `{ text, segments, volatile }` under **Scheme A**: `text` is a byte-stable, two-tier system (Tier 1 STABLE + Tier 2 SEMI-STABLE); all per-call dynamic content lives in `volatile`, assembled by `prepareMessages()` into a single `[SYSTEM] [Live context]` message (role `user`) appended as the **last message of the request** (after all history). Details:

1. **Tier 1 (Stable)**: Role, policies, tool usage rules, communication rules, collaboration rules. Scenario-free — stay cached across ALL mode switches (chat ↔ heartbeat ↔ a2a ↔ deliberation). A cache breakpoint after this tier caches this prefix across all calls.

2. **Tier 2 (Semi-stable)**: Identity, org context, workspace paths, scenario instructions last. Change on org/config events (days–weeks), but stay stable within a session. Scenario placed last keeps the identity/org prefix stable across mode switches (OpenAI benefit). A breakpoint here caches the combined Tier 1+2 prefix. These two tiers together form the byte-stable system `text`. **Agent-written memory (knowledge.md, NOTEBOOK.md) is deliberately NOT in this tier** — see §2.1.1 invariant 5.

3. **Volatile tail (Scheme A)** — replaces the old Tier 3: Project/task board, system announcements, feedback, available skills (query-filtered), `## Notebook` (cognitive), relevant memories, team status, channel history, mailbox state, working memory, timestamps, deferred-tool catalog. These change per call and live **outside the system**: `prepareMessages()` assembles them (plus `contextHint`) into one `[SYSTEM] [Live context]` message appended as the **LAST message of the request**. Values are quantized where possible (timestamps to 5-min buckets, mailbox elapsed time to coarse labels, notebook ages to buckets) to reduce churn. Sitting in the **history tail** rather than in the system message means changing it never invalidates the byte-stable system + history prefix (implicit prefix-cache on OpenAI-compatible providers).

   > **Placement is load-bearing — it must be the LAST message.** Do NOT "insert it just before the current query": inside an agent tool loop the last user message is the ORIGINAL task instruction (index 1) — every later turn is assistant/tool — so that insertion point is actually the *front* of the history. Rewriting `messages[1]` every turn broke the byte-identical prefix right after `system` and re-billed the entire replayed history on every LLM call (measured on real logs: 46% prefix reuse instead of 79%, ~90k tokens re-sent per call).

**Message-level cache breakpoints**: In addition to system caching, a `cacheBreakpoint` is placed on
the last message before the current turn in the conversation history, letting providers (e.g.
Anthropic) cache the stable conversation prefix independently of new messages.

**Channel session reuse**: A2A and group chat messages sharing a channel reuse a stable session ID
(`channel_{channelKey}_{agentId}`); history accumulates and only the delta is added on later turns.
Channel history is injected as part of the volatile `[Live context]` tail, not prepended into
history — preserving conversation-prefix cache stability.

**Tool definition caching (Anthropic)**: The last tool in the `tools` array is marked with
`cache_control: { type: 'ephemeral' }`, caching the (deterministically registry-ordered) tool
definitions prefix.

**Dynamic value quantization**: Several dynamic fields use coarse labels to reduce churn: notebook
entry ages (`just now`, `recent`, `~Nh ago`), mailbox elapsed labels (`just started`, `a few minutes`,
`~Nmin`), timestamps drop seconds (minute-level). Coarser timestamp buckets were rejected — the tail
has many other per-call fields, so the marginal benefit did not justify inaccurate time perception.

### 2.1.1 Prefix-cache invariants (regression-tested)

The implicit prefix cache is **byte-prefix based**: the first byte that differs throws away
everything after it. That makes four things invariants rather than preferences. Each has a
guard test; break one and long sessions silently re-bill their whole history on every call.

| # | Invariant | Where | Guard test |
|---|-----------|-------|-----------|
| 1 | The volatile `[Live context]` block is the **last message** — never inserted at `messages[1]` | `context-engine.prepareMessages` | `context-engine.test.ts` → `C-cache-volatile-tail`, `C-cache-volatile-stable-head` |
| 2 | The request-history window **slides in blocks**, not per message | `history-window.ts` (`requestHistoryStart`), used by every `Agent.requestHistory()` call | `history-window.test.ts` |
| 3 | The deferred-tool catalog (Afford.S2) rides the **volatile tail**, never the system prompt | `Agent.consumeDeferredToolCatalog()` + `mergeVolatile()` | `agent-deep.test.ts` → `deferred-tool catalog placement` |
| 4 | ContextOS `[SLOTS]` + `[CONTEXT SUMMARY]` are **derived in the engine**, so every prepare path carries them | `context-engine.prepareMessages` defaults from `(memory, sessionId)` | `context-engine.test.ts` → `ContextOS slots + summary ride EVERY prepare path` |
| 5 | Agent-written knowledge / state (`## Your Knowledge`, `## Notebook`) ride the **volatile tail**, never Tier 2 | write-frequency tier boundary, below | `cache-optimization.test.ts` → `C-cache-knowledge-body`, `C-cache-knowledge-write` |
| 6 | The `tools` array is **byte-stable per session** — no per-turn counts, dynamic lists, or selection-derived content in any tool `description` / `inputSchema` | `tool-selector.ts` `buildDiscoverTool` (registry-derived, sorted) | `tool-selector.test.ts` → `CACHE: discover_tools description is byte-stable …` |
| 7 | When volatile state **changes**, it is also persisted as a replayable `[SYSTEM] [State checkpoint]` (append-only ⇒ cache-extending) | `context-engine.prepareMessages` | `context-volatile-gating.test.ts` → checkpoint describe |
| 8 | The system prompt is emitted in **scope order, widest first**: the universal (scope-U) block comes FIRST and is **byte-identical for every agent**; agent-private persona/policies are emitted *after* it | `context-engine.buildSystemPrompt` (`stable` vs `agentPersona` → head of `semiStable`) | `context-cache-scope.test.ts` → *two different agents produce a byte-identical scope-U segment* |
| 9 | **No agent-varying branch may appear inside the universal block.** A condition on agent state (skills, team, config) is a divergence point for the whole install | `context-engine.buildSystemPrompt` (the old `hasBrowserSkill` branch was the counter-example) | `context-cache-scope.test.ts` → *a browser-skill difference does NOT fork the universal block* |
| 10 | Session-scoped sticky tool state (`recent`/`activated`) is **monotonic within a session** (grows, never evicts) and **reset on session switch** — the emitted `tools` schema warms up and then stays byte-stable | `Agent.stickyTools()` (`toolSticky`, keyed by session) | `tool-selector.test.ts` (schema stability) + agent tool-loop tests |
| 11 | Byte-stable tiers may only contain **quantized** values — anything that churns faster than its tier (free disk, precise timestamps, live counts) must be quantized, moved to the volatile tail, or removed | `buildEnvironmentSection` (disk → 10 GB bands), `environment-profile.ts` (probe retry) | `context-cache-scope.test.ts`; env drift measured at offset 30228 on 2026-09-16 |
| 12 | Assembly state that is **keyed by session** must also be **stored per worker** (`SessionWorkspace`), never on the `Agent` instance | `Agent.stickyTools()`, `Agent.activatedSkills()` → `SessionWorkspace.toolSticky` / `.activatedSkills` | `agent-worker-scoped-state.test.ts` |
| 13 | A scenario emitted by the caller is **authoritative**; the engine may *normalize* it (channel-derived) but must never clobber it. Every scenario block declares (a) output visibility, (b) the tool that reaches a human, (c) the silence rule | `context-engine.buildScenarioSection` + `prepareMessages` normalize; `agent.ts` `a2a_message` default | `context-scenario-matrix.test.ts` |

**Invariant 6 — why tools dominate the risk.** Measured on a live agent tail:
`fixed 19660 (system 8618 + tools 11042)` — the **tool schemas cost more than the
entire system prompt**, and they serialise *ahead* of it, so one byte of drift
there invalidates system + all replayed history. `discover_tools.description` used
to embed the *unloaded* remainder (`allTools − alreadySelected`), so its sample
names and its `… +N` tail tracked the per-turn keyword selection and changed on
nearly every call — under a comment that claimed it was cache-friendly. It is now
derived from the tool **registry** (minus `TOOL_DEF_CORE_KEEP`) and sorted, so it
changes only when a tool or skill is genuinely installed or removed. This is also
what `tool-system.md` §1.0.1 already required (`MUST NOT` append a catalog to
`discover_tools.description`); the code had been violating its own spec.

**Invariant 7 — why a checkpoint and not just "re-send less".** See §2.1.2: the
tail is ephemeral and is not replayed, so gating alone *lost* information. The
checkpoint restores completeness while keeping the token saving, because an
append-only message extends the cached prefix instead of being re-billed per call.

**Invariant 2 — request-history window.** A raw `getRecentMessages(id, N)` returns the *last N*
messages, so once a session is longer than N the window head moves by 1–2 messages **every turn**
and the whole replayed history misses the cache. The fix is quantization, not a bigger N: keep at
least `SESSION_REQUEST_HISTORY_MIN` (400) messages and advance the window start only in
`SESSION_REQUEST_HISTORY_BLOCK` (100) steps, so the head — and therefore the whole replayed prefix —
stays byte-identical for ~50 turns. Per-call token packing still bounds the prompt (the budget path
compresses/trims independently), and storage-level compaction
(`SESSION_STORAGE_COMPACT_TRIGGER` 2000 / `KEEP` 1000) remains the deliberate, rare anchor shift
every ~1000 messages.

**Invariant 4 — why it matters.** Only the non-stream chat path used to pass `slotsSegment` /
`summarySegment` explicitly. The streaming path, every tool-loop continuation, and the
task/review/session scenarios silently dropped `session_pin` anchors **and** the
`[CONTEXT SUMMARY]` compaction anchor. Deriving them inside `prepareMessages` makes it impossible
for a new call site to forget them.

**Invariant 5 — agent-written memory/knowledge belongs to the volatile tail.** `## Your Knowledge`
(knowledge.md) and `## Notebook` (NOTEBOOK.md) are **agent-written** and change far more
often than "semi-stable" implies: `memory_save` appends to `## _observations` on *every* call, and
`memory_update` rewrites curated sections. While they sat in the byte-stable Tier 2, every one of
those writes invalidated the cached prefix for the **entire replayed history** — a high-frequency
cache buster hiding inside the tier whose whole justification is "changes only occasionally".
Measured on this org's 91 agents: 498 accumulated `_observations` lines (36 agents), i.e. 498
full-prefix invalidations since the last prune, plus every `memory_update`.

The tier boundary is therefore **write frequency, not subject matter**:

| Block | Written by | Frequency | Tier |
|-------|-----------|-----------|------|
| `## Your Knowledge` (knowledge.md) | the agent (`memory_save`/`memory_update`) | many× per task | **volatile** |
| `## Notebook` (NOTEBOOK.md) | the agent | per task | **volatile** |
| Relevant memories, notebook, mailbox, task board, team status | platform | per turn | volatile |
| `## About the Owner` (USER.md), org/team context, workspace paths, team announcements/norms, `## Your Trust Level` | humans / org config | days–weeks | Tier 2 (cached) |
| Role, policies, tool-usage rules, Learning Habits | repo/build | only on release | Tier 1 (cached) |

**The trade-off, stated honestly:** volatile tokens are never prefix-cached, so the move is not
free — it costs up to `KNOWLEDGE_PROMPT_MAX_TOKENS` (1 500; 1 200 converse; 0 reflex) extra
full-price tokens **per call**. It is worth it because the alternative was a full-history re-bill
(~30k–90k tokens, depending on window) **per memory write**: the crossover is roughly one write per
50 calls, and active agents write memory several times per task. Keeping knowledge cached only wins
for an agent that never learns anything.

Guard tests: `cache-optimization.test.ts` → `C-cache-knowledge-body`, `C-cache-knowledge-write`
(the latter asserts that a `memory_save` leaves `result.text` byte-identical while still reaching the
model through `result.volatile`). Both were verified to FAIL against the old Tier-2 placement.

### 2.1.2 ContextOS v2 — change-gated volatile delivery (2026-09-16)

**Problem.** The volatile tail used to be re-sent **in full on every LLM call**.
Inside a single user turn a tool loop can issue 60+ calls, so the blob
(~7 800 chars) was re-delivered verbatim each time. Measured on
`sess_1789536167018_dxnmco` (66 calls, one user turn, `inputTokens` 24 481 → 269 168):

- consecutive-call similarity of the compiled tail: **0.9989**
- one persistent fact (`worker 2 is working on the same topic`) was re-delivered **66×**
- the assistant went on to re-narrate that same fact in **3 separate iterations**
  and re-emitted identical progress-recap lines **×4 / ×3 / ×2**

Root cause: a tail message is read as the *newest user input immediately before
generating*. Re-stating unchanged background therefore reads as the user
repeating themselves — and the model answers by repeating itself.

**Policy.** Placement is unchanged (still the last message, so the system +
history prefix keeps hitting the prefix cache); only *what the tail carries*
changed:

| Situation | Tail content |
|---|---|
| First call of a user turn | water-level hint + **all** volatile sections (full) |
| A section's content hash changed | hint + that section in full; the rest digested |
| Nothing changed | hint + one-line digest naming the omitted sections |
| ≥ `CONTEXT_VOLATILE_REARM_CALLS` (8) calls since the last full refresh | hint + **all** sections (forced re-arm) |

Branch key: `isFirstCallOfTurn = !messages.slice(turnStart + 1).some(m => m.role === 'assistant')`.
Section identity: `sha1(body).slice(0,8)`, held in the engine's bounded
per-session map (`VOLATILE_SNAPSHOT_MAX_SESSIONS = 64`).

**Completeness invariant (v3, 2026-09-16 — supersedes the v2 wording).**
`isFirstCallOfTurn` is kept *deliberately*: a turn boundary is a fresh decision
point, and the tail is ephemeral (see below), so a full refresh there is a real
guarantee rather than redundancy.

The v2 note claimed "content is never *permanently* hidden: … every new user turn
starts from a full snapshot". That reasoning was **wrong**, and the mechanism
below is what makes the claim true now.

> **The volatile tail is ephemeral and is never replayed.**
> `[SYSTEM] [Live context]` is produced only in `context-engine.ts` and appended to
> the *outgoing* request; it is **never written back to the session store**
> (verified: `agent.ts` persists only real user text, assistant replies, tool
> results and continuation prompts). It therefore **does not appear in the next
> call's replayed history.** An LLM has no memory across calls beyond what is
> replayed, so under pure change-gating an omitted section was genuinely *gone*
> from the model's context until the next re-arm. Gating on its own was a
> completeness **regression** against the original re-send-everything design.

**Fix — durable state checkpoints.** Whenever the state actually changes (or on
the first call of a session, when no snapshot exists yet), `prepareMessages`
appends a `[SYSTEM] [State checkpoint]` message carrying the **full** current
state to durable session history, in addition to putting the fresh sections in
this call's tail:

- **Complete** — the newest checkpoint is replayed on every later call, so
  omitting an unchanged section from the tail no longer removes it from context.
- **Cheap** — the checkpoint is *append-only*, so it extends the cacheable prefix
  instead of being re-billed on every call. Older checkpoints are superseded
  (last-write-wins) and are folded away by the normal compaction path.
- **Single choke point** — written inside `prepareMessages`, not at the ~8 call
  sites, so a new call site cannot forget it (same rationale as the
  slots/summary derivation in [context-assembly.md](./context-assembly.md) §3.7).
- **Best-effort** — a persistence failure logs a warning; that call's tail still
  carries the state verbatim, so the agent is never blind.
- Recognised by `isSyntheticMessage()`, so a checkpoint never counts as a user turn.

**The digest must state where the content lives.** The v2 wording was "Act only on
the sections shown above" — false whenever nothing changed, because the tail then
carries *only* the digest and there is nothing shown above. The v3 text names the
`[SYSTEM] [State checkpoint]` history message explicitly and labels the block as
reference material that must not be re-announced.

**Relative-time labels must not break the gate.** `hashSection()` hashes a
*normalised* body: `(7h ago)`, `(23m ago)`, `(just started)`, `(2 days ago)` all
collapse to `(age)`. `## Notebook` renders entry ages, so hashing the raw body
made the gate fire — re-sending ~12 KB and persisting a redundant checkpoint —
every time an age label rolled over its hour bucket.

**Regression guards**: `context-volatile-gating.test.ts` (gating, checkpoint
persistence, label normalisation), `context-engine-cache-v3.test.ts`
(knowledge selection).

**Transient harness prompts are deduped** (`dedupeTransientPrompts`).
`[Continue from where you left off …]` and `[SYSTEM] Loop detected: …` are
appended to *durable* memory by the agent loop, so they stack up (observed: 4
copies of the continuation prompt plus a loop warning in one session). They are
negative instructions ("do not repeat") — the pattern LLMs handle worst — and
each copy counts as a `user` turn, corrupting `findCurrentTurnStart` and
cache-breakpoint placement. `prepareMessages` now collapses each family to its
latest copy. The transform is pure and deterministic, so the byte-identical
prefix is unaffected.

**Regression guard**: `packages/core/test/context-volatile-gating.test.ts`.

**Resolved in v2.1** — see [context-assembly.md](./context-assembly.md) §3.8. A single turn issuing 60+ LLM calls is now
folded in place: when the absolute history ceiling trips, the fold boundary is
the END of history instead of the current turn start, so the same block-wise fold
reaches inside the current turn. No separate intra-turn code path was needed.

**Sample-size caveat.** The similarity/repeat figures come from one 66-call
session. Treat them as an existence proof of the failure mode, not as a
population statistic.

**References**
- DeepSeek KV-cache guide — prefix must match from token 0; a mid-context rewrite
  invalidates the suffix. <https://api-docs.deepseek.com/guides/kv_cache/>
- Manus context engineering — keep the prefix stable, append-only, and do not
  give the agent "a few-shot of itself". <https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>
- Negation is the weakest instruction form in LLMs. <https://aclanthology.org/2023.starsem-1.10/>

### 2.2 Spec: injection-point ownership audit (C3)

The tiering above is the intended design; this spec makes it an enforced invariant so a new
injection point cannot silently land in a stable tier and bust the cache prefix.

- **Behavior**: every prompt injection point has an explicit owner. Identity, policies,
  tool-usage rules → **Tier 1 (stable)**. Org/workspace/scenario/announcements/norms/
  activated-skills/user-profile/trust → **Tier 2 (semi-stable; written on org/config events)**.
  Agent-written memory (`## Your Knowledge`, `## Notebook`) → **volatile** (§2.1.1
  invariant 5). All per-call situational meta (the deterministic `## Cognitive Context` block,
  triage decision, mailbox state, task board, timestamps, relevant memories, team
  status, query-filtered skills, working memory, contextHint) → **volatile tail (the `[Live
  context]` message), never in any system segment**.
- **Invariants**:
  - The system `text` (all segments) contains **no** per-call varying content (cognitive-context/triage/notebook/
    mailbox/task/date/skills markers appear only in the `volatile` tail).
  - Every system segment carries a `cacheBreakpoint`; the deterministic `## Cognitive Context`
    block and `## Relevant Memories` ride the `volatile`/dynamic tail, never a stable
    system-prompt section (see [cognitive-architecture.md](./cognitive-architecture.md) §3).
- **Note — CPP retired; the deterministic block is always injected**: the deterministic situational
  block (recent activity + working-memory keys) is now **always** injected as the `## Cognitive
  Context` section — there is no CPP toggle and no pre-call LLM (see §1.1). It is **complementary
  to, not mutually exclusive with**, the ContextEngine's relevant-memory retrieval: in the same turn
  both `## Cognitive Context` and `## Relevant Memories` are injected when available.
- **Design rationale**: dynamic content in the byte-stable system prefix invalidates every downstream
  cache hit; Scheme A keeps it in the volatile **history tail**, preserving prefix reuse across mode
  switches (Anthropic explicit + OpenAI/DeepSeek implicit).
- **Testing** (`packages/core/test/cache-optimization.test.ts` — the "C3:" cases): with a
  prompt carrying a deterministic `## Cognitive Context` block, mailbox/attention meta, channel history, sender identity and a
  timestamp, assert (a) **every system segment is a cache breakpoint and carries no dynamic marker**,
  (b) those markers appear only in `volatile`, (c) identity / tool-usage rules stay in the stable
  prefix while the **agent-written knowledge body stays OUT of it** (`C-cache-knowledge-body`) and a
  `memory_save` leaves the system text byte-identical (`C-cache-knowledge-write`), and (d) the
  deterministic `## Cognitive Context` block rides the volatile tail rather than being injected as a stable system-prompt section,
  and (e) two turns with different per-turn context yield byte-identical `text` but different
  `volatile`. The cache-hit-rate metric is tracked separately (see
  [architecture.md §11.1](./architecture.md) observability).
- **Status**: implemented (Scheme A — volatile tail; adds the enforcing guard tests, the
  byte-stability regression, and the `usage.compressed`-driven cache/compression metrics).

### 2.3 Section Details

#### Role System Prompt (§1)
Source: `role.systemPrompt` parsed from the agent's `ROLE.md`.  
Contains the core behavioral instructions, personality, and domain expertise.

#### Your Knowledge (§14)
Source: `memory.getLongTermMemory()` — curated sections from `knowledge.md` (legacy `MEMORY.md` is migrated once and not written afterward).
The `## _observations` buffer is **excluded** from the prompt; observations are surfaced via `memory_search`, the ContextEngine's deterministic relevant-memory retrieval, or mechanical relevance matching (written to Notebook as `relevant-context`). This section represents the agent's consolidated long-term knowledge — procedures, conventions, domain facts the agent maintains via `memory_update`.

#### Dynamic Context — Notebook (§21)
Source: `getDynamicContext()` — three sources:
1. **Registered providers**: Callback functions set via `registerDynamicContextProvider()`.
2. **Activated skill instructions**: When an agent calls `discover_tools` to activate a skill, its instructions are wrapped in `<skill name="...">...</skill>` tags and injected here.
3. **Notebook**: Persistent cognitive workspace from `NOTEBOOK.md`, rendered as `## Notebook`. Each entry shows its key, age label, and managed type tag:

| Tag | Writer | Typical keys |
|-----|--------|--------------|
| `agent` | `notebook_upsert` / `notebook_clear` | Agent-chosen keys (priorities, blockers, decisions) |
| `system` | Runtime (triage, mechanical retrieval) | `triage-decision`, `relevant-context` |

**Bounding ([memory-system.md](./memory-system.md) §2).** The block is bounded on four independent axes, because each alone is insufficient:

| Axis | Limit | Failure it prevents |
|------|-------|---------------------|
| Entry count | 16 total, 4 `agent` | "26 entries against a nominal cap of 4" — three of four writers bypassed the cap and the load path trimmed nothing |
| Per-entry chars | 6000 (1500 for `relevant-context`, `NOTEBOOK_RELEVANT_CONTEXT_MAX_CHARS`) | one 9 475-char entry — more than the whole block budget — crowding every real note out |
| Total block chars | 6000 | the block reaching 41 % of the volatile tail |
| TTL | `agent` 96h / `system` 24h | month-old situational state (`triage-decision`) re-injected as current fact |

Overflow is handled by **inline truncation**, not omission: an entry too large for the remaining budget is sliced with a `_[truncated]_` marker rather than dropped whole, and any entry that still cannot be shown appears in a sorted index line. So the agent always sees that a note exists (and can `file_read` NOTEBOOK.md) instead of it vanishing silently.

**Ordering is deterministic**: `updatedAt` DESC with a `key` ASC tie-break. Ranking matters for staleness; determinism matters for caching — for the same logical state the block must serialize to the same bytes, or every assembly dirties the volatile tail and re-bills those tokens. (Map insertion order did neither: evict + re-insert permuted the block.)

The `notebookWriter` dual-destination was **removed**: relevance-matched memories are injected **only** for the current turn as `## Relevant Memories`, and a small deterministic `## Cognitive Context` block (recent activity + working-memory keys) may be injected — neither is written to Notebook. Notebook holds only deliberate working state. See [memory-system.md](./memory-system.md).

The legacy notebook aliases `update_working_memory` / `clear_working_memory` were **removed** — use `notebook_upsert` / `notebook_clear`.

#### Content layers (availability tiers: which content is always on vs on-demand)

| Layer | Content | When |
|-------|---------|------|
| **L0** | Role, tool rules, search, **Learning Habits** (≤1600 chars; look-back / encode-where / skill impact — [learning-loop.md](./learning-loop.md) §8), autonomy, security, resource refs, user language, shortest task workflow | Always (non-dream) |
| **L1** | Identity (capped roster), org/workspace, knowledge, active tasks | Identity always; tasks when present |
| **L2** | Skill catalog metadata (name + one-line description) | Always via identity / discover_tools |
| **L3+** | Skill full bodies, Error Recovery, Quality Gates, full Task Workflow, deliverable format | `discover_tools` activate, or scenarios: `task_execution` / `review` / `deliberation` / `comment_response` |

> **SSOT**: Budgets, packs, and afford fail-closed rules live in [agent-runtime.md](./agent-runtime.md). The sections below are normative Spec supplements.

#### Identity Section (§7)
Source: `buildIdentitySection()`.  
Contains:
- Agent name, role, position (manager vs worker)
- Assigned skills (names only — activate via `discover_tools` for full instructions)
- Organization name, Agent ID
- Manager info (for workers)
- Colleague list capped at `SYSTEM_COLLEAGUES_MAX` (10); remainder via `team_list` / `agent_list_colleagues`
- Other teams capped at `SYSTEM_OTHER_TEAMS_MAX`; humans at `SYSTEM_HUMANS_MAX`
- **Manager Responsibilities** (for managers): player-coach — own Owner pair-work when ROLE fits; delegate for specialty/parallel/async; Reporting; Cross-team (peer managers); Escalation; Hiring

#### Skills (Hermes L0–L1 progressive disclosure)
Skill **full bodies are not injected at spawn** (including former `alwaysOn` builtins and
assigned skills). The catalog lists name + description; agents call
`discover_tools({ name: [...] })` to load `<skill>` instructions into the volatile tail
context. MCP servers for assigned skills still connect at spawn (tools only).

#### Task Board (§23)
Source: `opts.assignedTasks`.  
Displays the agent's active tasks and team tasks, **capped to prevent prompt bloat**:
- **My active tasks**: Top 15 by priority (critical → high → medium → low), each with title, ID, priority, and truncated description (150 chars).
- **Team tasks**: Top 10 by priority, with title, ID, assignee, and priority.
- Overflow is indicated with a count and a hint to use `task_list` for the full list.
- Completed/closed tasks are only shown as a count.

#### Mailbox & Attention Context (§26)
Source: `getMailboxContext()` → `buildMailboxSection()` in `ContextEngine`.  
Every LLM call passes through the mailbox, so this section is always populated. It injects:
- **Current focus**: What the agent is currently working on (item type, summary, time elapsed).
- **Pending queue**: Count and top items in the mailbox, so the agent knows what's waiting.
- **Recent decisions**: Last 3-5 attention decisions (continue/preempt/cancel/merge/defer) with reasoning. The `preempt` decision means current work was **paused** (deferred for later resumption); the `cancel` decision means current work was **permanently stopped**.
- **Merged content**: If a `merge` decision injected additional context (e.g., a comment on the current task), it appears here.

In addition to the passive `## Your Attention State` section, agents can query
their mailbox on demand using `check_mailbox` in any scenario.

**Triage context budget** is generous — up to 20 recent messages × 2000 chars each, plus full item content (3000 chars per candidate) and the agent's active task list. Tens of thousands of tokens are acceptable for triage because accurate prioritization decisions save far more cost downstream. The triage LLM can also invoke a curated set of **read-only tools** (`task_list`, `task_get`, `requirement_list`, `requirement_get`, `list_projects`, `team_list`) to gather additional context before deciding. These are controlled by `TRIAGE_ALLOWED_TOOLS` and `TRIAGE_MAX_TOOL_ITERATIONS` in `limits.ts`.

**Task status notifications** are purely informational — the system's side-effect mechanism handles all actions (execution start/cancel, reviewer notification, dependency unblocking). Agents are instructed not to send redundant A2A messages for routine status changes.

All 12 mailbox item types (`human_chat`, `task_status_update`, `session_reply`, `daily_report`, `memory_consolidation`, `heartbeat`, etc.) route through this section. Internal agent processes like heartbeats, daily reports, and memory consolidation also enqueue to the mailbox, meaning the agent always has full situational awareness about its own cognitive state. See [mailbox-system.md](./mailbox-system.md) for the full design.

#### Concurrency Context (volatile tail)
Source: `buildSystemPrompt()` with `opts.concurrentContext` in `ContextEngine`.
Injected **only** when concurrent processing is enabled *and* `workerCount > 1` (see
[concurrent-processing.md](./concurrent-processing.md)). It is a **volatile-tail** segment,
never a system-prompt section, so its per-turn churn cannot invalidate the STABLE /
SEMI-STABLE prefix cache. It injects:
- **Worker identity**: "this session is one of N workers (worker W)".
- **In-flight siblings**: up to 4 recent `declared`/`fact` handoff records from *other* workers (own records filtered out).
- **Recent handoffs**: up to 4 `done`/`conflict` records from other workers, newest first.
- **Consistency rules**: (1) do not assume exclusive cognition — check shared knowledge + handoff log before any persistent decision; (2) an entity is processed by one worker at a time — do not force work whose entity is held; (3) on a detected conflict, report the divergence instead of silently overwriting.

The data comes from the agent's `ConcurrentHandoffLog`; the injectable subset is bounded
by `HANDOFF_CONTEXT_LIMIT` (8).

#### Scenario Section (§15)
Source: `buildScenarioSection()`.  
Placed at the **end of Tier 2** so the identity/org prefix remains stable across mode switches (chat ↔ heartbeat ↔ a2a). Twelve distinct instruction sets depending on `scenario` parameter (see [tool-loop-harness.md](./tool-loop-harness.md) §5.9 for the full matrix). Each scenario is slim and references the global Task Workflow and Tool Usage Rules rather than re-explaining them. Each scenario includes a **Communication channel** paragraph that specifies output visibility and appropriate tools:

| Scenario | Key Instructions | Output Visibility | Communication Tools |
|----------|-----------------|-------------------|-------------------|
| `chat` | Inline immediate-answer work. Sustained implementation → `task_create`. | **Directly visible** to the chatting human (real-time stream) | Speak naturally; `agent_send_message` for agents |
| `task_execution` | Isolated session. Decompose → execute → `task_submit_review`. | Visible in **task execution logs** (Work page) | `notify_user` for critical updates; `agent_send_message` for agents |
| `heartbeat` | Brief check-in: review tasks, retry failures, active goals; at most one-line `memory_save` (no long evolution essays). Inline prompt includes `## Active Goals` when standing goals exist. | **Not visible** to anyone | `notify_user` (only way to reach humans); `agent_send_message` for agents |
| `chat` (evolution child) | User-initiated Remember session ([learning-loop.md](./learning-loop.md) §9): seeded with parent DM transcript + `parentSessionId`; agent follows Learning Habits and may page history via `recall_context(scope=chat_session)`. | Visible to the human in that personal session | Same as chat; high-impact skill/ROLE changes use `request_user_input` |
| `distillation` | Post-task Learning Loop ([learning-loop.md](./learning-loop.md) §2): on **completed** only; Habits encode (memory/skill); `package_install` with §8.3 impact/HITL. No JSON outcome ritual. | **Not visible**; system session | Memory / file encode + skill create/install (approval for high impact) |
| `a2a` | Coordination only. Concise, structured. Complex work → `task_create`. | Visible to **peer agent** only | Reply directly; `notify_user` to escalate to humans |
| `group_chat` | Team group chat channel. Silence by default, @mention routing, processing checklist, reply-in-group rules. | Visible to **all team members** | `agent_send_group_message` for replies; `notify_user` for private escalation |
| `comment_response` | Context-first protocol. Batch awareness (handle bundled comments as one). Use `reply_to_comment_id` for structural quoting. Convergence check before replying. | **Not directly visible** | `task_comment` / `requirement_comment` for thread (with `reply_to_comment_id`); `notify_user` if urgent |
| `deliberation` | Multiple mailbox items — assess before committing. Use `check_mailbox` for full queue inspection; `defer_mailbox_item` / `drop_mailbox_item` for queue management; `notebook_upsert` to record situational assessment; finish with `complete_deliberation`. Goal tools (`goal_create`, `goal_update`, `goal_status`) available. | **Not visible** | Inline handling via deliberation whitelist (`notify_user`, `task_comment`, `agent_send_message`, etc.) |
| `review` | Evaluate deliverable quality against acceptance criteria. | **Not directly visible** | `task_update` for verdict; `notify_user` optionally |
| `memory_consolidation` | Internal memory management. Purely private. | **Not visible**; internal only | No communication tools needed |

#### Referencing Markus Resources

Placed in **Tier 1 (Stable)** (`## Referencing Markus Resources`, near the Deliverable Output Format section). Teaches agents the link conventions the Web UI markdown renderer understands, so references become clickable in chat/comments/reports:

- **Bare ID** in prose (`tsk_…`, `req_…`, `proj_…`, `dlv_…`, `agt_…`, `team_…`) → inline clickable chip (auto-linked by `preprocessEntityIds` in `markdown-utils.ts`).
- **Titled link** `[Title](task:tsk_…)` (types: `task`, `requirement`, `project`, `deliverable`, `agent`, `team`) → chip showing the title.
- **Card**: a reference **alone on its own line/paragraph** renders as a rich block card (icon + title + status + summary) via `EntityCard`. Agents are told to reference a new `dlv_…` on its own line after `deliverable_create` so users get a clickable deliverable card.
- Agents must NOT paste raw `/api/…` paths or bare `http(s)://` internal URLs — those render as external links, not in-app navigation.

This closes the previous gap where the renderer silently auto-linked IDs but no prompt told agents to emit them.

#### Async Work, Callbacks & Timing

Placed in **Tier 1 (Stable)** (`## Async work, callbacks & timing`, after the agent-communication rules). Establishes the event-driven behavioral model that backs the callback/wakeup infrastructure (see [mailbox-system.md](./mailbox-system.md) §3.4/§11.3):

- **Await, don't poll**: after starting async work, register for the completion event and stop — do not busy-loop checking status. `background_exec` reports completion automatically; a tight `process poll` loop is discouraged.
- **`schedule_wakeup` / `cancel_wakeup`**: agents set precise time-based follow-ups (`in_seconds` or ISO `at`, optional `recurring_seconds`) instead of relying on the heartbeat, which is now a coarse safety-net (default `DEFAULT_HEARTBEAT_INTERVAL_MS`, 6h) rather than a frequent poll.
- **`set_heartbeat_interval`**: agents (or users, via the Heartbeat tab / config API) can adjust the coarse safety-net cadence itself (clamped 5min–24h, applied live). This is distinct from `schedule_wakeup` — the latter is for precise one-off/recurring follow-ups; the former only changes how often the fallback patrol fires.
- **`agent_send_message` `reply_in_session`** (alias: deprecated `await_in_session`): the peer's reply resumes the **current conversation** (an `a2a_reply` callback correlated by `conversation_id`), instead of landing in a disconnected a2a session. Non-blocking — the send returns immediately and the reply re-wakes the thread.
- **`agent_send_message` `wake_recipient`**: if the recipient is stopped, optionally wake (start) them before dispatch; the response always reports `recipient.status` so a stopped recipient is never a silent dead letter.
- **Two delivery forms**: `in_session` (result resumes the origin session — `background_exec`, `reply_in_session`) vs `mailbox` (fresh attention cycle — `schedule_wakeup`, autonomous follow-ups). Documented so agents pick the right one.
- Note: `task_create` is intentionally **not** wired for in-session return — tasks are an independent, tracked/reviewed workflow whose results flow through the board, review, and `notify_user`, not back into the creating conversation.

#### Behavioral Policies (coding-agent patterns)

Placed in **Tier 1 (Stable)** (`## Error Recovery` + `## Autonomy & Escalation`). Production-coding-agent patterns encoded as durable rules:

- **Bounded retry + escalate**: at most ~2 attempts at the same failing action without new evidence; then stop and escalate (`request_user_input` for a decision that has no built-in UI, `notify_user` for FYI, mark `blocked`). Never loop; never fail silently.
- **Autonomy calibration**: reversible/low-stakes → pick a sensible default and record the assumption; irreversible/destructive/scope-expanding → `request_user_input` first. When unsure about reversibility, treat as irreversible.
- **Requirement/task approval**: after `requirement_propose` / `task_create`, do **not** use `request_user_input` to ask the human to approve — the entity card already has Approve/Reject, and creation already notifies them. Skip extra `notify_user` reminders at creation time; at most one non-blocking nudge if something stays pending for a very long time.
- **Self-contained delegation contract**: delegations must carry goal, context, constraints, expected return format, and preserve `conversation_id` — recipients have no access to the sender's session.
- **Decision-ready return contract**: async results and delegation replies are summarized for immediate action, not raw stdout/log dumps.

### 2.4 Spec: Prompt profiles (`promptProfile`)

MUST: `buildSystemPrompt()` MUST accept `promptProfile: 'reflex' | 'converse' | 'execute' | 'govern'` derived from the scenario pack ([agent-runtime.md](./agent-runtime.md) §2 / §4).

| Section | reflex | converse | execute/govern |
|---------|--------|----------|----------------|
| ROLE | full (soft warn metric) | full | full |
| Collaboration Rules (L0) | yes | yes | yes |
| knowledge.md as `## Your Knowledge` | omitted | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS_CONVERSE`) | capped (`KNOWLEDGE_PROMPT_MAX_TOKENS`) |
| ~~state.md~~ | — | retired 2026-09-16 → notebook `system` tier | — |
| L3 quality/git/error-recovery | omitted | omitted (incl. comments) | included |
| Search Strategy | complete, concise | complete, concise | complete, concise |
| Team announcements / norms | capped | 400 chars | 2000 chars |
| Channel history / shared deliverables | omitted | optional short | as needed |
| Full roster | manager + ≤3 active | existing caps | existing caps |
| Date / locale / Interaction Mode | yes | always retained | yes |

MUST: ROLE.md is always injected in full (persona only). `ROLE_PROMPT_MAX_TOKENS` is warn-only.
MUST NOT: Append `HANDBOOK.md` into ROLE. Distill collaboration hard rules into L0
`## Markus Collaboration Rules`; HANDBOOK.md is a depth handbook via `file_read`.
Long-tail API/reference content belongs in skills, not ROLE/HANDBOOK always-on.
MUST: knowledge injection MUST exclude observations buffer; converse uses a short
digest cap (full text via `memory_search` / files). Knowledge body headings `##`
MUST be demoted to `###` under `## Your Knowledge` so they do not collide with
system sections; stale fault/transcript sections are deprioritized when truncating.
MUST NOT: Inject full history into reflex (the retired `state.md` block is gone — situational state rides `## Notebook`).
MUST: Converse size is controlled by progressive disclosure + afford guard, **not**
by post-assemble truncation of ROLE/L0/Collaboration Rules/mode/date.
MUST NOT: Emit `_[ROLE truncated]_` / `_[system trimmed]_` markers.

#### Conversation-first vs Task-when-needed (L0 + chat scenario)

MUST: Human chat defaults to **conversation-first** — agents MAY advance real work
(edit files, run commands, multi-step debugging) in the live conversation without
forcing `task_create`.
MUST: Task workflow is for async work, delegation, multi-agent parallel delivery,
formal review/audit trail, or when the human explicitly asks for a task.
MUST: **STOP** means only: after `task_create` for a piece of work, do not continue
**that task** in chat. Work never placed on a task may continue conversationally.
MUST: Requirements gate applies to **tasks** (`gate all tasks`), not to conversational chat work.
MUST: Conflict priority:
`Owner explicit instruction > conversation-first default > Protocol (once a task exists) > ROLE persona > Position (manager)`.
MUST: Managers are **player-coach** — Position does not forbid hands-on building when ROLE is a builder/founder.

MUST: L0 includes **How Your Prompt Is Composed** — ROLE.md is persona; L0 is always-on
platform rules; HANDBOOK/skills are on demand. ROLE line count ≠ full constraints.

MUST (`task_submit_review`): Auto-fill `task_id` from execution ALS/`activeTasks` when
present; otherwise `task_id` is required. MUST NOT guess from the TaskService board.
Work-context-bound tools MUST NOT sticky into free chat — but MUST remain available in
entity-bound sessions (task_execution, review, comment_response, requirement_action,
workflow_action) (`S-execute-only-no-sticky-converse`).

Test IDs: `A-profile-reflex-omits`, `A-profile-role-full`, `A-collab-rules-always-on`,
`A-conversation-first-chat`, `A-knowledge-heading-demote`, `A-role-no-shared-append`,
`A-knowledge-cap`, `A-profile-converse-no-l3`, `S-execute-only-no-sticky-converse`.

### 2.5 Spec: Afford fail-closed packing

MUST: After assembling system + tools, compute `fixed = systemTokens + toolDefTokens`.
MUST: If `promptAffordTokens != null` and
`fixed + PROMPT_AFFORD_OUTPUT_RESERVE + safetyMargin > promptAffordTokens`:
1. Downgrade once to `reflex` pack + profile and re-assemble.
2. If still over, MUST NOT call the provider; return actionable error (`prompt_pack_rejected`).
MUST: Heartbeat paths that hit reject MUST end activity with `success: false`.
MUST NOT: Only shrink `messageBudget` while shipping an over-afford fixed prefix.

MUST (§Afford.S1): `handleMessageStream` MUST use the same `ensureAffordablePromptPack`
gate as `handleMessage` before any provider call.

MUST (§Afford.S3): `SYSTEM_PROMPT_BUDGET_CONVERSE` is a soft observe/warn metric for
converse system size. MUST NOT truncate ROLE/L0/mode/date to meet it. Hard limits
are enforced by the provider afford guard (downgrade/reject).

MUST (§Afford.S4): Provider MUST clamp `max_tokens` to remaining afford (proactive when
`lastPromptAffordTokens` known; reactive on reservation 402).

Test IDs: `A-afford-downgrade`, `A-afford-heartbeat-fail`, `S-stream-afford-reject`,
`S-stream-afford-downgrade`, `S-converse-system-budget`, `S-converse-keeps-date`,
`S-max-tokens-clamp-remaining`.

Cold-start acceptance: converse fixed ≤ 28_000; reflex fixed ≤ 8_000
(`A-budget-contract-converse`, `A-budget-contract-reflex`).

### 2.6 Skill Filtering

**removed (2026-09-16)** — `filterSkillsByRelevance()` (query-keyword scoring, "top 30") was deleted as dead code; it was never called. The every-turn skill catalog is ORG context (scope O) — byte-stable for the whole org — so ranking it per query would convert a shared cached block into a per-call one. See [context-assembly.md](./context-assembly.md) §3.9.1 O4.

---

> **Split (2026-11-15)** — §3 and §4–§5 live in sibling files: **how history is packed and compressed** → [context-assembly.md](./context-assembly.md) (token budget, compression pipeline, task-prompt protection, ContextOS fixed/variable split & SLOT anchors, compaction defects §3.8 and root causes §3.9); **how one call runs and how each scenario is assembled** → [tool-loop-harness.md](./tool-loop-harness.md) (harness variants, loop detection, reflection nudges, scenario × context matrix §5.9, scenario × tool face §5.10, async callback replay §5.11). The section-number gap at §3–§5 below is exactly that moved material.

---

## 6. Output Token Resolution

The `LLMRouter` resolves `maxTokens` (output token limit) for every LLM call:

1. If the caller explicitly sets `request.maxTokens`, that value is used.
2. Otherwise, the router looks up the model in `BUILTIN_MODEL_CATALOG` and uses the model's `maxOutputTokens` (e.g. 64K for Claude Sonnet 4, 128K for Claude Opus 4.6).
3. As a final fallback (unknown models), the provider's configured default applies (typically 4096).

This ensures that modern models with large output windows are not artificially constrained, allowing full-length code generation, detailed analyses, and long-form writing without premature `max_tokens` truncation.

---

## 7. Tool Selection

### 7.0 Memory & Notebook Tools

Five primary memory tools (down from seven); legacy aliases preserved:

| Tool | Purpose |
|------|---------|
| `notebook_upsert` | Upsert a keyed entry in `NOTEBOOK.md` (situational workspace) |
| `notebook_clear` | Remove one entry or all agent-managed entries |
| `memory_save` | Append one observation to `## _observations` in `knowledge.md` |
| `memory_update` | Edit curated `knowledge.md` sections (always in `## Your Knowledge`) |
| `memory_search` | Search observations and curated knowledge |

**Legacy memory aliases** (same handlers): `memory_list`, `memory_delete`, `memory_update_longterm`. (The notebook aliases `update_working_memory` / `clear_working_memory` were removed — use `notebook_upsert` / `notebook_clear`.)

Goal tools (`goal_create`, `goal_update`, `goal_status`) are available during **heartbeat** and **deliberation** for standing-goal management.

`ToolSelector.selectTools()` determines which tools appear in each LLM call:

1. **Always-on tools**: Core set always included (e.g., `memory_save`, `memory_search`, `memory_update`, `notebook_upsert`, `notebook_clear`, `file_read`, `file_write`, `task_create`, `task_list`, `spawn_subagent`, `spawn_subagents`, `check_mailbox`, etc.)
2. **Manager-only tools**: Added when `isManager=true` (e.g., `task_assign`, `team_status`, `delegate_message`)
3. **Package tools**: Available to all agents, activated by keyword (e.g., `package_list`, `package_install`, `hub_search`, `hub_install`)
4. **Task-execution tools**: Added when `isTaskExecution=true` (e.g., `task_submit_review`, `subtask_create`)
5. **Recently used tools**: Tools used in recent calls are re-included to maintain continuity
6. **Mailbox management tools**: `defer_mailbox_item`, `drop_mailbox_item`,
   `prioritize_mailbox_item` — registered for all agents, available during
   deliberation and focused processing.
7. **Activated tools**: Tools the agent explicitly activated via `discover_tools`
8. **Skill-provided tools**: MCP tools from activated skills
9. **`discover_tools` meta-tool**: Always present, enabling agents to list/activate/install skills at runtime

### 7.2 Agent/Team Creation & Deployment

Creation and deployment are **two separate phases** with an explicit user gate between them.

**Simple hire (no artifact design):** `package_install(type:"agent", name, agent_name, team_name?)` — optional `team_name` find-or-creates a team; or `team_id` from `list_teams`. There is **no** `team_create` tool.

**Custom package flow:**
**Phase 1 — Create (design the artifact):**
- Activate `agent-building`, `team-building`, or `skill-building` skill via `discover_tools`
- Write manifest + content files with `file_write` to `~/.markus/builder-artifacts/{agents|teams|skills}/{name}/` (dirs are ensured at startup; chat JSON is **not** auto-saved)
- This produces a package on disk. No live resources are created.

**Phase 2 — Deploy (ONLY on explicit user request):**
| Method | When to use | Tools |
|--------|-------------|-------|
| Local / builtin package | Agents, teams, skills from package_list | `package_list` → `package_install` (`type:"team"` creates team+members together) |
| Hub one-step | Community packages from Markus Hub | `hub_search` → `hub_install` |

**Post-deploy:** Onboard new agents via `agent_send_message` (project context) → `task_create` (initial work).

**Critical rules:**
- Agents must NEVER auto-deploy. `package_install` and `hub_install` create live agents that consume LLM tokens and join the organization. Only execute when the user explicitly says "install", "deploy", "hire", or "start".
- Never create org teams/agents via `shell_execute`, direct DB edits, or paths outside `builder-artifacts`.

---

## 8. Provider Routing & Resilience

### 8.1 LLM Router

`LLMRouter` manages multiple provider instances (Anthropic, OpenAI, Google, Ollama) with:
- **Complexity-based tiers**: Default provider covers all complexity levels; secondary providers handle specific tiers (e.g., Anthropic for complex, OpenAI-compatible for simple/moderate).
- **Circuit breaker**: After 2 consecutive failures, a provider is marked degraded for 5 minutes (30 minutes for auth/billing errors).
- **Fallback chain**: If the primary provider fails, the router tries the next provider in the tier list.

### 8.2 Network Retry

`withNetworkRetry()` wraps **all** LLM calls (chat, stream, task execution, respond-in-session) with exponential backoff:
- Max retries: configurable via `Agent.NETWORK_RETRY_MAX`
- Only retries on network errors (connection refused, timeout, DNS failure).
- Non-network errors (400, 401, 403) are thrown immediately.

### 8.3 Compaction (Anthropic)

For Claude Opus 4.x and Sonnet 4.x models, Anthropic's server-side `compact_20260112` beta is enabled. This provides transparent context compression at the API level, complementing Markus's own context management.

---

## 9. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [context-assembly.md](./context-assembly.md) | **Split out of this document 2026-11-15** (§3): message assembly, token budget, compression pipeline, ContextOS fixed/variable split & SLOT anchors, compaction defects and root causes |
| [tool-loop-harness.md](./tool-loop-harness.md) | **Split out of this document 2026-11-15** (§4 + §5): tool-loop harness, loop detection, scenario-specific assembly, scenario × context matrix, scenario × tool face, async callback replay |
| [state-machines.md](./state-machines.md) | Task state transitions trigger different LLM call paths ([tool-loop-harness.md](./tool-loop-harness.md) §5.2 task execution, §5.3 heartbeat review) |
| [memory-system.md](./memory-system.md) | Notebook + `knowledge.md` layers (`state.md` retired 2026-09-16); `## Your Knowledge` and `## Notebook` in prompts; consolidation ([tool-loop-harness.md](./tool-loop-harness.md) §5.6-5.8) |
| [cognitive-architecture.md](./cognitive-architecture.md) | Deterministic context assembly ([context-assembly.md](./context-assembly.md) §3); CPP and its depth levels removed |
| `packages/core/src/agent.ts` | Implementation of all 8 LLM call scenarios and 4 harness variants |
| `packages/core/src/context-engine.ts` | `buildSystemPrompt()` and `prepareMessages()` implementation; SLOT fixed segment, volatile tail, watermark |
| `packages/core/src/context-slot.ts` | SLOT segment model: `SlotEntry` / `SlotsStore` / `buildSlotSegment()` — the never-compacted anchors ([context-assembly.md](./context-assembly.md) §3.7) |
| `packages/core/src/tools/session.ts` | Session 10-op tool family (compact/pin/include/retrieve…) + `checkOwnership` ([context-assembly.md](./context-assembly.md) §3.7) |
| `packages/core/src/llm/router.ts` | Provider routing, circuit breaker, model catalog, output token resolution |
| `packages/core/src/tool-selector.ts` | Tool selection logic |
| ~~`context-os.md`~~ | **Merged into [context-assembly.md](./context-assembly.md) §3.7** (Fixed/Variable split, SLOT anchors, session tools, watermark). "ContextOS" is the name of that mechanism; deliverable notes (8/20 repro, regression ledger) are archived in git history. |
