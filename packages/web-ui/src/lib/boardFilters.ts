/**
 * Board (task/requirement) visibility rules — pure, so they can be tested.
 *
 * These rules existed inline as `filterTasks()` / `filteredReqs()` in Work.tsx,
 * duplicated for tasks and requirements (two copies that already drifted: the
 * requirement copy ignored the status filter, the task copy had an
 * `includeArchived` parameter that the body never read).
 *
 * The drift mattered: the DAG view calls `filterTasks(..., true)` expecting
 * closed tasks to be included so a **finished** workflow run still renders its
 * graph — but `includeArchived` was ignored, so `/workflows → 查看任务` on a
 * completed run opened an empty DAG. Making the flag real is what this file
 * fixes, and `includeClosed` is now an explicit override instead of a comment.
 */

/** Statuses that make a task/requirement "closed" for board filtering. */
export const CLOSED_STATUSES = new Set(['rejected', 'cancelled', 'archived']);

export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status);
}

export interface BoardVisibilityState {
  /** The board's own "show closed" toggle. */
  showClosed: boolean;
  /**
   * Override: include closed items regardless of `showClosed`.
   *
   * Used by views that opt out of the toggle — the dependency graph, which has
   * its own archived switch, and "open this specific requirement" navigation,
   * where hiding the thing the user asked for is never correct.
   */
  includeClosed?: boolean;
  statusFilter?: string | null;
  viewMode?: 'all' | 'project';
  selectedProjectId?: string | null;
  projectFilter?: Set<string>;
  agentFilter?: Set<string>;
  myTasksOnly?: boolean;
  currentUserId?: string;
}

interface Filterable {
  status: string;
  projectId?: string;
  assignedAgentId?: string;
  createdBy?: string;
}

export function filterBoardTasks<T extends Filterable>(
  tasks: T[],
  state: BoardVisibilityState,
): T[] {
  const includeClosed = state.showClosed || state.includeClosed === true;
  let result = includeClosed ? tasks : tasks.filter((t) => !isClosedStatus(t.status));

  if (state.statusFilter) result = result.filter((t) => t.status === state.statusFilter);
  if (state.viewMode === 'project' && state.selectedProjectId) {
    result = result.filter((t) => t.projectId === state.selectedProjectId);
  }
  if (state.projectFilter && state.projectFilter.size > 0) {
    result = result.filter((t) => t.projectId && state.projectFilter!.has(t.projectId));
  }
  if (state.agentFilter && state.agentFilter.size > 0) {
    result = result.filter((t) => t.assignedAgentId && state.agentFilter!.has(t.assignedAgentId));
  }
  if (state.myTasksOnly && state.currentUserId) {
    result = result.filter((t) => t.createdBy === state.currentUserId);
  }
  return result;
}
