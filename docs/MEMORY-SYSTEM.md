# Agent Memory System

Architecture and data flows for the Markus agent memory system. Persistent cognition uses a **two-file model** — `NOTEBOOK.md` (cognitive workspace) and `MEMORY.md` (long-term knowledge) — grounded in Tulving-style procedural / semantic / episodic persistence plus cognitive-science working-memory models.

## 1. Design Principles

1. **Two-file model**: `NOTEBOOK.md` holds the situational cognitive workspace; `MEMORY.md` holds curated knowledge plus a `## _observations` buffer. Both are human-readable markdown on disk.
2. **Tulving mapping + notebook**: Persistent layers align with Tulving-style cognition — **Procedural** (ROLE.md), **Semantic** (MEMORY.md), **Episodic** (sessions + activities). The **Notebook** replaces volatile in-memory working memory with a persistent scratchpad always injected into the system prompt.
3. **SQLite for history**: Activity history lives in SQLite — indexed, searchable, and queryable via tools.
4. **Context is currency**: Every byte in the LLM prompt competes for limited context window. Retrieval must maximize signal-to-noise.
5. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update`), and how to evolve (ROLE.md edits).

### Cognitive Science Foundations

| Concept | Markus mapping |
|---------|----------------|
| **Baddeley — Working Memory Model** | `NOTEBOOK.md` = central executive + visuospatial sketchpad: limited-capacity, actively maintained situational state |
| **Cowan — Embedded Processes** | Curated sections of `MEMORY.md` = activated long-term memory, always in prompt |
| **Kahneman — Dual Process** | System 1 = fast retrieval (`memory_search`, prompt injection); System 2 = CPP deliberative processing writes `cpp`-managed notebook entries |

## 2. Four-Layer Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Procedural Memory — "how I operate"                          │
│  ROLE.md + HEARTBEAT.md + Skills                              │
│  Most stable. Loaded at startup. Shapes every response.       │
│  Code: RoleLoader, Agent.reloadRole(), skill system           │
├───────────────────────────────────────────────────────────────┤
│  Semantic Memory — "what I know"                              │
│  MEMORY.md — curated sections + ## _observations buffer       │
│  Code: MemoryStore (addEntry, search, addLongTermMemory)      │
│  Tools: memory_save, memory_search, memory_update             │
├───────────────────────────────────────────────────────────────┤
│  Episodic Memory — "what I've experienced"                    │
│  Current episode: sessions/*.json (active conversation)       │
│  Past episodes:   SQLite agent_activities (searchable history)│
│  Code: MemoryStore (sessions) + SqliteActivityRepo            │
│  Tools: recall_activity (list / search / get)                 │
├───────────────────────────────────────────────────────────────┤
│  Notebook — persistent cognitive workspace                    │
│  NOTEBOOK.md — keyed entries (agent / system / cpp managed)   │
│  Tools: update_notebook, clear_notebook                       │
│  Code: Agent + MemoryStore (loadNotebook / saveNotebook)     │
└───────────────────────────────────────────────────────────────┘

Not memory (never read back by agent):
  daily-logs/*.md — audit trail for humans only
```

### Notebook (NOTEBOOK.md)

Persistent markdown replacing the former volatile in-memory working memory.

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/NOTEBOOK.md` |
| Format | `## key` headings with metadata comments + body text |
| Entry fields | `key`, `text`, `managed` (`agent` \| `system` \| `cpp`), `updatedAt` |
| Prompt injection | Always loaded as `## Notebook` |
| Limits | 15 agent-managed entries, 6000 chars each; oldest evicted when full |

**Managed tags**:

- `agent` — written via `update_notebook` / `clear_notebook`
- `system` — triage → `"triage-decision"`, deliberation → `"deliberation"`, etc.
- `cpp` — Cognitive Preparation Pipeline writes situational context

**Lifecycle**: Loaded at agent startup → updated in-process → debounced persist (2s) to disk. Survives restarts.

**Relationship to other layers**:

- More volatile than `MEMORY.md` curated sections but always in prompt
- Raw observations → `memory_save` → `## _observations`
- Validated knowledge → `memory_update` → curated sections above `_observations`

### Code Location

| Concern | Implementation | File |
|---------|---------------|------|
| Semantic + Episodic (sessions) | `MemoryStore` | `packages/core/src/memory/store.ts` |
| Notebook parse/serialize | `loadNotebook`, `saveNotebook` | `packages/core/src/memory/store.ts` |
| Interface | `IMemoryStore` | `packages/core/src/memory/types.ts` |
| Episodic (history) | `SqliteActivityRepo` | `packages/storage/src/sqlite-storage.ts` |
| Episodic retrieval | `recall_activity` tool | `packages/core/src/tools/recall.ts` |
| Procedural | `RoleLoader` | `packages/core/src/role-loader.ts` |
| Semantic tools | `memory_save`, `memory_search`, `memory_update` | `packages/core/src/tools/memory.ts` |
| Notebook tools | `update_notebook`, `clear_notebook` | `packages/core/src/tools/mailbox-tools.ts` |
| Vector search | `SemanticMemorySearch` | `packages/core/src/memory/semantic-search.ts` |
| Notebook runtime | `Agent.workingMemory`, prompt injection | `packages/core/src/agent.ts` |

---

## 3. Semantic Memory (MEMORY.md)

Unified file for both curated knowledge and raw observations.

```
MEMORY.md
├── ## conventions          ← agent-organized curated sections
├── ## procedures
├── ## preferences
├── ...
└── ## _observations        ← raw observation buffer (NOT in prompt)
    ├── ### obs_123...
    └── ### obs_456...
```

### Curated Sections

