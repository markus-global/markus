# Prompt Engineering & Context Assembly

This document specifies how Markus constructs prompts, manages context, and orchestrates LLM interactions across all scenarios. It complements [STATE-MACHINES.md](./STATE-MACHINES.md) (task lifecycle) and [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) (storage layers).

---

## 1. LLM Call Taxonomy

Every LLM invocation falls into one of seven categories:

| # | Scenario | Entry Point | Method | Streaming | Tools | Network Retry | Loop Limit |
|---|----------|-------------|--------|-----------|-------|---------------|------------|
| 1 | **Human Chat** (non-stream) | API `/api/agents/:id/chat` | `handleMessage()` | No | Yes | Yes | 200 (safety net) |
| 2 | **Human Chat** (stream/SSE) | API `/api/agents/:id/chat?stream=1` | `handleMessageStream()` | Yes | Yes | Yes | 200 (safety net) |
| 3 | **Task Execution** | `TaskService.runTask()` → `_executeTaskInternal()` | `llmRouter.chatStream()` | Yes | Yes | Yes | **None** |
| 4 | **Respond-in-Session** | API `/api/agents/:id/sessions/:sid/messages` | `respondInSession()` | Yes | Yes | Yes | 200 (safety net) |
| 5 | **Heartbeat** | `HeartbeatScheduler` → `handleHeartbeat()` | `handleMessage(ephemeral)` | No | Subset | Yes (via handleMessage) | 200 + 3 retries |
| 6 | **A2A Chat** | API `/api/agents/:id/a2a` / channel routing | `handleMessage(ephemeral)` | No | Yes | Yes (via handleMessage) | 200 |
| 7 | **Ephemeral Internal** | Various | `handleMessage(ephemeral)` | No | Varies | Yes (via handleMessage) | 200 |

### Ephemeral Internal Calls (Scenario 7)

These are `handleMessage()` calls with `ephemeral: true` and no `senderId`, creating throwaway sessions. They use `scenario: 'heartbeat'` to receive lightweight instructions instead of full chat scenario guidance.

| Sub-scenario | Trigger | Purpose |
|-------------|---------|---------|
| **Daily Report** | `consolidateMemory()` (once/day) | Generate brief status report → `daily-logs/` |
| **Memory Flush** | `consolidateMemory()` (before compaction) | Prompt agent to `memory_save` important info before context window is compacted |
| **LLM Summarizer** | `contextEngine.smartSummarizeAndTruncate()` | Compress older conversation messages into a summary (no tools) |
| **Dream Consolidation** | `consolidateMemory()` (once/day, ≥50 entries) | LLM reviews memory entries, outputs prune/merge plan (no tools) |

---

## 2. System Prompt Architecture

The system prompt is assembled by `ContextEngine.buildSystemPrompt()`. Sections are appended in a fixed order to maximize KV-cache reuse (stable prefix, volatile suffix):

```
┌─────────────────────────────────────────────┐
│  1. Role System Prompt (from ROLE.md)       │  ← Stable: rarely changes
│  2. Dynamic Context (activated skills)      │
│  3. Identity Section                        │
│  4. Organization Context (CONTEXT.md)       │
│  5. Team Announcements & Norms              │
│  6. Project Context (governance)            │
│  7. Workspace Info (paths, branches)        │
│  8. User Profile (USER.md)                  │
│  9. Trust Level                             │
│ 10. System Announcements                    │
│ 11. Human Feedback                          │
│ 12. Project Deliverables                    │
│ 13. Policies                                │
│ 14. Long-term Knowledge (MEMORY.md)         │
│ 15. Lessons from Past Experience            │
│ 16. Shared Deliverables                     │
│ 17. Relevant Memories (semantic search)     │
│ 18. Recent Activity Summary (daily-logs)    │
│ 19. Task Board (capped)                     │
│ 20. Task Workflow Instructions              │
│ 21. Environment Profile                     │
│ 22. Current Conversation (sender info)      │
│ 23. Scenario Section (mode-specific)        │  ← Volatile: changes per call
│ 24. Timestamp                               │
└─────────────────────────────────────────────┘
```

