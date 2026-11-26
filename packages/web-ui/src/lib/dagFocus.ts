/**
 * 「在依赖图上点了一张卡片」这一件事的**唯一判定点**。
 *
 * 为什么要单独抽出来：这段决策原先内联在 `TaskDAG.tsx#handleNodeClick`，用的是
 * 「这个节点是不是任何边的终点（topLevel）」来区分行为 —— 而需求归属边
 * （`req → task`，紫色虚线）也是边，于是**挂在需求下的任务永远不是 topLevel、
 * 点它只开面板；没有归属需求的孤儿任务反而是 topLevel、点它会把整张图切掉**。
 * 两张长得一样的卡片，点下去后果不同，用户无法预测。这不是样式问题，是
 * "卡片的身份由拓扑偷偷决定"的结构问题。
 *
 * 现在的规则只有一条，和需求聚焦模型一一对应：
 *   - **任务卡片 = 叶子**：只选中（开详情面板），永不改变图的结构。
 *   - **需求卡片 = 层级入口**：
 *       · 没聚焦             → 进入该需求（并选中它）
 *       · 聚焦在别的需求     → 换焦到该需求（并选中它）
 *       · 聚焦的就是这张卡   → 退出聚焦（唯一的退出方式；不再有独立按钮）
 *
 * 退出时是否顺带关闭详情面板：绑在「这张需求此刻是否已被选中」上，也就是
 * 页面既有的"再点同一张卡 = 取消选中"约定 —— 面板正显示这张需求 ⇒ 关闭；
 * 面板显示的是聚焦内某个任务 ⇒ 保留（那是用户的阅读位置，不是这一层的状态）。
 *
 * 纯函数、无副作用，所以 `test/dagFocus.test.ts` 能直接钉住上面每一条。
 */

/** 卡片点击之后，组件该做的唯一一件事。 */
export type DagNodeClick =
  /** 任务卡片：只选中，结构不变。 */
  | { type: 'selectTask' }
  /** 需求卡片：进入或换焦到该需求，并把详情面板切到它。 */
  | { type: 'focus'; nodeId: string }
  /** 需求卡片（当前聚焦根）：退出聚焦。 */
  | { type: 'unfocus'; closeRequirementPanel: boolean };

export const REQ_NODE_PREFIX = 'req-';

export const reqNodeId = (requirementId: string): string => `${REQ_NODE_PREFIX}${requirementId}`;

export const isRequirementNode = (nodeId: string): boolean => nodeId.startsWith(REQ_NODE_PREFIX);

/**
 * 「已归档」判定。概览分支与聚焦分支必须用**同一个谓词** —— 这个谓词原先只活在
 * 组件里，两个分支各写一次就是两份真相。
 */
export const isArchivedTask = (task: { status: string }): boolean => task.status === 'archived';

/**
 * @param nodeId         被点击的节点 id（需求节点形如 `req-<requirementId>`）
 * @param focusedNodeId  当前聚焦的节点 id；`null` = 处于概览
 * @param selectedReqId  右侧详情面板当前展示的需求 id；`null` = 面板没在展示需求
 */
export function resolveDagNodeClick(
  nodeId: string,
  focusedNodeId: string | null,
  selectedReqId: string | null,
): DagNodeClick {
  if (!isRequirementNode(nodeId)) return { type: 'selectTask' };

  // 聚焦根再点一次 = 退出。这是唯一的退出手势（没有「返回概览」按钮）。
  if (focusedNodeId === nodeId) {
    return { type: 'unfocus', closeRequirementPanel: selectedReqId === nodeId.slice(REQ_NODE_PREFIX.length) };
  }

  // 未聚焦 → 进入；已聚焦别的需求 → 换焦。两者对使用者是同一个动作。
  return { type: 'focus', nodeId };
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
 * 这条规则一次删掉了三个旧行为（都属于“聚焦态里有两套真相”）：
 *   ① 跨需求依赖把别的需求连同它的任务拉进聚焦图（“不要显示其他需求或任务”）；
 *   ② 聚焦时一改筛选项就被踢回概览（现在就地生效，chip 的选中状态不变）；
 *   ③ 需求锚定让“取消勾已完成”在聚焦里静默失效。
 *
 * 任务归属取 `requirement.taskIds` 与 `task.requirementId` 的**并集**：归档 /
 * 分页场景下两者可能各缺一部分，取并集才不会漏任务。
 */
export function visibleIdsInFocus(input: FocusVisibilityInput): Set<string> {
  const visible = new Set<string>([input.focusedNodeId]);
  if (!isRequirementNode(input.focusedNodeId)) return visible;

  const requirementId = input.focusedNodeId.slice(REQ_NODE_PREFIX.length);
  const memberIds = new Set(input.requirementTaskIds);
  for (const task of input.tasks) {
    if (!memberIds.has(task.id) && task.requirementId !== requirementId) continue;
    if (!input.allowedStatuses.has(task.status)) continue;
    if (!input.showArchived && isArchivedTask(task)) continue;
    visible.add(task.id);
  }
  return visible;
}
