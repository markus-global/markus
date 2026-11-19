# Tool Loop Harness & Scenario Assembly

> **Scope (this file)**: how one LLM call actually *runs* — the tool-loop harness and its variants, tool execution, loop detection, task-completion reminders, reflection nudges — and how each scenario assembles its prompt, tool face, and callback replay (scenario × context matrix, scenario × tool face, async callback scenario replay).
> **Split out of** [prompt-engineering.md](./prompt-engineering.md) §4 + §5 on **2026-11-15**. Section numbers (§4.x, §5.x) are unchanged, so an existing `prompt-engineering.md §4.x/§5.x` reference resolves to the same number here.
> **Siblings**: [prompt-engineering.md](./prompt-engineering.md) — call taxonomy, cache-scope layout, system-prompt architecture (§1–§2), output-token resolution (§6); [context-assembly.md](./context-assembly.md) — token budget, compression pipeline, ContextOS anchors (§3).

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
0. Deterministic context assembly (no LLM): read recent activity + working-memory
   keys; ContextEngine retrieves relevance-matched memories (bounded).
1. Build system prompt (contextEngine.buildSystemPrompt)
   → injects ## Relevant Memories (this turn only) + a deterministic ## Cognitive Context
2. Build tool definitions (toolSelector.selectTools)
3. Prepare messages (contextEngine.prepareMessages — compress to fit budget)
4. LLM call (llmRouter.chat / chatStream, wrapped in withNetworkRetry)
5. WHILE response requires continuation:
   a. If tool_use: execute tools → append results → re-prepare messages → LLM call
   b. If max_tokens: append continuation prompt → re-prepare messages → LLM call
