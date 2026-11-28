/**
 * Milestone scope — the ONE place that decides "is this item inside the active milestone?".
 *
 * The Work page applies this to two different shapes (requirements and board tasks) and three
 * surfaces (list, board columns, backlog). Anything that answers the question in more than one
 * place drifts apart on the first edge case, so the rule lives here, is pure, and is unit-tested.
 *
 * A task belongs to a milestone **through its requirement**: the task model carries no milestone
 * column (a milestone groups requirements; tasks inherit). A task with no requirement is
 * therefore never inside a named milestone — it is only "unassigned" material.
 */

export const MILESTONE_ALL = 'all';
export const MILESTONE_NONE = 'none';

export interface MilestoneScope {
  /** `none` = the 未归属 filter; `one` = a specific milestone. */
  mode: 'none' | 'one';
  /** For `one`: requirement ids in that milestone. For `none`: ids that HAVE a milestone. */
  ids: Set<string>;
}

interface RequirementLike {
  id: string;
  milestoneId?: string | null;
}

interface TaskLike {
  requirementId?: string | null;
}

/**
 * Resolve the filter into an id set once per (requirements, filter) pair.
 * Returns `null` for "no milestone filter" (the ALL case) so callers can skip filtering entirely.
 */
export function resolveMilestoneScope(
  requirements: ReadonlyArray<RequirementLike>,
  filter: string
): MilestoneScope | null {
  if (!filter || filter === MILESTONE_ALL) return null;
  if (filter === MILESTONE_NONE) {
    return { mode: 'none', ids: new Set(requirements.filter(r => !!r.milestoneId).map(r => r.id)) };
  }
  return { mode: 'one', ids: new Set(requirements.filter(r => r.milestoneId === filter).map(r => r.id)) };
}

export function requirementInScope(req: RequirementLike, scope: MilestoneScope | null): boolean {
  if (!scope) return true;
  return scope.mode === 'none' ? !req.milestoneId : req.milestoneId === null ? false : scope.ids.has(req.id);
}

export function taskInScope(task: TaskLike, scope: MilestoneScope | null): boolean {
  if (!scope) return true;
  const rid = task.requirementId;
  if (!rid) return scope.mode === 'none';
  return scope.mode === 'none' ? !scope.ids.has(rid) : scope.ids.has(rid);
}
