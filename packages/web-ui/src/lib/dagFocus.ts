/**
 * 「在依赖图上点了一张卡片」这一件事的**唯一判定点**。
 *
 * 核心原理（Owner 2026-11-26 定调）：
 *
 *   一次点击的含义，由「点的是不是面板里当前显示的那个东西」决定，
 *   而不是由「在不在聚焦态」决定。
 *
 * 但在**手机上这是另一套钻取模型**，不是同一套的两种尺寸：
 *
 *   desktop —— 详情面板常驻右侧 ⇒「再点一次选中的东西 = 退出聚焦」可行。
 *   mobile  —— 详情是盖在画布上的全屏层 ⇒ 三级钻取：概览 → 聚焦 → 详情；
 *              返回键逐级回退；卡片点击**永不**代表退出聚焦，出口只有左上角的
 *              浮动按钮（「显示所有」）。所以手机上概览点卡片只聚焦、不开详情，
 *              否则会越过"聚焦"这一级。
 *
 * 桌面三条：
 *   ① 点的是面板里正显示的东西 → 退出聚焦（唯一出口，与"是不是聚焦根"无关）
 *   ② 面板里显示着别的 → 只是切面板，图与聚焦都不动
 *   ③ 还在概览 → 点需求、或点该需求名下任意任务，都进入该需求；面板显示被点的那个
 *
 * 纯函数、无副作用，`test/dagFocus.test.ts` 把每一行都钉住了。
 */

/** 卡片点击之后，组件该做的唯一一件事。 */
export type DagNodeClick =
  /** 面板切到该任务（聚焦态内换面板；概览里的孤儿任务也走这条） */
  | { type: 'selectTask'; taskId: string }
  /** 面板切到该需求（聚焦态内换面板） */
  | { type: 'selectRequirement'; requirementId: string }
  /** 进入某个需求的聚焦，并把面板切到被点的实体（手机端 `null` = 只聚焦、不开详情） */
  | {
      type: 'focusRequirement';
      requirementNodeId: string;
      select:
        | { kind: 'requirement'; requirementId: string }
        | { kind: 'task'; taskId: string }
        | null;
    }
  /**
   * 再次点击面板里正显示的东西：**只退出聚焦**。
   *
   * 它不携带任何面板指令 —— "是否聚焦"与"面板是否开着"是两个独立状态。
   * 类型里没有 select / close 字段：谁想在这里关面板，就是在往模型里塞一条
   * 不存在的规则。
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
  /** 面板当前展示的实体 id（需求 id 或任务 id）；`null` = 面板没开。 */
  selectedEntityId: string | null;
  /**
   * 被点的是任务时，它所属需求的 id —— **仅当该需求当前可聚焦**时给值。
   * 需求被筛掉/没加载时给 `null`：没有可进的层，点击降级为"只开面板"。
   */
  requirementIdOfTask: string | null;
  /** 交互形态：桌面与手机是两套钻取模型（见文件头注释）。 */
  profile: 'desktop' | 'mobile';
}

export function resolveDagNodeClick(input: DagClickInput): DagNodeClick {
  const { nodeId, focusedNodeId, selectedEntityId, requirementIdOfTask, profile } = input;
  const clickedRequirementNode = isRequirementNode(nodeId);
  // 需求节点用需求 id 参与比较，任务节点用任务 id —— 两者共用一个"当前选中"。
  const ownId = clickedRequirementNode ? nodeId.slice(REQ_NODE_PREFIX.length) : nodeId;

  if (profile === 'mobile') {
    // 聚焦层：点任何卡片都只是"打开详情"，详情层用返回键回到这一层。
    if (focusedNodeId !== null) {
      return clickedRequirementNode
        ? { type: 'selectRequirement', requirementId: ownId }
        : { type: 'selectTask', taskId: ownId };
    }
    // 概览层：点需求、或点它名下任意任务，都是"进入该需求"，不顺带开详情。
    if (clickedRequirementNode) {
      return { type: 'focusRequirement', requirementNodeId: nodeId, select: null };
    }
    if (requirementIdOfTask) {
      return {
        type: 'focusRequirement',
        requirementNodeId: reqNodeId(requirementIdOfTask),
        select: null,
      };
    }
    // 孤儿任务：没有可进的层，只能开详情。
    return { type: 'selectTask', taskId: ownId };
  }

  // ① 再次点击面板里正显示的东西 → 退出聚焦。
  if (focusedNodeId !== null && selectedEntityId === ownId) return { type: 'exitFocus' };

  // ② 已在聚焦态、点的是别的东西 → 只换面板。
  if (focusedNodeId !== null) {
    return clickedRequirementNode
      ? { type: 'selectRequirement', requirementId: ownId }
      : { type: 'selectTask', taskId: ownId };
  }

  // ③ 概览态：需求 → 进入它；任务 → 进入它所属需求，但面板显示**被点的任务**。
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
 * 这也是两层各自持有勾选状态的理由：进/出聚焦不是重置，而是切到另一层的视图。
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
 * 「哪些任务属于这个需求」——**唯一实现**。
 *
 * 取 `requirement.taskIds` 与 `task.requirementId` 的**并集**：归档 / 分页场景下
 * 两者可能各缺一部分，取并集才不会漏任务。可见集、锚定集、归档计数都必须走
 * 这一个谓词，否则几处会对不上（而用户一眼就能看出对不上）。
 */
export function tasksOfRequirement<T extends { id: string; requirementId?: string }>(
  tasks: readonly T[],
  requirementId: string,
  requirementTaskIds: readonly string[],
): T[] {
  const memberIds = new Set(requirementTaskIds);
  return tasks.filter(task => memberIds.has(task.id) || task.requirementId === requirementId);
}

export interface ArchivedCountScope {
  requirementId: string;
  requirementTaskIds: readonly string[];
}

/**
 * 概览层的「锚定任务」：可见且未结束的需求，其**全部任务**都要出现（不看任务自身的
 * 状态分组）。归属走 `tasksOfRequirement`，与聚焦层同一个实现。
 */
export function collectAnchoredTaskIds(
  tasks: readonly { id: string; requirementId?: string }[],
  requirements: readonly { id: string; taskIds: readonly string[] }[],
  anchoredRequirementIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (!anchoredRequirementIds.has(requirement.id)) continue;
    for (const task of tasksOfRequirement(tasks, requirement.id, requirement.taskIds)) ids.add(task.id);
  }
  return ids;
}

/**
 * 当前层里已归档的任务数：`scope` 为 `null` 时是整张图（概览），否则只数该需求自己的。
 */
export function countArchivedTasks(
  tasks: readonly { id: string; requirementId?: string; status: string }[],
  scope: ArchivedCountScope | null,
): number {
  const pool = scope ? tasksOfRequirement(tasks, scope.requirementId, scope.requirementTaskIds) : tasks;
  return pool.filter(isArchivedTask).length;
}

/**
 * 聚焦态可见的节点 id：**只有当前聚焦的需求 + 它自己的任务**，而这些任务还要
 * 通过同一套状态分组筛选。
 */
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
