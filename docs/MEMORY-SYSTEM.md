# Agent Memory System

Architecture and data flows for the Markus agent memory system. Persistent cognition uses
**NOTEBOOK.md** (cognitive workspace) plus a **dual long-term store** — `knowledge.md`
(permanent) and `state.md` (TTL snapshots) — with a legacy `MEMORY.md` migration path.
Grounded in Tulving-style procedural / semantic / episodic persistence plus cognitive-science
working-memory models.

> **SSOT budgets/injection**: [AGENT-RUNTIME.md](./AGENT-RUNTIME.md) §6.
> **Learning / dream librarian**: [LEARNING-LOOP.md](./LEARNING-LOOP.md).

## 1. Design Principles

1. **Workspace + dual semantic store**: `NOTEBOOK.md` is the situational cognitive workspace;
   `knowledge.md` holds permanent curated knowledge; `state.md` holds time-bounded snapshots
   (default TTL `STATE_TTL_DAYS = 7`). Observations buffer is never fully prompt-injected.
   Legacy `MEMORY.md` MUST migrate on first load.
2. **Tulving mapping + notebook**: Persistent layers align with Tulving-style cognition — **Procedural** (ROLE.md), **Semantic** (`knowledge.md` + `state.md`), **Episodic** (sessions + activities). The **Notebook** replaces volatile in-memory working memory with a persistent scratchpad always injected (via the volatile `[Live context]` tail by Scheme A — not as a system-prompt segment).
3. **SQLite for history**: Activity history lives in SQLite — indexed, searchable, and queryable via tools.
4. **Context is currency**: Every byte in the LLM prompt competes for limited context window. Retrieval must maximize signal-to-noise.
5. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update`), and how to evolve (ROLE.md edits).

### Cognitive Science Foundations

| Concept | Markus mapping |
|---------|----------------|
| **Baddeley — Working Memory Model** | `NOTEBOOK.md` = central executive + visuospatial sketchpad: limited-capacity, actively maintained situational state |
| **Cowan — Embedded Processes** | Capped `knowledge.md` = activated long-term memory in prompt (profile-dependent) |

### 1.1 Spec: knowledge.md / state.md

MUST: Prefer `knowledge.md` + `state.md` on disk under the agent data dir.
MUST: On first load, if only `MEMORY.md` exists, split heuristically:
dated / “silent” / “current” / progress snapshots → `state.md`; remainder → `knowledge.md`.
MUST: Prompt injection of knowledge MUST honor `KNOWLEDGE_PROMPT_MAX_TOKENS`
(`0` for reflex profile — omit full dump).
MUST: Reflex MAY inject ≤ `STATE_PROMPT_MAX_LINES_REFLEX` lines from `state.md`.
MUST: Dream/consolidation MUST expire state entries older than `STATE_TTL_DAYS`.
MUST: `memory_update_longterm` / curated updates write `knowledge.md`.
SHOULD: Expose `state_update` (or equivalent) for TTL snapshots.

Test IDs: `A-knowledge-cap`, `C-dream-state-ttl`.
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
│  knowledge.md — permanent curated sections                    │
│  state.md — TTL snapshots (progress, silence counters, …)     │
│  ## _observations — raw buffer (not fully injected)           │
│  Code: MemoryStore (addEntry, search, addLongTermMemory)      │
│  Tools: memory_save, memory_search, memory_update, state_update│
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
| Limits | **4 agent-managed** entries (`NOTEBOOK_MAX_AGENT_ENTRIES`), 6000 chars each; oldest *agent* entry evicted when inserting a new key. `system` / `cpp` entries do **not** count toward the 4. |

**Managed tags**:

- `agent` — written via `update_notebook` / `clear_notebook`
- `system` — triage → `"triage-decision"`, deliberation → `"deliberation"`, etc.
- `cpp` — Cognitive Preparation Pipeline writes situational context

**Lifecycle**: Loaded at agent startup → updated in-process → debounced persist (2s) to `NOTEBOOK.md`. Survives restarts.
**Cleanup**: `clear_notebook({ key })` removes one entry; `clear_notebook` without key clears the whole notebook. Prompt guidance: clear when a task completes or context goes stale. No TTL auto-prune — eviction is capacity-based (4 agent slots).

**Relationship to other layers**:

- More volatile than `knowledge.md` curated sections but always injected (volatile `[Live context]` tail)
- Raw observations → `memory_save` → `knowledge.md` `## _observations`
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

