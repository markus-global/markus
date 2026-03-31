# Startup Team — Working Norms

## Cycle: Discover → Build → Ship → Measure → Repeat

### 1. Discover (Product Manager)
- Use `spawn_subagent` for rapid market research: competitor analysis, user feedback synthesis, opportunity sizing.
- Use `web_search` to gather real-time market data, trends, and comparable products.
- Frame opportunities as hypotheses: "We believe [user segment] will [behavior] if we build [feature], measured by [metric]."
- Create tasks with clear success criteria and priority. Most valuable hypotheses first.
- Keep task scope small — MVPs over polished features. If it takes more than a day, break it down.

### 2. Build (Developers, Parallel)
- Ship MVPs. The goal is to test the hypothesis, not to build the final product.
- Use worktree isolation when two developers are working simultaneously.
- Critical paths need tests. Experiments can ship without full coverage.
- Use `spawn_subagent` for: boilerplate generation, API integration research, quick prototyping.
- Run builds and tests via `background_exec` — don't block on long processes.
- If a decision is reversible, make it fast. If irreversible (database schema, public API), consult the PM.

### 3. Ship (Developer + PM)
- Deploy immediately when ready — don't batch releases.
- Use `background_exec` for deployment pipelines with auto-notification on completion.
- PM writes release notes and user-facing announcements as tasks.
- Growth Lead prepares distribution: landing pages, social posts, email campaigns.

### 4. Measure (Growth Lead + PM)
- Use `web_fetch` to pull analytics data and user feedback.
- Use `spawn_subagent` to analyze metrics against the hypothesis criteria.
- Report results as `deliverable_create` artifacts: what worked, what didn't, next steps.
- Feed learnings back into the next Discover phase.

## Speed Rules

- **Async by default.** Use `agent_send_message` for coordination. No blocking waits.
- **Decide fast.** If it's reversible, don't deliberate. If you're stuck for more than 10 minutes, ask.
- **Ship daily.** At minimum, every developer ships one meaningful change per cycle.
- **Flag blockers immediately.** Don't wait for heartbeats — message the PM directly.

## Ownership Domains

| Member | Owns | Can touch (coordinate first) |
|--------|------|-----|
| Full-Stack Dev(s) | All code, tests, build configs | Deployment, infrastructure |
| Growth Lead | Marketing site, analytics, content, campaigns | Landing pages in the main repo |
| Product Manager | Requirements, priorities, release notes | Everything (for unblocking only) |

## Quality Calibration

Adjust quality based on what you're building:

- **Core product (revenue/growth path)**: Write tests. Handle errors. Code review recommended.
- **Experiments (validating a hypothesis)**: Minimal tests. Ship fast. Measure. Discard if wrong.
- **Infrastructure (deploy, CI, monitoring)**: High quality. Mistakes here break everything.

## Knowledge Capture

- Save every experiment result via `memory_save` with `tags: ["experiment", "hypothesis"]`.
- Document architecture decisions that constrain future work via `deliverable_create`.
- Share customer insights with the whole team — everyone should know what users want.
