# Research Lab — Working Norms

## Methodology: Frame → Investigate → Challenge → Synthesize

### Phase 1: Frame (Research Lead)
- Define the research question precisely. Vague questions produce vague answers.
- Set **success criteria** upfront: what "done" looks like, what evidence would confirm or disprove each hypothesis.
- Identify **competing hypotheses** or **angles of investigation** — assign each researcher a different one.
- Create tasks with clear scope: "Investigate hypothesis X by examining Y, looking for evidence of Z."
- Set dependencies via `blockedBy` so later phases do not start until prerequisites are satisfied.

### Phase 2: Investigate (Researchers, Parallel)
- Each researcher independently explores their assigned angle.
- Use `spawn_subagent` for deep dives into specific files, logs, or codebases without losing your investigation context.
- Use `web_search` and `web_fetch` for external research — documentation, papers, vendor comparisons. Prefer `web_fetch` to verify quotes and numbers; do not rely on search snippets alone for high-stakes conclusions.
- Record all findings as `deliverable_create` artifacts with evidence:
  - Code snippets, log excerpts, benchmark data, documentation references
  - Confidence level (High/Medium/Low) with reasoning
  - Explicitly note what you did NOT find (negative evidence matters)
- **Do not anchor on your first finding.** Actively look for disconfirming evidence.
- Run `memory_search` at the start of each investigation thread to avoid redoing prior work.

### Phase 3: Challenge (All Researchers)
- After initial investigation, researchers **review each other's findings** via `agent_send_message`.
- The goal is adversarial: each researcher tries to find weaknesses in others' conclusions.
- Ask: "What would have to be true for this finding to be wrong?"
- Prefer specific questions over rubber-stamp agreement. Escalate unresolved conflicts to the Lead with a summary of positions and evidence.
- Update your deliverables based on challenges received. Strengthen or retract claims.

### Phase 4: Synthesize (Synthesizer + Research Lead)
- Synthesizer collects all deliverables and cross-examination results.
- Use `spawn_subagent` to systematically compare findings across researchers.
- Produce a synthesis deliverable (`deliverable_create`) that includes:
  1. **Executive summary** — decision-oriented: key conclusions and confidence level.
  2. **Methodology** — scope, sources consulted, tools used, limitations.
  3. **Findings** — organized by theme or question, each tied to cited evidence.
  4. **Recommendations** — actionable next steps, explicit assumptions, open questions.
- If no consensus emerges, the synthesis should say so honestly and recommend further investigation.
- Research Lead reviews and approves the final synthesis.

## Competing Hypotheses Protocol

For ambiguous investigations (unclear root cause, conflicting sources, multiple plausible explanations):

1. Each researcher **independently** forms a primary hypothesis and at least one alternative before heavy collaboration.
2. Each analyst tests their hypothesis using evidence gathering without anchoring on another's conclusion first.
3. Record hypotheses in `memory_save` with tags including `hypothesis` plus topic tags.
4. Only after individual testing do researchers compare notes in the Challenge phase.

## Investigation Playbooks

### Debugging / Root Cause Analysis
- Assign researchers to different hypotheses: "race condition" vs "data corruption" vs "configuration issue."
- Each investigator must produce **reproduction steps** or explain why reproduction is not possible.
- Share raw evidence (stack traces, logs, diffs) in task notes so others can verify.

### Technology Evaluation
- Assign each researcher a different technology to evaluate against the same criteria.
- Criteria must be defined in the framing phase: performance, ecosystem, learning curve, cost, security.
- Each researcher writes a balanced assessment — strengths AND weaknesses.
- The Synthesizer produces a comparison matrix from individual assessments.

### Security Audit
- Divide the codebase by attack surface: authentication, authorization, input handling, data storage, network.
- Each researcher focuses on one surface using the OWASP framework.
- Findings must include severity, exploitability, and recommended remediation.
- Cross-challenge phase: can one researcher exploit a path that another declared safe?

## Evidence Standards

- **Every non-trivial claim** must cite specific sources (URL, file path, log line, or deliverable reference).
- Assign a **confidence level** to major conclusions and state what would change that rating.
- Distinguish **facts** (directly supported) from **inference** (reasonable interpretation) from **speculation** (unsupported).
- A finding without evidence is an opinion, not research.
- Negative results are valuable — "I investigated X and found no evidence of Y" is a useful finding.

## Knowledge Accumulation

- Run `memory_search` at the start of new investigation threads to avoid redoing work.
- `memory_save` all durable insights: methods tried, dead ends, key citations, resolved disagreements, takeaways.
- Use consistent tagging (topic, project, phase, `hypothesis` when applicable) for fast retrieval.

## Communication

- **Share early, share raw**: Post intermediate findings to task notes. Don't wait for polished conclusions.
- **Cite your sources**: Every claim links to a file, URL, log line, or benchmark.
- **Disagree constructively**: "I found evidence that contradicts X because..." not "X is wrong."
- **Track confidence**: Use explicit levels (High/Medium/Low) and update as evidence changes.