## 3. Semantic Memory (`knowledge.md` SSOT)

**Canonical on-disk store** for curated knowledge + the observation buffer is
`knowledge.md` under the agent data dir. Legacy `MEMORY.md` is migrated once on first
load (`ensureKnowledgeStateFiles`) and MUST NOT be written afterward. Tool results
SHOULD report `store: "knowledge.md"` so agents do not invent a wrong path.

```
knowledge.md
├── ## conventions          ← agent-organized curated sections
├── ## procedures
├── ## preferences
├── ...
└── ## _observations        ← raw observation buffer (NOT in prompt)
    ├── ### obs_123...
    └── ### obs_456...

state.md                    ← TTL snapshots (default STATE_TTL_DAYS = 7)
NOTEBOOK.md                 ← situational workspace (always in prompt)
MEMORY.md                   ← DEPRECATED legacy; migrate → knowledge/state once
```

### Lifecycle (Inject / Update / Clean)

| Phase | What | When |
|-------|------|------|
| **Inject** | Curated sections → `## Your Knowledge` (capped; omitted for reflex). Observations **not** injected. Notebook always. `state.md` short lines for reflex only. | Every non-reflex turn packing |
| **Update** | `memory_save` → `_observations` (one entry; `content` required). `memory_update` / `memory_update_longterm` → named curated section (`replace` / `patch`; `append` aliases `patch`). | Immediate on tool call |
| **Clean** | Dream (`memory_consolidation` only): dedupe / merge / promote (3+ theme) when ≥50 observations (≤1×/day; ≤4×/day if ≥500). Empty observations rejected on write and pruned on load. Section ≤3000 / file ≤15000 chars (compress or refuse). `state.md` TTL prune in dream. Post-task encode is **Distillation** (`scenario: distillation`), not Dream — see [LEARNING-LOOP.md](./LEARNING-LOOP.md) §0. | `consolidateMemory()` + write-time guards |

### Curated Sections

| Attribute | Value |
|-----------|-------|
| Write triggers | `memory_update` tool, Dream Cycle promotion |
| System prompt | Loaded as `## Your Knowledge` when knowledge token cap > 0 (excludes `## _observations`) |
| Limits | 3000 chars/section (`MEMORY_MD_SECTION_MAX_CHARS`), 15000 chars total (`MEMORY_MD_TOTAL_MAX_CHARS`) |
| Body rule | Section bodies MUST NOT introduce sibling `## ` headings (store sanitizes `## ` → `### `) |

The agent organizes sections freely — common patterns: `conventions`, `procedures`, `preferences`, `domain-knowledge`.

### `## _observations` — Observation Buffer

| Attribute | Value |
|-----------|-------|
| Format | `### {id}` subsections with HTML comment metadata + content |
| Entry types | `fact`, `note`, `insight`, `task_result`, `conversation` |
| Write triggers | `memory_save` tool (single object; not an array), task reflection |
| Prompt injection | **Not** injected — searched on demand via `memory_search` |
| Search | Substring match + optional vector overlay (`SemanticMemorySearch`) |
| Max entries | 500 (oldest trimmed on save); empty `content` refused |

**Entry lifecycle**: `memory_save` → buffered in `_observations` → searched via `memory_search` → consolidated by Dream Cycle (merge/prune/promote) → promoted to curated sections in `knowledge.md`.

**Tags** (in metadata comments): `insight`, `role-evolution`, `domain:<topic>`

### Migration