### 2.1 KV-Cache Optimization Strategy

The timestamp is placed at the **end** of the system prompt (not the beginning) so that the stable prefix (identity, role, policies, memory) can be KV-cached across calls. Only the last few lines change between invocations.

### 2.2 Section Details

#### Role System Prompt (§1)
Source: `role.systemPrompt` parsed from the agent's `ROLE.md`.  
Contains the core behavioral instructions, personality, and domain expertise.

#### Dynamic Context (§2)
Source: `getDynamicContext()` — two sources:
1. **Registered providers**: Callback functions set via `registerDynamicContextProvider()`.
2. **Activated skill instructions**: When an agent calls `discover_tools` to activate a skill, its instructions are wrapped in `<skill name="...">...</skill>` tags and injected here.

#### Identity Section (§3)
Source: `buildIdentitySection()`.  
Contains:
- Agent name, role, position (manager vs worker)
- Active skills (already installed)
- **Available skills catalog** (filtered by relevance to current query, max 30 entries — see §2.3)
- Organization name, Agent ID
- Manager info (for workers)
- Colleague list (name, role, type, status, skills)
- Human team members

#### Task Board (§19)
Source: `opts.assignedTasks`.  
Displays the agent's active tasks and team tasks, **capped to prevent prompt bloat**:
- **My active tasks**: Top 15 by priority (critical → high → medium → low), each with title, ID, priority, and truncated description (150 chars).
- **Team tasks**: Top 10 by priority, with title, ID, assignee, and priority.
- Overflow is indicated with a count and a hint to use `task_list` for the full list.
- Completed/closed tasks are only shown as a count.

#### Scenario Section (§23)
Source: `buildScenarioSection()`.  
Four distinct instruction sets depending on `scenario` parameter:

| Scenario | Key Instructions |
|----------|-----------------|
| `chat` | Inline only simple queries (≤3 tool calls). Complex work → `task_create`. **Stop after creating tasks.** |
| `task_execution` | Decompose into subtasks. Work systematically. Call `task_submit_review` when done (mandatory). |
| `heartbeat` | Brief check-in. Review duty first, then status, failed tasks, daily report, self-evolution. Max 5 tool calls (exceptions for reviews/reports). |
| `a2a` | Coordination only. Concise, structured. Complex work → `task_create`. |

### 2.3 Skill Filtering

`filterSkillsByRelevance()` scores each skill against the current query by keyword overlap. Returns top 30. Each entry is one line: `**name** [category]: description`. This keeps token cost proportional — agents with many installed skills don't bloat every prompt.

---

## 3. Message Assembly & Context Compression

`ContextEngine.prepareMessages()` assembles the final message array sent to the LLM. It operates in four stages.

### 3.1 Token Budget Calculation

```
contextWindow        = model's context window (e.g. 200K for Claude Sonnet 4)
maxOutput            = min(model.maxOutputTokens, contextWindow × 40%)
safetyMargin         = min(contextWindow × 15%, 30000)
messageBudget        = contextWindow − systemTokens − toolDefTokens − maxOutput − safetyMargin
```

**maxOutput reservation**: Uses the model's actual `maxOutputTokens` from the model catalog (e.g. 64K for Claude Sonnet 4, 128K for Claude Opus 4.6), capped at 40% of the context window. This ensures the budget reserves enough space for the model's full output capability without over-compressing messages.

Token estimates use tiktoken when available (model-specific encoding), falling back to `chars / 3.5` heuristic.

### 3.2 Compression Pipeline

