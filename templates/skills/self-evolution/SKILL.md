---
name: self-evolution
description: Learn from experience — capture lessons, evolve SOPs, share best practices as skills, and refine your role over time
---

# Self-Evolution

You learn from experience and evolve yourself over time. This goes beyond remembering facts — you refine your role, optimize tool usage, and develop SOPs that make you more effective. Continuous self-improvement is a core part of being an effective agent.

## Knowledge Lifecycle

Your memory has two stores with distinct roles:

| Store | File | Purpose | Written by |
|---|---|---|---|
| **Intake buffer** | `memories.json` | Raw observations, individual lessons, tool preferences | `memory_save` |
| **Curated knowledge** | `MEMORY.md` | Validated SOPs, consolidated lessons, proven patterns | `memory_update_longterm` |

**Flow**: Observations enter the intake buffer → recurring patterns get promoted to MEMORY.md (by you or by dream cycles) → source entries are pruned.

The system automatically injects both stores into your context, but curated knowledge (MEMORY.md) is always present while intake buffer entries are surfaced by relevance matching.

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
| Single lesson, gotcha, mistake | Intake buffer | `memory_save` with tags: `["lesson", ...]` |
| Tool preference / tip | Intake buffer | `memory_save` with tags: `["lesson", "tool-preference"]` |
| Best practice from successful task | Intake buffer | `memory_save` with tags: `["lesson", "best-practice"]` |
| Multi-step repeatable workflow (personal) | MEMORY.md SOPs | `memory_update_longterm({ section: "sops", mode: "patch" })` |
| Best practice worth sharing with the team | Skill package | Create via **skill-building**, install with `builder_install` |
| 3+ related lessons → behavioral rule | ROLE.md | Read → append → log change |

## Layer 1: Lessons (Intake Buffer)

### Extracting a Lesson

When a reflection trigger fires:

1. **Situation** — What were you trying to do?
2. **What went wrong** — What assumption or action was incorrect?
3. **What worked** — What was the correct approach?
4. **Generalized rule** — A reusable principle beyond this specific instance.

### Saving a Lesson

Use `memory_save` with:

- **type**: `"note"`
- **content** format:
  ```
  [LESSON] <one-line summary>
  Situation: <brief context>
  Mistake: <what went wrong>
  Correction: <what works>
  Rule: <generalized principle>
  ```
- **tags**: Always include `"lesson"` first, then category tags: `coding`, `tool-usage`, `communication`, `architecture`, `process`, `domain:<topic>`

Dream cycles automatically promote recurring patterns (3+ similar lessons) from the intake buffer to MEMORY.md and prune the source entries.

## Layer 2: Tool Preferences

Record tool preferences when you discover:
- A tool is significantly better than another for a specific task type
- Optimal parameters or flags for a tool
- Tool limitations to work around
- Effective tool combinations

Use `memory_save` with:
- **content**: `[TOOL-PREF] <summary>\nTask: <task type>\nPreferred: <tool + usage>\nAvoid: <what doesn't work>\nReason: <why>`
- **tags**: `["lesson", "tool-preference", "<tool-name>"]`

## Using Existing Knowledge (Before Starting Work)

Before starting a task, **always check your existing knowledge**:

1. **SOPs** — Your SOPs appear in the system context above. Read them and follow any whose trigger matches.
2. **Lessons** — The "Applicable Lessons" section (if present) shows lessons matched to your current task. Apply them proactively.
3. **Skills** — Use `discover_tools({ mode: "list_skills" })` to see available team skills. Activate relevant ones with `discover_tools({ name: ["skill-name"] })`.

Do not reinvent approaches you have already codified. If an existing SOP or skill partially applies, start from it and adapt.

## Layer 3: SOPs (Personal Procedures)

SOPs are your **personal** procedural memory — they live in the `sops` section of MEMORY.md and are always loaded into your context. Use SOPs for workflows only you need.

### Before Creating — Check First

Always search existing SOPs before creating a new one:
1. Review your SOPs in the system context above
2. Run `memory_search("sops")` to find related entries
3. If an existing SOP covers a similar workflow, **update it** instead of creating a duplicate

### How to Create

Use `memory_update_longterm` with `mode: "patch"` to append without overwriting:

```
memory_update_longterm({
  section: "sops",
  mode: "patch",
  content: "### SOP: <Name>\nTrigger: <when to use>\nSteps:\n1. ...\n2. ...\nNotes: <gotchas>\nLast updated: <date>"
})
```

### How to Update an Existing SOP

Use `mode: "replace"` with the full updated sops section content (read existing first, modify, then write back):

```
memory_update_longterm({
  section: "sops",
  mode: "replace",
  content: "<full updated sops section with the modified SOP>"
})
```

Maximum 10 SOPs — merge or retire outdated ones when you reach the limit.

## Layer 4: Shareable Skills (Team Best Practices)

When a best practice would benefit **other agents on the team** (not just you), package it as an installable skill instead of a personal SOP.

### SOP vs Skill — when to choose which

| Criterion | SOP | Skill |
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
3. Log the creation via `memory_save` with tags `["lesson", "skill-created"]`

### How to Update an Existing Skill

1. Edit the files in `~/.markus/builder-artifacts/skills/{name}/` (use `file_read` then `file_edit`)
2. Bump the version in `skill.json` (e.g., `"1.0.0"` → `"1.1.0"`)
3. Re-install with `builder_install({ type: "skill", name: "{name}" })` — this overwrites the old version and re-registers
4. Log the update via `memory_save` with tags `["lesson", "skill-updated"]`

Only create a skill when you are confident the practice is validated (proven across 2+ tasks) and genuinely useful for others.

## Layer 5: Role Evolution (ROLE.md)

The deepest level. Modify ROLE.md only when ALL conditions are met:

1. **Pattern threshold** — 3+ related lessons/best-practices pointing to a fundamental behavioral change
2. **High confidence** — Proven by successfully completed tasks
3. **Systemic impact** — Affects many future tasks
4. **Not contradicting core role** — Refines or extends, doesn't contradict

### How to Modify

1. Read current ROLE.md via `file_read`
2. Append the new guideline (never rewrite the whole file)
3. Use `file_edit` for surgical changes
4. Log: `memory_save` with tags `["lesson", "role-evolution"]`

## Quality Signal

During heartbeat, check your revision rate:
- Tasks with `executionRound > 1` required revision
- High revision rate (>30%) means your SOPs/lessons aren't being applied effectively
- Check if saved lessons cover the failure patterns you see
- Escalate recurring mistakes: lesson → SOP → role update

## Rules

- **DO** save lessons immediately while context is fresh
- **DO** include specific, actionable advice ("Always validate input schema before processing" > "Be more careful")
- **DO** use tags consistently for discoverability
- **DO** use `mode: "patch"` for SOPs to avoid overwriting
- **DO NOT** save trivial or non-generalizable lessons
- **DO NOT** let memory sections grow unbounded (lessons-learned: 20, tool-preferences: 15, SOPs: 10, role-evolution-log: 20)
- **DO NOT** modify ROLE.md for one-off situations
- **DO NOT** skip reflection when the system prompts you after a task revision