| Attribute | Value |
|-----------|-------|
| Write triggers | `memory_update` tool, Dream Cycle promotion |
| System prompt | Always loaded as `## Your Knowledge` (excludes `## _observations`) |
| Limits | 3000 chars/section (`MEMORY_MD_SECTION_MAX_CHARS`), 15000 chars total (`MEMORY_MD_TOTAL_MAX_CHARS`) |

The agent organizes sections freely — common patterns: `conventions`, `procedures`, `preferences`, `domain-knowledge`.

### `## _observations` — Observation Buffer

| Attribute | Value |
|-----------|-------|
| Format | `### {id}` subsections with HTML comment metadata + content |
| Entry types | `fact`, `note`, `task_result`, `conversation` |
| Write triggers | `memory_save` tool, task reflection |
| Prompt injection | **Not** injected — searched on demand via `memory_search` |
| Search | Substring match + optional vector overlay (`SemanticMemorySearch`) |
| Max entries | 500 (oldest trimmed on save) |

**Entry lifecycle**: `memory_save` → buffered in `_observations` → searched via `memory_search` → consolidated by Dream Cycle (merge/prune/promote) → promoted to curated sections.

**Tags** (in metadata comments): `insight`, `role-evolution`, `domain:<topic>`

### Migration from memories.json

On first load, if `memories.json` exists, entries migrate into `## _observations` within `MEMORY.md` and the JSON file is deleted. No manual migration required.

---

## 4. Memory Tools

Five primary tools (down from seven). Legacy aliases (`memory_list`, `memory_delete`, `memory_update_longterm`, `update_working_memory`, `clear_working_memory`) remain for backward compatibility.

| Tool | Purpose |
|------|---------|
| `update_notebook` | Upsert a keyed entry in NOTEBOOK.md |
| `clear_notebook` | Remove one entry or all agent-managed entries |
| `memory_save` | Append observation to `## _observations` |
| `memory_update` | Update curated section (`replace` / `patch`) or delete observations by ID (`mode: delete`) |
| `memory_search` | Search observations and curated knowledge; empty query lists recent observations |

---

## 5. Episodic Memory

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

## 6. Procedural Memory

How the agent operates — managed outside `MemoryStore` by the role/skill system.

| Component | Storage | Loader |
|-----------|---------|--------|
| ROLE.md | `~/.markus/agents/{id}/role/ROLE.md` | `RoleLoader` / `EnhancedRoleLoader` (`enhanced-role-loader.ts`) |
| HEARTBEAT.md | `~/.markus/agents/{id}/HEARTBEAT.md` | Loaded by heartbeat processor |
| Skills | Installed via `discover_tools` | Skill registry + MCP |

ROLE.md is loaded at startup and hot-reloaded when the agent modifies it via `file_edit`. Changes require proven experience — the self-evolution skill governs when and how agents modify their own identity.

---

## 7. Storage Layout

### File System (per agent)

```
~/.markus/agents/{agent-id}/
├── NOTEBOOK.md            # Notebook: persistent cognitive workspace
├── MEMORY.md              # Semantic: curated knowledge + ## _observations
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

> **Note**: `memories.json` is deprecated. Existing files auto-migrate to `MEMORY.md ## _observations` on first load.

### SQLite (`~/.markus/data.db`)

| Table | Memory Layer | Purpose |
|-------|-------------|---------|
| `agent_activities` | **Episodic** | Past episodes — searchable via `recall_activity` |
| `agent_activity_logs` | **Episodic** | Event-level detail within episodes |
| `chat_sessions` + `chat_messages` | *(UI persistence)* | Web UI chat history; synced to file sessions on restore |
| `mailbox_items` + `agent_decisions` | **Episodic** | Stimulus/response record (what the agent received and decided) |

**The test**: if the agent can retrieve it to inform future decisions, it's memory. If only humans read it, it's audit trail.

---

## 8. Consolidation (Dream Cycle)

Periodic process that maintains semantic memory health. Runs via `consolidateMemory()`. All consolidation happens within `MEMORY.md`.

### Trigger

- `## _observations` has 50+ entries
- Dream cycle has not run today (`lastDreamDate`); up to 4×/day when heavily bloated (500+ entries)

### Process (LLM-assisted)

1. Cap entries at 500, send to LLM with: id, type, date, tags, content preview
2. LLM responds with JSON: `{ remove: [...ids], merge: [...groups], promote: [...] }`
3. Apply removals: delete from `## _observations` + vector index
4. Apply merges: replace groups with merged entry in `_observations`
5. Apply promotions: append synthesized content to curated sections above `_observations`

### MEMORY.md Hygiene (`pruneMemoryMd`)

- Remove `## daily-report-*` sections (belong in daily-logs/)
- Enforce section char limits (3000/section, 15000 total)
- Strip leaked LLM artifacts (`<think>` blocks)

---

## 9. Key Rules

1. **MEMORY.md curated sections are sacred** — only distilled knowledge. Never raw LLM output or debug info.
2. **`## _observations` is the observation buffer** — not injected into prompts; vector index is a secondary search overlay.
3. **NOTEBOOK.md is always in prompt** — keep entries concise; use `memory_save` for durable observations.
4. **Activity history is episodic memory** — retrieved via `recall_activity` to inform future decisions.
5. **Sessions are thin** — hold current conversation only, auto-compacted.
6. **Daily logs are NOT memory** — append-only audit trail for humans. Never read back into prompts.
7. **Dream Cycle is conservative** — err on keeping entries; incorrect removal is worse than duplicates.
8. **One MemoryStore per agent** — file-system based, no cross-agent contamination.

---

## 10. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) | How agents use memory for context preparation |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | How memory is assembled into system prompts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Overall system architecture |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox stimulus/response feeds into episodic memory |