```
Session Messages
       │
       ▼
 Stage 1: Count-based summarization
   └─ If >60 messages → smartSummarizeAndTruncate(keep: 40)
       │
       ▼
 Stage 2: Per-message size cap
   └─ shrinkOversizedMessages(cap: max(2000, budget/8))
   └─ sanitizeMessageSequence()
       │
       ▼
 Stage 3: Token-budget-driven compression (progressive)
   ├─ 3a: compactOldTurns() — summarize tool-call blocks
   ├─ 3b: smartSummarizeAndTruncate(keep: 40%) — LLM or heuristic
   └─ 3c: Aggressive summarize(keep: 30%) + re-shrink
       │
       ▼
 Stage 4: Last-resort trimming
   └─ trimToFitBudget() — drop oldest, protect index 0 (task prompt)
       │
       ▼
 Final: [system prompt, ...compressed messages]
```

**Ephemeral sessions**: Ephemeral calls (heartbeat, A2A, memory flush) skip the full `prepareMessages` pipeline but use a lightweight `shrinkEphemeralMessages()` guard that caps each message at `contextWindow/20` chars and drops the oldest non-system messages when the total exceeds 70% of the context window. This prevents unbounded growth during multi-tool ephemeral interactions.

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
- Output max 1024 tokens, temperature 0.2.
- Fallback: `buildHeuristicSummary()` extracts key sentences from assistant messages.
- Summary is persisted to daily-logs (keyed by `agentId`) for traceability.

### 3.6 Message Sanitization

`sanitizeMessageSequence()` ensures structural correctness before LLM submission:
- Every `assistant(toolCalls)` must be followed by ALL corresponding `tool` result messages.
- Orphaned tool messages are dropped.
- Incomplete assistant+tool blocks are dropped entirely.
- Consecutive user messages are merged (unless either is a system injection like `[SYSTEM]` or `[Conversation history summary`).

---

## 4. Tool Loop Harness

The "harness" is the while-loop that drives agentic tool use: LLM → tool calls → results → LLM → ... until the model stops calling tools.

### 4.1 Harness Variants

| Harness | Location | Loop Condition | max_tokens Handling | Loop Detection | Network Retry | Iteration Limit |
|---------|----------|----------------|--------------------|--------------------|---------------|-----------------|
| `handleMessage` | Chat (non-stream) | `tool_use \|\| max_tokens` | ✅ Continuation prompt | ✅ `ToolLoopDetector` | ✅ `withNetworkRetry` | 200 |
| `handleMessageStream` | Chat (stream) | `tool_use \|\| max_tokens` | ✅ Continuation prompt | ✅ `ToolLoopDetector` | ✅ `withNetworkRetry` | 200 |
| `_executeTaskInternal` | Task execution | `tool_use \|\| max_tokens` | ✅ Continuation prompt | — (uses reminder instead) | ✅ `withNetworkRetry` | None |
| `respondInSession` | Session reply | `tool_use \|\| max_tokens` | ✅ Continuation prompt | — | ✅ `withNetworkRetry` | 200 |

**Design rationale for iteration limits**: Task execution has **no hard iteration limit**. Complex tasks (writing code, running tests, debugging) legitimately require 100+ tool calls. Natural limiters are sufficient: the context window triggers compression, cancel tokens allow external stop, and the model naturally finishes by calling `task_submit_review`. Chat paths retain a generous 200-iteration safety net as a last resort — real loop protection comes from `ToolLoopDetector`, not from this cap.

### 4.2 Common Harness Flow

```
1. Build system prompt (contextEngine.buildSystemPrompt)
2. Build tool definitions (toolSelector.selectTools)
3. Prepare messages (contextEngine.prepareMessages — compress to fit budget)
4. LLM call (llmRouter.chat / chatStream, wrapped in withNetworkRetry)
5. WHILE response requires continuation:
   a. If tool_use: execute tools → append results → re-prepare messages → LLM call
   b. If max_tokens: append continuation prompt → re-prepare messages → LLM call
6. Output guardrail check
7. Persist final reply to session
```

### 4.3 Tool Execution

All tool calls within a single LLM response are executed **in parallel** (`Promise.all`) in `handleMessage` and `handleMessageStream`. In `_executeTaskInternal` and `respondInSession`, they are executed **sequentially** (for-of loop) with per-tool status events.

