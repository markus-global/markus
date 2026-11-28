# Work hierarchy: project → milestone → requirement → task

`docs/architecture/state-machines.md` covers the lifecycle of tasks and requirements.
This document covers the **containment** hierarchy they sit in, and the one rule that
keeps it honest: which layer is allowed to write which field.

```
project                (existing — a work domain)
  └── milestone        (optional checkpoint, 里程碑)
        └── requirement
              └── task
```

## 1. Milestone

A milestone is a **project-owned checkpoint grouping requirements**. A project may have
zero milestones; a requirement may be unassigned forever. Nothing in the existing
requirement/task flow depends on milestones existing.

Fields (`packages/shared/src/types/milestone.ts`):

| Field | Meaning |
|---|---|
| `projectId` | Owning project. **Required and immutable** — moving a milestone would silently re-home every requirement pointing at it. |
| `name` | Display name. Non-empty. |
| `description` | Free text, default `''`. |
| `dueDate` | ISO date `YYYY-MM-DD`, or `null` = no deadline. A milestone is a checkpoint, not a timestamped deadline, so there is no time-of-day. |

### 1.1 There is no milestone status, and no stored counts

Owner decision (2026-11-28): a milestone has no state of its own. "Overdue" is derived in
the UI from `dueDate`; nothing is written back. Completion is derived too — see §2.

A `progress` / `completed_count` column would be a **second source of truth** that goes
stale on every requirement status change, so it does not exist.

## 2. Progress — one definition

`computeMilestoneProgress` (`packages/org-manager/src/milestone-service.ts`) is the only
implementation. The HTTP API, the agent tools and the UI all read its output; the UI never
counts requirements itself.

- `total` = requirements of the milestone whose status is **not** in `{cancelled, rejected}`
- `done` = status in `{completed, archived}`
- `active` = status in `{in_progress, review}`
- `blocked` = status `blocked`
- `percent` = `total === 0 ? 0 : round(done / total * 100)`

Cancelled/rejected are excluded from the denominator because a milestone is *what we signed
up for*, not *everything ever filed against it*. Archived counts as done — `REQ_TRANSITIONS`
only allows `completed → archived`, so an archived requirement was finished earlier.

## 3. Invariants and their single enforcement point

| # | Invariant | Enforced in |
|---|---|---|
| I1 | A milestone belongs to exactly one **existing** project | `MilestoneService.createMilestone` (fail-closed; the DB also has a real FK on `milestones.project_id`) |
| I2 | `requirements.milestone_id`, when set, references a milestone of the requirement's **own** project | `RequirementService.assertMilestoneBelongsToProject`, called by both create and update |
| I3 | Moving a requirement to another project while it holds a foreign milestone is **rejected**, not silently cleared | same guard (caller must pass a milestone of the new project, or `milestoneId: null`) |
| I4 | Deleting a milestone **unlinks** its requirements; it never deletes them | `MilestoneService.deleteMilestone` → `RequirementService.detachMilestone` |
| I5 | Deleting a project deletes its milestones | `ProjectService.onBeforeDelete` → `MilestoneService.deleteByProject` |
| I6 | Completion has exactly one definition | `computeMilestoneProgress` (§2) |

**Single writer.** `requirements.milestone_id` is written only by `RequirementService`.
Milestone-side operations ask it (`listByMilestone`, `detachMilestone`); agent tools such as
`milestone_assign` route every id through the requirement update path. There is no code path
that writes that column from the milestone side.

Guards validate **before** mutating in-memory state, so a rejected call leaves the
requirement byte-identical.

## 4. Tasks inherit their milestone

`tasks` carries no milestone column. A task belongs to milestone *M* iff its
`requirementId` belongs to *M*; a task with no requirement is only "unassigned" material.
`packages/web-ui/src/lib/milestoneScope.ts` is the single implementation of that rule
(used by the requirement list, board columns and backlog).

## 5. Storage and upgrade path

- `milestones` table + `requirements.milestone_id` (nullable, no backfill — `NULL` means
  unassigned, which is the correct semantic for pre-existing rows).
- Existing databases get the column through the `migrations` array in
  `packages/storage/src/sqlite-storage.ts`; the `requirements(milestone_id)` index is created
  in the **post-migration** index block, because an index on a migrated column cannot live in
  `SCHEMA_SQL` (the column does not exist yet when an old database is opened).
- Covered by `packages/storage/test/milestone-storage.test.ts`, which builds a legacy
  `requirements` table without the column and asserts the upgrade adds it while leaving the
  existing rows untouched.

## 6. HTTP surface

| Method | Path | Notes |
|---|---|---|
| GET | `/api/milestones?projectId=&orgId=&milestoneId=` | each row carries derived `progress` |
| POST | `/api/milestones` | `{ projectId, name, description?, dueDate? }` |
| GET | `/api/milestones/:id` | one milestone + progress |
| PUT | `/api/milestones/:id` | `{ name?, description?, dueDate?: string \| null }` — `null` clears the date |
| DELETE | `/api/milestones/:id` | `{ deleted, detachedRequirements }` |

Requirement routes carry the field: `POST /api/requirements` and `PUT /api/requirements/:id`
accept `milestoneId` (`null` detaches), and `GET /api/requirements` returns it and accepts a
`milestoneId=` filter.

## 7. Observability

- **WS events**: `milestone:created` / `milestone:updated` / `milestone:deleted`, broadcast by
  `MilestoneService` (wired in the CLI bootstrap next to the requirement broadcasters). The Work
  page subscribes with an 800 ms debounce and refreshes both the milestone list and the
  requirement list — a delete unlinks requirements, so the requirement list is stale too.
- **Audit facts**: `milestone_created` / `milestone_updated` / `milestone_deleted`, emitted by the
  service through an injected sink (the service does not know the audit store) and recorded with
  the acting user/agent. The delete fact carries `detachedRequirements`, which is the number a
  human asks for afterwards. A throwing sink never aborts the write it describes.

## 8. Deliberate non-goals
- No milestone nesting, per-milestone teams or budgets, drag-reorder.
- Milestones are not in global search and not shown on the chat requirement card (Owner
  decision); the Work page requirement card shows and edits them.
- A milestone is not a deliverable container.

## 9. UI layout contract (Work page)

At most **three columns**. The project detail panel (which hosts the milestone section) sits
immediately right of the L1 project list; the item detail panel sits at the far right. They
are **mutually exclusive** and share one resizable width: selecting a task/requirement closes
the project panel, re-opening the project panel closes the item detail. Selecting a project
always opens its detail panel.
