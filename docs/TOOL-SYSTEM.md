# Tool System

> Last updated: 2026-07

How Markus decides **which tools an agent can see**, how tool results are shaped and
returned, how the **tool-execution loop** drives the model until it is done, and how
**subagents** are spawned with budget guardrails.

Related docs: [AGENT-RUNTIME.md](./AGENT-RUNTIME.md) (SSOT for packs/budgets),
[PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) (how tool definitions and
results are packed into context), [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) (the attention
loop that owns each turn), [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) (how
tool progress and tool errors reach the client), [CODING-TOOLS.md](./CODING-TOOLS.md)
(external coding CLIs, a distinct concern from the general tool loop).

---

## 1. Tool Selection

Not every registered tool is sent to the model on every call. Sending the full registry
would inflate the system/tool prefix (token tax) and dilute the model's attention. The
[`ToolSelector`](../packages/core/src/tool-selector.ts) chooses a working set per call
**within a Scenario Capability Pack** ([AGENT-RUNTIME.md](./AGENT-RUNTIME.md) §2).

### 1.0 Spec: Scenario Capability Packs

MUST: Each scenario maps to exactly one pack: `reflex` | `converse` | `execute` | `govern`.

| Pack | Scenarios | `toolDefTokens` budget |
|------|-----------|------------------------|
| `reflex` | heartbeat, memory_consolidation, memory_flush, dream | 3_000 |
| `converse` | chat, a2a, group_chat, comment_response, requirement_action | 6_000 |
| `execute` | task_execution | 10_000 |
| `govern` | review, deliberation | 8_000 |

MUST: `reflex` default allowlist MUST be the slim core in AGENT-RUNTIME §2.2
(MUST NOT include `package_install`, `goal_*`, `spawn_subagent(s)`, `deliverable_create`, …).

MUST: Default `converse` MUST NOT include `spawn_subagents` or `deliverable_create`
(available via `discover_tools` only).

MUST: `execute` MUST include code/shell/coding capability groups.

Test IDs: `A-pack-reflex-tools`, `A-pack-converse-no-spawn`, `A-pack-execute-has-code`.

### 1.0.1 Spec: ToolDef budget eviction

MUST: After selection, if estimated tool-definition tokens exceed the pack budget, keep
pack core + `discover_tools` + HITL tools, then evict largest / least-recent extras until
under budget.

MUST (§Afford.S2): Evicted names MUST appear in a compact **system Tier 3** catalog
(name-only or name + ≤40 chars, total ≤ `DEFERRED_CATALOG_MAX_CHARS` ≈ 1500 chars)
for rediscovery via `discover_tools`.

MUST NOT: Append the eviction catalog into `discover_tools.description` (inflates
`toolDefTokens` and defeats the pack budget).

MUST: `recentToolNames` / activated extras remain session-sticky but MUST NOT break the budget.

Test IDs: `A-tooldef-budget`, `A-tooldef-sticky-capped`, `S-catalog-not-in-tooldef`.

### 1.1 Selection inputs

`selectTools()` unions the following sources into the working set **for the active pack**:

| Source | What it adds | Notes |
|--------|--------------|-------|
| **Pack core** | Pack-specific always-on tools | Replaces unbounded global BASE for converse/reflex |
| **Role tools** | `isManager` / `isTaskExecution` / `isReview` within pack rules | e.g. execute unions `code` + `shell` + `coding` |
| **Keyword groups** (`TOOL_GROUPS`) | Accelerator when message matches | MUST respect toolDef budget |
| **Recent tools** (`recentToolNames`) | Session reactivation | Sticky but budget-capped |
| **`discover_tools`** | Always appended | Progressive disclosure entry point |
| **`notify_user` / `request_user_input`** | Always appended (non-dream) | Human communication + HITL |

### 1.2 Design rationale (Pi / Hermes)

- **Pi** ships ~4 default tools and leans on `bash` + progressive discovery, keeping the
  tool tax near zero. **Hermes** registers a large registry (~70 tools) but keeps the
  active toolset stable per session.
- Markus sits between: a small always-on core + on-demand discovery + keyword acceleration.
  The core-plus-discover shape is the right one; the weakness is relying on **keyword
  matching** as the *only* path to many groups.

### 1.3 Spec: core-always-on + discover (keyword as accelerator only)

- **Behavior**: A fixed **core tool set** is present on every call regardless of message
  content. Long-tail tools are reachable via `discover_tools`. Keyword-group matching only
  *accelerates* (pre-loads likely tools); it is never the sole gate for a core capability.
  Session-aware reactivation (`recentToolNames`) is retained.
