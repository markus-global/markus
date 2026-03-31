# Content Team — Working Norms

## Pipeline: Research → Brief → Draft → Edit → Publish

### 1. Research (Research Analyst)
- Use `web_search` and `web_fetch` to gather source material, competitor analysis, and data.
- Use `spawn_subagent` for parallel research tracks: market data, user insights, technical accuracy.
- Publish research briefs as `deliverable_create` artifacts with citations and key findings.
- Every factual claim must trace to a source. Unsupported claims are flagged in review.

### 2. Brief (Editor-in-Chief)
- Create a content brief for each piece: audience, goal, key messages, tone, word count, references.
- Assign briefs to writers based on expertise — technical docs to Technical Writer, marketing copy to Senior Writer.
- Set dependencies: writing tasks should `blockedBy` the corresponding research task.
- Define the content calendar as a task dependency graph when running campaigns.

### 3. Draft (Writers, Parallel)
- Each writer works on their assigned pieces independently.
- Reference research deliverables — don't re-research what the analyst already covered.
- Use `spawn_subagent` for fact-checking individual claims during drafting.
- Submit drafts via `task_submit_review` with a summary: audience, key messages, word count, and any deviations from the brief.
- Include all content as `deliverable_create` artifacts so the editor can review inline.

### 4. Edit (Editor-in-Chief)
- Review for: accuracy, clarity, tone consistency, audience fit, brief compliance.
- Use `spawn_subagent` to cross-reference claims against research deliverables.
- Leave structured feedback via `task_note`: categorize as "must fix", "suggestion", or "approved".
- For major rewrites, create a new task rather than overloading revision notes.
- Approved pieces move to publish. Rejected pieces return to the writer with specific feedback.

### 5. Publish (Editor-in-Chief coordinates)
- Final proofread pass.
- Generate metadata: title, description, tags, categories.
- Publish via the appropriate channel (docs site, blog, CMS).

## Quality Standards

- **No unsupported claims.** Every factual statement needs a traceable source in the research deliverable.
- **Audience-first.** Write for the reader, not yourself. Technical docs explain; marketing copy persuades.
- **Consistency.** Use the established style guide for terminology, formatting, and tone.
- **Conciseness.** Every sentence must carry information. Cut filler ruthlessly.

## Communication

- Share drafts early for directional feedback — don't wait until "perfect."
- Research Analyst: proactively share interesting findings with writers via `agent_send_message`.
- Writers: flag brief ambiguities immediately. Don't guess at the editor's intent.
- Use `deliverable_create` for all artifacts — research briefs, drafts, final pieces. This creates an audit trail.