1. On first load, if only legacy `MEMORY.md` exists → split into `knowledge.md` + `state.md`.
2. If `memories.json` exists → migrate entries into `knowledge.md` `## _observations`, delete JSON.
3. After migration, all reads/writes use `knowledge.md`; stale `MEMORY.md` is ignored.

### Convergence test IDs

`A-memory-save-rejects-array`, `A-memory-save-no-empty-write`, `A-memory-update-append-alias`,
`A-section-no-h2-bleed`, `A-tool-result-store-path`, `A-legacy-memory-not-written`.

---

## 4. Memory Tools

Five primary tools (down from seven). Legacy aliases (`memory_list`, `memory_delete`, `memory_update_longterm`, `update_working_memory`, `clear_working_memory`) remain for backward compatibility.

| Tool | Purpose |
|------|---------|
| `update_notebook` | Upsert a keyed entry in NOTEBOOK.md |
| `clear_notebook` | Remove one entry or all agent-managed entries |
| `memory_save` | Append one observation to `knowledge.md` `## _observations` (`content` required; rejects arrays / empty) |
| `memory_update` | Update curated `knowledge.md` section (`replace` / `patch`; `append`→`patch`) or delete observations (`mode: delete`) |
| `memory_search` | Keyword search over observations **and** curated `knowledge.md` sections (token OR-match, ranked by hits); empty query lists recent observations. Falls back from semantic→keyword when embeddings miss. |

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
| Compaction | Full transcript kept by default; storage-side safety compaction only at `SESSION_STORAGE_COMPACT_TRIGGER = 2000` messages → keep `SESSION_STORAGE_COMPACT_KEEP = 1000`. Per-LLM-call token packing is separate (see [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) §3.2) |
| Lifetime | Per-session; new session per task or chat |

Session ID prefixes identify type: `hb_` (heartbeat), `a2a_`, `comment_`, `sys_`, `task_`.

> **Storage compaction is a high-volume safety net, not a token saver.** Below 2000
> messages the full transcript is kept on disk; only pathological on-disk tool results are
> shrunk (`SESSION_STORAGE_TOOL_SHRINK_CHARS = 100k`). This mirrors the window-first packing
> policy — we do not drop turns early to "save tokens".

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
| HEARTBEAT.md | `~/.markus/agents/{id}/role/HEARTBEAT.md` | Loaded by heartbeat processor |
| Skills | Installed via `discover_tools` | Skill registry + MCP |

ROLE.md is loaded at startup and hot-reloaded when the agent modifies it via `file_edit`. Changes require proven experience — platform **Learning Habits** ([LEARNING-LOOP.md](./LEARNING-LOOP.md) §8) govern when and how agents modify identity, memory, HEARTBEAT, or skills (including user-initiated Remember sessions in §9).

---

## 7. Storage Layout

### File System (per agent)

```
~/.markus/agents/{agent-id}/
├── NOTEBOOK.md            # Notebook: persistent cognitive workspace
├── knowledge.md           # Semantic SSOT: curated knowledge + ## _observations
├── state.md               # TTL snapshots (Dream librarian)
├── MEMORY.md              # DEPRECATED legacy (migrate once; do not write)
├── metrics.json           # Health counters (not memory)
├── role/
│   ├── ROLE.md            # Procedural: identity
│   └── HEARTBEAT.md       # Periodic self-check checklist
├── sessions/
│   └── sess_{ts}_{rand}.json  # Episodic: current conversation
├── daily-logs/
│   └── YYYY-MM-DD.md      # Audit trail (NOT memory — never read back)
├── workspace/             # Working files (not memory)
└── tool-outputs/          # Tool result offloads (not memory)
```

> **Note**: `memories.json` and `MEMORY.md` are deprecated. They auto-migrate into
> `knowledge.md` / `state.md` on first load; subsequent tool writes target `knowledge.md` only.

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

