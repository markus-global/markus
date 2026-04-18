# Agent Memory System

This document defines the architecture, data flows, and lifecycle rules for the Markus agent memory system. For how agents cognitively prepare context using memory (retrieval, reflection, association), see [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md).

## 1. Design Principles

1. **Layered retention**: Information moves from volatile short-term context to durable long-term knowledge through explicit promotion, never by accident.
2. **File-first**: The primary storage is the local file system (`~/.markus/agents/{id}/`). Files are human-readable, inspectable, and portable.
3. **Context is currency**: Every byte injected into the LLM system prompt competes for limited context window space. Memory retrieval must maximize signal-to-noise ratio.
4. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update_longterm`), and how to evolve (`ROLE.md` edits). The system provides the mechanisms; agents drive the policy via skills.
5. **Cognitive retrieval**: Memory access is not mechanical bulk loading but persona-directed retrieval. The Cognitive Preparation Pipeline determines what memories are relevant based on the agent's role, current state, and the specific situation. See [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md).

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
├── MEMORY.md                  # Knowledge store: agent-organized knowledge
├── memories.json              # Knowledge store: observation buffer
├── metrics.json               # Lightweight health counters (no audit events)
├── role/
│   └── ROLE.md                # Identity store: agent persona and behavioral rules
├── sessions/
│   └── sess_{ts}_{rand}.json  # Working Context: current processing sessions
├── daily-logs/
│   └── YYYY-MM-DD.md          # Audit trail: append-only, not injected into prompts
├── workspace/                 # Agent working files (not memory)
└── tool-outputs/              # Large tool result offloads (not memory)
```

### SQLite Tables (memory-related)

| Table | Used by | Purpose |
|-------|---------|---------|
| `chat_sessions` | API server, Web UI | Persistent chat session list; each agent has one **main session** (`is_main = 1`) for activity log |
| `chat_messages` | API server, Web UI | Persistent message history (user conversations + activity log entries with `metadata.activityLog`) |
| `agent_activities` | Agent, API server, Activity Tab, `recall_activity` tool | **Single source of truth** for all agent activity sessions (task, chat, heartbeat, A2A, internal) |
| `agent_activity_logs` | Agent, API server, Activity Tab, `recall_activity` tool | Event-level logs within each activity (LLM calls, tool calls, status changes) |
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

## 3. Memory Model

The memory model is organized around four stores, aligned with Tulving's memory systems from cognitive psychology (see [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) §1.1). The previous six-layer model (L0-L5) is consolidated: daily logs (former L3) are demoted to a write-only audit trail, and the activity index replaces their prompt injection role.

```
┌─────────────────────────────────────────────────────────┐
│  Identity (ROLE.md)                  [Procedural Memory] │
│  Who the agent is. Persona, expertise, behavioral rules. │
│  Most stable. Shapes all cognitive preparation.          │
├─────────────────────────────────────────────────────────┤
│  Knowledge (MEMORY.md + memories.json)  [Semantic Memory]│
│  What the agent knows. Agent-organized knowledge.        │
│  MEMORY.md: always in system prompt (stable context).    │
│  memories.json: retrieved by CPP or bulk search.         │
├─────────────────────────────────────────────────────────┤
│  Experience (SQLite activity index)    [Episodic Memory] │
│  What the agent did. Every activity with summary +       │
│  keywords. Searchable. Retrieved by CPP Phase 2.         │
│  Includes: mailbox timeline, activity logs, decisions.   │
├─────────────────────────────────────────────────────────┤
│  Working Context (current session)                       │
│  What the agent is doing now. Active conversation or     │
│  task. Thin — just the current processing turn.          │
│  Auto-compacted when large.                              │
└─────────────────────────────────────────────────────────┘

Audit trail (not injected into prompts):
  daily-logs/*.md — append-only, for debugging and human inspection
```

### Why Four Stores Instead of Six

The previous model had six numbered layers (L0-L5) with overlapping responsibilities:

| Old Layer | Disposition | Reason |
|-----------|-------------|--------|
| L0: Episodic (mailbox) | → **Experience** store | Now indexed with `summary` + `keywords` for cognitive retrieval |
| L1: Conversation (sessions) | → **Working Context** store | Thinner — CPP replaces session as context carrier |
| L2: Structured Memories | → **Knowledge** store | Explicit saves remain; auto-compaction artifacts eliminated |
| L3: Activity Logs (daily-logs) | → **Audit trail** (no prompt injection) | Replaced by indexed activity store for prompt injection |
| L4: Long-Term Knowledge | → **Knowledge** store | MEMORY.md unchanged |
| L5: Identity | → **Identity** store | ROLE.md unchanged, now MORE important (shapes CPP) |

The key insight: with the Cognitive Preparation Pipeline, the agent retrieves context *on-demand* based on its appraisal of the situation, rather than mechanically loading bulk daily logs and recent facts into every prompt. Daily logs were a workaround for not having searchable activity history — the indexed activity store (`agent_activities` with `summary` + `keywords`) replaces that function.

### Store Specifications

#### Identity (ROLE.md)

| Attribute | Value |
|-----------|-------|
| Storage | `role/ROLE.md` |
| Format | Markdown role definition — persona, expertise, behavioral rules |
| Write triggers | Agent self-modification via `file_edit` tool (governed by self-evolution skill) |
| System prompt | Parsed and loaded as `RoleTemplate` at agent startup; always the first section |
| Lifetime | Persistent; survives restarts; can be synced with upstream templates |
| Cognitive role | **Shapes all CPP prompts** — the role description directs appraisal, retrieval, and reflection |

The identity store is the most stable. Changes require:
1. 3+ related lessons pointing to a behavioral change
2. High confidence that the change reflects proven experience
3. Systemic impact (affects many future tasks)
4. No contradiction with the core role

#### Knowledge (MEMORY.md + memories.json)

Two complementary substores serving Tulving's semantic memory function:

**MEMORY.md — Curated Knowledge**

| Attribute | Value |
|-----------|-------|
| Storage | `MEMORY.md` |
| Format | Markdown with `## section-name` headers |
| Write triggers | `memory_update_longterm` tool (agent-initiated), Dream Cycle promotion |
| System prompt | Always loaded as a single `## Your Knowledge` section (up to 8000 chars total) |
| Lifetime | Persistent across sessions and restarts |
| Role | Distilled, validated knowledge — agent organizes freely |

**Agent-organized sections**: The agent decides what sections to create in MEMORY.md based on what it learns. There is no rigid system-imposed taxonomy (the old `lessons-learned` / `tool-preferences` / `sops` split was artificial). Common patterns agents develop:

| Example Section | Content |
|----------------|---------|
| `conventions` | Project-specific coding standards, naming rules |
| `procedures` | Recurring workflows, step-by-step approaches |
| `preferences` | Tool choices, communication styles, review criteria |
| `domain-knowledge` | Technical facts specific to the agent's area |
| `evolution-log` | Chronological record of ROLE.md changes |

**Hard limits (code-enforced)**:
- Per-section: 3000 chars max (`MEMORY_MD_SECTION_MAX_CHARS`)
- Total file: 15000 chars max (`MEMORY_MD_TOTAL_MAX_CHARS`)

**Why no SOPs/lessons/best-practices taxonomy**: The old system split knowledge into `lesson` → `best-practice` → `SOP` with separate prompt sections for each. This created 5 overlapping prompt sections wasting context window space. In cognitive science, semantic memory has no such artificial taxonomy -- knowledge is knowledge, organized by the knower. Agents learn what to organize and how through the self-evolution skill.

**memories.json — Observation Buffer**

| Attribute | Value |
|-----------|-------|
| Storage | `memories.json` |
| Format | `MemoryEntry[]` — each entry has `id`, `timestamp`, `type`, `content`, `metadata` |
| Entry types | `fact`, `note`, `insight` |
| Write triggers | `memory_save` tool, task reflection |
| Search | Substring match, tag filter, semantic search (vector overlay) |
| System prompt | Retrieved by CPP Phase 2 (directed) or legacy bulk retrieval (fallback) |
| Role | Observation buffer — raw agent observations awaiting promotion to MEMORY.md |