Large tool results (>50K chars) are offloaded to `{agentDataDir}/tool-outputs/` with a preview in context (Manus-inspired "restorable compression").

### 4.4 Loop Detection

`ToolLoopDetector` is active in both `handleMessage` and `handleMessageStream`. It tracks recent tool calls and detects repetitive patterns. When a critical loop is detected, a `[SYSTEM]` warning is injected into the conversation to nudge the model toward a different approach.

### 4.5 Task Completion Reminder

In `_executeTaskInternal`, every 10 tool iterations, a `[SYSTEM REMINDER]` message is injected reminding the agent to call `task_submit_review`. This combats the "lost in the middle" effect where long tool-use sequences push the original instructions out of the model's attention.

---

## 5. Scenario-Specific Prompt Assembly

### 5.1 Human Chat (`handleMessage` / `handleMessageStream`)

```
┌─ System Prompt (full: identity + memory + tasks + scenario=chat)
├─ Session Messages (from memory store, compressed by prepareMessages)
└─ User Message (latest)
```

Session management:
- Non-ephemeral: Uses `currentSessionId`. Creates session if none exists.
- Messages persisted to session store and replayed on next call.
- Input/output guardrails applied.

### 5.2 Task Execution (`_executeTaskInternal`)

```
┌─ System Prompt (full: identity + memory + tasks + scenario=task_execution)
│   + projectContext (governance rules, repositories)
│   + currentWorkspace (branch, worktreePath, baseBranch)
├─ Task Prompt (injected as first user message):
│   [TASK EXECUTION — Task ID: xxx]
│   {description}
│   {resume/retry instructions if applicable}
│   ## Completion Requirements — MANDATORY
│   You MUST call task_submit_review ...
└─ Session Messages (task session: task_{id}_r{round})
```

Key differences from chat:
- **Deterministic session ID**: `task_{taskId}_r{round}`. Retries within the same round reuse session history (preserving tool call results). New rounds get fresh sessions.
- **Workspace rebinding**: If the task has a `TaskWorkspace`, tools are rebound to the worktree path with a new `PathAccessPolicy`.
- **Retry with history**: If the session has prior assistant work (from interrupted attempts), a `[SYSTEM: Your previous execution attempt was interrupted...]` message is appended instead of the full task prompt.
- **AbortController**: Linked to `cancelToken` for external cancellation.

### 5.3 Heartbeat (`handleHeartbeat`)

Heartbeat uses `handleMessage(prompt, undefined, undefined, { ephemeral: true, maxHistory: 30, allowedTools, scenario: 'heartbeat' })`.

The heartbeat prompt is assembled inline (not via `buildSystemPrompt`) and includes:
1. `[HEARTBEAT CHECK-IN]` header
2. Agent's custom checklist (from `role.heartbeatChecklist`)
3. Last heartbeat summary (from memory search)
4. Failed task recovery instructions
5. Daily report section (managers, after 20:00)
6. Self-evolution reflection instructions
7. Rules (compare against last heartbeat, max 5 tool calls with exceptions)

Tool whitelist: `task_list`, `task_update`, `task_get`, `task_note`, `file_read`, `file_edit`, `agent_send_message`, `requirement_propose`, `requirement_list`, `memory_save`, `memory_search`, `memory_update_longterm`, `discover_tools`, `send_user_message`. Managers additionally get: `task_board_health`, `task_cleanup_duplicates`, `task_assign`, `team_status`, `deliverable_create`, `deliverable_search`.

Retry: 3 retries with exponential backoff (3s base).

### 5.4 A2A Chat

Uses `handleMessage(message, fromAgentId, senderInfo, { ephemeral: true })`.

The `scenario` is auto-detected: when `isEphemeral && senderId` are both truthy, scenario defaults to `'a2a'`. The sender's identity is injected via `senderIdentity` in `buildSystemPrompt`.