- **Invariants**:
  - Core tools are present for *any* input, including empty, synthetic-continuation, and
    short follow-up messages.
  - A previously-used tool remains available for the rest of the session.
  - `discover_tools` is always present.
- **Design rationale**: Fixes historical misses where a short follow-up or a
  synthetic `[Continue…]` / completion-marker message failed to re-match keywords and
  dropped tools the turn actually needed (e.g. multimodal).
- **Testing** (`packages/core/test/tool-selector.test.ts` — the "B2:" cases):
  - Core tools + `discover_tools` present for empty / whitespace / synthetic / short input,
    and a missing message does not throw.
  - Historical multimodal-continuation case keeps `generate_image` via `recentToolNames`.
- **Status**: implemented (base/core + `discover_tools` + `notify_user`/`request_user_input`
  are added unconditionally; keyword matching is now explicitly an accelerator and a
  blank/undefined message is handled safely).

---

## 2. Tool Result Envelope

Tool results are strings the model reads back as `tool` messages. A consistent envelope
lets the model, the tool loop (loop detection, error handling), and the activity UI agree
on success vs failure. Canonical helpers live in
[`tools/result.ts`](../packages/core/src/tools/result.ts):

```
toolOk(data)  → {"...data", "status":"success", "success":true}
toolErr(msg)  → {"...extra", "status":"error", "error":"<msg>"}
```

`isToolErrorResult(result)` recognizes the failure conventions currently in use:
`status: 'error' | 'denied' | 'rejected'`, `success: false`, or a truthy top-level
`error` without `success: true`.

### 2.1 Spec: strict, uniform failure detection

- **Behavior**: `isToolErrorResult` must classify a genuine failure as an error even when
  the tool returned a **non-JSON plain-text** error string (e.g. `"Error: ..."`), not only
  structured JSON. New tools use `toolOk` / `toolErr`; legacy shapes remain recognized but
  emit a one-time `warn` to drive migration.
- **Invariants**:
  - Plain-text error strings are detected as failures (not silently treated as success).
  - `{ success: true, error: null }` is still success (defensive).
  - Canonical `toolOk` / `toolErr` round-trip correctly.
- **Design rationale**: A failure mis-read as success corrupts the loop detector and the
  activity UI (shows a failed step as done). Mirrors Pi's "errors are values" discipline.