**Entry lifecycle**:
1. **Created** by agent via `memory_save` tool or task reflection
2. **Indexed** in vector store for semantic search
3. **Retrieved** by CPP Phase 2 (directed by appraisal plan) or by legacy `retrieveRelevantMemories()` (fallback)
4. **Consolidated** by Dream Cycle: duplicates removed, related entries merged
5. **Promoted** by Dream Cycle: recurring patterns (3+ similar entries) synthesized into MEMORY.md

**Tagging convention** (simplified):
- `insight` — learned principle, proven approach, or tool preference (replaces old `lesson` / `best-practice` / `tool-preference` split)
- `role-evolution` — ROLE.md change record
- `domain:<topic>` — domain-specific knowledge

**Relationship to Skills**: Skills (installable via `discover_tools`) are architecturally distinct from Knowledge. A skill is an **external capability package** -- it comes with instructions, tool registrations, and MCP configurations. Knowledge in MEMORY.md is **personal** to the agent. An agent might learn a procedure and write it as a MEMORY.md section; if that procedure becomes reusable across agents, it should be packaged as a skill.

#### Experience (SQLite Activity Index)

| Attribute | Value |
|-----------|-------|
| Storage | SQLite `agent_activities` + `agent_activity_logs` + `mailbox_items` + `agent_decisions` |
| Format | Structured rows with `summary` + `keywords` columns for indexed retrieval |
| Write triggers | Every agent action: startActivity/endActivity, mailbox enqueue, attention decisions |
| System prompt | Retrieved by CPP Phase 2 based on appraisal plan. NOT bulk-loaded. |
| Lifetime | Persistent; never deleted. Grows continuously. |
| Role | **Searchable episodic memory** — the ground truth of everything the agent experienced and did |

The activity index is the primary source for the Cognitive Preparation Pipeline's retrieval phase. When the Appraisal phase determines the agent needs past experience context, Phase 2 searches `summary` and `keywords` columns to find relevant activities.

The mailbox timeline (`mailbox_items` + `agent_decisions`) is the complete stimulus/response record. The activity index (`agent_activities` + `agent_activity_logs`) is the complete action/outcome record. Together they form the agent's episodic memory.

All 12 mailbox item types are recorded. Internal processes (heartbeats, daily reports, memory consolidation) also flow through the mailbox, ensuring complete traceability. The mailbox timeline feeds into higher stores:
- **Knowledge** (MEMORY.md) — long-term patterns extracted from decision history
- **Identity** (ROLE.md) — recurring patterns inform identity evolution
- **Dream Cycle** — memory consolidation is itself a recorded mailbox item

See [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) for the mailbox architecture.

#### Working Context (Current Session)

| Attribute | Value |
|-----------|-------|
| Storage | `sessions/{session_id}.json` |
| Format | `ConversationSession` — array of `LLMMessage` objects |
| Write triggers | Every `appendMessage()` call |
| Capacity | Auto-compacted when session exceeds 80 messages (keep 40); `prepareMessages` also compresses at 60+ |
| System prompt | Recent messages passed as conversation history |
| Lifetime | Per-session; new session per task round or chat |
| Role | **Active conversation context** — just the current processing turn, not a context carrier |

Sessions should be **thin**. The Cognitive Preparation Pipeline replaces the session's former role as the primary context carrier. Activity context is now retrieved from the Experience store, not from injected session messages.

**Compaction flow** (two mechanisms):
1. **MemoryStore `checkAndCompact()`**: When a session reaches 80+ messages, tool results older than the most recent 40 are truncated (20KB+ → head+tail preview), then `compactSession()` keeps the newest 40 messages with a summary of older ones.
2. **ContextEngine `prepareMessages()` Stage 1**: When preparing messages for an LLM call, if >60 messages, `smartSummarizeAndTruncate()` compresses older messages (keeps 40).
3. The summary from either mechanism is injected as a synthetic user message at the start of the retained window.

