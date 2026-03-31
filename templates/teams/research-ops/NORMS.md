# Research & Analysis Ops — Working Norms

## Purpose

This team runs structured research, analysis, and investigation using Markus capabilities: `spawn_subagent` for parallel tracks, `blockedBy` for phased work, `memory_save` / `memory_search` for knowledge, `deliverable_create` / `deliverable_search` for outputs, `web_search` / `web_fetch` / `web_extract` for online evidence, and A2A messages for coordination.

---

## Four-phase workflow

Work proceeds in order. Use task dependencies (`blockedBy`) so later phases do not start until prerequisites are satisfied.

### 1. Scope (Research Lead)

- Define the research questions, boundaries, and **success criteria** (what “done” means).
- Assign angles or workstreams so Analysts are not duplicating the same narrow thread without intent.
- Break scope into tasks with explicit dependencies: investigation tasks must not start until scope tasks are complete.

### 2. Investigate (Research Analysts)

- Work **in parallel** on different angles, sources, or methods as assigned by the Lead.
- Use `spawn_subagent` for deep dives (long traces, tool-heavy sub-investigations, or isolated hypotheses) so the main analyst can merge results without losing focus.
- Before comparing notes with peers, follow the **competing hypotheses protocol** (below) when the problem is ambiguous.

### 3. Challenge (Research Analysts, coordinated via A2A)

- Share findings through **A2A messages** with enough context for others to verify (links, memory keys, deliverable IDs).
- Actively seek **contradictions, gaps, and alternative explanations**. Prefer specific questions (“What would falsify this?”) over consensus for its own sake.
- Escalate unresolved conflicts to the Research Lead with a short summary of positions and evidence.

### 4. Synthesize (Tech Writer / Synthesizer)

- Combine vetted findings into **structured deliverables** (`deliverable_create`) that match the quality bar below.
- Pull from memory and prior deliverables via `deliverable_search` / `memory_search`; do not restate uncited claims.
- Final synthesis tasks should depend on completion of the Challenge phase (e.g. via `blockedBy`).

---

## Competing hypotheses protocol

For **ambiguous** investigations (unclear root cause, conflicting public sources, or multiple plausible explanations):

1. **Independently**, each Research Analyst forms their own **primary hypothesis** and at least one **alternative** before heavy collaboration.
2. Each analyst **tests** their hypothesis using evidence gathering (including `web_fetch` where applicable) without anchoring on another analyst’s conclusion first.
3. Record hypotheses and status in **`memory_save`**, using tags that include `hypothesis` plus topic tags (e.g. `hypothesis`, `vendor-x`, `incident-2024`).
4. Only after individual testing do analysts **compare notes** in Challenge phase and reconcile or escalate.

This mirrors parallel investigation with competing lines of inquiry until evidence converges.

---

## Evidence standards

- **Every non-trivial claim** must cite **specific sources** (URL + title or identifier, repository path, internal doc, or memory/deliverable reference).
- Prefer **`web_fetch`** to verify quotes, numbers, dates, and claims from search snippets; do not rely on search summaries alone for high-stakes conclusions.
- Assign a **confidence level** to major conclusions (e.g. high / medium / low) and state **what would change** that rating (missing data, single-source dependency, etc.).
- Distinguish **facts** (directly supported by sources) from **inference** (reasonable interpretation) from **speculation** (unsupported).

---

## Knowledge accumulation

- Run **`memory_search`** at the start of a new investigation thread to avoid redoing work and to align with existing team knowledge.
- **`memory_save`** all durable insights: methods tried, dead ends, key citations, resolved disagreements, and final takeaways.
- Use **consistent tagging** (topic, project, phase, `hypothesis` when applicable) so others can retrieve context quickly.

---

## Deliverable quality

Structured reports created via **`deliverable_create`** should include:

1. **Executive summary** — decision-oriented; key conclusions and confidence.
2. **Methodology** — scope, sources consulted, tools used (e.g. subagents, web passes), limitations.
3. **Findings** — organized by theme or question; each section tied to cited evidence.
4. **Recommendations** — actionable next steps, explicit assumptions, and open questions.

The Tech Writer owns formatting and narrative coherence; Analysts supply traceable evidence and structured inputs.

---

## Coordination

- Use **A2A** for synchronous coordination, handoffs, and challenge-phase discussion.
- Use **tasks** for assignable work; chain phases with **`blockedBy`** where the product supports it.
- Keep the Research Lead informed of blockers, scope creep, and material changes to confidence levels.
