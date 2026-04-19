---
name: self-evolution
description: Learn from experience — capture insights, organize knowledge, share reusable practices as skills, and refine your role over time
---

# Self-Evolution

You learn from experience and evolve yourself over time. This goes beyond remembering facts — you organize your own knowledge, develop effective procedures, and refine your role. Continuous self-improvement is a core part of being an effective agent.

## Knowledge Stores

Your memory has two stores with distinct roles:

| Store | File | Purpose | Written by |
|---|---|---|---|
| **Observation buffer** | `memories.json` | Raw observations, individual insights, tool tips | `memory_save` |
| **Curated knowledge** | `MEMORY.md` | Validated procedures, consolidated insights, proven patterns | `memory_update_longterm` |

**Flow**: Observations enter the buffer → recurring patterns get promoted to MEMORY.md (by you or by dream cycles) → source entries are pruned.

MEMORY.md is always loaded into your context as `## Your Knowledge`. The observation buffer is surfaced by the cognitive preparation pipeline or by relevance matching.

## When to Reflect

Trigger reflection when any of these happen:

1. **User correction** — "no, do X instead", "that's wrong". Strongest signal.
2. **Task revision** — Your submission was rejected. The system prompts you automatically.
3. **Self-correction** — One approach failed, a different one worked.
4. **Resolved error** — Unexpected failure you diagnosed and fixed.
5. **Efficiency insight** — A faster/cleaner/more reliable way for a recurring task.
6. **Pattern recognition** — You keep doing something the same way and it could be standardized.

Skip trivial matters — typos, one-off path errors, situations that won't recur.

## Decision Matrix — Where Does This Insight Go?

| What you learned | Where to save | How |
|---|---|---|
| Single insight, gotcha, mistake | Observation buffer | `memory_save` with tags: `["insight", ...]` |
| Tool tip or preference | Observation buffer | `memory_save` with tags: `["insight", "tool:<name>"]` |
| Validated pattern from successful task | Observation buffer | `memory_save` with tags: `["insight", ...]` |
| Multi-step repeatable workflow (personal) | MEMORY.md | `memory_update_longterm({ section: "<your-section>", mode: "patch" })` |
| Practice worth sharing with the team | Skill package | Create via **skill-building**, install with `builder_install` |
| 3+ related insights → behavioral rule | ROLE.md | Read → append → log change |

## Capturing Insights (Observation Buffer)

### Extracting an Insight

When a reflection trigger fires:

1. **Situation** — What were you trying to do?
2. **What went wrong** — What assumption or action was incorrect?
3. **What worked** — What was the correct approach?
4. **Generalized rule** — A reusable principle beyond this specific instance.

### Saving an Insight

Use `memory_save` with:

- **type**: `"insight"`
- **content** format:
  ```
  [INSIGHT] <one-line summary>
  Situation: <brief context>
  Mistake: <what went wrong>
  Correction: <what works>
  Rule: <generalized principle>
  ```
- **tags**: Always include `"insight"` first, then category tags: `coding`, `tool-usage`, `communication`, `architecture`, `process`, `domain:<topic>`

Dream cycles automatically promote recurring patterns (3+ similar insights) from the observation buffer to MEMORY.md and prune the source entries.

## Organizing Your Knowledge (MEMORY.md)

MEMORY.md is **your** knowledge base. You decide what sections to create and how to organize it. There is no rigid system-imposed taxonomy — structure it in whatever way makes your work most effective.

### Common Section Patterns

| Section name | Example content |
|---|---|
| `conventions` | Coding standards, naming rules, review criteria for your projects |
| `procedures` | Step-by-step workflows for recurring tasks |
| `preferences` | Tool choices, flags, parameter settings that work well |
| `domain-knowledge` | Technical facts specific to your area of expertise |
| `evolution-log` | Chronological record of ROLE.md changes |

You are not limited to these — create whatever sections make sense for your work.

### How to Add Knowledge

Use `memory_update_longterm` with `mode: "patch"` to append without overwriting:

```
memory_update_longterm({
  section: "procedures",
  mode: "patch",
  content: "### <Name>\nTrigger: <when to use>\nSteps:\n1. ...\n2. ...\nNotes: <gotchas>\nLast updated: <date>"
})
```