Periodic process that maintains semantic memory health. Runs via `consolidateMemory()`. All consolidation happens within `knowledge.md` (plus `state.md` TTL prune).

### Trigger

- `## _observations` has 50+ entries
- Dream cycle has not run today (`lastDreamDate`); up to 4×/day when heavily bloated (500+ entries)

### Process (LLM-assisted)

1. Cap entries at 500, send to LLM with: id, type, date, tags, content preview
2. LLM responds with JSON: `{ remove: [...ids], merge: [...groups], promote: [...] }`
3. Apply removals: delete from `## _observations` + vector index
4. Apply merges: replace groups with merged entry in `_observations`
5. Apply promotions: append synthesized content to curated sections above `_observations`

### knowledge.md Hygiene (`pruneMemoryMd`)

- Remove `## daily-report-*` sections (belong in daily-logs/)
- Enforce section char limits (3000/section, 15000 total)
- Strip leaked LLM artifacts (`<think>` blocks)
- Drop empty observation entries left by legacy buggy writes

---

## 8.7 Memory Flush (spec)

Before the working context fills up, the agent is prompted to persist anything important so
lossy compaction never silently discards decisions or learned facts. The prompt-side
mechanics live in [PROMPT-ENGINEERING.md §5.7](./PROMPT-ENGINEERING.md); this is the
authoritative behavior spec.

- **Behavior**: a **turn-level preflight** runs `memoryFlush` once per session when the
  previous turn's context usage crossed a high-water threshold (~75%). The flush asks the
  agent to `memory_save` key decisions/facts and `update_notebook` current state. It runs
  as an independent `sys_` session.
- **Invariants**:
  - Flush fires **at most once per session** (deduplicated), and **before** the compression
    that would drop older turns.
  - The flush session is independent, so a flush cannot recurse into another flush or into
    storage compaction (no `flush → compact → flush` loop).
  - Low-usage turns never trigger a flush.
- **Design rationale (Hermes)**: Hermes's compression flushes durable memory to disk *first*;
  Markus adopts the same "flush before you lose it" ordering, implemented as a preflight so it
  does not reenter the packing path.
- **Testing** (`packages/core/test/memory-flush-preflight.test.ts`): the pure decision
  `shouldMemoryFlushPreflight` fires at/above threshold, not below, not twice per session,
  never for `sys_` sessions, and not without prior usage. Wiring lives in
  `Agent.maybeMemoryFlushPreflight` / `recordContextUsage`, invoked before the chat, stream,
  and task `prepareMessages` calls.
- **Status**: implemented (`shouldMemoryFlushPreflight` + `maybeMemoryFlushPreflight`, wired
  into all three main turn paths; `memoryFlush` runs in an independent `sys_` session).

## 8.8 knowledge.md write-refusal visibility (spec)

`knowledge.md` enforces per-section (`MEMORY_MD_SECTION_MAX_CHARS = 3000`) and total
(`MEMORY_MD_TOTAL_MAX_CHARS = 15000`) limits. When a curated `memory_update` would
exceed the cap after compression, the write is refused.

- **Behavior**: a refused write returns a structured failure (`{ ok:false, reason }`,
  recognized by `isToolErrorResult`) and is surfaced to the activity log / stream (see
  [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) §4.1) — never a silent no-op the
  model mistakes for success.
- **Testing** (`packages/core/test/memory-store.test.ts` "B1:", `memory-tools-extended.test.ts`):
  an over-cap write returns `{ ok:false, reason }`; the memory tools propagate it as a
  structured `{ status:'error', ok:false }` result the caller/UI can observe.
- **Status**: implemented (`MemoryStore.addLongTermMemory` returns `{ ok, reason }`;
  `memory_update` / `memory_update_longterm` return a structured error on refusal).

---

## 9. Key Rules

1. **`knowledge.md` curated sections are sacred** — only distilled knowledge. Never raw LLM output or debug info. Do not teach agents to write `MEMORY.md`.
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
| [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) | Surfaces memory-write refusals as visible events |
