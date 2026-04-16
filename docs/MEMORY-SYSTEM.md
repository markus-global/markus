# Agent Memory System

This document defines the architecture, data flows, and lifecycle rules for the Markus agent memory system.

## 1. Design Principles

1. **Layered retention**: Information moves from volatile short-term context to durable long-term knowledge through explicit promotion, never by accident.
2. **File-first**: The primary storage is the local file system (`~/.markus/agents/{id}/`). Files are human-readable, inspectable, and portable.
3. **Context is currency**: Every byte injected into the LLM system prompt competes for limited context window space. Memory retrieval must maximize signal-to-noise ratio.
4. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update_longterm`), and how to evolve (`ROLE.md` edits). The system provides the mechanisms; agents drive the policy via skills.

## 2. Storage Backends

Three independent storage backends serve different purposes:

| Backend | Location | Purpose |
|---------|----------|---------|
| **File System** | `~/.markus/agents/{id}/` | Primary agent memory — all layers |
| **SQLite** | `~/.markus/data.db` | Organizational data, chat persistence, **activity/audit history** |
| **Vector Index** | `~/.markus/agents/vector-store/` or PostgreSQL | Semantic similarity search overlay |
| **LLM Logs** | `~/.markus/llm-logs/*.jsonl` | Optional debug trace (full prompt/response bodies) |

### File System Layout (per agent)

```
~/.markus/agents/{agent-id}/
├── MEMORY.md                  # Layer 4: Long-term knowledge (section-based)
├── memories.json              # Layer 2: Structured memory entries
├── metrics.json               # Lightweight health counters (no audit events)
├── role/
│   └── ROLE.md                # Layer 5: Agent identity definition
├── sessions/
│   └── sess_{ts}_{rand}.json  # Layer 1: Conversation sessions
├── daily-logs/
│   └── YYYY-MM-DD.md          # Layer 3: Daily activity logs
├── workspace/                 # Agent working files (not memory)
└── tool-outputs/              # Large tool result offloads (not memory)
```

### SQLite Tables (memory-related)

| Table | Used by | Purpose |
|-------|---------|---------|
| `chat_sessions` | API server, Web UI | Persistent chat session list; each agent has one **main session** (`is_main = 1`) for activity log |
| `chat_messages` | API server, Web UI | Persistent message history (user conversations + activity log entries with `metadata.activityLog`) |
| `agent_activities` | Agent, API server, Activity Tab | **Single source of truth** for all agent activity sessions (task, chat, heartbeat, A2A, internal) |
| `agent_activity_logs` | Agent, API server, Activity Tab | Event-level logs within each activity (LLM calls, tool calls, status changes) |
| `mailbox_items` | Agent mailbox, API server, Agent Mind UI | **Episodic memory ground truth** — every stimulus the agent received, with timestamps and status |
| `agent_decisions` | Attention controller, API server, Agent Mind UI | Every attention decision (continue, preempt, merge, defer) with reasoning |
| `memories` | *(unused — dead code)* | Was intended for DB-backed memory but never wired into the core loop |

**Relationship**: The API server writes every chat turn to `chat_sessions` + `chat_messages` for UI persistence. When a user reopens a chat in the Web UI, the API server calls `agent.restoreSessionFromHistory()` to hydrate the file-based `MemoryStore` from the SQLite messages. The two systems are synchronized only in this direction: **SQLite → File System** (on session restore).

**Main Session**: Each agent's main session (`is_main = 1`) accumulates activity summaries from mailbox processing — task execution outcomes, review results, heartbeat summaries, etc. These entries have `metadata.activityLog = true` and are rendered as compact cards in the frontend. The main session ensures the agent maintains narrative continuity across different processing contexts. See `docs/MAILBOX-SYSTEM.md` §20.

### Vector Index

| Implementation | Storage | When used |
|----------------|---------|-----------|
| `LocalVectorStore` | `~/.markus/agents/vector-store/embeddings.json` | Default: single-file JSON, in-memory cosine similarity |
| `PgVectorStore` | PostgreSQL `memory_embeddings` table | Optional: when PostgreSQL with pgvector extension is available |

The vector index is a **search overlay**, not a primary store. It indexes the `content` field of `MemoryEntry` objects for semantic retrieval. The source of truth remains `memories.json`.

The vector store is shared across all agents (created once at `AgentManager` level). Each entry is tagged with `agentId` for scoped queries.

---

## 3. The Five-Layer Memory Model

```
┌─────────────────────────────────────────────────────────┐
│  Layer 5: Identity (ROLE.md)                            │
│  Deepest, most stable. Defines who the agent is.        │
│  Changes: rare, only after proven patterns (3+ lessons) │
├─────────────────────────────────────────────────────────┤
│  Layer 4: Long-Term Knowledge (MEMORY.md)               │
│  Distilled wisdom: lessons, SOPs, tool preferences.     │
│  Always loaded into system prompt (up to 5000 chars).   │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Activity Logs (daily-logs/)                   │
│  Append-only daily record. Compaction summaries.        │
│  Today's log loaded into system prompt (1500 chars).    │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Structured Memories (memories.json)           │
│  Facts, notes, task results. Searchable by tag/text.    │
│  Relevant entries retrieved per query (semantic/text).  │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Conversation Context (sessions/)              │
│  Raw message history. Persisted per interaction.        │
│  Auto-compacted when large. Most volatile layer.        │
├─────────────────────────────────────────────────────────┤
│  Layer 0: Episodic Memory (mailbox timeline)            │
│  SQLite-backed. Every stimulus + every decision.        │
│  Ground truth for what happened and what was chosen.    │
│  Feeds into all other layers. See MAILBOX-SYSTEM.md.   │
└─────────────────────────────────────────────────────────┘
```

### Layer Specifications

#### Layer 0: Episodic Memory (Mailbox Timeline)

| Attribute | Value |
|-----------|-------|
| Storage | `mailbox_items` + `agent_decisions` SQLite tables |
| Format | `MailboxItem` rows (stimulus) + `AttentionDecision` rows (response) |
| Lifecycle | Persistent; never deleted. Grows continuously. |
| Injection | Recent decisions + current focus summary injected into system prompt (§22 — see [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md)) |
| Query | Available via `/api/agents/:id/mailbox` and `/api/agents/:id/decisions` |

The mailbox timeline is the **ground truth** of the agent's experience — every incoming stimulus and every attention decision. All 12 item types (`human_chat`, `a2a_message`, `task_status_update`, `task_comment`, `mention`, `review_request`, `requirement_update`, `session_reply`, `daily_report`, `heartbeat`, `memory_consolidation`, `system_event`) are recorded. Internal agent processes (heartbeats, daily reports, memory consolidation) also flow through the mailbox, ensuring complete traceability. Higher memory layers are derived from this timeline:

- **Daily logs** (Layer 3) are generated by querying the day's mailbox items. The daily report itself is a `daily_report` mailbox item.
- **Long-term patterns** (Layer 4) are extracted from decision history (e.g., "review requests are typically high-urgency").
- **Identity evolution** (Layer 5) is informed by recurring patterns in decision-making.
- **Memory consolidation** (dream cycle) is a `memory_consolidation` mailbox item, making the consolidation process itself part of the episodic record.

See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for the complete architecture.

#### Layer 1: Conversation Context

| Attribute | Value |
|-----------|-------|
| Storage | `sessions/{session_id}.json` |
| Format | `ConversationSession` — array of `LLMMessage` objects |
| Write triggers | Every `appendMessage()` call (user/assistant/tool messages) |
| Capacity | Auto-compacted when session exceeds 80 messages |
| System prompt | Recent messages passed as conversation history |
| Lifetime | Per-session; new session created for each task round or chat |

**Compaction flow**:
1. When a session reaches 80+ messages, `checkAndCompact()` fires
2. Tool results older than the most recent 40 messages are truncated (20KB+ → head+tail preview)
3. `compactSession()` keeps the newest 40 messages, summarizes older ones
4. The summary is injected as a synthetic user message at the start of the retained window
5. The summary is also written to daily logs (Layer 3)
6. Key assistant statements are extracted and saved as `conversation` type entries in `memories.json` (Layer 2)

**LLM-assisted compaction**: Before heuristic compaction, `memoryFlush()` sends a lightweight prompt asking the agent to persist any important information via `memory_save`. This ensures high-value content is promoted to Layer 2 before the conversation is truncated.

#### Layer 2: Structured Memories

| Attribute | Value |
|-----------|-------|
| Storage | `memories.json` |
| Format | `MemoryEntry[]` — each entry has `id`, `timestamp`, `type`, `content`, `metadata` |
| Entry types | `fact`, `note`, `task_result`, `conversation` |
| Write triggers | `memory_save` tool, session compaction, task reflection |
| Search | Substring match (`search()`), tag filter (`getEntriesByTag()`), semantic search (vector overlay) |
| System prompt | Top-K relevant entries retrieved per query via `retrieveRelevantMemories()` |

**Entry lifecycle**:
1. **Created** by agent via `memory_save` tool, or automatically during session compaction
2. **Indexed** in vector store for semantic search (if embedding provider is configured)
3. **Retrieved** during system prompt assembly: facts always included, query-relevant entries added via semantic or substring search
4. **Consolidated** by Dream Cycle: duplicates removed, related entries merged, outdated entries pruned (see Section 5)

**Tagging convention** (enforced by self-evolution skill):
- `lesson` — learned principle from experience
- `tool-preference` — tool usage optimization
- `role-evolution` — ROLE.md change record
- `domain:<topic>` — domain-specific knowledge

#### Layer 3: Activity Logs

| Attribute | Value |
|-----------|-------|
| Storage | `daily-logs/YYYY-MM-DD.md` |
| Format | Markdown, append-only. Each entry timestamped: `## [HH:MM:SS] Agent: {id}` |
| Write triggers | Session compaction, daily report generation |
| System prompt | Today's log loaded via `getRecentDailyLogs(1)`, capped at 1500 chars |

Daily logs serve as an audit trail. They capture:
- Session compaction summaries (what was discussed before truncation)
- Daily report content (generated by the agent periodically)
- Activity records for debugging and analysis

**Important**: Daily logs are append-only and are never deleted or modified. They serve as a historical record for problem analysis.

#### Layer 4: Long-Term Knowledge

| Attribute | Value |
|-----------|-------|
| Storage | `MEMORY.md` |
| Format | Markdown with `## section-name` headers, key-value section structure |
| Write triggers | `memory_update_longterm` tool (agent-initiated) |
| System prompt | Full content loaded via `getLongTermMemory()`, capped at 5000 chars |
| Lifetime | Persistent across sessions and restarts |

**Allowed sections and limits**:

| Section | Max entries | Purpose |
|---------|------------|---------|
| `lessons-learned` | 20 | Generalized principles from experience |
| `tool-preferences` | 15 | Optimal tool choices per task type |
| `sops` | 10 | Standard operating procedures for recurring workflows |
| `role-evolution-log` | 20 | Chronological record of ROLE.md changes |
| Custom sections (e.g. `project-conventions`) | 20 | Agent-defined knowledge categories |

**Rules**:
- MEMORY.md must contain only **distilled, high-signal knowledge** — not raw reports or verbose outputs
- Daily reports must **not** be written to MEMORY.md; they belong in daily-logs/ (Layer 3)
- Agents are responsible for enforcing section limits when calling `memory_update_longterm`; the Dream Cycle (Section 5) provides a system-level enforcement backstop

#### Layer 5: Identity

| Attribute | Value |
|-----------|-------|
| Storage | `role/ROLE.md` |
| Format | Markdown role definition |
| Write triggers | Agent self-modification via `file_edit` tool (governed by self-evolution skill) |
| System prompt | Parsed and loaded as `RoleTemplate` at agent startup |
| Lifetime | Persistent; survives restarts; can be synced with upstream templates |

The identity layer is the most stable. Changes require:
1. 3+ related lessons pointing to a behavioral change
2. High confidence that the change reflects proven experience
3. Systemic impact (affects many future tasks)
4. No contradiction with the core role

---

## 4. Data Flows

### 4.1 Write Flows

```
                   Agent Actions                           Automatic Triggers
                   ─────────────                           ──────────────────
 memory_save ──────────────────────► memories.json ◄────── session compaction
      │                                   │                task reflection
      │                                   │
      └──► vector index (async)           │
                                          │
 memory_update_longterm ──────────► MEMORY.md
                                          │
 file_edit (self-evolution) ──────► role/ROLE.md
                                          │
 appendMessage ───────────────────► sessions/*.json ──────► (auto-compact at 80 msgs)
                                          │
                                   daily-logs/*.md ◄────── compaction summaries
                                          ▲                 daily report output
                                          │
 Web UI chat ─► SQLite chat_messages ─────┘ (on session restore)
```

### 4.2 Read Flow (System Prompt Assembly)

`ContextEngine.buildSystemPrompt()` assembles memory into the system prompt in this order:

```
System Prompt
├── Agent Identity (from RoleTemplate — Layer 5)
├── Organization Context (CONTEXT.md, team info)
├── Policies & Governance
├── Long-term Knowledge (MEMORY.md — Layer 4, up to 5000 chars)
├── Lessons from Past Experience (memories.json — Layer 2, tag: "lesson", up to 10)
├── Shared Deliverables
├── Relevant Memories (Layer 2 + Vector Index)
│   ├── All "fact" type entries (up to topK)
│   ├── Semantic search results for current query (if vector index enabled)
│   └── Fallback: substring search results
├── Recent Activity Summary (daily-logs/ — Layer 3, today only, up to 1500 chars)
└── Task Board (assigned tasks)
```

### 4.3 Conversation History Flow

Conversation history is passed as messages (not in the system prompt):

```
ContextEngine.prepareMessages()
├── System prompt (assembled above)
├── Protected prefix messages (task prompt, revision context)
└── Conversation history (from sessions/*.json)
    ├── If too large: LLM-summarized (via llmSummarizer callback)
    ├── Fallback: heuristic summary (buildHeuristicSummary)
    └── Compaction injects summary as synthetic user message
```

---

## 5. Memory Consolidation Lifecycle (Dream Cycle)

The Dream Cycle is a periodic, LLM-assisted process that maintains memory health. It runs as part of `consolidateMemory()`, triggered every 4 hours.

### Trigger Conditions

```
consolidateMemory() — every 4 hours
├── Step 1: Session compaction (if session > 30 messages)
│   ├── memoryFlush() — lightweight LLM call to persist important info
│   └── compactSession() — heuristic truncation + summary
│
├── Step 2: Daily report generation (once per day)
│   └── generateDailyReport() — writes to daily-logs/ only
│
└── Step 3: Dream Cycle (once per day, when entries >= 50)
    └── dreamConsolidateMemory() — LLM-assisted prune/merge
```

### Dream Cycle Specification

**Preconditions**:
- `memories.json` has 50 or more entries
- Dream cycle has not run today (tracked by `lastDreamDate`)

**Process**:

```
dreamConsolidateMemory(entries)
│
├── 1. Prepare entry list for LLM
│   ├── Cap at 200 entries (oldest entries excluded if over limit)
│   ├── Each entry: id, type, date, tags, content (first 200 chars)
│   └── Total prompt stays within safe context bounds
│
├── 2. Send to LLM (lightweight, no tools)
│   ├── Prompt: identify duplicates, outdated entries, merge candidates
│   └── Response: JSON { "remove": [...ids], "merge": [...groups] }
│
├── 3. Log the consolidation plan (before applying)
│   └── Debug log: entries to remove, merge groups, reasons
│
├── 4. Apply removals
│   ├── Remove entries from memories.json via removeEntries()
│   └── Delete corresponding vectors from vector index
│
├── 5. Apply merges
│   ├── Replace entry groups with merged entry via replaceEntries()
│   ├── Delete old vectors from vector index
│   └── Index new merged entry in vector index
│
└── 6. Log results
    └── Info log: entries before, removed count, merged count, entries after
```

**LLM Prompt Contract**:

The LLM receives the entry list and must respond with a JSON object:

```json
{
  "remove": ["id1", "id2"],
  "merge": [
    {
      "removeIds": ["id3", "id4"],
      "mergedContent": "Combined information from both entries...",
      "tags": ["lesson", "coding"]
    }
  ]
}
```

**Rules for the LLM**:
- Be conservative — only remove entries that are clearly redundant or superseded
- When merging, preserve all unique information from the original entries
- Keep lesson and best-practices entries unless truly duplicated
- If nothing needs consolidation, return `{ "remove": [], "merge": [] }`

### MEMORY.md Hygiene (pruneMemoryMd)

As part of the Dream Cycle, `pruneMemoryMd()` enforces MEMORY.md health:

1. **Remove daily-report sections**: Strip any `## daily-report-*` sections (these belong in daily-logs/)
2. **Enforce section limits**: Parse each section and truncate content that exceeds the defined limits
3. **Strip LLM artifacts**: Remove `<think>` blocks and other LLM reasoning traces that leaked into stored content

---

## 6. Activity & Audit Storage

**Architecture Decision: SQLite is the single source of truth for all activity/audit data.**

Every agent operation (task execution, chat, heartbeat, A2A communication, internal operations like daily reports and memory flushes) produces an **activity session** with ordered **log entries**. This data is persisted to SQLite and surfaced in the frontend Activity tab.

**Background processes:** Completions from `background_exec` are tracked; when a background session finishes, a notification is injected into the agent’s current chat session so the model sees it on the next turn (heartbeat processing also drains these notifications).

### Storage Design

| Data | Location | Role |
|------|----------|------|
| Activity sessions + events | SQLite `agent_activities` + `agent_activity_logs` | Single source of truth for all agent activity history |
| `metrics.json` | File system (per agent) | Lightweight health counters only — no audit events |
| In-memory activity Map | Agent process memory | Write-through cache for currently-live activities only |
| LLM JSONL logs | `~/.markus/llm-logs/*.jsonl` | Optional debug trace with full prompt/response bodies |

### Data Model

```
agent_activities (session-level)
├── id            — Unique activity ID (act-{agentId}-{timestamp}-{rand})
├── agent_id      — Owner agent
├── type          — task | heartbeat | chat | a2a | internal | respond_in_session
├── label         — Human-readable description
├── task_id       — For task-type activities
├── started_at    — ISO timestamp
├── ended_at      — ISO timestamp (null while active)
├── total_tokens  — Aggregated token count
├── total_tools   — Number of tool calls
└── success       — Whether the activity completed successfully

agent_activity_logs (event-level, 1:N from activities)
├── activity_id   — Parent activity
├── seq           — Ordered sequence number
├── type          — status | text | tool_start | tool_end | error | llm_request
├── content       — Event description
├── metadata      — JSON (tokensUsed, durationMs, etc.)
└── created_at    — ISO timestamp
```

### Write Path

```
Agent.startActivity() → onActivityStartCb → SqliteActivityRepo.insertActivity()
Agent.emitActivityLog() → onActivityLogCb → SqliteActivityRepo.insertActivityLog()
Agent.endActivity() → onActivityEndCb → SqliteActivityRepo.updateActivity()
```

### What Each LLM Call Scenario Produces

| Scenario | Activity Type | Contains |
|----------|--------------|----------|
| Human Chat (stream/non-stream) | `chat` | LLM requests, tool calls, status events |
| Task Execution | `task` | LLM requests, tool calls, status events (many iterations) |
| Respond-in-Session | `respond_in_session` | LLM requests, tool calls |
| Heartbeat | `heartbeat` | LLM requests, status events |
| A2A Chat | `a2a` | LLM requests, tool calls, status events |
| Daily Report / Memory Flush | `internal` | LLM requests, status events |

---

## 7. Key Rules

1. **MEMORY.md is sacred**: Only distilled knowledge belongs here. Never write raw LLM output, verbose reports, or debug information. The `generateDailyReport()` method writes to `daily-logs/` only.

2. **Vector index is a secondary index**: The source of truth for memory entries is `memories.json`. The vector index must be kept in sync — when entries are removed or merged, the corresponding vectors must be deleted and re-indexed.

3. **Memory tools are agent-facing**: `memory_save`, `memory_search`, `memory_list`, and `memory_update_longterm` are the agent's interface to the memory system. The system (consolidation, compaction) operates on the same stores but through internal methods.

4. **Sessions are persistent**: All session files (including lightweight internal ones like heartbeat, A2A, comments) contain raw conversation history persisted to `sessions/*.json`. They are compacted and summarized when large, with key information promoted to Layer 2 (`memories.json`) before truncation. Typed session ID prefixes (`hb_`, `a2a_`, `comment_`, `sys_`) enable easy identification and filtering.

5. **Daily logs are append-only**: Never delete or modify daily log files. They serve as historical audit trail for debugging and analysis.

6. **Dream Cycle is conservative**: The LLM-assisted consolidation must err on the side of keeping entries. Incorrect removal of a memory entry is worse than keeping a duplicate.

7. **SQLite is the single source of truth for structured data**: Chat history (`chat_sessions`, `chat_messages`), activity history (`agent_activities`, `agent_activity_logs`), and organizational data live in SQLite. The file system (`MemoryStore`) is the source of truth for agent cognitive memory (sessions, memories.json, MEMORY.md). Session restore (`restoreSessionFromHistory`) is the only bridge from SQLite back to the file-based memory.

8. **One vector store, many agents**: The `LocalVectorStore` (or `PgVectorStore`) is shared across all agents, with entries tagged by `agentId`. Cross-agent semantic search is possible by omitting the agent filter.

---

## 8. Memory Capacity Summary

| Layer | Storage | Injected into prompt | Cap |
|-------|---------|---------------------|-----|
| L1: Conversations | `sessions/*.json` | As message history | Auto-compact at 80 msgs, keep 40 |
| L2: Structured Memories | `memories.json` | Top-K relevant per query | Dream Cycle consolidation at 50+ entries |
| L3: Activity Logs | `daily-logs/*.md` | Today's log only | 1500 chars in prompt |
| L4: Long-Term Knowledge | `MEMORY.md` | Full content | 5000 chars in prompt; section limits enforced |
| L5: Identity | `role/ROLE.md` | Parsed as RoleTemplate | Max 200 lines (self-evolution skill rule) |