6. Output guardrail check
7. Persist final reply to session
```

Step 0 is **deterministic** — there is no Cognitive Preparation Pipeline and no pre-call LLM. The ContextEngine assembles a small, bounded situational block from recent activity and working-memory keys, and performs its own bounded relevant-memory retrieval. Deeper cross-domain recall is agent-driven via `memory_search` / `kb_search`.

### 4.3 Tool Execution

All tool calls within a single LLM response are executed **in parallel** (`Promise.all`) in `handleMessage` and `handleMessageStream`. In `_executeTaskInternal` and `respondInSession`, they are executed **sequentially** (for-of loop) with per-tool status events.

**Write serialisation under concurrency.** When the agent runs a concurrent worker pool,
state-mutating tool calls are routed through an agent-level FIFO **write lock**
(`Agent.withToolWriteLock`, see [concurrent-processing.md](./concurrent-processing.md)) so
two workers cannot mutate shared state at the same instant. Read-only tools are not
blocked; the lock is released even when the wrapped call throws. Note this serialises a
*single tool call*, not an entire multi-step flow — see the known-limitations section of
that doc.

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

The heartbeat user prompt is assembled inline; the system prompt still comes from `buildSystemPrompt(scenario:'heartbeat')` (identity, `## Your Knowledge`, and the cached `heartbeat` scenario section); mailbox context and `## Notebook` ride the volatile `[Live context]` tail rather than the system prefix. The inline prompt is deliberately **slim** — it carries only per-call dynamic content and defers durable rules to the cached system prompt. It includes:
1. `[HEARTBEAT CHECK-IN]` header + agent's custom checklist (from `role.heartbeatChecklist`)
2. Last heartbeat summary (from memory search)
3. Conditional dynamic sections, only when present: `## Background Processes Completed` (finished `background_exec` sessions), `## Timed-Out Async Operations`, **`## Active Goals`** (when `goalFetcher` is wired — each standing goal's title, status, `currentIteration`/`maxIterations`, and completion criteria), and the manager `## Daily Report Required` section (after 20:00)
4. Slim `## Failed Task Recovery` and `## Requirement Monitoring` (2-3 lines each)
5. `## Self-Evolution` — a compact Knowledge Lifecycle **decision matrix** that routes each learning to the right home (`memory_save` / `memory_update_longterm` / skill / ROLE.md / HEARTBEAT.md), with the revision-rate quality signal folded into a single line
6. `## Patrol Reminder` — lightweight-patrol do/don't rules; points to `schedule_wakeup` for precise follow-ups and `set_heartbeat_interval` to adjust cadence. It explicitly **defers** communication-channel and async-timing details to the cached scenario/Tier-1 sections rather than restating them
7. `## Finishing Up` — `memory_save` a `heartbeat:summary`, produce the daily report if required, else respond `HEARTBEAT_OK`

**Deduplication note**: earlier versions of the inline prompt restated `## Communication Channels`, `## Core Principle: Patrol, Don't Build`, `## Prefer Scheduled Wakeups`, `## What You CAN/MUST NOT Do`, and `## Conditional Actions`. These duplicated the cached `heartbeat` scenario section (§5.3 / `buildScenarioSection`) and Tier-1 rules, so they were removed from the (uncached) inline user prompt to cut per-heartbeat token cost. The `heartbeat` scenario section is now the single source of truth for comms/priorities.

**Notebook Guidelines** (in mailbox checklists / system prompt when queue context is present): use `notebook_upsert` to save priorities, context, decisions, and blockers; `notebook_clear` when context becomes irrelevant. Do not store raw message content — use `memory_save` for durable observations.

Tool whitelist = **reflex allowlist** (`REFLEX_CORE_TOOLS` + manager `team_status`):
`task_list`, `task_get`, `memory_save`, `memory_search`, `notify_user`, `request_user_input`,
`schedule_wakeup`, `cancel_wakeup`, `set_heartbeat_interval`, `discover_tools`, `check_mailbox`,
`file_read`, `agent_send_message`, `notebook_upsert`. MUST NOT imply `task_create` /
`requirement_propose` / `package_install` / `goal_*` in heartbeat (see Interaction Mode).

**Heartbeat cadence & configurability**: the periodic heartbeat is a coarse safety-net (`DEFAULT_HEARTBEAT_INTERVAL_MS`, 6h) behind the event-driven `schedule_wakeup` mechanism — it is NOT the primary timing mechanism. The interval is configurable at three levels: (a) the user via `PATCH /api/agents/:id/config` (`heartbeatIntervalMs`) or the Agent Profile → Heartbeat tab; (b) the agent itself via the `set_heartbeat_interval` tool (clamped to `MIN_HEARTBEAT_INTERVAL_MS`–`MAX_HEARTBEAT_INTERVAL_MS`, i.e. 5min–24h). Both apply **live** via `Agent.setHeartbeatInterval()` (restarts the scheduler) and persist (agent-driven changes flow through the `agent:heartbeat-interval-changed` event → `agentRepo.updateConfig`). A one-time SQLite migration (gated by `PRAGMA user_version`) bumps agents still on the legacy 30-min default to the 6h safety-net without clobbering any interval a user or agent set deliberately.

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

**Trigger (spec)**: a **turn-level preflight** — before a turn packs context, if the
previous turn's context usage crossed a threshold (~75%) and this session has not flushed
yet, run `memoryFlush` once (deduplicated per session; the flush itself uses an independent
`sys_` session so it cannot recurse into another flush). See the memory-flush spec in
[memory-system.md](./memory-system.md) for the authoritative behavior, invariants, and
tests. Status: implemented — `maybeMemoryFlushPreflight()` is wired into the three main turn paths
(`handleMessage`, `handleMessageStream`, and task execution in `agent.ts`), deduplicated per session.

### 5.8 Dream Consolidation

Not a `handleMessage` call — uses `llmRouter.chat()` directly with a specialized prompt:

```
System: You are a memory consolidation assistant...
User: ## Memory Entries\n{id|timestamp|type|tags|content for each entry}
      ## Instructions: Output JSON with remove, merge operations...
```

Capped at 500 most recent entries (`MAX_ENTRIES_FOR_LLM`). Output is parsed as JSON and applied programmatically (remove entries, merge duplicates). Vector index is synchronized post-consolidation.

### 5.9 Scenario × Context Matrix (2026-09-16)

Every `AgentScenario` must render a `## Current Interaction Mode` block answering three
questions the model **cannot infer from history**: (a) *is my text output visible to anyone?*,
(b) *which tool actually reaches a human?*, (c) *when must I stay silent?* Losing any of the
three is a **completeness** regression, not a token saving — a model that does not know its
output is invisible will end the turn with prose and accomplish nothing.

| Scenario | Output visible? | Reaches a human via | Silence rule | Boundary guard |
|---|---|---|---|---|
| `chat` | yes (streamed) | direct text | — | stop when done, no check-in questions |
| `task_execution` | no (logs only) | `notify_user` / `task_note` | — | `task_submit_review` mandatory |
| `heartbeat` | **no** | `notify_user` (only path) | `HEARTBEAT_OK` | reflex pack only |
| `a2a` (DM) | auto-sent to peer | — | `[NO_RESPONSE]` on ack/conclusion | DM dedup + loop guard |
| `a2a` (group channel) | **normalized → `group_chat`** | — | `[NO_RESPONSE]` | see invariant below |
| `group_chat` | auto-sent to channel | `notify_user` (private) | `[NO_RESPONSE]` (default) | @mention routing |
| `comment_response` | no | `task_comment` / `requirement_comment` | `[NO_REPLY_NEEDED]` | context-first, no bare ack |
| `requirement_action` | no | `requirement_comment` / `notify_user` | — | ≥1 action tool required |
| `workflow_action` | no | `notify_user` | — | ≥1 action tool required |
| `review` | no | `task_comment` / `notify_user` | — | reviewer ≠ assignee |
| `distillation` | no | `notify_user` (rare) | stop with no tools if nothing durable | Learning Habits |
| `memory_consolidation` | no | — (tools forbidden) | — | JSON-only output |

There is **no `deliberation` scenario**: the batch assess-then-commit turn
and its whole-queue completion tool were **deleted** in the Forever Loop refactor (M1–M7).
Which item the agent works on next — and whether a new arrival preempts, merges with
or queues behind it — is decided before the turn by the pure rule table `heuristicDecision()`
in `attention.ts` (R0–R9): no model call, no triage, no deliberation turn. Strict-state items
stay untouchable at the tool layer (`defer_mailbox_item` / `drop_mailbox_item` refuse them).

**Invariant 13a — a caller-supplied scenario is authoritative.** `agent.ts` used to force
`opts.scenario = 'a2a'` for every `sourceType: 'a2a_message'`, clobbering an explicit scenario
from the caller. `a2a_message` is a *transport* (it is what a channel message looks like when it
comes from an agent rather than a human), not a scenario. The engine now defaults to `'a2a'` only
when the caller stayed silent.

**Invariant 13b — channel-derived normalization.** `a2a` covered two physically different
channels. A group-channel item rendered the 1:1 wording — *"Humans do NOT see this conversation …
absorb silently"* — which is false in a group chat, where the reply is **auto-broadcast to
humans**. `buildSystemPrompt` now normalizes `a2a` + `channelKey.startsWith('group:')` →
`group_chat`, and `api-server.ts` stops downgrading a group channel to `'a2a'` for chained
(agent-triggered) replies. The A2A-ness of such a message is carried by the caller's injected
`[AGENT COLLABORATION]` prefix, not by switching the scenario.

Guard test: `context-scenario-matrix.test.ts` — asserts all 12 scenarios render a non-trivial
block, that each declares visibility/reachability, that `a2a`+group renders the group block and
never the DM/"humans do NOT see this" wording, and that `distillation` (which previously said only
"free-text is not a chat reply") states visibility explicitly. Run against the old code, the
group-channel and distillation cases fail.

---

### 5.10 Scenario × Tool Face — prompts must not name tools the model doesn't have (2026-09-16)

The matrix in §5.9 answers *what the model is told*. This section is its dual: *what the model can
actually call*. A prompt that mandates a tool absent from the request's `tools` array is worse than
a missing instruction — the model burns turns on `discover_tools` (or loops on validation errors)
and the scenario silently fails.

**The selection path.** `ToolSelector.selectTools` builds the schema from
`BASE_TOOL_NAMES` ∪ keyword-matched `ToolGroup`s ∪ `recentToolNames` ∪ `discover_tools`
activations, with `TOOL_DEF_CORE_KEEP` protected from eviction. A tool name that appears in **no**
group and is not in the keep-set can therefore never reach the model by default — even when it is
fully registered and the scenario's prompt demands it.

**The authoritative-allow-list contract.** Scenarios whose prompt issues hard mandates carry an
explicit `allowedTools` set. `agent.ts` applies it in two directions: it *filters* the selection
**and** *unions in* any allowed tool that keyword selection missed (offering its live
description/schema from the registry). The existing sets are
`HEARTBEAT_ALLOWED_TOOLS`, `DELIBERATION_ALLOWED_TOOLS`, `DISTILLATION_EXTRA_TOOLS` and — added in
this pass — `COMMENT_RESPONSE_ALLOWED_TOOLS`, `REQUIREMENT_ACTION_ALLOWED_TOOLS`,
`WORKFLOW_ACTION_ALLOWED_TOOLS` (+ `TASK_EXECUTION_EXTRA_TOOLS` spliced into the `isTaskExecution`
branch). `SCENARIO_ALLOWED_TOOLS` exposes the map.

Why each one is load-bearing:

| Scenario | Prompt mandate | Why default selection can't surface it |
|---|---|---|
| `requirement_action` | *"**MANDATORY**: before deciding, call `requirement_get`"*, *"`requirement_update_status`"* | neither is in `TOOL_DEF_CORE_KEEP`/`BASE_TOOL_NAMES`, and there is **no `requirement` or `workflow` tool group** |
| `workflow_action` | *"use `workflow_status`"*, *"`workflow_cancel`"* | same — no group can ever select them |
| `comment_response` | *"call `task_get`/`requirement_get` first"* | `requirement_get` is discover-only for `converse` |
| `task_execution` | *"run builds and tests via `background_exec`"*, *"register key outputs via `deliverable_create`"* | the `shell` group carries only `shell_execute`; `background_exec` is in no group at all |

**Invariant 14 — prompt-declared tools ⊆ scenario tool face.** Guard test
`scenario-tool-face.test.ts` builds each scenario's prompt, asserts the prompt text actually
mentions the mandated names, asserts those names are in the scenario's `allowedTools`, and asserts
they are genuinely *absent* from the always-on keep-set (proving the allowance is load-bearing
rather than redundant). It also asserts the action scenarios do **not** carry `shell_execute`,
`apply_patch`, `package_install` or `hub_install`.

**Invariant 14b — an allow-list may narrow, never widen, the capability boundary.** The union step
in `agent.ts` only offers names the scenario's allow-list declares; it is not a bypass of
`allowedTools` filtering.

---

### 5.11 Async callbacks must replay their originating scenario (2026-09-16)

`background_exec` is documented in the `task_execution` prompt as *"run builds and tests via
`background_exec` — continue other subtasks while waiting"*. That contract is only meaningful if
the **completion** turn can act. It could not.

Both callback dispatch branches (`callback_result`, and the callback-typed `system_event` emitted
by `deliverCallback`'s mailbox path) hardcoded `scenario: 'heartbeat'`. `heartbeat` maps to the
**reflex** pack, and `REFLEX_CORE_TOOLS` contains **no work tools** — no `file_write`,
`file_edit`, `shell_execute`, `apply_patch`, `task_note`, `subtask_complete`,
`deliverable_create`, `task_submit_review`. The heartbeat prompt additionally says *"your text
output is NOT visible … end with `HEARTBEAT_OK`"*. So a build launched from a task session could,
on completion, only **notify** — never fix the failure, never record progress, never submit.

**Mechanism.** The scenario is captured where it is still knowable and replayed where it is needed:

| Step | Where | What |
|---|---|---|
| capture | `registerBackgroundSession(...)` / `a2a_reply` / `schedule_wakeup` registration | `this.activeScenario` → `PendingCallback.originScenario` |
| carry | `deliverCallback` | writes it into the mailbox item's `payload.extra.scenario` (both delivery modes) |
| replay | `callback_result` / callback-typed `system_event` dispatch | `asAgentScenario(extra.scenario) ?? 'heartbeat'` |

Capture must happen at **registration**, not delivery: the completion fires later, outside any
turn, when `activeScenario` no longer refers to the launching scenario. Both delivery modes carry
it — `mailbox` surfaces a *new* attention cycle, but the work still needs work tools.

**Invariant 15 — an untrusted scenario string is never cast.** `buildHandleOpts` used to do
`opts.scenario = ex.scenario as AgentScenario`. Because that override runs **after** each branch's
explicit default, it silently won: any mailbox producer could set an arbitrary scenario, and
unknown/legacy values became the turn's scenario. It now goes through `asAgentScenario()` and is
ignored when unrecognized, so the branch default (`heartbeat`) survives. `AGENT_SCENARIOS` is the
runtime mirror of the `AgentScenario` union and the single validation authority.

Guard test: `callback-scenario.test.ts` — asserts reflex has no work tools, that
`registerBackgroundSession` records the launch scenario, that `deliverCallback` propagates it in
both modes, that dispatch replays it, that a missing scenario falls back to `heartbeat`, and that
invalid values (`'bogus-scenario'`) are rejected rather than passed through.

