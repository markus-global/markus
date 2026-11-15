# Context Assembly & Compression

> **Scope (this file)**: how conversation history and anchors are packed into one request and compressed — token budget, the compression pipeline, task-prompt protection, tool-block compaction, LLM summarization, sanitization, the ContextOS fixed/variable split with SLOT anchors, and the compaction defects with their root-cause analysis.
> **Split out of** [prompt-engineering.md](./prompt-engineering.md) §3 on **2026-11-15**. Section numbers (§3.x) are unchanged, so an existing `prompt-engineering.md §3.x` reference resolves to the same `§3.x` here.
> **Siblings**: [prompt-engineering.md](./prompt-engineering.md) — call taxonomy, cache-scope layout, system-prompt architecture (§1–§2), output-token resolution (§6); [tool-loop-harness.md](./tool-loop-harness.md) — tool-loop harness and scenario-specific assembly, incl. the scenario × context matrix (§4–§5).

## 3. Message Assembly & Context Compression

`ContextEngine.prepareMessages()` assembles the final message array sent to the LLM. It operates in four stages.

### 3.1 Token Budget Calculation

```
contextWindow        = model's context window (e.g. 200K for Claude Sonnet 4)
maxOutput            = min(model.maxOutputTokens, contextWindow × 40%)
safetyMargin         = ceil(min(contextWindow × 8%, 16000))
messageBudget        = contextWindow − systemTokens − toolDefTokens − maxOutput − safetyMargin
```

**maxOutput reservation**: Uses the model's actual `maxOutputTokens` from the model catalog (e.g. 64K for Claude Sonnet 4, 128K for Claude Opus 4.6), capped at 40% of the context window. This ensures the budget reserves enough space for the model's full output capability without over-compressing messages.

Token estimates use tiktoken when available (model-specific encoding), falling back to `chars / 3.5` heuristic.

### 3.2 Compression Pipeline

**Policy: budget-first (model window AND provider afford).** Markus packs against the
real model window, then further clamps by any OpenRouter prompt-afford hint (from a prior
`Prompt tokens limit exceeded: X > Y` 402). Compression runs when history exceeds
`CONTEXT_PROACTIVE_COMPACT_RATIO` (75% — the history-occupancy water level, i.e. the history's
share of `messageBudget`) — not only when the hard window overflows. Session restore also trims before the first LLM call
(`SESSION_RESTORE_MAX_MESSAGES` / `SESSION_RESTORE_MAX_MESSAGE_TOKENS`).

```
Session Messages
       │
       ▼
 Stage 0: Clamp messageBudget by promptAffordTokens − PROMPT_AFFORD_OUTPUT_RESERVE
       │
       ▼
 Stage 1: Pathological single-message shrink ONLY
   └─ shrinkOversizedMessages(cap: CONTEXT_ABSURD_MESSAGE_CHARS = 200k)
   └─ sanitizeMessageSequence()
       │
       ▼
 (runs if totalTokens > messageBudget OR > proactive 75% threshold)
       │
       ▼
 Stage 2: Token-budget-driven compression (progressive)
   ├─ 2a: shrinkOversizedMessages(cap: max(8000, budget/4)) + compactOldTurns()
   ├─ 2b: smartSummarizeAndTruncate(keep: max(24, 55%))
   └─ 2c: stronger summarize(keep: max(16, 40%)) + re-shrink
       │
       ▼
 Stage 3: Last-resort trimming
   └─ trimToFitBudget() — drop oldest, protect index 0 (task prompt)
       │
       ▼
 Final: [system prompt, ...compressed messages]
 Metrics: systemTokens / historyTokens / toolDefTokens / totalPromptTokens / compactStage
```

- **Safety margin**: `min(contextWindow * 0.08, 16000)` — modest, to prefer packing
  history over reserving unused slack.
- **Channel history**: `CHANNEL_CONTEXT_MESSAGES = 15` (load, inject, and prompt copy aligned).
- **Tool result offload**: `TOOL_RESULT_OFFLOAD_CHARS = 12_000` (preview kept in context).
- **Storage-side compaction** is a separate, high-volume safety net (not a per-call token
  saver): on-disk sessions are compacted only at
  `SESSION_STORAGE_COMPACT_TRIGGER = 2000` messages, keeping
  `SESSION_STORAGE_COMPACT_KEEP = 1000`; oversized on-disk tool results are shrunk at
  `SESSION_STORAGE_TOOL_SHRINK_CHARS = 100k`. See [memory-system.md](./memory-system.md).

