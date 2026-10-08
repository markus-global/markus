# Agent Platform Friction — field notes from a working agent (2026-10)

Written by an agent that runs on Markus and used its own delegation, background-exec and test
tooling for a multi-hour real task. Every item below is something that cost real time and that a
future refactor of the agent platform should consider. Each is stated as **observed behaviour →
why it is a problem → suggested change**, with the evidence that produced it.

This is a *dated record* (see `docs/records/`). It is not a specification.

---

## 1. Platform issues (Markus itself)

### F1 — `spawn_subagents` iteration budgets are shared, not per-child, and the sharing is invisible

**Observed.** Dispatching 6 children, each with `max_iterations: 30/70/80/…`, returned
`"aggregateIterationBudget": 100` and killed **all six** mid-work (they had used 11–22 iterations
each, summing to 100). Re-dispatching 3 children with a per-child `iteration_budget: 30` stopped the
aggregate ceiling from firing at all.

**Why it is a problem.** `max_iterations` reads like "how much this child may do". It is not. A
caller who fans out N children and sizes `max_iterations` per child gets a shared pool of ~100 —
so *adding a child silently starves the others*, and the failure appears in a different child than
the one that caused it. This is the same class of defect the platform elsewhere calls out for
memory: one concept, two meanings.

**Suggested change.** Either make `max_iterations` genuinely per-child, or reject it at the tool
boundary with "use `iteration_budget` for per-child limits". Whatever is chosen, the aggregate
ceiling must be documented in the tool description, and the response should state which budget was
hit (`own` vs `aggregate`) — today it only reports `aggregateCeilingReached` on some children.

### F2 — A budget-exhausted child leaves silent partial writes

**Observed.** A child stopped at its budget returned exactly
`"[INCOMPLETE: subagent stopped early — own iteration budget (30) exhausted …]"`. It said nothing
about what it had already written. I had to run `git status` by hand to discover whether the
workspace had been modified.

**Why it is a problem.** With a fan-out of N children editing a shared repo, "budget exhausted" is
indistinguishable from "budget exhausted *after* half-applying an edit". On a larger fan-out this is
a correctness hazard: the parent cannot tell a clean no-op from a half-finished mutation, and the
children cannot know about each other.

**Suggested change.** Include a structured `filesTouched` / diff-stat in the child result, and make
the default behaviour for a child that ends `budget_exhausted` *without* a completion report either
(a) revert its writes, or (b) explicitly mark them as unverified in the parent's context.

### F3 — No signal that a task is too large for one child

**Observed.** Two attempts to audit a ~900-line document each burned the full budget (30 then 35
iterations) and returned **zero** edits — the child kept exploring. A third, tightly scoped attempt
on the same file kind finished in 24 iterations.

**Why it is a problem.** The failure mode is silent: the parent pays full cost and learns nothing.
There is no feedback that says "this child spent 90 % of its budget on reads".

**Suggested change.** Return an iteration breakdown (reads vs writes) in the result, and surface a
hint when a child exhausts its budget without a single write.

### F4 — Delegation results have no schema

The free-text `result` is fine for a summary, but the parent needs machine-checkable fields
(what changed, what was verified, what was left). Right now the only reliable audit path is to
ignore the report and diff the workspace — which works, but means the report is decoration.

---

## 2. Repo tooling papercuts (not platform bugs, but they cost the same time)

- **`npx vitest run` at the package level lies.** Run from `packages/web-ui` without a project it
  reports ~42 failures (`document is not defined`) because jsdom is not enabled. The failures are
  artefacts, not regressions — and they are convincing enough to send you chasing a phantom. Correct
  entry points are `pnpm test:web-ui` / `pnpm test:node`, or `--project web-ui`.
- **`pnpm pack` is shadowed by pnpm's own `pack`.** Running it in `packages/desktop` does not run
  the package's `pack` script; it silently produces a ~140 MB tarball of the workspace instead. Use
  `pnpm --filter @markus/desktop run pack`.
- **`pnpm --filter <dir>` does not work by directory.** The CLI package lives at `packages/cli` but
  is named `@markus-global/cli`; filtering by the path matches nothing and the error ("No projects
  matched the filters") does not suggest the package name.
- **Gitignored builds shadow their sources.** `packages/cli/templates/` and `packages/desktop/dist/`
  hold stale copies of files that actually live in the repo root (`templates/`,
  `packages/web-ui/dist`). Grepping the repo finds the stale copy first. Symptom seen: a shipped
  `HANDBOOK.md` with links pointing at paths that no longer existed.
- **`docs/api/` was gitignored while holding a hand-written file.** The ignore rule was added for a
  typedoc generator that no longer exists anywhere in the repo, so the directory that holds the
  API reference was silently ignoring any new file added to it.

---

## 3. What I would fix first

1. **F1**, because it is a correctness trap that looks like a sizing parameter.
2. **F2**, because it is the difference between "safe to fan out" and "must diff after every
   dispatch".
3. Then the repo tooling items — they are cheap and each one has already burned time twice.
