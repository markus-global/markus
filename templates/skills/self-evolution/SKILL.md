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
| Behavioral rule or guiding principle | ROLE.md | `file_read` → `file_edit` to append |
| New recurring check for your patrol | HEARTBEAT.md | `file_read` → `file_edit` to add/remove items |

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

ROLE.md is your identity — it is loaded into every conversation and shapes all your behavior. Updating it is one of the **simplest and most impactful** forms of self-evolution.

### When to Update

Modify ROLE.md when you discover a behavioral rule, working style, or guiding principle that should **always** apply to your work. Examples:

- "Always run tests before submitting code for review"
- "When debugging, check logs first before reading source code"
- "Prefer small, focused PRs over large ones"

You do NOT need to accumulate multiple insights first — even a single validated lesson can warrant a role update if it is fundamental and non-obvious.

### Guard Rails

- **Refine, don't contradict** — New guidelines should extend your core role, not conflict with it
- **Proven, not speculative** — The principle should be validated by actual task outcomes
- **Not one-off** — It should apply to future tasks, not just the current situation

### How to Modify

1. Read current ROLE.md via `file_read`
2. Append the new guideline (never rewrite the whole file)
3. Use `file_edit` for surgical changes
4. Log: `memory_save` with tags `["insight", "role-evolution"]`

## Heartbeat Customization (HEARTBEAT.md)

HEARTBEAT.md is your personal patrol checklist — it controls what you check during each heartbeat cycle. Customizing it is a direct way to evolve your operational behavior.

### When to Update

- You realize you should be regularly checking for something you currently aren't (e.g., monitoring a specific service, reviewing a certain type of task)
- A checklist item is obsolete or no longer relevant to your responsibilities
- You want to change the order or priority of your patrol routine

### How to Modify

1. Read current HEARTBEAT.md via `file_read`
2. Add, remove, or reorder checklist items via `file_edit`
3. Changes take effect at the next heartbeat cycle (the system auto-reloads)
4. Log: `memory_save` with tags `["insight", "heartbeat-evolution"]`

### Examples of Good Heartbeat Additions

- "Check if any PR I opened has new review comments"
- "Verify that the staging deployment matches the latest main branch"
- "Review `task_list` for tasks blocked more than 24 hours — escalate if needed"

## Quality Signal

During heartbeat, check your revision rate:
- Tasks with `executionRound > 1` required revision
- High revision rate (>30%) means your knowledge isn't being applied effectively
- Check if saved insights cover the failure patterns you see
- Consider: would a ROLE.md rule or a HEARTBEAT.md check have prevented any recent failures?
- Escalate recurring mistakes: insight → MEMORY.md procedure → ROLE.md rule or HEARTBEAT.md check

## Rules

- **DO** save insights immediately while context is fresh
- **DO** include specific, actionable advice ("Always validate input schema before processing" > "Be more careful")
- **DO** use tags consistently for discoverability
- **DO** use `mode: "patch"` when adding to MEMORY.md sections
- **DO NOT** save trivial or non-generalizable observations
- **DO NOT** let MEMORY.md sections grow unbounded — merge or prune regularly
- **DO NOT** modify ROLE.md for one-off situations
- **DO NOT** skip reflection when the system prompts you after a task revision
