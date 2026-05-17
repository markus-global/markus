# Prompt Engineering & Context Assembly

This document specifies how Markus constructs prompts, manages context, and orchestrates LLM interactions across all scenarios. It complements [STATE-MACHINES.md](./STATE-MACHINES.md) (task lifecycle), [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) (storage layers), and [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) (cognitive preparation pipeline).

---

## 1. LLM Call Taxonomy

### 1.1 Two-Tier Call Model

LLM calls are organized in two tiers:

**Tier 1 -- Cognitive Preparation Calls**: Lightweight LLM calls that prepare context for the main call. These use persona-aware prompts and the cheapest available model. See [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) for theoretical foundations and full design.

| # | Phase | Purpose | Model | Tools | Max Output |
|---|-------|---------|-------|-------|-----------|
| P1 | **Appraisal** | Assess situation, plan context retrieval | Cheapest tier | No | 512 tokens |
| P3 | **Reflection** | Extract persona-specific patterns and insights from retrieved context | Cheapest tier | No | 512 tokens |
| P5 | **Evaluation** (D3 only) | Post-response assessment of context adequacy | Cheapest tier | No | 256 tokens |

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

**Cognitive depth** determines how many Tier 1 calls precede each Tier 2 call:

| Depth | Tier 1 Calls | When |
|-------|-------------|------|
| D0 Reflexive | 0 | HEARTBEAT_OK, acks, dream cycle |
| D1 Reactive | 0-1 (Appraisal) | Most chats, A2A, comments |
| D2 Deliberative | 2 (Appraisal + Reflection) | Task execution, complex questions |
| D3 Meta-cognitive | 2-3 (Appraisal + Reflection + post-Evaluation) | High-stakes decisions |

### 1.2 Lightweight Internal Calls (Scenario 8)

These are `handleMessage()` calls with `scenario: 'heartbeat'` and typed session IDs (e.g. `sys_<agentId>_<ts>`). Each call creates a persisted session for full traceability.

| Sub-scenario | Trigger | Session ID Pattern | Purpose |
|-------------|---------|-------------------|---------|
| **Daily Report** | `consolidateMemory()` (once/day) | `sys_<agentId>_<ts>` | Generate brief status report → `daily-logs/` |
| **Memory Flush** | `consolidateMemory()` (before compaction) | `sys_<agentId>_<ts>` | Prompt agent to `memory_save` important info before context window is compacted |
| **LLM Summarizer** | `contextEngine.smartSummarizeAndTruncate()` | N/A (internal) | Compress older conversation messages into a summary (no tools) |
| **Dream Consolidation** | `consolidateMemory()` (once/day, ≥50 entries) | `sys_<agentId>_<ts>` | LLM reviews memory entries, outputs prune/merge plan (no tools) |

---

## 2. System Prompt Architecture

The system prompt is assembled by `ContextEngine.buildSystemPrompt()` and organized into **three tiers** for optimal KV-cache reuse. Each tier has a `cache_control: { type: 'ephemeral' }` breakpoint (for Anthropic), allowing the provider to cache each stable prefix independently:

```
╔══════════════════════════════════════════════════════════╗
║  TIER 1 — STABLE (cache breakpoint ✓)                   ║
║  Rarely changes between calls for the same agent.        ║
║                                                          ║
║   1. Role System Prompt (from ROLE.md)                   ║
║   2. Policies                                            ║
║   3. Deliverable Format                                  ║
║   4. Task & Requirement Workflow                         ║
║   5. Tool Usage Rules                                    ║
║   6. Communication Rules                                 ║
║   7. Scenario Section (mode-specific instructions)       ║
╠══════════════════════════════════════════════════════════╣
║  TIER 2 — SEMI-STABLE (cache breakpoint ✓)              ║
║  Changes with org/config/session, not per query.         ║
║                                                          ║
║   8. Identity Section (name, role, colleagues)           ║
║   9. Organization Context (CONTEXT.md)                   ║
║  10. Team Announcements & Norms                          ║
║  11. Workspace Info (paths)                              ║
║  12. User Profiles (users/*.md) + Team Context           ║
║  13. Trust Level                                         ║
║  14. Environment Profile                                 ║
║  15. Your Knowledge (MEMORY.md — unified long-term)      ║
╠══════════════════════════════════════════════════════════╣
║  TIER 3 — DYNAMIC (no cache breakpoint)                  ║
║  Changes per call. Kept as small as possible.            ║
║                                                          ║
║  16. Project Context (governance)                        ║
║  17. System Announcements                                ║
║  18. Human Feedback                                      ║
║  19. Project Deliverables                                ║
║  20. Shared Deliverables                                 ║
║  21. Dynamic Context (skills, working memory)            ║
║  22. Cognitive Context / Relevant Memories               ║
║      (22a. CPP Appraisal, 22b. Retrieval, 22c.          ║
║       Reflection — when CPP active D1+/D2+)              ║
║  23. Task Board (capped)                                 ║
║  24. Mailbox & Attention Context                         ║
║  25. Sender Identity                                     ║
║  26. Timestamp                                           ║
╚══════════════════════════════════════════════════════════╝
```

### 2.1 KV-Cache Optimization Strategy

The system prompt uses a **3-tier cache architecture** with explicit cache breakpoints:

1. **Tier 1 (Stable)**: Role, policies, tool usage rules, scenario instructions. These rarely change for the same agent and scenario. A cache breakpoint after this tier allows the provider to cache this prefix across all calls with the same scenario.

2. **Tier 2 (Semi-stable)**: Identity, org context, workspace paths, long-term memory. These change when the agent's configuration, team, or memory changes, but remain stable within a session. A cache breakpoint here enables caching the combined Tier 1+2 prefix.

3. **Tier 3 (Dynamic)**: Project context, announcements, feedback, task board, mailbox state, timestamps. These change per call and are kept as small as possible. No cache breakpoint — this section is always re-processed.

**Message-level cache breakpoints**: In addition to system prompt caching, a `cacheBreakpoint` is placed on the last message before the current turn in the conversation history. This allows providers (e.g. Anthropic) to cache the stable conversation prefix (older history, channel context) independently from new messages.

**Channel session reuse**: A2A and group chat messages using the same channel share a stable session ID (`channel_{channelKey}_{agentId}`), so conversation history accumulates naturally and benefits from message-level prefix caching. Only the delta (new messages since last call) is added on subsequent turns.

### 2.2 Section Details

#### Role System Prompt (§1)
Source: `role.systemPrompt` parsed from the agent's `ROLE.md`.  
Contains the core behavioral instructions, personality, and domain expertise.

#### Dynamic Context (§2)
Source: `getDynamicContext()` — three sources:
1. **Registered providers**: Callback functions set via `registerDynamicContextProvider()`.
2. **Activated skill instructions**: When an agent calls `discover_tools` to activate a skill, its instructions are wrapped in `<skill name="...">...</skill>` tags and injected here.
3. **Working Memory**: Agent-managed situational awareness stored as a keyed Map.
   Each entry has a key, content, and update timestamp. Rendered as
   `## Working Memory` with age labels. Controlled by `update_working_memory` /
   `clear_working_memory` tools. System events (triage, deliberation) also auto-write entries.

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
- **Manager Responsibilities** (for managers): Routing, Coordination, Reporting, Cross-team, Escalation, Hiring

#### Task Board (§17)
Source: `opts.assignedTasks`.  
Displays the agent's active tasks and team tasks, **capped to prevent prompt bloat**:
- **My active tasks**: Top 15 by priority (critical → high → medium → low), each with title, ID, priority, and truncated description (150 chars).
- **Team tasks**: Top 10 by priority, with title, ID, assignee, and priority.
- Overflow is indicated with a count and a hint to use `task_list` for the full list.
- Completed/closed tasks are only shown as a count.

#### Mailbox & Attention Context (§22)
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

All 12 mailbox item types (`human_chat`, `task_status_update`, `session_reply`, `daily_report`, `memory_consolidation`, `heartbeat`, etc.) route through this section. Internal agent processes like heartbeats, daily reports, and memory consolidation also enqueue to the mailbox, meaning the agent always has full situational awareness about its own cognitive state. See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for the full design.

