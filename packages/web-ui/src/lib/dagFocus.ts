/**
 * 「在依赖图上点了一张卡片」这一件事的**唯一判定点**。
 *
 * 核心原理（Owner 2026-11-26 定调）：
 *
 *   **一次点击的含义，由「点的是不是面板里当前显示的那个东西」决定，
 *     而不是由「在不在聚焦态」决定。**
 *
 * 展开成三条：
 *   ① 点的是面板里正显示的东西 → **退出聚焦**（这是唯一的退出方式；面板不动）
 *   ② 面板里显示着别的 → **只是切面板**，图与聚焦都不动
 *   ③ 还在概览（没有聚焦）→ 点击需求、或点击该需求的任意任务，都**进入该需求**；
 *      面板显示被点的那个（点任务就显示任务，不显示需求）
 *
 * 为什么之前是错的：旧实现把「退出」绑在"聚焦根节点"上，于是
 *   · 聚焦中、面板显示任务 T 时点需求 R（R 是聚焦根）→ 退了聚焦，面板还留着 T，
 *     图回概览而面板指向另一个实体 —— 用户报的就是这个；
 *   · 而"任务卡片点击"是否换图，当年还取决于该任务是不是任何边的终点（拓扑），
 *     长得一样的两张卡后果不同。
 *
 * 现在的判定与拓扑、与"谁是不是根"全都无关：只看**点的是谁 / 面板里是谁 / 在不在聚焦**。
 * 纯函数、无副作用，`test/dagFocus.test.ts` 把上面每一条都钉住了。
 */

/** 卡片点击之后，组件该做的唯一一件事。 */
export type DagNodeClick =
  /** 面板切到该任务（聚焦态内换面板；概览里的孤儿任务也走这条） */
  | { type: 'selectTask'; taskId: string }
  /** 面板切到该需求（聚焦态内换面板） */
  | { type: 'selectRequirement'; requirementId: string }
  /** 进入某个需求的聚焦，并把面板切到被点的那个实体 */
  | {
      type: 'focusRequirement';
      requirementNodeId: string;
      select: { kind: 'requirement'; requirementId: string } | { kind: 'task'; taskId: string };
    }
  /**
   * 再次点击面板里正显示的东西：**只退出聚焦**。
   *
   * 它**不携带任何面板指令** —— “是否聚焦”与“面板是否开着”是两个独立状态
   * （Owner 2026-11-26）：退出聚焦后面板继续显示刚才看的东西，用户不会
   * 忘记自己刚才看过啥。类型里没有 select / close 字段，谁想在这里关面板，
   * 就是在往模型里塞一条不存在的规则。
   */
  | { type: 'exitFocus' };

export const REQ_NODE_PREFIX = 'req-';

export const reqNodeId = (requirementId: string): string => `${REQ_NODE_PREFIX}${requirementId}`;

export const isRequirementNode = (nodeId: string): boolean => nodeId.startsWith(REQ_NODE_PREFIX);

/**
 * 「已归档」判定。概览分支与聚焦分支必须用**同一个谓词** —— 这个谓词原先只活在
 * 组件里，两个分支各写一次就是两份真相。
 */
export const isArchivedTask = (task: { status: string }): boolean => task.status === 'archived';

export interface DagClickInput {
  /** 被点击的节点 id（需求节点形如 `req-<requirementId>`，任务是自身 id）。 */
  nodeId: string;
  /** 当前聚焦的需求节点 id；`null` = 处于概览。 */
  focusedNodeId: string | null;
  /** 右侧面板当前展示的实体 id（需求 id 或任务 id）；`null` = 面板没开。 */
  selectedEntityId: string | null;
  /**
   * 被点的是任务时，它所属需求的 id —— **仅当该需求当前可聚焦**时给值。
   * 需求被筛掉/没加载时给 `null`：那样就没有可进的层，点击降级为"只开面板"。
   */
  requirementIdOfTask: string | null;
}

export function resolveDagNodeClick(input: DagClickInput): DagNodeClick {
  const { nodeId, focusedNodeId, selectedEntityId, requirementIdOfTask } = input;
  const clickedRequirementNode = isRequirementNode(nodeId);
  // 需求节点用需求 id 参与比较，任务节点用任务 id —— 两者共用一个"当前选中"。
  const ownId = clickedRequirementNode ? nodeId.slice(REQ_NODE_PREFIX.length) : nodeId;

  // ① 再次点击面板里正显示的东西 → 整体退出聚焦。唯一出口，与"是不是聚焦根"无关。
  if (focusedNodeId !== null && selectedEntityId === ownId) return { type: 'exitFocus' };

  // ② 已在聚焦态、点的是别的东西 → 只换面板（需求↔任务都算换面板）。
  if (focusedNodeId !== null) {
    return clickedRequirementNode
      ? { type: 'selectRequirement', requirementId: ownId }
      : { type: 'selectTask', taskId: ownId };
  }

  // ③ 概览态：需求 → 进入它；任务 → 进入它所属需求，但面板显示的是**被点的任务**。
  if (clickedRequirementNode) {
    return {
      type: 'focusRequirement',
      requirementNodeId: nodeId,
      select: { kind: 'requirement', requirementId: ownId },
    };
  }
  if (requirementIdOfTask) {
    return {
      type: 'focusRequirement',
      requirementNodeId: reqNodeId(requirementIdOfTask),
      select: { kind: 'task', taskId: ownId },
    };
  }
  // 孤儿任务（没有归属需求）：没有可进的层，只能开面板。
  return { type: 'selectTask', taskId: ownId };
}

