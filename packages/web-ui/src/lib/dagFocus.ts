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