#### Scenario Section (§23)
Source: `buildScenarioSection()`.  
Eight distinct instruction sets depending on `scenario` parameter. Each scenario is slim and references the global Task Workflow (§18) and Tool Usage Rules (§21) rather than re-explaining them. Each scenario includes a **Communication channel** paragraph that specifies output visibility and appropriate tools:

| Scenario | Key Instructions | Output Visibility | Communication Tools |
|----------|-----------------|-------------------|-------------------|
| `chat` | Inline immediate-answer work. Sustained implementation → `task_create`. | **Directly visible** to the chatting human (real-time stream) | Speak naturally; `agent_send_message` for agents |
| `task_execution` | Isolated session. Decompose → execute → `task_submit_review`. | Visible in **task execution logs** (Work page) | `notify_user` for critical updates; `agent_send_message` for agents |
| `heartbeat` | Brief check-in: review tasks, retry failures, self-evolution. | **Not visible** to anyone | `notify_user` (only way to reach humans); `agent_send_message` for agents |
| `a2a` | Coordination only. Concise, structured. Complex work → `task_create`. | Visible to **peer agent** only | Reply directly; `notify_user` to escalate to humans |
| `group_chat` | Team group chat channel. Silence by default, @mention routing, processing checklist, reply-in-group rules. | Visible to **all team members** | `agent_send_group_message` for replies; `notify_user` for private escalation |
| `comment_response` | Context-first protocol. Batch awareness (handle bundled comments as one). Use `reply_to_comment_id` for structural quoting. Convergence check before replying. | **Not directly visible** | `task_comment` / `requirement_comment` for thread (with `reply_to_comment_id`); `notify_user` if urgent |
| `deliberation` | Multiple mailbox items — assess before committing. Use `check_mailbox` for full queue inspection; `defer_mailbox_item` / `drop_mailbox_item` for queue management; `update_working_memory` to record situational assessment; finish with `complete_deliberation`. | **Not visible** | Inline handling via deliberation whitelist (`notify_user`, `task_comment`, `agent_send_message`, etc.) |
| `review` | Evaluate deliverable quality against acceptance criteria. | **Not directly visible** | `task_update` for verdict; `notify_user` optionally |
| `memory_consolidation` | Internal memory management. Purely private. | **Not visible**; internal only | No communication tools needed |

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
| `handleMessage` | Chat (non-stream) | `tool_use \|\| max_tokens` | ✅ Continuation prompt | ✅ `ToolLoopDetector` | ✅ `withNetworkRetry` | configurable (default 200) |
| `handleMessageStream` | Chat (stream) | `tool_use \|\| max_tokens` | ✅ Continuation prompt | ✅ `ToolLoopDetector` | ✅ `withNetworkRetry` | configurable (default 200) |
| `_executeTaskInternal` | Task execution | `tool_use \|\| max_tokens` | ✅ Continuation prompt | — (uses reminder instead) | ✅ `withNetworkRetry` | None |
| `respondInSession` | Session reply | `tool_use \|\| max_tokens` | ✅ Continuation prompt | — | ✅ `withNetworkRetry` | 200 |

**Design rationale for iteration limits**: Task execution has **no hard iteration limit**. Complex tasks (writing code, running tests, debugging) legitimately require 100+ tool calls. Natural limiters are sufficient: the context window triggers compression, cancel tokens allow external stop, and the model naturally finishes by calling `task_submit_review`. Chat and similar paths use a **configurable** safety cap via `AgentOptions.maxToolIterations` and the system settings API (range 1–10000, default 200) — not a hardcoded 200. Real loop protection still comes primarily from `ToolLoopDetector`, not from this cap.

### 4.2 Common Harness Flow