**Design rationale (Hermes progressive disclosure + afford-aware packing)**: keep cold-start
system+tools lean (~10k target), activate skill bodies on demand, and never fill a 128k/1M
window when the provider key can only afford ~37k prompt tokens.

**Lightweight sessions**: All interactions (heartbeat, A2A, memory flush, comments) use the same `prepareMessages()` pipeline. Sessions are persisted to JSON files for full traceability. The `scenario` parameter controls what context is included in the system prompt — lightweight scenarios (`heartbeat`, `a2a`, `comment_response`) skip heavy context like assigned tasks, deliverables, and chat session lists.

### 3.3 Task Prompt Protection

The first user message in a task session often contains the task description and the `task_submit_review` instruction. This message is **protected** throughout all compression stages:
- `smartSummarizeAndTruncate()` detects `TASK EXECUTION` or `task_submit_review` markers and preserves the first message verbatim.
- `compactOldTurns()` skips compaction of block 0 if it matches the task prompt pattern.
- `trimToFitBudget()` preserves index 0 and only compacts it as a last resort.

### 3.4 Tool Block Compaction

`summarizeToolBlock()` compresses an `[assistant+toolCalls, tool, tool, ...]` block into a single assistant message:
- Preserves tool names and truncated arguments.
- **Error results** are preserved in full (up to 200 chars) — errors in context help the model self-correct.
- Research tool results (`web_search`, `file_read`, etc.) retain up to 500 chars of findings.
- **Serialization diversity**: Uses 4 rotating summary templates to prevent the model from mimicking uniform compaction patterns.

### 3.5 LLM-Powered Summarization

