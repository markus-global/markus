# Agent Memory System

Architecture and data flows for the Markus agent memory system. Persistent cognition uses
**NOTEBOOK.md** (cognitive workspace) plus **`knowledge.md`** as the single long-term store
(permanent curated knowledge + the observation buffer). The former second half of the old
"dual store", `state.md`, has **retired** — its situational state now lives in the notebook's
`system` tier (see §2 / §3). A legacy `MEMORY.md` still migrates once.
Grounded in Tulving-style procedural / semantic / episodic persistence plus cognitive-science
working-memory models.

> **SSOT budgets/injection**: [AGENT-RUNTIME.md](./AGENT-RUNTIME.md) §6.
> **Learning / dream librarian**: [LEARNING-LOOP.md](./LEARNING-LOOP.md).

## 1. Design Principles

1. **Workspace + single semantic store**: `NOTEBOOK.md` is the situational cognitive workspace;
   `knowledge.md` holds permanent curated knowledge plus the observation buffer. Situational
   ("current") state lives in the notebook's `system` tier rather than a second file — the old
   `state.md` half **retired** (see §2). Observations buffer is never fully prompt-injected.
   Legacy `MEMORY.md` MUST migrate on first load.
2. **Tulving mapping + notebook**: Persistent layers align with Tulving-style cognition — **Procedural** (ROLE.md), **Semantic** (`knowledge.md`), **Episodic** (sessions + activities). The **Notebook** replaces volatile in-memory working memory with a persistent scratchpad always injected (via the volatile `[Live context]` tail by Scheme A — not as a system-prompt segment).
3. **SQLite for history**: Activity history lives in SQLite — indexed, searchable, and queryable via tools.
4. **Context is currency**: Every byte in the LLM prompt competes for limited context window. Retrieval must maximize signal-to-noise.
5. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update`), and how to evolve (ROLE.md edits).

### Cognitive Science Foundations

| Concept | Markus mapping |
|---------|----------------|
| **Baddeley — Working Memory Model** | `NOTEBOOK.md` = central executive + visuospatial sketchpad: limited-capacity, actively maintained situational state |
| **Cowan — Embedded Processes** | Capped `knowledge.md` = activated long-term memory in prompt (profile-dependent) |

### 1.1 Spec: knowledge.md (single long-term store)

MUST: Prefer `knowledge.md` on disk under the agent data dir as the single long-term store.
MUST: On first load, if only legacy `MEMORY.md` exists, migrate it into `knowledge.md`.
MUST: Prompt injection of knowledge MUST honor `KNOWLEDGE_PROMPT_MAX_TOKENS`
(`0` for reflex profile — omit full dump).
MUST: `MEMORY_MD_TOTAL_MAX_CHARS` MUST be enforced as a **load-time invariant**, not only a
write-time guard: `MemoryStore.convergeLongTermToCap()` runs on construction/load and condenses
the largest curated section(s) to a stub **keeping the heading** (so the index line and
`memory_search` still surface the topic), never touching `## _observations`. Rationale: a
write-time refusal cannot shrink an already-oversized file, so an over-budget file used to stay
over budget forever (measured 23 323 chars against a 15 000 limit).
MUST: `memory_update mode="forget"` (`MemoryStore.removeLongTermSection`) is the curated-section
**forget primitive**; forgetting `## _observations` is refused (delete observations by id instead).
MUST: `knowledge.md` / `NOTEBOOK.md` MUST be persisted with `writeFileAtomic` (tmp + rename) so a
half-written file is never parsed back as real state on the next load.
MUST: `memory_update_longterm` / curated updates write `knowledge.md`.
MUST: `memory_save` → `## _observations`; `memory_update` → named curated section.

Test IDs: `A-knowledge-cap`.
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
│  (retired) —> NOTEBOOK.md system tier (situational state)      │
│  ## _observations — raw buffer (not fully injected)           │
│  Code: MemoryStore (addEntry, search, addLongTermMemory)      │
│  Tools: memory_save, memory_search, memory_update, notebook ops│
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
| Prompt injection | Always loaded as `## Notebook`, bounded to `NOTEBOOK_MAX_ENTRIES` (16) entries / `NOTEBOOK_PROMPT_MAX_CHARS` (6000) chars. Oversized entries are truncated inline (never dropped whole). |
| Limits | **16 total** entries (`NOTEBOOK_MAX_ENTRIES`) — the CROSS-TIER cap; **4 agent** entries (`NOTEBOOK_MAX_AGENT_ENTRIES`); `NOTEBOOK_MAX_CHARS_PER_ENTRY` (6000) per entry; key ≤ `NOTEBOOK_KEY_MAX_CHARS` (64). |
| TTL | Per tier: `agent` 96h, `system` 24h, `cpp` 6h (`NOTEBOOK_TTL_MS_*`). Entries past their TTL are dropped on load, after every write, and again before injection. |
| Eviction | Oldest-`updatedAt`-first. Tier order: `cpp` → `system` → `agent` — the agent's own notes are the **last** to go. |