```
0. Cognitive Preparation (when CPP enabled, depth D1+):
   0a. Appraisal — persona-aware LLM call → context plan (D1+)
   0b. Directed Retrieval — execute plan against indexed stores (D2+)
   0c. Reflection — persona-aware LLM call → insights (D2+)
   0d. Assembly — merge prepared context (code only)
1. Build system prompt (contextEngine.buildSystemPrompt + PreparedContext)
2. Build tool definitions (toolSelector.selectTools)
3. Prepare messages (contextEngine.prepareMessages — compress to fit budget)
4. LLM call (llmRouter.chat / chatStream, wrapped in withNetworkRetry)
5. WHILE response requires continuation:
   a. If tool_use: execute tools → append results → re-prepare messages → LLM call
   b. If max_tokens: append continuation prompt → re-prepare messages → LLM call
6. Output guardrail check
7. Persist final reply to session
8. Post-response evaluation (D3 only) — LLM assesses context adequacy
```

Step 0 is the Cognitive Preparation Pipeline. It runs once before the main harness loop (steps 1-7) begins. The preparation prompts are persona-aware: they include the agent's role description, current state, and recent activity, so different agents produce different context preparation plans for the same stimulus. See [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) for the full design.

### 4.3 Tool Execution

All tool calls within a single LLM response are executed **in parallel** (`Promise.all`) in `handleMessage` and `handleMessageStream`. In `_executeTaskInternal` and `respondInSession`, they are executed **sequentially** (for-of loop) with per-tool status events.

`spawn_subagent` and `spawn_subagents` let the model delegate focused subtasks to lightweight LLM subagents; `spawn_subagents` runs several in parallel. They are registered on the Agent like other built-in tools. All subagent limits (max parallel count, LLM retry policy, preview truncation lengths) are centralized in `packages/shared/src/limits.ts` — not hardcoded in the subagent module.

Large tool results (>50K chars) are offloaded to `{agentDataDir}/tool-outputs/` with a preview in context (Manus-inspired "restorable compression").

### 4.4 Loop Detection

`ToolLoopDetector` is active in both `handleMessage` and `handleMessageStream`. It tracks recent tool calls and detects repetitive patterns. When a critical loop is detected, a `[SYSTEM]` warning is injected into the conversation to nudge the model toward a different approach.

### 4.5 Task Completion Reminder

In `_executeTaskInternal`, every 10 tool iterations, a `[SYSTEM REMINDER]` message is injected reminding the agent to call `task_submit_review`. This combats the "lost in the middle" effect where long tool-use sequences push the original instructions out of the model's attention.

### 4.6 Mid-Execution Reflection Nudge

Every 30 tool iterations during task execution, a `[REFLECTION CHECKPOINT]` message is injected prompting the agent to capture any insights discovered during the current task. This ensures lessons are saved while context is fresh, rather than relying solely on post-task reflection.

### 4.7 Post-Task Reflection

When a task is accepted (`triggerPostTaskReflection` in `task-service.ts`), the system sends a reflection prompt to the assigned agent. The prompt includes:
- An **execution trace summary** (execution rounds, duration, result summary, recent notes)
- Differentiated guidance for **revision** cases (focus on what went wrong) vs **success** cases (focus on what worked)
- Guidance to create **skill packages** via skill-building for complex procedures (5+ steps)

---

## 5. Scenario-Specific Prompt Assembly

### 5.1 Human Chat (`handleMessage` / `handleMessageStream`)

```
┌─ System Prompt (full: identity + memory + tasks + scenario=chat)
├─ Session Messages (from memory store, compressed by prepareMessages)
└─ User Message (latest)
```

Session management:
- Uses `currentSessionId`. Creates session if none exists.
- Messages persisted to session JSON files and replayed on next call.
- Input/output guardrails applied.

### 5.2 Task Execution (`_executeTaskInternal`)

