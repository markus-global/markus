# Agent Memory System

Architecture and data flows for the Markus agent memory system, based on Tulving's cognitive classification.

## 1. Design Principles

1. **Tulving's three systems**: Semantic (what you know), Episodic (what happened), Procedural (how to do things).
2. **File-first for cognition**: Agent's working memory (sessions, knowledge) lives on the file system — human-readable and portable.
3. **SQLite for history**: Activity history lives in SQLite — indexed, searchable, and queryable via tools.
4. **Context is currency**: Every byte in the LLM prompt competes for limited context window. Retrieval must maximize signal-to-noise.
5. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update_longterm`), and how to evolve (ROLE.md edits).

## 2. Three-Layer Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Procedural Memory — "how I operate"                          │
│  ROLE.md + HEARTBEAT.md + Skills                              │
│  Most stable. Loaded at startup. Shapes every response.       │
│  Code: RoleLoader, Agent.reloadRole(), skill system           │
├───────────────────────────────────────────────────────────────┤
│  Semantic Memory — "what I know"                              │
│  MEMORY.md (curated, always in prompt)                        │
│  memories.json (observation buffer, searched on demand)        │
│  Code: MemoryStore (addEntry, search, addLongTermMemory)      │
│  Tools: memory_save, memory_search, memory_list,              │
│         memory_update_longterm                                 │
├───────────────────────────────────────────────────────────────┤
│  Episodic Memory — "what I've experienced"                    │
│  Current episode: sessions/*.json (active conversation)       │
│  Past episodes:   SQLite agent_activities (searchable history)│
│  Code: MemoryStore (sessions) + SqliteActivityRepo            │
│  Tools: recall_activity (list / search / get)                 │
└───────────────────────────────────────────────────────────────┘

Not memory (never read back by agent):
  daily-logs/*.md — audit trail for humans only
```

### Code Location

| Concern | Implementation | File |
|---------|---------------|------|
| Semantic + Episodic (sessions) | `MemoryStore` | `packages/core/src/memory/store.ts` |
| Interface | `IMemoryStore` | `packages/core/src/memory/types.ts` |
| Episodic (history) | `SqliteActivityRepo` | `packages/storage/src/sqlite-storage.ts` |
| Episodic retrieval | `recall_activity` tool | `packages/core/src/tools/recall.ts` |
| Procedural | `RoleLoader` / `EnhancedRoleLoader` | `packages/core/src/role-loader.ts` |
| Semantic tools | `memory_save`, etc. | `packages/core/src/tools/memory.ts` |
| Vector search | `SemanticMemorySearch` | `packages/core/src/memory/semantic-search.ts` |

---

## 3. Semantic Memory

Factual knowledge the agent has accumulated. Two complementary substores:

### MEMORY.md — Curated Knowledge

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/MEMORY.md` |
| Format | Markdown with `## section-name` headers |
| Write triggers | `memory_update_longterm` tool, Dream Cycle promotion |
| System prompt | Always loaded as `## Your Knowledge` |
| Limits | 3000 chars/section (`MEMORY_MD_SECTION_MAX_CHARS`), 15000 chars total (`MEMORY_MD_TOTAL_MAX_CHARS`) |

The agent organizes sections freely. Common patterns:

- `conventions` — coding standards, naming rules
- `procedures` — recurring workflows
- `preferences` — tool choices, communication styles
- `domain-knowledge` — technical facts

### memories.json — Observation Buffer

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/memories.json` |
| Format | `MemoryEntry[]` with `id`, `timestamp`, `type`, `content`, `metadata` |
| Entry types | `fact`, `note`, `task_result`, `conversation` |
| Write triggers | `memory_save` tool, task reflection |
| Search | Substring match + optional vector overlay (`SemanticMemorySearch`) |

**Entry lifecycle**: Created via `memory_save` → Searched via `memory_search` → Consolidated by Dream Cycle (merge duplicates) → Promoted to MEMORY.md (recurring patterns)

**Tags** (stored in `metadata.tags`): `insight`, `role-evolution`, `domain:<topic>`

---

## 4. Episodic Memory

Everything the agent has experienced. Two substores serving different time horizons:

### Current Episode — Active Conversation

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/sessions/sess_{ts}_{rand}.json` |
| Format | `ConversationSession` — `{ id, agentId, messages: LLMMessage[], startedAt, lastActivityAt }` |
| Write triggers | `appendMessage()` on every LLM turn |
| Prompt injection | Automatically included as conversation history |
| Compaction | Auto-compact when session exceeds threshold (keep recent, summarize old) |
| Lifetime | Per-session; new session per task or chat |

Session ID prefixes identify type: `hb_` (heartbeat), `a2a_`, `comment_`, `sys_`, `task_`.

### Past Episodes — Activity History

| Attribute | Value |
|-----------|-------|
| Storage | SQLite `agent_activities` + `agent_activity_logs` |
| Format | Structured rows with `summary` + `keywords` for indexed retrieval |
| Write triggers | `Agent.startActivity()` / `Agent.endActivity()` — every agent action |
| Prompt injection | NOT automatic — retrieved on demand via `recall_activity` tool |
| Lifetime | Persistent; never deleted. Grows continuously. |

