# Agent Memory System

Architecture and data flows for the Markus agent memory system, based on Tulving's cognitive classification.

## 1. Design Principles

1. **Tulving's three systems**: Semantic (what you know), Episodic (what happened), Procedural (how to do things).
2. **File-first**: Primary storage is the local file system (`~/.markus/agents/{id}/`). Human-readable and portable.
3. **Context is currency**: Every byte in the LLM prompt competes for limited context window. Retrieval must maximize signal-to-noise.
4. **Agent autonomy**: Agents decide what to remember (`memory_save`), what to distill (`memory_update_longterm`), and how to evolve (ROLE.md edits).

## 2. Three-Layer Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Procedural Memory (ROLE.md + HEARTBEAT.md + Skills)          │
│  How the agent operates. Identity, behavioral rules, skills.  │
│  Most stable. Loaded at startup.                              │
│  Code: ProceduralMemory / loadProceduralMemory()              │
├───────────────────────────────────────────────────────────────┤
│  Semantic Memory (MEMORY.md + memories.json)                  │
│  What the agent knows. Curated knowledge + observation buffer.│
│  MEMORY.md: always in system prompt.                          │
│  memories.json: searched on demand.                           │
│  Code: SemanticMemory                                         │
├───────────────────────────────────────────────────────────────┤
│  Episodic Memory (conversation sessions via SQLite)           │
│  What happened in interactions. Chat history per session.     │
│  Auto-compacted when too large.                               │
│  Code: EpisodicMemory (wraps SqliteChatSessionRepo)           │
└───────────────────────────────────────────────────────────────┘