```
┌─ System Prompt (full: identity + memory + tasks + scenario=task_execution)
│   + projectContext (project info, repositories, governance rules)
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
- **Project repo access**: Agents can read and write files freely; the only hard restriction is that writes to other agents' directories are blocked. The agent manages its own workspace setup (worktrees, branching) via `shell_execute`.
- **Git command governance**: The shell tool enforces a three-tier model (Allow / Approval / Deny). Safe operations execute immediately, risky ones (checkout existing branch, merge, rebase, push to protected branches) pause for human approval via `HITLService.requestApprovalAndWait()`, and destructive operations (force push) are always denied. Approval responses include optional comments/reasons, which are returned to the agent as actionable feedback.
- **Retry with history**: If the session has prior assistant work (from interrupted attempts), a `[SYSTEM: Your previous execution attempt was interrupted...]` message is appended instead of the full task prompt.
- **AbortController**: Linked to `cancelToken` for external cancellation.

### 5.3 Heartbeat (`handleHeartbeat`)

Heartbeat uses `handleMessage(prompt, undefined, undefined, { sessionId: 'hb_<agentId>_<ts>', allowedTools, scenario: 'heartbeat' })`.

The heartbeat prompt is assembled inline (not via `buildSystemPrompt`) and includes:
1. `[HEARTBEAT CHECK-IN]` header
2. Agent's custom checklist (from `role.heartbeatChecklist`)
3. Last heartbeat summary (from memory search)
4. Failed task recovery instructions
5. Requirement monitoring section
6. Daily report section (managers, after 20:00)
7. Self-evolution reflection instructions — includes Knowledge Lifecycle decision matrix (observation buffer vs curated knowledge vs skill creation)
8. Quality signal check — revision rate self-assessment, knowledge effectiveness
9. "Patrol, Don't Build" rules — lightweight actions allowed, complex work → create task
10. When `background_exec` sessions have finished since the last turn, a `## Background Processes Completed` section is included so the model sees completion summaries on the next heartbeat
11. Conditional actions (failed bg processes, blocked tasks, completed dependencies, patterns)

Tool whitelist: `task_list`, `task_update`, `task_get`, `task_note`, `task_create`, `file_read`, `file_edit`, `agent_send_message`, `requirement_propose`, `requirement_list`, `memory_save`, `memory_search`, `memory_update_longterm`, `discover_tools`, `notify_user`, `request_user_approval`, `recall_activity`. Managers additionally get: `task_board_health`, `task_cleanup_duplicates`, `task_assign`, `team_status`, `deliverable_create`, `deliverable_search`, `package_list`, `package_install`. Secretary (with building skills) additionally gets: `hub_search`, `hub_install`.

Agent communication guidance (heartbeat context):

**Reaching humans** — raw text output is NOT visible to humans in heartbeat mode:
| Situation | Tool | Example |
|-----------|------|---------|
| Status report, finding, alert | `notify_user` (appears in chat timeline + bell) | "Daily report: completed 3 tasks today" |
| Task completed notification | `notify_user` + `related_task_id` | "Task X is ready for review" (clicks to task) |
| Need user to approve/reject | `request_user_approval` | "Approve deployment to production?" |
| Need user to choose between options | `request_user_approval` with custom `options` | "Should I use approach A or B for the auth refactor?" |
| Need user freeform input | `request_user_approval` with `allow_freeform: true` | "What credentials should I use?" |
| Want to discuss interactively | Mention user via task/requirement comment | Use `task_comment` or `requirement_comment` |
| Need to review past execution details | `recall_activity` | `recall_activity({ task_id: "tsk_abc" })` to find what happened |
| Routine heartbeat, nothing notable | Neither | Agent responds with `HEARTBEAT_OK` |

**Reaching agents** — use `agent_send_message` to send to a peer agent's mailbox.

Retry: 3 retries with exponential backoff (3s base).

### 5.4 A2A Chat

Uses `handleMessage(message, fromAgentId, senderInfo, { sessionId, scenario: 'a2a' })`.

**Session ID strategy**: When a `channelKey` is present (group chat context), the session ID is `channel_{channelKey}_{agentId}` — stable across all messages in the same channel. This enables conversation history accumulation and KV-cache reuse. For direct 1:1 A2A messages without a channel, a timestamp-based `a2a_{agentId}_{ts}` session is used (one-off).