**LLM-assisted compaction**: Before heuristic compaction, `memoryFlush()` sends a lightweight prompt asking the agent to persist any important information via `memory_save`. This ensures high-value content is promoted to the Knowledge store before truncation.

#### Audit Trail (daily-logs/)

| Attribute | Value |
|-----------|-------|
| Storage | `daily-logs/YYYY-MM-DD.md` |
| Format | Markdown, append-only |
| Write triggers | Session compaction, daily report generation |
| System prompt | **Not injected** — replaced by CPP retrieval from the Experience store |
| Role | Human-readable audit trail for debugging and analysis |

Daily logs are **write-only from the agent's perspective**. They are never read back into prompts. They exist for:
- Human inspection and debugging
- Compliance and audit requirements
- Historical analysis

The indexed activity store (`agent_activities` with `summary` + `keywords`) replaces daily logs' former prompt injection role. The CPP retrieves activity context on-demand rather than mechanically loading today's log.

---

## 4. Data Flows

### 4.1 Write Flows

```
                   Agent Actions                           Automatic Triggers
                   ─────────────                           ──────────────────

Identity store:
 file_edit (self-evolution) ──────► role/ROLE.md

Knowledge store:
 memory_save ──────────────────────► memories.json ◄────── task reflection
      │                                   │
      └──► vector index (async)           │
 memory_update_longterm ──────────► MEMORY.md

Experience store:
 startActivity/endActivity ────────► agent_activities (with summary + keywords)
 emitActivityLog ──────────────────► agent_activity_logs
 enqueueToMailbox ─────────────────► mailbox_items
 attention decisions ──────────────► agent_decisions

Working Context:
 appendMessage ───────────────────► sessions/*.json ──────► (auto-compact at 60 msgs)

Audit trail (write-only):
 compaction summaries ─────────────► daily-logs/*.md
 daily report output ──────────────► daily-logs/*.md

Web UI chat ─► SQLite chat_messages ─► (on session restore) ─► sessions/*.json
```

### 4.2 Read Flow (System Prompt Assembly)

Memory is assembled into the system prompt via two complementary mechanisms:

#### Stable Context (always loaded by `buildSystemPrompt`)

```
System Prompt (stable sections — from Identity + Knowledge stores)
├── Agent Identity (from ROLE.md — Identity store)
├── Organization Context (CONTEXT.md, team info)
├── Policies & Governance
├── Your Knowledge (MEMORY.md — Knowledge store, up to 8000 chars total)
├── Shared Deliverables
└── Task Board (assigned tasks)
```

Note: the old 5-section knowledge split (`SOPs`, `Long-term Knowledge`, `Lessons from Past Experience`, `Best Practices`, `Applicable Lessons for This Task`) is replaced by a single `## Your Knowledge` section loaded from MEMORY.md. Task-specific knowledge retrieval is handled by CPP Phase 2, not by a separate prompt section.

#### Cognitive Context (from CPP — Experience + Knowledge stores)

When the Cognitive Preparation Pipeline (see [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md)) is active (depth D1+), memory retrieval is **persona-directed**:

```
System Prompt (cognitive sections — from CPP Phases 1-3)
├── Cognitive Context — appraisal reasoning (Phase 1)
├── Retrieved Context — targeted retrieval (Phase 2)
│   ├── Activity history (Experience store — keyword search on summary/keywords)
│   ├── Relevant memories (Knowledge store — directed by appraisal plan)
│   ├── Task context (specific tasks identified by appraisal)
│   └── Team context (colleague status and recent activity)
└── Reflection — persona-aware insights (Phase 3)
```

#### Legacy Bulk Retrieval (fallback when CPP is at D0 or disabled)

```
├── Relevant Memories (Knowledge store + Vector Index)
│   ├── All "fact" type entries (up to topK)
│   ├── Semantic search results for current query
│   └── Fallback: substring search results
```

Note: daily logs are **no longer injected** into the system prompt. The Experience store (indexed activity summaries) replaces their prompt injection role.

