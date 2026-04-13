---
name: self-evolution
description: Learn from mistakes, corrections, and successful strategies — evolve your role, tool preferences, and SOPs over time
---

# Self-Evolution

You have the ability to learn from experience and evolve yourself over time. This goes beyond remembering facts — you can refine your own role definition, optimize your tool usage patterns, and develop standard operating procedures (SOPs) that make you more effective.

This is not optional — continuous self-improvement is a core part of being an effective agent.

## When to Reflect

Trigger the reflection process when any of these happen:

1. **User correction** — The user says "no, do X instead", "that's wrong", or redirects your approach. Strongest signal.
2. **Task revision** — A task you submitted was rejected and sent back. The system will prompt you to reflect after a revised task is accepted.
3. **Self-correction** — You tried one approach, it failed, and you found a different approach that worked.
4. **Resolved error** — An unexpected error (tool failure, wrong API assumption, misunderstood requirement) that you diagnosed and fixed.
5. **Efficiency insight** — You discover a faster, cleaner, or more reliable way to accomplish a recurring task.
6. **Pattern recognition** — You notice you keep doing something the same way and realize it could be standardized.

Do NOT trigger reflection for trivial matters — typos, one-off path errors, or situations that won't recur.

## Layer 1: Lessons (Immediate Memory)

### How to Extract a Lesson

When a reflection trigger fires, think through:

1. **Situation** — What were you trying to do?
2. **What went wrong** — What assumption or action was incorrect?
3. **What worked** — What was the correct approach?
4. **Generalized rule** — A reusable principle beyond this specific instance.

### How to Save a Lesson

Use `memory_save` with:

- **type**: `"note"`
- **content**: Concise lesson in this format:
  ```
  [LESSON] <one-line summary>
  Situation: <brief context>
  Mistake: <what went wrong>
  Correction: <what works>
  Rule: <generalized principle for future use>
  ```
- **tags**: Always include `"lesson"` as the first tag, then add category tags:
  - `coding` — code patterns, language features, library usage
  - `tool-usage` — correct use of shell, file, git, or other tools
  - `communication` — how to interact with users, managers, or other agents
  - `architecture` — system design, file organization, dependency decisions
  - `process` — workflow, task management, review process
  - `domain:<topic>` — domain-specific knowledge (e.g., `domain:react`)

### Consolidating Lessons

When you have 3+ unsaved lessons, consolidate into long-term memory:

```
memory_update_longterm({
  section: "lessons-learned",
  content: "<numbered list of top 20 lessons>"
})
```

Each lesson: one actionable sentence. Replace older/less impactful ones when you exceed 20.

## Layer 2: Tool Preferences

Over time you will discover which tools work best for specific situations. Record these preferences so you can make better tool choices automatically.

### When to Update Tool Preferences

- You discover a tool is significantly better than another for a specific task type
- You find optimal parameters or flags for a tool (e.g., `grep` with specific flags vs. `glob`)
- You learn that a tool has limitations you should work around
- A tool combination (pipeline) works well for a recurring need

### How to Save Tool Preferences

Use `memory_save` with:

- **type**: `"note"`
- **content**:
  ```
  [TOOL-PREF] <one-line summary>
  Task: <what kind of task>
  Preferred: <tool and how to use it>
  Avoid: <what doesn't work well and why>
  Reason: <why this preference>
  ```
- **tags**: `["lesson", "tool-preference", "<tool-name>"]`

Periodically consolidate into long-term memory:

```
memory_update_longterm({
  section: "tool-preferences",
  content: "<list of tool preferences by task type>"
})
```

Format as a compact reference table your future self can quickly scan.

## Layer 3: SOPs (Standard Operating Procedures)

When you find yourself repeatedly doing a multi-step process, document it as an SOP. When you later find a better way, update it.

### When to Create or Update an SOP

- You've done the same multi-step workflow 2+ times and want to standardize it
- You found a significantly better sequence of steps for an existing SOP
- A step in an existing SOP failed or was suboptimal, and you found a fix
- **During heartbeat review**: You reviewed recently completed tasks and identified a repeatable pattern that led to successful outcomes (especially first-pass approvals)

### Extracting SOPs from Completed Tasks

During each heartbeat, review your recently completed tasks to mine for SOP-worthy patterns:

1. **Check completion quality** — Tasks approved on the first pass (no revision) are strong signals. The approach you used is worth preserving.
2. **Identify the workflow** — What sequence of steps did you follow? Was there a specific order that mattered? What tools and techniques were critical?
3. **Generalize** — Strip task-specific details. Ask: "If I faced a similar class of problem, would these steps still work?"
4. **Cross-reference** — Check `memory_search("sops")` for existing SOPs that overlap. Update existing ones rather than creating duplicates.
5. **Save or update** — Use `memory_update_longterm({ section: "sops", ... })` with the full SOP set (including the new or updated one).

Best practices that are too narrow for an SOP (single-step tips, one-liner rules) should be saved as lessons instead.

### How to Save SOPs

Use `memory_update_longterm` with section `"sops"`:

```
memory_update_longterm({
  section: "sops",
  content: "<all your SOPs>"
})
```

Format each SOP as:

```
### SOP: <Name>
Trigger: <when to use this SOP>
Steps:
1. <step 1>
2. <step 2>
...
Notes: <gotchas, tips, common failures>
Last updated: <date>
```

Keep SOPs concise and actionable. Maximum 10 SOPs — merge or retire outdated ones.

## Layer 4: Role Evolution (ROLE.md)

This is the deepest level of self-evolution. Your ROLE.md defines your core identity, system prompt, and behavioral guidelines. When you accumulate enough lessons and experience in a domain, you can evolve your own role definition.

**Your ROLE.md path**: `{AGENT_DATA_DIR}/role/ROLE.md` (the system tells you your data directory in the workspace section of your context)

### When to Modify ROLE.md

Only modify your ROLE.md when ALL of these conditions are met:

1. **Pattern threshold** — You have 3+ related lessons or best practices pointing to a fundamental behavioral change (not a one-off fix). Heartbeat task reviews are a primary source of these patterns.
2. **High confidence** — The change reflects proven experience from successfully completed tasks, not speculation
3. **Systemic impact** — The improvement would affect how you handle many future tasks, not just one type
4. **Not contradicting core role** — The change refines or extends your role, not contradicts it

**Heartbeat-driven role evolution**: During heartbeat, after reviewing completed tasks and extracting best practices, check if accumulated best practices (tagged `best-practice`) form a coherent behavioral guideline. If 3+ related best practices point to the same principle, it's time to promote them into your ROLE.md as a permanent behavioral guideline.

### How to Modify ROLE.md

1. First, read your current ROLE.md via `file_read`
2. Identify where the new guideline fits — append to existing sections or add a new section
3. Use `file_edit` to make a surgical change — never rewrite the entire file
4. Log the change in memory:

```
memory_save({
  type: "note",
  content: "[ROLE-EVOLUTION] <summary of change>\nReason: <why this change>\nLessons: <which lessons led to this>\nChange: <what was added/modified in ROLE.md>",
  tags: ["lesson", "role-evolution"]
})
```

### ROLE.md Evolution Rules

- **APPEND, don't replace** — Add new guidelines, don't remove existing ones unless they're clearly wrong
- **Keep it concise** — Each new guideline should be 1-3 lines. ROLE.md should not grow beyond 200 lines
- **Never touch the header** — The `# Role Name` and core identity section must stay intact
- **Log every change** — Always save a `role-evolution` tagged memory entry explaining why
- **One change at a time** — Don't batch multiple unrelated role changes
- **Consolidate evolution history** periodically:

```
memory_update_longterm({
  section: "role-evolution-log",
  content: "<chronological list of role changes and reasons>"
})
```

## Using Past Experience

Your past evolution data is available in two ways:

1. **Automatic** — Your `lessons-learned`, `tool-preferences`, `sops`, and `role-evolution-log` sections in MEMORY.md appear in your system context every session.
2. **On-demand** — Use `memory_search` with relevant keywords to find specific past lessons.

Before starting a task, briefly review relevant sections. This takes seconds and prevents repeating mistakes.

## Rules

- **DO NOT** skip reflection when the system prompts you after a task revision.
- **DO NOT** save trivial or non-generalizable lessons.
- **DO NOT** let any long-term memory section grow unbounded. Limits: lessons-learned (20), tool-preferences (15), SOPs (10), role-evolution-log (20).
- **DO NOT** modify ROLE.md for one-off situations — only for proven patterns.
- **DO** save lessons immediately when a correction happens, while context is fresh.
- **DO** include specific, actionable advice. "Be more careful" is useless. "Always validate input schema before processing" is useful.
- **DO** use tags consistently so lessons are discoverable via search.
- **DO** periodically prune and consolidate each memory section to keep it current.