The sender's identity is injected via `senderIdentity` in `buildSystemPrompt`. Channel-based A2A (via group chats) passes `channelContext` — recent channel messages are prepended to the session on the first turn; subsequent turns inject only delta messages (last 5).

### 5.4.1 Group Chat

Group chat messages (to `group:<teamId>` channels) are broadcast to ALL team members simultaneously via `processGroupChatReply()` in `api-server.ts`. Each agent processes the message independently with `scenario: 'group_chat'` (for human messages) or `scenario: 'a2a'` (for agent chain replies).

**Static rules in system prompt**: The `group_chat` scenario section in `buildScenarioSection()` contains all static group chat rules (silence by default, @mention routing, processing checklist, reply-in-group). This content is part of the Tier 1 stable system prompt and benefits from KV-caching.

**Per-message prefix**: Only variable, per-message information remains in the user message prefix:
- Channel header (team size, agent name, channel key)
- Targeting info (who is @mentioned, reply target, whether this agent is the target)
- Team member roster (for @mention format reference)

Empty or `[NO_RESPONSE]` replies are silently discarded (not persisted or broadcast).

### 5.5 Respond-in-Session

`respondInSession()` is used for continuing a specific session (e.g., task execution follow-up messages via the API). It always uses `scenario: 'chat'` and streams output via `onLog` events.

### 5.6 Daily Report

```
[DAILY REPORT REQUEST]
Generate a brief daily status report. Include:
1. What you worked on today (if anything)
2. Current status and any blockers
3. What you plan to work on next
...
Keep the report concise (3-5 sentences). Do NOT use any tools.
```

Called via `sendMessage(prompt, undefined, undefined, { sourceType: 'daily_report', sessionId: 'sys_<agentId>_<ts>', scenario: 'heartbeat' })`.
Result written to `daily-logs/` via `memory.writeDailyLog()`.

### 5.7 Memory Flush

```
[MEMORY FLUSH — System Request]
The conversation context is approaching its limit...
Use memory_save to persist:
- Key decisions or conclusions reached
- Important facts learned...
```

Called via `handleMessage(prompt, undefined, undefined, { sessionId: 'sys_<agentId>_<ts>', scenario: 'heartbeat' })`.  
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

1. **Always-on tools**: Core set always included (e.g., `memory_save`, `memory_search`, `file_read`, `file_write`, `task_create`, `task_list`, `spawn_subagent`, `spawn_subagents`, `check_mailbox`, `update_working_memory`, `clear_working_memory`, etc.)
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

### 7.1 Agent/Team Creation & Deployment

Creation and deployment are **two separate phases** with an explicit user gate between them.

**Phase 1 — Create (design the artifact):**
- Activate `agent-building`, `team-building`, or `skill-building` skill via `discover_tools`
- Write manifest + content files to `~/.markus/builder-artifacts/{agents|teams|skills}/{name}/`
- This produces a package on disk. No live resources are created.

**Phase 2 — Deploy (ONLY on explicit user request):**
| Method | When to use | Tools |
|--------|-------------|-------|
| Local package | Agents, teams, skills from package_list | `package_list` → `package_install` |
| Hub one-step | Community packages from Markus Hub | `hub_search` → `hub_install` |

**Post-deploy:** Onboard new agents via `agent_send_message` (project context) → `task_create` (initial work).

**Critical rule:** Agents must NEVER auto-deploy. `package_install` and `hub_install` create live agents that consume LLM tokens and join the organization. Only execute when the user explicitly says "install", "deploy", "hire", or "start".

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
| [MEMORY-SYSTEM.md](./MEMORY-SYSTEM.md) | Three memory layers (Semantic, Episodic, Procedural) feed into system prompt and are maintained by consolidation (§5.6-5.8) |
| `packages/core/src/agent.ts` | Implementation of all 7 LLM call scenarios and 4 harness variants |
| `packages/core/src/context-engine.ts` | `buildSystemPrompt()` and `prepareMessages()` implementation |
| `packages/core/src/llm/router.ts` | Provider routing, circuit breaker, model catalog, output token resolution |
| `packages/core/src/tool-selector.ts` | Tool selection logic |