When available, `smartSummarizeAndTruncate()` uses an LLM call to summarize older messages:
- The summarizer LLM call is cheap: truncates each message to 300 chars, total input capped at 8000 chars.
- No `maxTokens` cap — the router fills in the model's real output limit (the prompt itself bounds output to "under 1500 characters"). Temperature 0.2.
- Fallback: `buildHeuristicSummary()` extracts key sentences from assistant messages.
- The summary is **not** persisted to disk — `prepareMessages()` must stay pure (no `writeDailyLog`).
  It is instead carried in-history as a `[SYSTEM] [Conversation history summary …]` message, and the
  durable compaction summary lives in the fixed `[CONTEXT SUMMARY]` segment (the session's `summary` field).

### 3.6 Message Sanitization

`sanitizeMessageSequence()` ensures structural correctness before LLM submission:
- Every `assistant(toolCalls)` must be followed by ALL corresponding `tool` result messages.
- Orphaned tool messages are dropped.
- Incomplete assistant+tool blocks are dropped entirely.
- Consecutive user messages are merged (unless either is a system injection like `[SYSTEM]` or `[Conversation history summary`).

### 3.7 Fixed/Variable Split & Session Anchors (ContextOS)

A complement to the compression pipeline above: separate the prompt into a **fixed segment**
(system + tools + SLOT anchors) that is **never business-compacted**, and a **variable segment**
(history) that is the only thing compression/truncation touches. Motivation: long-session "loop"
bugs where compaction discarded the agent's work anchors, so the agent lost its "position" and
re-read the same files forever (diagnosed on 8/20; deliverable notes are archived in git history).
Scope: `packages/core/src/context-slot.ts` + `tools/session.ts` + the `prepareMessages` slot
plumbing.

**Fixed vs variable:**

- **Fixed (never compacted)**: system prompt, tool definitions, and the **SLOT segment**.
- **Variable**: conversation history — the only thing shaved/compressed/truncated.

**SLOT fixed segment (`[SLOTS]`)** — `context-slot.ts`:
- Slots are agent-managed named anchors (`goal` / `done` / `next`, or any agent-chosen key)
  persisted on the session (`ConversationSession.slots`).
- At send time, `prepareMessages` accepts `slotsSegment` (= `serializeSlots(sessionId)`), subtracts
  `slotsTokens` from the budget, and appends it to the system message (`[SLOTS] (agent-managed, not
  compacted)\n· key: text…`). It is **excluded from the compaction/truncation chain** — so after any
  compress or truncate, the agent still sees its current goal/done/next and can continue **without
  re-reading files**.
- Runtime caps: `CONTEXT_SLOT_MAX_CHARS` (1200).

**Session tools (agent-driven compaction + anchors)** — `tools/session.ts` exposes 10 operations so
the agent can actively manage long sessions instead of relying only on passive auto-compaction:
`list | get | compact(keepLast, goal?, done?, next?) | pin | unpin | retrieve | include | purge | status | rename`.
- `compact` folds expired history into structured anchors (`compactWithAnchor`: pin goal/done/next
  into SLOTs, then compress), keeping recent N; raw history is archived to `conversation_fragment`
  (never deleted) and recoverable via `include`.
- `pin`/`unpin`: write/remove named slot anchors (survive compression + truncation).
- `include`: place archived fragment back into context precisely.
- All read/write ops are guarded by `checkOwnership(sessionId, agentId)` — an agent may only manage
  its own session.

**Context watermark (`[CONTEXT X% used …]`)** — the agent can observe its own pressure (no more
silent truncation) and act:
- `usedPct = (fixedTokens + variableTokens) / effectiveBudget`.
- `[CONTEXT WARN]` at ≥80%: nudge to `session_compact` or `session_pin` an anchor.
- `[CONTEXT CRIT]` at ≥95%: warn that the system will hard-truncate oldest turns; instruct to
  immediately `session_compact` + `session_pin`.
- Injected via the volatile `[SYSTEM] [Live context]` tail (see [prompt-engineering.md](./prompt-engineering.md) §2.1), never into the system prefix.

**Why this fixes the loop**: previously compaction dropped anchors → the agent lost position → it
re-read the same files to re-orient → that re-reading itself grew context → re-truncated → loop.
With SLOT anchors locked in the fixed segment, a compressed/truncated history still carries
goal/done/next every turn, so the agent resumes without re-reading — the trigger for the loop is gone.

---

### 3.8 Compaction defects fixed in v2.1 (2026-09-16)

Four defects were found by auditing the pipeline against the published designs
(Anthropic compaction, DeepSeek V3.2 context management, fast-agent).

**(a) Fold direction was inverted — `compactOldTurns()`.** It walked blocks
oldest→newest, kept each verbatim while the budget allowed, then summarised *or
dropped* the remainder. That preserves the **oldest** conversation and
summarises/discards the **most recent** past turns — the opposite of "keep the
recent window verbatim, summarise the distant past" — and it discarded exactly
the context the model still needed. Now the recency walk accumulates from the END
and keeps the newest blocks verbatim. Order is preserved, and folding is
block-wise via `parseIntoBlocks()`, so an assistant tool-call is never separated
from its tool results. Task prompts (`TASK EXECUTION` / `task_submit_review`) stay
protected verbatim even though they are the oldest block.

**(b) The watermarks could never fire on a large window.**
`CONTEXT_PROACTIVE_COMPACT_RATIO` / `CONTEXT_WARN_RATIO` are relative to the model
window, so on the 1311k window Markus runs, proactive compaction sits around
~500k tokens. The observed session finished a single turn at 269k input tokens —
~12 % of the window — with `compactStage === 'none'` throughout: **no maintenance
compression ever ran.** Added an absolute ceiling:

| Constant | Value | Meaning |
|---|---|---|
| `CONTEXT_ABS_HISTORY_TOKENS` | 120 000 | above this, maintenance compression fires regardless of window % |
| `CONTEXT_ABS_HISTORY_TARGET_TOKENS` | 72 000 | what a fold compresses down to (hysteresis: grow to 120k, fold to 72k) |

When the ceiling trips, `historyTarget` replaces the window-derived
`messageBudget` (which would otherwise authorise keeping everything — a silent
no-op) and the fold boundary becomes `messages.length`, which is what also covers
the single-gigantic-turn case.

**(c) `smartSummarizeAndTruncate()` reordered history.** Eligible messages were
sorted by **priority**, and `retained` was then built straight from that sorted
array — so the summariser received a priority-shuffled transcript and the kept
older messages were replayed in importance order instead of time order. Both
`older` and `promoted` are now re-sorted by original index. (Chronological input
also produces a better summary, and restores determinism, which the prefix cache
relies on.)

**(d) `findCurrentTurnStart()` counted synthetic messages as user turns.**
Engine-synthesised blocks — the compaction summary, the `[SYSTEM] [Live context]`
tail, `[Continue from where you left off …]` and `[SYSTEM] Loop detected: …` —
are `role: 'user'` but are not user turns. Since `findCurrentTurnStart()` decides
both the turn boundary and the prefix-cache breakpoint, they were placed against
the wrong boundary. `isSyntheticMessage()` now skips them.

> **Why the synthetic blocks cannot simply become `role: 'system'`:** the
> Anthropic adapter does `find(m => m.role === 'system')` and then
> `filter(m => m.role !== 'system')`, so any non-first system message is silently
> dropped there (the summary would vanish). Skipping them during accounting is the
> provider-safe fix. Revisit only if every adapter is switched to multi-system
> handling.

**Regression guard**: `packages/core/test/context-compaction-v21.test.ts`.

### 3.9 Root cause analysis: why these defects keep returning (2026-09-16)

Three rounds of auditing found six defect classes. They are **not six independent
bugs** — they are six surfaces of four design gaps, which is why fixing one kept
exposing the next. This section records the gaps so the next fix is aimed at the
cause rather than the symptom.

| # | Root cause | Design or implementation debt | Surfaces it produced |
|---|---|---|---|
| RC1 | **The fixed/variable split has no third tier.** Context was modelled as *fixed* (system + tools + slots) vs *variable* (history + volatile tail). Stable-but-large session state — knowledge, notebook, skills catalog, deferred tools, task board — has neither a home nor a delivery contract, so it was dumped into the *per-call* tail. | **Design** | Tail re-sent 66× in one turn; every "make the tail smaller" fix then risked losing the state outright ([prompt-engineering.md](./prompt-engineering.md) §2.1.2) |
| RC2 | **No harness channel.** Providers accept only system/user/assistant/tool, so the engine synthesises `role:'user'` for state, `[Continue …]` and loop warnings. There is no explicit framing that marks a block as *telemetry, not instruction*. | **Design** | Turn accounting corrupted (`findCurrentTurnStart`); negative priming from stacked \"do not repeat\" prompts; state read as the newest user message and re-announced |
| RC3 | **No context budget owner.** Each feature pushes into the dynamic array with its own cap; nobody owns the total, the priority order, or eviction. | **Design** | Byte-constant noise lines survive forever (`_(66 completed/closed tasks)_`); knowledge truncated by *document order* mid-sentence; `## Notebook` reached 41 % of the tail |
| RC4 | **Cache-friendliness was a patch, not an invariant — and was unmeasurable.** Registration-order emission was fixed case-by-case; `discover_tools.description` still embedded per-turn counts *directly under a comment claiming cache-safety*; the documented MUST-NOT in `tool-system.md` was violated by the code. No cache-hit telemetry and a 0.7 heuristic polluting the denominator meant regressions were **invisible**. | **Design (missing guard) + implementation** | Tool prefix silently busted every turn; the same class of bug reappeared across rounds |
| RC5 | **The toolset is recomputed per turn, not accumulated per session.** `recentToolNames` is an instance-level LRU(10); `activatedExtraTools` is instance-level and never reset. Both drift within a turn **and leak across sessions**. | **Implementation** | Capability surface changes every turn (cache break); one session inherits tools activated in another |
| RC6 | **Estimated vs reported usage is a dual rail.** Budget and `[CONTEXT x%]` come from the local `TokenCounter`; server-reported `inputTokens` is used only for the audit log, only calibrates the estimator, and is wired on *one* code path (`agent.ts:4373`). | **Implementation** | The displayed water level is an estimate; the cache-hit denominator was back-filled with `totalTokens*0.7` |

#### What was fixed in this round

| Root cause | Fix | Where |
|---|---|---|
| RC1 + RC2 | Durable `[SYSTEM] [State checkpoint]` history message on change (complete + append-only + cache-extending); tail digest names where the content lives; relative-time labels normalised out of the hash | [prompt-engineering.md](./prompt-engineering.md) §2.1.2, `context-engine.ts` |
| RC3 | Closed-task counters deleted; **team active tasks kept in full** but ranked actionable-first; empty board skipped for converse; `prepareKnowledgeForPrompt(raw, maxChars, query?)` ranks by relevance, selects **whole** sections, and always emits a title index of what was omitted | §3.9.1, `context-engine.ts` |
| RC4 | `discover_tools.description` is now a pure function of the **registry** (minus `TOOL_DEF_CORE_KEEP`), deterministically sorted; byte-stability guard test added; per-session cache-hit window + `cacheHitRateWindow` / `cacheHitRateSamples` telemetry that returns `null` (not 0) when nothing was reported | `tool-selector.ts`, `agent-metrics.ts` |

> **A note on RC3's shape:** the first attempt at the task-board fix collapsed
> *all* non-actionable team tasks into a count bucket. That was rejected on review
> — it traded information away for tokens, hiding \"what is my team working on?\"
> from a manager. Only the genuinely constant counters were removed. **Deleting
> noise is a win; deleting signal is a regression**, and the two look identical in
> a token-diff.

#### 3.9.1 Open items — status after the cache-scope round (2026-09-16, v4)

| # | Item | Status |
|---|---|---|
| O1 | **Tool schema drift (RC5).** Session-level monotonic toolset. | **DONE.** `Agent.stickyTools()` keeps `recent`/`activated` in a session-keyed record (`toolSticky`), monotonic within a session (freezes at `STICKY_RECENT_TOOLS_MAX` instead of evicting) and reset on session switch, so the *cross-session leak* is closed as well as the per-turn drift. Remaining (deferred): the call-site inconsistency where the stream/task/risk paths do not pass `extraRecentToolNames`, and `Mask, Don't Remove` decode-time placeholders (not applicable to closed APIs). |
| O2 | **Reported usage as the single source of truth (RC6).** | **PARTIAL — calibration only.** `calibrateTokenCounter(response.usage.inputTokens)` is now wired on 8 paths, and `extractCacheReadTokens()` already parses DeepSeek's `prompt_cache_hit_tokens` **and** OpenAI/OpenRouter `prompt_tokens_details.cached_tokens`, feeding `cacheHitRateWindow` (reported-only denominator). Still open: using reported tokens to *drive* the budget/water level and marking it `src=reported\|estimated`. Deferred per Owner's call — do DeepSeek-first if pursued. |
| O3 | **`## Notebook` size (RC3).** Largest single tail section (mean 9 163 chars, 41 % of tail). | **DONE (size + lifecycle).** Added a TOTAL cap (`NOTEBOOK_PROMPT_MAX_CHARS = 6000`) on top of the per-entry cap, keeping the most recent entries and naming any omitted keys — so the block can no longer dominate the tail. Relevance ranking deliberately NOT applied: the notebook is the agent's own workspace, and dropping a note it wrote itself is a correctness risk, not a token win. Follow-up ([memory-system.md](./memory-system.md) §2): the cap alone was not enough — entry count/TTL/single-writer were missing, so a real notebook reached 26 entries / 33 KB and an 18-day-old triage decision was re-injected as current fact. Now: single write path (`Agent.writeNotebookEntry`), per-tier TTL, cross-tier entry cap, normalize-on-load, deterministic ordering, and inline truncation instead of whole-entry omission. |
| O4 | **`filterSkillsByRelevance` dead code.** | **DONE.** Deleted. It was never called, and the every-turn `## Available Skills` table is ORG context (scope O) — byte-stable for the whole org — so ranking it per query would convert a shared cached block into a per-call one. Rationale recorded in-code. |

**Evidence provenance.** All measured figures come from
`~/.markus/llm-logs/2026-09-16.jsonl` (66-call session; 377 tails) plus a
read-only audit of `packages/core/src`. The 322 tails taken *before* the gating
commit are a historical snapshot used to size the problem, **not** a description
of current `HEAD`.