**Deduplication**: When CPP is active, the retrieval plan from Phase 1 determines what to fetch, avoiding duplication by design. When using legacy bulk retrieval, entry IDs already shown in `## Your Knowledge` are excluded from `## Relevant Memories`.

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
      "tags": ["insight", "coding"]
    }
  ],
  "promote": [
    {
      "sourceIds": ["id5", "id6", "id7"],
      "section": "procedures",
      "content": "Synthesized insight from recurring pattern..."
    }
  ]
}
```

**Rules for the LLM**:
- Be conservative — only remove entries that are clearly redundant or superseded
- When merging, preserve all unique information from the original entries
- Keep `insight`-tagged entries unless truly duplicated
- Promote only when 3+ entries point to the same recurring pattern
- The `section` field in `promote` uses the agent's own MEMORY.md section names (agent-organized, not system-imposed)
- Promoted content is appended to the named MEMORY.md section; source entries are removed from `memories.json`
- If nothing needs consolidation, return `{ "remove": [], "merge": [], "promote": [] }`

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
├── summary       — 1-3 sentence summary computed from activity logs at endActivity()
├── keywords      — Comma-separated keywords (tool names, error types, file paths)
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

1. **MEMORY.md is sacred**: Only distilled knowledge belongs here. Never write raw LLM output, verbose reports, or debug information.

2. **Vector index is a secondary index**: The source of truth for memory entries is `memories.json`. The vector index must be kept in sync — when entries are removed or merged, the corresponding vectors must be deleted and re-indexed.

3. **Memory tools are agent-facing**: `memory_save`, `memory_search`, `memory_list`, and `memory_update_longterm` are the agent's interface to the Knowledge store. The system (consolidation, compaction) operates on the same stores through internal methods.

4. **Sessions are thin**: Sessions hold the current processing turn only, not historical context. Typed session ID prefixes (`hb_`, `a2a_`, `comment_`, `sys_`, `task_`) enable identification and filtering.

5. **Daily logs are write-only**: Append-only audit trail for human inspection. Never read back into agent prompts — the Experience store replaces their prompt injection role.

6. **Dream Cycle is conservative**: The LLM-assisted consolidation must err on the side of keeping entries. Incorrect removal of a memory entry is worse than keeping a duplicate.

7. **SQLite is the single source of truth for structured data**: Activity history (`agent_activities`, `agent_activity_logs`), chat persistence (`chat_sessions`, `chat_messages`), and organizational data live in SQLite. The file system (`MemoryStore`) is the source of truth for agent cognitive memory (sessions, memories.json, MEMORY.md).

8. **One vector store, many agents**: The `LocalVectorStore` (or `PgVectorStore`) is shared across all agents, with entries tagged by `agentId`. Cross-agent semantic search is possible by omitting the agent filter.

9. **Experience store is the retrieval backbone**: The indexed activity store (`agent_activities` with `summary` + `keywords`) is the primary source for CPP Phase 2 retrieval. The `recall_activity` tool also queries this store.

---

## 8. Store Capacity Summary

| Store | Storage | Prompt Injection | Cap |
|-------|---------|-----------------|-----|
| Identity | `role/ROLE.md` | Always (stable prefix) | Max 200 lines |
| Knowledge: MEMORY.md | `MEMORY.md` | Always as `## Your Knowledge` (single section) | 8000 chars total; 3000 chars/section |
| Knowledge: memories.json | `memories.json` | CPP-directed or legacy bulk | Dream Cycle at 50+ entries |
| Experience | SQLite `agent_activities` | CPP Phase 2 retrieval | No cap (grows continuously) |
| Working Context | `sessions/*.json` | As message history | Auto-compact at 80 msgs, keep 40 |
| Audit trail | `daily-logs/*.md` | **Not injected** | No cap (append-only) |

---

## 9. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) | How agents cognitively prepare context using memory stores — persona-directed retrieval, reflection, association |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | How memory stores are assembled into the system prompt and compressed for LLM calls |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Overall system architecture including agent runtime, context engine, and memory components |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox timeline as ground truth within the Experience store |
