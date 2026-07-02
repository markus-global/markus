---
sidebar_position: 4
---

# Memory System

Markus agents use a four-layer memory architecture inspired by Tulving's model of human memory: procedural, semantic, episodic, and working memory. Each layer has distinct storage, retention, and retrieval characteristics.

## Four-Layer Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Procedural  — "how I operate"     ROLE.md, Skills           │
│  Semantic    — "what I know"       MEMORY.md, memories.json  │
│  Episodic    — "what I've done"    agent_activities (SQLite)  │
│  Working     — "what's top of mind" In-memory Map (volatile) │
└───────────────────────────────────────────────────────────────┘
```

## MEMORY.md — Curated Knowledge

Always loaded into the agent's system prompt as `## Your Knowledge`. Managed via `memory_update_longterm`. Agents organize content into custom sections (e.g., `conventions`, `procedures`, `domain-knowledge`). Enforced limits: 3000 chars per section, 15000 chars total.

## memories.json — Observation Buffer

A JSON array of timestamped entries (`fact`, `note`, `task_result`, `conversation`) on disk. Written via `memory_save`, searched via `memory_search` (substring + optional vector overlay). Acts as the agent's short-to-medium-term semantic store before consolidation.

## agent_activities — Execution History

Episodic memory stored in SQLite (`agent_activities` + `agent_activity_logs` tables). Each agent action is recorded as an activity with summary, keywords, token/tool counts, and success status. Retrieved on demand via the `recall_activity` tool — never auto-injected into prompts.

## Dream Cycle Consolidation

A periodic LLM-assisted process that maintains semantic memory health. When `memories.json` exceeds 50 entries and no consolidation has run today, the Dream Cycle: (1) removes duplicate or stale entries, (2) merges related observations, and (3) promotes recurring patterns into MEMORY.md sections. Also performs hygiene — strips leaked LLM artifacts and enforces size limits.

## Key Design Principles

- **File-first** for durable cognition (MEMORY.md, memories.json, ROLE.md) — human-readable and portable
- **Agent autonomy** — agents decide what to remember, distill, and evolve
- **Context is currency** — retrieval maximizes signal-to-noise for the limited context window
- **SQLite for history** — activity history is indexed, searchable, and queryable

## Deeper Reading

See the [detailed Memory System document](https://github.com/markus-global/markus/blob/main/docs/MEMORY-SYSTEM.md) for the full specification including storage layout, data models, write/read paths, and code references.