/**
 * 依赖图的两层作用域。两层回答的是**不同问题**，所以筛选项的默认值不同：
 *
 *   overview（"哪些需求还活着"）—— 已完成的需求可能成百上千，全铺上去图就废了，
 *                                   默认**不勾**「已完成」。
 *   focus   （"这个需求整体做到哪一步"）—— 已完成的任务正是进来看的东西，
 *                                   默认**勾上**「已完成」。
 *
 * 这也是两层各自持有勾选状态的理由：`Enter/Exit` 不是重置，而是切到另一层的视图。
 */
export type DagFilterLayer = 'overview' | 'focus';

/** 该层的默认勾选分组。`allGroupIds` 由调用方传入（分组定义属于 UI 层）。 */
export function defaultGroupsFor(layer: DagFilterLayer, allGroupIds: readonly string[]): Set<string> {
  return layer === 'focus'
    ? new Set(allGroupIds)
    : new Set(allGroupIds.filter(id => id !== 'done'));
}

export interface FocusVisibilityInput {
  /** 当前聚焦的需求节点 id（`req-<requirementId>`）。 */
  focusedNodeId: string;
  /** 该需求的 `taskIds`（需求对象上的成员表）。 */
  requirementTaskIds: readonly string[];
  /** 图里拿到的全部任务。 */
  tasks: readonly { id: string; requirementId?: string; status: string }[];
  /** 状态分组筛选展开后的允许状态集合（与概览用的是同一套 chip）。 */
  allowedStatuses: ReadonlySet<string>;
  showArchived: boolean;
}

/**
 * 聚焦态可见的节点 id：**只有当前聚焦的需求 + 它自己的任务**，而这些任务还要
 * 通过同一套状态分组筛选。
 *
 * 这条规则一次删掉了三个旧行为（都属于"聚焦态里有两套真相"）：
 *   ① 跨需求依赖把别的需求连同它的任务拉进聚焦图（"不要显示其他需求或任务"）；
 *   ② 聚焦时一改筛选项就退回概览（现在就地生效，chip 的选中状态不变）；
 *   ③ 需求锚定让"取消勾已完成"在聚焦里静默失效。
 *
 * 任务归属取 `requirement.taskIds` 与 `task.requirementId` 的**并集**：归档 /
 * 分页场景下两者可能各缺一部分，取并集才不会漏任务。
 */
export interface ArchivedCountScope {
  requirementId: string;
  requirementTaskIds: readonly string[];
}

/**
 * 「哪些任务属于这个需求」——**唯一实现**。
 *
 * 取 `requirement.taskIds` 与 `task.requirementId` 的**并集**：归档 / 分页场景下
 * 两者可能各缺一部分，取并集才不会漏任务。可见集与「N 个已归档」的计数都必须
 * 走这一个谓词，否则两边会对不上（而用户一眼就能看出对不上）。
 */
export function tasksOfRequirement<T extends { id: string; requirementId?: string }>(
  tasks: readonly T[],
  requirementId: string,
  requirementTaskIds: readonly string[],
): T[] {
  const memberIds = new Set(requirementTaskIds);
  return tasks.filter(task => memberIds.has(task.id) || task.requirementId === requirementId);
}

/**
 * 当前层里已归档的任务数：`scope` 为 `null` 时是整块图（概览），否则只数该需求自己的。
 *
 * 之前这里是全局 `tasks.filter(isArchivedTask).length`，于是在聚焦态显示的是
 * **整块看板的归档数**——数字看着像本需求的，其实不是。
 */
export function countArchivedTasks(
  tasks: readonly { id: string; requirementId?: string; status: string }[],
  scope: ArchivedCountScope | null,
): number {
  const pool = scope ? tasksOfRequirement(tasks, scope.requirementId, scope.requirementTaskIds) : tasks;
  return pool.filter(isArchivedTask).length;
}

export function visibleIdsInFocus(input: FocusVisibilityInput): Set<string> {
  const visible = new Set<string>([input.focusedNodeId]);
  if (!isRequirementNode(input.focusedNodeId)) return visible;

  const requirementId = input.focusedNodeId.slice(REQ_NODE_PREFIX.length);
  for (const task of tasksOfRequirement(input.tasks, requirementId, input.requirementTaskIds)) {
    if (!input.allowedStatuses.has(task.status)) continue;
    if (!input.showArchived && isArchivedTask(task)) continue;
    visible.add(task.id);
  }
  return visible;
}
