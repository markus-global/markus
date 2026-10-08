# Agent Platform Friction — field notes from a working agent (2026-10)

> **Status: audited 2026-10-08.** Before acting on this record it was re-read against `main` (the
> v0.11.3 era). Two items were already resolved and the record did not say so: the *core* of F1/F2
> had shipped with H6 (`f7cdbd7d`), and T5 (`docs/api/` ignore) was already fixed. The remaining
> gaps were actioned in the PR that closes [#366](https://github.com/markus-global/markus/issues/366).
> Per-item verdicts are in the audit below; the original bodies are kept verbatim as the dated
> evidence they are, each now carrying a **Resolution** line.

Written by an agent that runs on Markus and used its own delegation, background-exec and test
tooling for a multi-hour real task. Every item below is something that cost real time and that a
future refactor of the agent platform should consider. Each is stated as **observed behaviour →
why it is a problem → suggested change**, with the evidence that produced it.

This is a *dated record* (see `docs/records/`). It is not a specification.

---

## 0. Audit (2026-10-08) — already fixed vs. still owed

| Item | Verdict on `main` before this pass | Resolution |
|------|------------------------------------|------------|
| **F1** | **Partly fixed by H6** (`f7cdbd7d`): `iteration_budget` is now an independent per-child budget, and the fan-out pool is a breaker only. Still missing: the breaker was undocumented, and a stopped child reported only a boolean. | Breaker documented in the `spawn_subagents` description; `budgetHit` added. |
| **F2** | **Partly fixed by H6**: `output` is never empty and carries an `[INCOMPLETE …]` note. Still missing: no structured record of *what* was written. | `filesTouched` added and echoed in the note. |
| **F3** | **Open.** | `toolCalls { total, writes }` added; a zero-write early stop now says so. |
| **F4** | **Partly fixed by H6** (`status` / `iterations` / `aggregateCeilingReached`). | Extended with the fields above; the schema now crosses the `spawn_subagent` / `spawn_subagents` boundary. |
| **T1** | Still true. | Documented in `CONTRIBUTING.md` → *Development Gotchas*. |
| **T2** | Still true (pnpm builtin). | Documented. |
| **T3** | Still true (pnpm semantics). | Documented. |
| **T4** | Still true. | Documented (points at `scripts/sync-dir.mjs`). |
| **T5** | **Already fixed** before this audit. | No change; record corrected. |

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

**Resolution (2026-10-08).** H6 had already made the budget genuinely per-child and turned the
shared pool into a breaker. This pass documented the breaker in the tool description and added
`budgetHit: 'own' | 'aggregate' | 'max_iterations' | null`, so a parent learns *which* budget
stopped a child and not merely that one did.

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

**Resolution (2026-10-08).** Added `filesTouched: string[]` — the distinct paths a child actually
changed via `file_write` / `file_edit` / `apply_patch` (errored calls and `apply_patch` dry runs are
excluded) — and echoed it inside the `[INCOMPLETE …]` note. Option (b) was chosen over (a): the
writes are *marked*, not silently reverted, because reverting a child's work behind its parent's
back is exactly the "platform decides your content" failure this record keeps warning about.

### F3 — No signal that a task is too large for one child

**Observed.** Two attempts to audit a ~900-line document each burned the full budget (30 then 35
iterations) and returned **zero** edits — the child kept exploring. A third, tightly scoped attempt
on the same file kind finished in 24 iterations.

**Why it is a problem.** The failure mode is silent: the parent pays full cost and learns nothing.
There is no feedback that says "this child spent 90 % of its budget on reads".

**Suggested change.** Return an iteration breakdown (reads vs writes) in the result, and surface a
hint when a child exhausts its budget without a single write.

**Resolution (2026-10-08).** Added `toolCalls: { total, writes }` and, on any early stop with zero
successful writes, the note now says *"No files were modified — it spent its whole budget
exploring."* We deliberately did not split calls into "reads" vs "writes" (a `shell_execute` can
write without being a write tool); counting *writes* is the honest, unambiguous half.