**Managed tags**:

- `agent` — written via `update_notebook` / `clear_notebook`
- `system` — triage → `"triage-decision"`, deliberation → `"deliberation"`, etc.
- `cpp` — Cognitive Preparation Pipeline writes situational context

**Lifecycle**: Loaded at agent startup → **normalized on load** (TTL + caps; trimmed result is persisted immediately) → updated in-process → persisted with a 2s debounce **bounded by `NOTEBOOK_PERSIST_MAX_WAIT_MS` (10s)** so a chatty turn cannot defer the write indefinitely. Survives restarts.
**Cleanup**: `clear_notebook({ key })` removes one entry; `clear_notebook` without key clears the whole notebook. TTL handles passive expiry; `clear_notebook` handles deliberate removal. Prompt guidance: clear when a task completes or context goes stale.

#### Invariants (§2 Notebook lifecycle)

The notebook is a RESIDENT prompt region, so it needs all four mechanisms that keep a
resident region honest. Historically only the storage-side per-entry cap existed, and
the entry cap was applied on **one** write path — the other three writers
(`triage` → `triage-decision`, `deliberation`, the CPP notebook writer) called
`workingMemory.set()` directly and were never counted. The load path trimmed
nothing. Result: a real notebook reached **26 entries / 33 KB** against a nominal
cap of 4, including an 18-day-old triage decision and a 57-day-old CPP output that
were re-injected on every turn.

| # | Invariant | Authority |
|---|-----------|-----------|
| 1 | Entry count ≤ 16 (and agent tier ≤ 4) | `pruneNotebookEntries` |
| 2 | No entry older than its tier TTL | `pruneNotebookEntries` + `notebookTtlMs` |
| 3 | Per-entry char cap; `relevant-context` capped tighter (`NOTEBOOK_RELEVANT_CONTEXT_MAX_CHARS`) | `Agent.writeNotebookEntry` |
| 4 | Injected block ≤ 6000 chars, deterministic order, index line for what did not fit | `Agent.getDynamicContext` |
| 5 | Every write goes through `Agent.writeNotebookEntry` | call-site discipline |
| 6 | Disk matches memory after normalization | `Agent.enforceNotebookLimits` + `persistNotebookSync` |

`pruneNotebookEntries` is the single authority for "notebook state is legal" and is
idempotent. It is applied at three points: **on load**, **after every write**, and
**before injection**. Because it is called on load, an oversized notebook written by
an older build self-heals at the next startup instead of persisting forever.

Ordering in the injected block is `updatedAt` DESC with a `key` ASC tie-break. Two
properties matter: staleness ranking (the entries that matter most are read first)
and **byte stability** — for the same logical state the block must serialize
identically, or every assembly dirties the volatile tail and re-bills those tokens.
Map insertion order satisfied neither (evict + re-insert permutes the block).

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

NOTEBOOK.md (system tier)   ← short-lived situational state (per-tier TTL)
NOTEBOOK.md                 ← situational workspace (always in prompt)
MEMORY.md                   ← DEPRECATED legacy; migrate → knowledge/state once
```

### Lifecycle (Inject / Update / Clean)

| Phase | What | When |
|-------|------|------|
| **Inject** | Curated sections → `## Your Knowledge` (capped; omitted for reflex). Observations **not** injected. Notebook always (it carries the situational state that the retired `state.md` used to hold). | Every non-reflex turn packing |
| **Update** | `memory_save` → `_observations` (one entry; `content` required). `memory_update` / `memory_update_longterm` → named curated section (`replace` / `patch`; `append` aliases `patch`). | Immediate on tool call |
| **Clean** | Dream (`memory_consolidation` only): dedupe / merge / promote (3+ theme) when ≥50 observations (≤1×/day; ≤4×/day if ≥500). Empty observations rejected on write and pruned on load. Section ≤3000 / file ≤15000 chars — now enforced **at load** as well as on write (an over-budget file is converged on load instead of refusing future writes). Notebook per-tier TTL prune runs on every notebook write. Post-task encode is **Distillation** (`scenario: distillation`), not Dream — see [LEARNING-LOOP.md](./LEARNING-LOOP.md) §0. | `consolidateMemory()` + write-time guards |

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