**Activity types**: `task`, `chat`, `heartbeat`, `a2a`, `internal`, `respond_in_session`

**Data model**:

```
agent_activities (one per action session)
├── id            — act-{agentId}-{timestamp}-{rand}
├── agent_id      — owner
├── type          — task | chat | heartbeat | a2a | internal | respond_in_session
├── label         — human-readable description
├── task_id       — for task-type activities
├── summary       — 1-3 sentence summary (computed at endActivity)
├── keywords      — comma-separated (tool names, error types, file paths)
├── started_at / ended_at
├── total_tokens / total_tools
└── success       — outcome

agent_activity_logs (N per activity, ordered)
├── activity_id   — parent
├── seq           — ordered sequence number
├── type          — status | text | tool_start | tool_end | error | llm_request
├── content       — event description
└── metadata      — JSON (tokensUsed, durationMs, etc.)
```

**Write path**:

```
Agent.startActivity(type, label)
  → onActivityStartCb → SqliteActivityRepo.insertActivity()

Agent.emitActivityLog(activityId, type, content)
  → onActivityLogCb → SqliteActivityRepo.insertActivityLog()

Agent.endActivity(activityId, {summary, keywords})
  → onActivityEndCb → SqliteActivityRepo.updateActivity()
```

**Retrieval** — the `recall_activity` tool gives agents access to their own history:

| Operation | What it does |
|-----------|-------------|
| `list` | Recent activities, filterable by type/taskId |
| `search` | Keyword search across summary + keywords + label |
| `get` | Detailed event logs for a specific activity |

This is how an agent answers "what did I do last time with X?" — it searches its own episodic memory.

---

## 5. Procedural Memory

How the agent operates — managed outside `MemoryStore` by the role/skill system.

| Component | Storage | Loader |
|-----------|---------|--------|
| ROLE.md | `~/.markus/agents/{id}/role/ROLE.md` | `RoleLoader` / `EnhancedRoleLoader` |
| HEARTBEAT.md | `~/.markus/agents/{id}/HEARTBEAT.md` | Loaded by heartbeat processor |
| Skills | Installed via `discover_tools` | Skill registry + MCP |

ROLE.md is loaded at startup and hot-reloaded when the agent modifies it via `file_edit`. Changes require proven experience — the self-evolution skill governs when and how agents modify their own identity.

---

## 6. Storage Layout

### File System (per agent)

```
~/.markus/agents/{agent-id}/
├── MEMORY.md              # Semantic: curated knowledge
├── memories.json          # Semantic: observation buffer
├── metrics.json           # Health counters (not memory)
├── role/
│   └── ROLE.md            # Procedural: identity
├── sessions/
│   └── sess_{ts}_{rand}.json  # Episodic: current conversation
├── daily-logs/
│   └── YYYY-MM-DD.md      # Audit trail (NOT memory — never read back)
├── workspace/             # Working files (not memory)
└── tool-outputs/          # Tool result offloads (not memory)
```

### SQLite (`~/.markus/data.db`)

| Table | Memory Layer | Purpose |
|-------|-------------|---------|
| `agent_activities` | **Episodic** | Past episodes — searchable via `recall_activity` |
| `agent_activity_logs` | **Episodic** | Event-level detail within episodes |
| `chat_sessions` + `chat_messages` | *(UI persistence)* | Web UI chat history; synced to file sessions on restore |
| `mailbox_items` + `agent_decisions` | **Episodic** | Stimulus/response record (what the agent received and decided) |

**The test**: if the agent can retrieve it to inform future decisions, it's memory. If only humans read it, it's audit trail.

---

## 7. Consolidation (Dream Cycle)

Periodic process that maintains semantic memory health. Runs via `consolidateMemory()`.

### Trigger

- `memories.json` has 50+ entries
- Dream cycle has not run today (`lastDreamDate`)

### Process (LLM-assisted)

1. Cap entries at 200, send to LLM with: id, type, date, tags, content preview
2. LLM responds with JSON: `{ remove: [...ids], merge: [...groups], promote: [...] }`
3. Apply removals: delete from memories.json + vector index
4. Apply merges: replace groups with merged entry
5. Apply promotions: append synthesized content to MEMORY.md sections

### MEMORY.md Hygiene (`pruneMemoryMd`)

- Remove `## daily-report-*` sections (belong in daily-logs/)
- Enforce section char limits (3000/section, 15000 total)
- Strip leaked LLM artifacts (`<think>` blocks)

---

## 8. Key Rules

1. **MEMORY.md is sacred** — only distilled knowledge. Never raw LLM output or debug info.
2. **memories.json is source of truth for observations** — vector index is a secondary search overlay.
3. **Activity history is episodic memory** — the agent retrieves it via `recall_activity` to inform future decisions.
4. **Sessions are thin** — hold current conversation only, auto-compacted.
5. **Daily logs are NOT memory** — append-only audit trail for humans. Never read back into prompts.
6. **Dream Cycle is conservative** — err on keeping entries; incorrect removal is worse than duplicates.
7. **One MemoryStore per agent** — file-system based, no cross-agent contamination.

---

## 9. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) | How agents use memory for context preparation |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | How memory is assembled into system prompts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Overall system architecture |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox stimulus/response feeds into episodic memory |
