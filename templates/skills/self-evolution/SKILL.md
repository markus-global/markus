---
name: self-evolution
description: Learn from mistakes, corrections, and successful strategies — extract lessons and persist them as structured memories for future retrieval
---

# Self-Evolution

You have the ability to learn from experience. When you make a mistake and get corrected, discover a better approach through trial and error, or resolve an unexpected problem, you should extract the lesson and save it so you never repeat the same mistake.

This is not optional — learning from experience is a core part of being an effective agent.

## When to Reflect

Trigger the lesson extraction process when any of these happen:

1. **User correction** — The user says something like "no, do X instead", "that's wrong", or redirects your approach. This is the strongest signal.
2. **Task revision** — A task you submitted was rejected and sent back for revision. The system will prompt you to reflect after a revised task is accepted. Do not skip this.
3. **Self-correction** — You tried one approach, it failed, and you found a different approach that worked. The contrast between failure and success is the lesson.
4. **Resolved error** — You encountered an unexpected error (tool failure, wrong assumption about an API, misunderstood requirement) and figured out the root cause.

Do NOT trigger reflection for trivial matters — typos, wrong file paths due to incomplete info, or one-off situations that won't recur.

## How to Extract a Lesson

When a reflection trigger occurs, think through these dimensions before saving:

1. **Situation** — What were you trying to do? What was the context?
2. **What went wrong** — What assumption, approach, or action was incorrect?
3. **What worked** — What was the correct approach? Why does it work?
4. **Generalized rule** — Distill a reusable principle that applies beyond this specific instance. This is the most important part — it should be actionable advice your future self can apply.

## How to Save a Lesson

Use `memory_save` with the following structure:

- **type**: `"note"`
- **content**: A concise lesson in this format:
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
  - `domain:<topic>` — domain-specific knowledge (e.g., `domain:react`, `domain:database`)

### Example

```
memory_save({
  content: "[LESSON] Always check git status before committing\nSituation: Modifying multiple files in a project task\nMistake: Ran git commit without checking which files were staged, accidentally committed unrelated changes\nCorrection: Always run git status/git diff first, then selectively stage files\nRule: Before any git commit, verify the staging area matches your intent. Never blindly commit all changes.",
  type: "note",
  tags: ["lesson", "tool-usage", "coding"]
})
```

## Consolidating Lessons into Long-Term Memory

When you have accumulated several lessons (3 or more since last consolidation), consolidate them into your long-term memory using `memory_update_longterm`. This makes your most important lessons visible in every future conversation.

Call:
```
memory_update_longterm({
  section: "lessons-learned",
  content: "<curated list of your top lessons>"
})
```

Format the content as a numbered list of your most valuable, generalizable lessons. Keep it to **20 lessons maximum** — if you need to add more, replace older or less impactful ones. Each lesson should be a single actionable sentence or short paragraph.

### Example consolidated content

```
1. Always run git status before committing to verify the staging area matches intent.
2. When a shell command fails with a permission error, check if the file is read-only or owned by another user before retrying with sudo.
3. When the user asks for "a simple solution", they mean minimal dependencies and straightforward logic — avoid over-engineering.
4. For TypeScript projects, check tsconfig.json paths and module resolution before assuming import errors are code bugs.
5. When creating tasks for other agents, include explicit acceptance criteria — vague descriptions lead to revision cycles.
```

## Using Past Lessons

Your past lessons are available to you in two ways:

1. **Automatic** — Your consolidated lessons in the `lessons-learned` section of MEMORY.md appear in your system context. Review them at the start of important tasks.
2. **On-demand** — Use `memory_search` with relevant keywords to find specific past lessons before tackling a task in a domain where you've previously made mistakes.

When starting a task that touches a domain where you have past lessons, briefly review them. This takes seconds and can save significant rework.

## Rules

- **DO NOT** skip reflection when the system prompts you to reflect after a task revision. This is the highest-value learning opportunity.
- **DO NOT** save trivial or non-generalizable lessons. "The file was at /tmp/foo.txt not /tmp/bar.txt" is not a lesson.
- **DO NOT** let the lessons-learned section grow beyond 20 entries. Quality over quantity — keep only the lessons that would change your behavior.
- **DO** save lessons immediately when a correction happens, while the context is fresh. Don't defer.
- **DO** include specific, actionable advice in the "Rule" field. "Be more careful" is useless. "Always validate input schema before processing" is useful.
- **DO** use domain tags so lessons are discoverable via search.
- **DO** periodically review and prune your lessons-learned section during daily consolidation to keep it current and relevant.