1. On first load, if only legacy `MEMORY.md` exists → migrate **wholesale** into `knowledge.md` (the old knowledge/state split is gone; a retired `state.md`, if present, folds into the notebook's `system` tier as key `legacy-state`).
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
├── (state.md removed — situational state → NOTEBOOK.md `system` tier)
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
> `MEMORY.md` on first load; subsequent tool writes target `knowledge.md` only. `state.md` **retired 2026-09-16** (situational state → notebook `system` tier).

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

Periodic process that maintains semantic memory health. Runs via `consolidateMemory()`. All consolidation happens within `knowledge.md`. Notebook per-tier TTL pruning runs on every notebook write (the separate `state.md` TTL prune was removed with that store).

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

## 10. Layering criterion, consolidation record, known limits

### 10.1 The single criterion: `(scope × durability)`

Every state a running agent carries is placed by asking two questions only — *who can see it*
(scope) and *how long it must survive* (durability). Anything that cannot be placed is a smell.

| Layer | Scope | Durability | Carrier | Write path | Injected as |
|---|---|---|---|---|---|
| **Identity** | agent-lifetime | permanent (human-owned) | `role/ROLE.md`, `role/HEARTBEAT.md`, skills | human edit / explicit file write | fixed段 (system) |
| **Knowledge** | agent-lifetime | long, forgettable | `knowledge.md` (curated sections + `## _observations`) | `memory_save`, `memory_update` (incl. `mode="forget"`) | volatile tail, budget-capped |
| **Working** | agent-lifetime | short, auto-expiring | `NOTEBOOK.md` (per-tier TTL) | `update_notebook` (alias `update_working_memory`) | volatile tail (`## Notebook`) |
| **Session** | one session/worker | session-scoped | slots / `summary` / fragments | `session` tool family | fixed段 + history |

### 10.2 Consolidation record — what was merged away

Before this criterion was applied, 13 state-like mechanisms competed for the same jobs. The
merges below are the reason the count is now small; **do not re-introduce the retired halves**.

| Removed | Why it existed | Folded into | Date |
|---|---|---|---|
| `state.md` (store) | "short-lived situational state" half of a knowledge/state dual store — it had a reader (reflex prompt) and a TTL pruner (dream) but **no write tool at all**, so every writer actually went to the notebook | `NOTEBOOK.md` `system` tier; existing files migrate once to notebook key `legacy-state` with a tombstone left behind | 2026-09-16 (option A) |
| `working-memory` (lock domain) | the notebook's older name; kept as a second *domain* after the tool alias was added | `agent-memory:notebook` — one resource, one lock key (see [CONCURRENT-PROCESSING.md](./CONCURRENT-PROCESSING.md) §4.3) | 2026-09-16 |
| knowledge/state **split** on migration | `splitLegacyMemory` guessed which `MEMORY.md` sections were "state" by keywords | whole-file migration into `knowledge.md` (keyword guessing was itself an incident source) | 2026-09-16 |
| `getStateMemory` / `pruneStateMemory` / `STATE_TTL_DAYS` / `STATE_PROMPT_MAX_LINES_REFLEX` | supported the retired `state.md` | notebook per-tier TTL (`NOTEBOOK_TTL_MS_*`); constants deleted with in-place NOTE comments | 2026-09-16 |

Principles this produced:
- **A store with no writer is dead weight** — `state.md` was documented, initialized, read and
  pruned, yet unwritable. Documentation and tooling drifted apart; the tool surface is the truth.
- **A store with no delete inflates** — the curated half had no removal path, so superseded
  knowledge could only be overwritten. `mode="forget"` closes this (§1.1).
- **One resource must have one lock key** — see [CONCURRENT-PROCESSING.md](./CONCURRENT-PROCESSING.md) §4.3.

### 10.3 Known limits / deliberate non-goals

| Limit | Why it is accepted for now |
|---|---|
| Curated knowledge does **not** decay by age | distinguishing "durable principle" from "temporary conclusion" is a semantic judgement only an LLM can make → belongs in the dream-cycle curation prompt, not the storage layer. Bounded instead by the load-time total cap. |
| No write queue for memory writes | lock-key unification + atomic writes removed the main interleaving surface; a queue would add a serialisation bottleneck without evidence of remaining contention. |
| `relevant-context` may repeat what `## Your Knowledge` already says | deliberate: deduplicating raises "which copy is authoritative?" ambiguity. |
| Frontend renders the notebook; there is no jsdom-level render test | helper-level unit tests only (`packages/web-ui/src/lib/notebookDisplay.test.ts`); render-level harness is a separate piece of work. |

## 11. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) | How agents use memory for context preparation |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | How memory is assembled into system prompts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Overall system architecture |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox stimulus/response feeds into episodic memory |
| [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) | Surfaces memory-write refusals as visible events |