Channel-based A2A (via group chats) passes `channelContext` — recent channel messages for multi-party conversation context.

### 5.5 Respond-in-Session

`respondInSession()` is used for continuing a specific session (e.g., task execution follow-up messages via the API). It always uses `scenario: 'chat'` and streams output via `onLog` events.

### 5.6 Ephemeral: Daily Report

```
[DAILY REPORT REQUEST]
Generate a brief daily status report. Include:
1. What you worked on today (if anything)
2. Current status and any blockers
3. What you plan to work on next
...
Keep the report concise (3-5 sentences). Do NOT use any tools.
```

Called via `handleMessage(prompt, undefined, undefined, { ephemeral: true, maxHistory: 5, scenario: 'heartbeat' })`.  
Result written to `daily-logs/` via `memory.writeDailyLog()`.

### 5.7 Ephemeral: Memory Flush

```
[MEMORY FLUSH — System Request]
The conversation context is approaching its limit...
Use memory_save to persist:
- Key decisions or conclusions reached
- Important facts learned...
```

Called via `handleMessage(prompt, undefined, undefined, { ephemeral: true, maxHistory: 25, scenario: 'heartbeat' })`.  
Triggered when main session exceeds 30 messages, before compaction.

### 5.8 Dream Consolidation

Not a `handleMessage` call — uses `llmRouter.chat()` directly with a specialized prompt:

```
System: You are a memory consolidation assistant...
User: ## Memory Entries\n{id|timestamp|type|tags|content for each entry}
      ## Instructions: Output JSON with remove, merge operations...
```

Capped at 200 most recent entries. Output is parsed as JSON and applied programmatically (remove entries, merge duplicates). Vector index is synchronized post-consolidation.

---

## 6. Output Token Resolution

The `LLMRouter` resolves `maxTokens` (output token limit) for every LLM call:

1. If the caller explicitly sets `request.maxTokens`, that value is used.
2. Otherwise, the router looks up the model in `BUILTIN_MODEL_CATALOG` and uses the model's `maxOutputTokens` (e.g. 64K for Claude Sonnet 4, 128K for Claude Opus 4.6).
3. As a final fallback (unknown models), the provider's configured default applies (typically 4096).

This ensures that modern models with large output windows are not artificially constrained, allowing full-length code generation, detailed analyses, and long-form writing without premature `max_tokens` truncation.

---

## 7. Tool Selection

`ToolSelector.selectTools()` determines which tools appear in each LLM call:

1. **Always-on tools**: Core set always included (e.g., `memory_save`, `memory_search`, `file_read`, `file_write`, `task_create`, `task_list`, etc.)
2. **Manager-only tools**: Added when `isManager=true` (e.g., `task_assign`, `team_status`)
3. **Task-execution tools**: Added when `isTaskExecution=true` (e.g., `task_submit_review`, `subtask_create`)
4. **Recently used tools**: Tools used in recent calls are re-included to maintain continuity
5. **Activated tools**: Tools the agent explicitly activated via `discover_tools`
6. **Skill-provided tools**: MCP tools from activated skills
7. **`discover_tools` meta-tool**: Always present, enabling agents to list/activate/install skills at runtime

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
| [STATE-MACHINES.md](./STATE-MACHINES.md) | Task state transitions trigger different LLM call paths (§5.2 task execution, §5.3 heartbeat review) |
| [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) | Memory layers feed into system prompt (§2: long-term knowledge, lessons, daily logs, relevant memories) and are maintained by ephemeral LLM calls (§5.6-5.8) |
| `packages/core/src/agent.ts` | Implementation of all 7 LLM call scenarios and 4 harness variants |
| `packages/core/src/context-engine.ts` | `buildSystemPrompt()` and `prepareMessages()` implementation |
| `packages/core/src/llm/router.ts` | Provider routing, circuit breaker, model catalog, output token resolution |
| `packages/core/src/tool-selector.ts` | Tool selection logic |
