/**
 * Milestone (里程碑) — an optional checkpoint inside ONE project that groups a set of
 * requirements, so a project reads as "where are we against the plan" instead of one flat
 * list. See `docs/architecture/work-hierarchy.md`.
 *
 * Two structural facts this type encodes, both deliberate:
 *
 * 1. **No stored status / no stored counts.** Completion is *derived* from the milestone's
 *    requirements by `MilestoneService.progressOf` (the single definition). A stored
 *    `progress` column would be a second source of truth that goes stale on every
 *    requirement status change.
 * 2. **`projectId` is required.** A milestone cannot exist without a project, and a
 *    requirement may only reference a milestone of *its own* project — enforced fail-closed
 *    by the requirement write path.
 */
export interface Milestone {
  id: string;
  orgId: string;
  /** Owning project. Immutable after creation — moving a milestone between projects would
   *  silently re-parent every requirement that points at it. */
  projectId: string;
  name: string;
  description: string;
  /** ISO date (YYYY-MM-DD) or `null` = no deadline. A milestone is a checkpoint, not a
   *  timestamped deadline, so there is no time-of-day component. */
  dueDate: string | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Derived completion of a milestone. Never persisted — see the doc comment on
 * {@link Milestone}.
 *
 * Definition (single source of truth, `MilestoneService.progressOf`):
 * - `total`  = requirements of this milestone whose status ∉ {cancelled, rejected}
 * - `done`   = requirements of this milestone whose status ∈ {completed, archived}
 * - `active` = status ∈ {in_progress, review}
 * - `blocked`= status = blocked
 * - `percent` = total === 0 ? 0 : round(done / total * 100)
 *
 * Cancelled/rejected are excluded from the denominator: a milestone is "what we signed up
 * for", not "everything ever filed against it". Archived counts as done — `REQ_TRANSITIONS`
 * only allows `completed → archived`, so an archived requirement was finished earlier.
 */
export interface MilestoneProgress {
  total: number;
  done: number;
  active: number;
  blocked: number;
  percent: number;
}

/** A milestone together with its derived progress — the shape the API and tools return. */
export interface MilestoneWithProgress extends Milestone {
  progress: MilestoneProgress;
}

/** Requirements excluded from a milestone's denominator (`total`). */
export const MILESTONE_EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'rejected']);

/** Requirements counted as done in a milestone. */
export const MILESTONE_DONE_STATUSES: ReadonlySet<string> = new Set(['completed', 'archived']);

/** Requirements counted as actively in flight. */
export const MILESTONE_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'review']);

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalise a milestone due date. Accepts an ISO date (`YYYY-MM-DD`) or null.
 * A full ISO timestamp is accepted on input and truncated to its date — the column stores a
 * date, so accepting a timestamp must not create a second representation of the same fact.
 * Returns `undefined` for "invalid" so callers can fail closed with a precise message.
 */
export function normalizeMilestoneDueDate(raw: unknown): string | null | undefined {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const datePart = trimmed.slice(0, 10);
  if (!DUE_DATE_RE.test(datePart)) return undefined;
  const d = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  // Round-trip guard: rejects impossible calendar dates such as 2026-02-31 that Date parses
  // leniently into the next month.
  if (d.toISOString().slice(0, 10) !== datePart) return undefined;
  return datePart;
}