Separate concerns (not memory layers):
  Activity tracking  — SQLite agent_activities (operational observability)
  Audit trail        — daily-logs/*.md (append-only, never read back)
```

### Code Mapping

| Layer | Class | File |
|-------|-------|------|
| Semantic | `SemanticMemory` | `packages/core/src/memory/semantic-memory.ts` |
| Episodic | `EpisodicMemory` | `packages/core/src/memory/episodic-memory.ts` |
| Procedural | `loadProceduralMemory()` | `packages/core/src/memory/procedural-memory.ts` |
| Facade | `MemoryService` | `packages/core/src/memory/memory-service.ts` |
| Interfaces | all types | `packages/core/src/memory/interfaces.ts` |

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
| Limits | 3000 chars/section, 15000 chars total |

The agent organizes sections freely (no system-imposed taxonomy). Common patterns:

- `conventions` — coding standards, naming rules
- `procedures` — recurring workflows
- `preferences` — tool choices, communication styles
- `domain-knowledge` — technical facts

### memories.json — Observation Buffer

| Attribute | Value |
|-----------|-------|
| Storage | `~/.markus/agents/{id}/memories.json` |
| Format | `MemoryEntry[]` with `id`, `timestamp`, `type`, `content`, `tags` |
| Entry types | `fact`, `note`, `observation`, `task_result`, `conversation` |
| Write triggers | `memory_save` tool, task reflection |
| Search | Substring match + tag filter (vector overlay planned) |

**Entry lifecycle**: Created → Searched → Consolidated (Dream Cycle merges duplicates) → Promoted (recurring patterns → MEMORY.md)

**Tags**: `insight`, `role-evolution`, `domain:<topic>`

---

## 4. Episodic Memory

Conversation history managed through SQLite (`SqliteChatSessionRepo`).

| Attribute | Value |
|-----------|-------|
| Storage | SQLite `chat_sessions` + `chat_messages` |
| Interface | `IEpisodicMemory` |
| Write triggers | `appendMessage()` on every turn |
| Compaction | Auto-compact when session grows large (keep recent, summarize old) |
| Lifetime | Per-session; new session per task or chat |

Key operations:
- `createSession(agentId)` — start a new episode
- `appendMessage(sessionId, msg)` — record a turn
- `getRecentMessages(sessionId, limit)` — retrieve recent context
- `compactSession(sessionId, keepLast)` — trim old messages with summary

---

## 5. Procedural Memory

How the agent operates — identity, behavioral rules, and installed skills.

| Component | Storage | Purpose |
|-----------|---------|---------|
| ROLE.md | `~/.markus/agents/{id}/role/ROLE.md` | Agent persona, expertise, rules |
| HEARTBEAT.md | `~/.markus/agents/{id}/HEARTBEAT.md` | Periodic check-in behavior |
| Skills | `SKILL.md` or `manifest.json` in skill dirs | Installable capability packages |

Loaded on-demand via `loadProceduralMemory(config)`. The config specifies paths to scan:

```typescript
interface ProceduralMemoryConfig {
  rolePath: string;
  heartbeatPath: string;
  skillPaths: string[];
  additionalScanDirs?: string[];
}
```

Skills are discovered from directories containing `SKILL.md` (markdown with optional YAML frontmatter) or `manifest.json`. Each skill has `name`, `description`, optional `triggers` for on-demand loading.

---

## 6. MemoryService Facade

`MemoryService` unifies all three layers into a single entry point:

```typescript
const svc = new MemoryService({
  dataDir: '~/.markus/agents/{id}/',
  chatSessionRepo: sqliteRepo,
  proceduralConfig: { rolePath, heartbeatPath, skillPaths },
});

// Semantic
await svc.memorySave({ type: 'fact', content: '...' });
await svc.memorySearch('query');
await svc.updateSection('conventions', '...');

// Episodic
await svc.prepareSession(agentId);
await svc.appendMessage(sessionId, msg);
await svc.getRecentMessages(sessionId);

// Procedural
const proc = await svc.loadProcedural();

// Cross-layer
const ctx = await svc.getAgentContext(agentId, query);
await svc.consolidate();
```

---

## 7. Storage Layout

### File System (per agent)

```
~/.markus/agents/{agent-id}/
├── MEMORY.md              # Semantic: curated knowledge
├── memories.json          # Semantic: observation buffer
├── metrics.json           # Health counters (not memory)
├── role/
│   └── ROLE.md            # Procedural: identity
├── daily-logs/
│   └── YYYY-MM-DD.md      # Audit trail (write-only)
├── workspace/             # Working files (not memory)
└── tool-outputs/          # Tool result offloads (not memory)
```

### SQLite (`~/.markus/data.db`)

| Table | Layer | Purpose |
|-------|-------|---------|
| `chat_sessions` | Episodic | Session metadata |
| `chat_messages` | Episodic | Message history |
| `agent_activities` | *(operational)* | Activity tracking for UI/observability |
| `agent_activity_logs` | *(operational)* | Event-level logs within activities |

---

## 8. Consolidation (Dream Cycle)

Periodic process that maintains memory health. Runs as part of `consolidateMemory()`.

### Trigger

- `memories.json` has 50+ entries
- Dream cycle has not run today

### Process

1. Group observations by content similarity (Dice bigram coefficient)
2. Groups with 3+ similar entries → merge into consolidated `note`
3. Promote recurring patterns to MEMORY.md (`consolidated-insights` section)
4. Remove source observations after merge
5. Persist updated `memories.json`

### MEMORY.md Hygiene (`pruneMemoryMd`)

- Remove `## daily-report-*` sections (belong in daily-logs/)
- Enforce section char limits (3000/section, 15000 total)
- Strip leaked LLM artifacts (`<think>` blocks)

---

## 9. Key Rules

1. **MEMORY.md is sacred** — only distilled knowledge. Never raw LLM output or debug info.
2. **memories.json is source of truth** — vector index (when wired) is a secondary search overlay.
3. **Memory tools are agent-facing** — `memory_save`, `memory_search`, `memory_list`, `memory_update_longterm`.
4. **Sessions are thin** — hold current conversation only, not historical context.
5. **Daily logs are write-only** — append-only audit trail, never read back into prompts.
6. **Dream Cycle is conservative** — err on keeping entries; incorrect removal is worse than duplicates.
7. **One MemoryService per agent** — facade coordinates all three layers.

---

## 10. Cross-Reference

| Document | Relationship |
|----------|-------------|
| [COGNITIVE-ARCHITECTURE.md](./COGNITIVE-ARCHITECTURE.md) | How agents use memory for context preparation |
| [PROMPT-ENGINEERING.md](./PROMPT-ENGINEERING.md) | How memory is assembled into system prompts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Overall system architecture |
| [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) | Mailbox as stimulus/response pipeline |
