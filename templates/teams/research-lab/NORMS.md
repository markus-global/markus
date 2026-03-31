# Research Lab — Working Norms

## Methodology: Frame → Investigate → Challenge → Synthesize

### Phase 1: Frame (Research Lead)
- Define the research question precisely. Vague questions produce vague answers.
- Identify **competing hypotheses** or **angles of investigation** — assign each researcher a different one.
- Set evaluation criteria upfront: What evidence would confirm or disprove each hypothesis?
- Create tasks with clear scope: "Investigate hypothesis X by examining Y, looking for evidence of Z."

### Phase 2: Investigate (Researchers, Parallel)
- Each researcher independently explores their assigned angle.
- Use `spawn_subagent` for deep dives into specific files, logs, or codebases without losing your investigation context.
- Use `web_search` and `web_fetch` for external research — documentation, StackOverflow, academic papers, vendor comparisons.
- Record all findings as `deliverable_create` artifacts with evidence:
  - Code snippets, log excerpts, benchmark data, documentation references
  - Confidence level (high/medium/low) with reasoning
  - Explicitly note what you did NOT find (negative evidence matters)
- **Do not anchor on your first finding.** Actively look for disconfirming evidence.

### Phase 3: Challenge (All Researchers)
- After initial investigation, researchers **review each other's findings** via `agent_send_message`.
- The goal is adversarial: each researcher tries to find weaknesses in others' conclusions.
- Ask: "What would have to be true for this finding to be wrong?"
- Update your deliverables based on challenges received. Strengthen or retract claims.
- This phase prevents anchoring bias — the finding that survives cross-examination is more likely correct.

### Phase 4: Synthesize (Research Lead)
- Collect all deliverables and cross-examination results.
- Use `spawn_subagent` to systematically compare findings across researchers.
- Produce a synthesis deliverable that:
  - States the conclusion with confidence level
  - Summarizes supporting and contradicting evidence
  - Identifies remaining unknowns and recommended next steps
  - Credits individual researcher contributions
- If no consensus emerges, the synthesis should say so honestly and recommend further investigation.

## Investigation Protocols

### Debugging / Root Cause Analysis
- Assign researchers to different hypotheses: "It's a race condition" vs "It's a data corruption" vs "It's a configuration issue."
- Each investigator must produce **reproduction steps** or explain why reproduction is not possible.
- Share raw evidence (stack traces, logs, diffs) in task notes so others can verify.

### Technology Evaluation
- Assign each researcher a different technology to evaluate against the same criteria.
- Criteria must be defined in the framing phase: performance, ecosystem, learning curve, cost, security.
- Each researcher writes a balanced assessment — strengths AND weaknesses.
- The lead produces a comparison matrix from individual assessments.

### Security Audit
- Divide the codebase by attack surface: authentication, authorization, input handling, data storage, network.
- Each researcher focuses on one surface using the OWASP framework.
- Findings must include severity, exploitability, and recommended remediation.
- Cross-challenge phase: can one researcher exploit a path that another declared safe?

### Codebase Exploration
- Divide by module or architectural layer.
- Each researcher maps their area: key abstractions, data flow, dependencies, known issues.
- Deliverables should include architectural diagrams (text-based) and dependency maps.

## Communication
- **Share early, share raw**: Post intermediate findings to task notes. Don't wait for polished conclusions.
- **Cite your sources**: Every claim links to a file, URL, log line, or benchmark.
- **Disagree constructively**: "I found evidence that contradicts X because..." not "X is wrong."
- **Track confidence**: Use explicit confidence levels (High/Medium/Low) and update as evidence changes.

## Quality Standards
- A finding without evidence is an opinion, not research. Evidence is required.
- Negative results are valuable — "I investigated X and found no evidence of Y" is a useful finding.
- The synthesis must honestly represent the state of knowledge, including uncertainty.