### How to Update Existing Knowledge

Use `mode: "replace"` with the full updated section content (read existing first, modify, then write back):

```
memory_update_longterm({
  section: "procedures",
  mode: "replace",
  content: "<full updated section content>"
})
```

### Using Your Knowledge (Before Starting Work)

Before starting a task, check your existing knowledge:

1. **MEMORY.md** — Your curated knowledge appears in the system context above as `## Your Knowledge`. Read and follow any procedures whose trigger matches.
2. **Skills** — Use `discover_tools({ mode: "list_skills" })` to see available team skills. Activate relevant ones with `discover_tools({ name: ["skill-name"] })`.
3. **Past experience** — Use `recall_activity` to query your execution history for relevant context.

Do not reinvent approaches you have already codified. If an existing procedure or skill partially applies, start from it and adapt.

### Limits

- Per-section: 3000 chars max
- Total MEMORY.md: 15000 chars max
- Merge or retire outdated entries when sections grow large

## Shareable Skills (Team Practices)

When a practice would benefit **other agents on the team** (not just you), package it as an installable skill instead of a personal MEMORY.md entry.

### Personal Knowledge vs Skill — when to choose which

| Criterion | MEMORY.md entry | Skill |
|---|---|---|
| Who benefits | Only you | Multiple agents |
| Storage | MEMORY.md (your context) | Installable skill package |
| Visibility | Only in your prompt | Available to all agents after install |
| Examples | "How I deploy service X" | "Code review checklist", "Git workflow for this repo" |

### Before Creating — Check First

Before creating a new skill, check if one already exists:
1. Run `discover_tools({ mode: "list_skills" })` to see all installed skills
2. Run `builder_list` to see artifacts in builder-artifacts
3. If a similar skill exists, **update it** instead of creating a new one

### How to Create and Install

1. Use the **skill-building** skill to create the package:
   - Write `skill.json` manifest + `SKILL.md` instructions to `~/.markus/builder-artifacts/skills/{name}/`
2. Install with `builder_install({ type: "skill", name: "{name}" })`
3. Log the creation via `memory_save` with tags `["insight", "skill-created"]`

### How to Update an Existing Skill

1. Edit the files in `~/.markus/builder-artifacts/skills/{name}/` (use `file_read` then `file_edit`)
2. Bump the version in `skill.json` (e.g., `"1.0.0"` → `"1.1.0"`)
3. Re-install with `builder_install({ type: "skill", name: "{name}" })` — this overwrites the old version and re-registers
4. Log the update via `memory_save` with tags `["insight", "skill-updated"]`

Only create a skill when you are confident the practice is validated (proven across 2+ tasks) and genuinely useful for others.

## Role Evolution (ROLE.md)

The deepest level. Modify ROLE.md only when ALL conditions are met:

1. **Pattern threshold** — 3+ related insights pointing to a fundamental behavioral change
2. **High confidence** — Proven by successfully completed tasks
3. **Systemic impact** — Affects many future tasks
4. **Not contradicting core role** — Refines or extends, doesn't contradict

### How to Modify

1. Read current ROLE.md via `file_read`
2. Append the new guideline (never rewrite the whole file)
3. Use `file_edit` for surgical changes
4. Log: `memory_save` with tags `["insight", "role-evolution"]`

## Quality Signal

During heartbeat, check your revision rate:
- Tasks with `executionRound > 1` required revision
- High revision rate (>30%) means your knowledge isn't being applied effectively
- Check if saved insights cover the failure patterns you see
- Escalate recurring mistakes: insight → MEMORY.md procedure → role update

## Rules

- **DO** save insights immediately while context is fresh
- **DO** include specific, actionable advice ("Always validate input schema before processing" > "Be more careful")
- **DO** use tags consistently for discoverability
- **DO** use `mode: "patch"` when adding to MEMORY.md sections
- **DO NOT** save trivial or non-generalizable observations
- **DO NOT** let MEMORY.md sections grow unbounded — merge or prune regularly
- **DO NOT** modify ROLE.md for one-off situations
- **DO NOT** skip reflection when the system prompts you after a task revision
