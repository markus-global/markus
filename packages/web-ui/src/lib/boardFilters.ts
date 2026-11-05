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

/**
 * Statuses the board hides **by default** (until the user turns on «显示已关闭»).
 *
 * 这是**视图偏好**，不是终态判定 —— 本文件回答的是「默认看板要不要藏起来」，
 * 不是「这项工作是否已经结束」。两者是不同的两个问题，共用一个答案就会漂移：
 * `completed` / `failed` 属于终态，但**默认仍然要看得见**（已完成的工作是看板
 * 的主要产出，藏起来要用户多点一次才能确认收尾）。
 *
 * 终态的唯一判据在 `packages/shared/src/types/task.ts#isTerminal`，浏览器侧投影在
 * `lib/taskStatus.ts`。本常量只允许是终态的**真子集**，且不得并入终态集合 ——
 * 守卫见 `packages/shared/test/terminal-status-mirror.test.ts`。
 */
export const HIDDEN_BY_DEFAULT_STATUSES = new Set(['rejected', 'cancelled', 'archived']);

export function isHiddenByDefault(status: string): boolean {
  return HIDDEN_BY_DEFAULT_STATUSES.has(status);
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
  let result = includeClosed ? tasks : tasks.filter((t) => !isHiddenByDefault(t.status));

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