- **Testing** (`packages/core/test/tool-result.test.ts` — "B1: recognises non-JSON
  plain-text errors" / "…does not misclassify ordinary plain text"):
  - Plain-text errors (`Error:`, `Failed…`, `TypeError:`, `Traceback…`, `Cannot…`,
    `Unable to…`, `Fatal…`) → `isToolErrorResult === true`.
  - Ordinary prose (including mid-sentence "error") and success strings → `false`.
  - Legacy `{error}` / `{success:false}` still detected.
- **Status**: implemented (anchored `PLAIN_TEXT_ERROR_RE` fallback in
  `isToolErrorResult`).

### 2.2 Large tool-result offload

Results larger than `OFFLOAD_THRESHOLD` (50,000 chars) are written to
`{dataDir}/tool-outputs/…` and replaced with a **preview + file path** so the model can
`file_read` the rest in chunks (browser snapshots get a larger 30k preview;
`file_read` output is exempt to avoid an offload loop). See
[`Agent.offloadLargeResult`](../packages/core/src/agent.ts).

- **Spec**: The offload replacement is a clearly-marked, machine-recognizable envelope
  carrying the full-content **path**, so downstream summarization never drops the pointer.
  When a tool cannot complete because output was offloaded/omitted, it returns an explicit
  `{ ok:false, path, reason }`-style result rather than an optimistic success.
- **Testing** (`packages/core/test/memory-store.test.ts` — "addLongTermMemory result (B1)"):
  a normal `MEMORY.md` write returns `{ ok: true }`; an over-cap write is refused with
  `{ ok: false, reason }`, and the `memory_update` / `memory_update_longterm` tools return a
  structured `status:'error', ok:false` result (recognized by `isToolErrorResult`). Offload
  returns a result containing the file path.
- **Status**: implemented for the MEMORY.md refusal path (`MemoryStore.addLongTermMemory`
  now returns a structured result surfaced by the memory tools). Offload envelope with path
  is unchanged (already machine-recognizable).

---

## 3. Tool-Execution Loop

A "turn" runs the model, executes any tool calls it emits, appends the results, and calls
the model again — until the model stops requesting tools (or a safety cap is hit). Markus
runs this loop in several entry points in [`agent.ts`](../packages/core/src/agent.ts):
streaming chat (`handleMessageStream`), non-streaming chat (`handleMessage`), task
execution (`executeTask`), respond-in-session (`respondInSession`), and the
completion-marker continuation (`ensureCompletionMarker`).

Shared safety behavior across paths:

- **Iteration cap** `DEFAULT_MAX_TOOL_ITERATIONS = 200` (task execution is uncapped by
  design; heartbeat and marker-continuation use smaller caps).
- **Tool arg casing aliases** so snake_case vs camelCase never causes an infinite retry.
- **Loop detection** to break repeated identical tool calls.
- **`max_tokens` continuation** via a synthetic `[Continue…]` user message.
- **Parallel tool execution** on the streaming path; interrupt-aware sequential execution
  where preemption matters.

### 3.1 Spec: shared turn helper (incremental consolidation)

- **Behavior**: The common sub-steps of the loop — tool execution, error classification
  (`isToolErrorResult`), completion-marker handling, and the `max_tokens` continuation
  decision — are extracted into shared helpers invoked by all paths, so behavior does not
  diverge between entry points. This is an **incremental** consolidation, not a rewrite of
  the ~7k-line file. The first extraction covers the two loop-control decisions that were
  copy-pasted at all five loop sites: `shouldContinueToolLoop(response)` (keep iterating
  while the model still wants tools or was cut off by `max_tokens`) and
  `needsMaxTokensContinuation(response)` (a `max_tokens` cutoff without tool calls needs a
  "continue" nudge). Error classification (`isToolErrorResult`) and marker handling
  (`COMPLETION_MARKER` / `ensureCompletionMarker`) were already shared.
- **Invariants**: the five paths produce identical decisions for the same
  (tool result, finishReason, marker) inputs; existing loop/casing/`max_tokens` behavior is
  preserved (regression-guarded by the agent-loop tests). The helpers are pure and always
  return a `boolean` (never a truthy `toolCalls.length`).
- **Design rationale**: aligns with Pi's `pi-agent-core` and Hermes's single
  `conversation_loop` — one authoritative loop, many entry points.
- **Testing** (`packages/core/test/agent-loop.test.ts` — the "B5:" cases): unit tests for
  `shouldContinueToolLoop` / `needsMaxTokensContinuation`; the full loop suites
  (`agent-loop`, `agent-core`, `agent-extended`) run green as an equivalence guard.
- **Status**: implemented (pure `shouldContinueToolLoop` / `needsMaxTokensContinuation`
  exported from `agent.ts`, wired at all five loop sites). Further sub-step extraction
  (unified tool-execution/error-append) remains incremental future work.

---

## 4. Subagents

`spawn_subagent` and `spawn_subagents` run focused child agents with a **fresh, isolated
message history** that inherits the parent's tools and returns synchronously as a
`tool_result`. See [`tools/subagent.ts`](../packages/core/src/tools/subagent.ts).

Current guardrails:

- `SUBAGENT_MAX_PARALLEL = 10` caps concurrent children per `spawn_subagents` call.
- Each child has its own `maxIterations` (defaults to the parent's tool-iteration cap; the
  hard default is otherwise unbounded).

### 4.1 Design rationale (Hermes)

Hermes treats subagents as **processes**: independent iteration budgets, and it documents
that parent + child total iterations can exceed the parent cap — but bounds delegation with
`delegation.max_iterations`. Markus has per-child caps and a parallel-count cap but **no
aggregate budget** across a fan-out.

### 4.2 Spec: aggregate fan-out budget

- **Behavior**: A `spawn_subagents` fan-out enforces an **aggregate** iteration/cost ceiling
  across all children (in addition to per-child caps and `SUBAGENT_MAX_PARALLEL`). Exceeding
  it returns a structured error result rather than launching unbounded work.
- **Invariants**:
  - Total child iterations/cost for one fan-out cannot exceed the aggregate ceiling.
  - Under the ceiling, parallel execution behaves as today.
  - Over the ceiling, the tool returns `{ status:'error', … }` (recognized by
    `isToolErrorResult`).
- **Design rationale**: 10 parallel children × a large per-child cap can silently multiply
  CU/token spend; an explicit aggregate budget makes the cost bounded and observable.
- **Testing** (`packages/core/test/subagent-tools.test.ts` — the "B4:" cases):
  `runSubagentLoop` with a shared budget stops after exactly `remaining` iterations and marks
  its result; `spawn_subagents` with looping children returns `budgetExceeded: true` and the
  aggregate ceiling.
- **Status**: implemented (`SUBAGENT_MAX_AGGREGATE_ITERATIONS`; a `sharedBudget` threaded
  through `runSubagentLoop`, created per fan-out in `spawn_subagents`, surfaced as
  `budgetExceeded` in the aggregate result and an inline note in each truncated child).
  Per-child `maxIterations` and `SUBAGENT_MAX_PARALLEL` still apply.