### F4 — Delegation results have no schema

The free-text `result` is fine for a summary, but the parent needs machine-checkable fields
(what changed, what was verified, what was left). Right now the only reliable audit path is to
ignore the report and diff the workspace — which works, but means the report is decoration.

**Resolution (2026-10-08).** H6 had already structured `status` / `iterations` /
`aggregateCeilingReached`; this pass adds `budgetHit`, `filesTouched` and `toolCalls` to both
`spawn_subagent` and `spawn_subagents`. The report is no longer decoration — a parent can branch on
the fields without touching the workspace.

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

**Resolution (2026-10-08).** T1–T4 are workflow papercuts rather than defects in our code, so they
are now documented in `CONTRIBUTING.md` → *Development Gotchas* instead of being "fixed" with a
wrapper. T5 was already fixed: `.gitignore` now states that `docs/api/` is deliberately tracked and
only `docs/api-test/` is ignored.

---

## 3. What I would fix first

1. **F1**, because it is a correctness trap that looks like a sizing parameter.
2. **F2**, because it is the difference between "safe to fan out" and "must diff after every
   dispatch".
3. Then the repo tooling items — they are cheap and each one has already burned time twice.

---

## 4. New friction found while fixing these (2026-10-08)

Four more items surfaced during the audit-and-fix pass. They are recorded here, not fixed in it.

### F5 — A dated record can silently drift from the code, and its own banner hides it

`docs/records/` files are written as field notes, but nothing forces them to be re-checked against
`HEAD`. This file's banner still read *"Nothing here has been actioned yet"* while H6 had already
fixed the core of F1/F2 — so the record and the code disagreed and neither side said so. **Observed
cost:** the first chunk of this task went into re-deriving what was actually left. **Suggested
change:** give every `docs/records/*` file an explicit `Audited: <sha> / <date>` line plus per-item
verdicts, and treat "re-audit this record against HEAD" as step 0 of any task that picks it up.
(§0 of this document is what that looks like.)

### F6 — The tool-loop detector fires on identical result *envelopes*, not identical actions

Applying a batch of `file_edit` calls that each replaced a *different* hunk tripped
`Loop detected: "file_edit" returned identical results 6 times`. The calls were not a loop — they
were a normal refactor — but every successful edit returns the same envelope
(`{"status":"success","path":…,"replacements":1}`), and the detector compares envelopes. **Why it is
a problem:** the warning is a false positive by construction for *any* repetitive-but-distinct
operation (a multi-hunk refactor, a fan-out of same-shaped writes), and false positives are exactly
how a detector trains its reader to ignore it. The only workaround is to spread a normal edit batch
over several turns — i.e. the tooling makes correct behaviour slower. **Suggested change:** key the
detector on the call *arguments* (or a hash of them), or exempt calls whose result reports a
distinct side effect (`replacements`, `bytesWritten`), instead of on the result body. This item was
itself produced by the detector firing repeatedly during this very pass.

### T6 — A `git worktree` does not inherit `node_modules`, and reusing the primary checkout's is wrong

The clean way to develop a PR without disturbing the primary checkout is `git worktree add`. A fresh
worktree has **no** `node_modules`, and symlinking the primary checkout's is actively incorrect:
pnpm's workspace symlinks (`node_modules/@markus/shared → ../../packages/shared`) resolve back to the
*primary* checkout, so tests would run against the wrong sources. The correct move is a fresh
`pnpm install --prefer-offline --frozen-lockfile` **inside** the worktree — fast (6.3 s here) because
pnpm hardlinks from its global store. Documented in `CONTRIBUTING.md`.

### T7 — `CONTRIBUTING.md` recommended a test command that cannot work

The command table advised `pnpm test --filter @markus/<pkg>`, but no package other than the repo root
has a `test` script (`pnpm --filter @markus/core test` just looks for a `test` script that isn't
there). The working form is the root Vitest plus a positional path filter —
`pnpm test -- packages/core`. **Resolution:** already applied (the table and *Development Gotchas*),
and recorded here so the pattern is not reintroduced.
