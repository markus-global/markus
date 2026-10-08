/**
 * navigationFocus —— 「跳过某条消息」这类导航（搜索结果 / ⌘F / 通知深链）的状态与规则。
 *
 * ── 为什么单独成文 ────────────────────────────────────────────────────────────
 *
 * 一次导航分三个阶段（等对的 Agent 就位 → 切到目标会话并等它的对话记录加载完 →
 * 交给跳转），**前提是导航在途时它拥有"这个视图该看哪个会话、该加载什么"的决定权**。
 * 这个前提如果只在某个分支里执行，另一个分支就会同时挑会话、同时发加载 ——
 * 于是同一个 Agent 的同一时刻有**两个加载在途**，它们谁最后完成谁写"窗口边界"
 * （还能往前翻吗 / 从哪儿翻），而窗口边界当时还是**全局**的。
 *
 * 用户报障的形状正是这个：「跨会话搜索**第一次正常**，多试几次之后闪一下又跳到别处 /
 * 直接显示该会话最新消息」—— 第一次访问该 Agent 时它的消息缓冲是空的，走的分支
 * **有**这个守卫；第二次起缓冲非空，走的分支**没有** → 竞争出现。
 *
 * 所以规则必须抽出来、**两个分支走同一个判定**（唯一执行点）。
 */

/** 一个在途导航要去哪儿。 */
export interface NavigationFocus {
  /** 要停在的那条消息（没有消息就只有"回该 Agent/会话"的意图）。 */
  messageId?: string;
  mode: 'direct' | 'channel';
  agentId?: string;
  sessionId?: string | null;
  channel?: string;
  /**
   * 目标消息自身的创建时间（搜索结果/通知里已知）。
   * 传给跳转的取数器：翻过这个时间还没命中 → 目标不在本会话（已删除/不属于这里），
   * 可以据此收手，不必为了 prove-a-negative 一路翻到会话开头。纯优化，可选。
   */
  createdAt?: string;
  /** 审阅通知后的落点：没有确定的目标会话时，落到该 Agent 的主会话。 */
  preferMain?: boolean;
}

/**
 * 导航是否拥有「本视图的会话选择与加载」？
 *
 * 只有**会话态视图**（`direct`）才存在"该看哪个会话"这个问题，所以：
 *
 *   • 导航目标是频道、或当前是频道/私聊视图 → **不拦**：那里没有会话选择，
 *     而加载对话记录正是导航自己的前提；
 *   • 导航没指定会话（`sessionId` 与 `preferMain` 都没有）→ **不拦**：由换视图的
 *     effect 按它自己的规则决定（没有会话选择权之争）；
 *   • 导航属于**别的 Agent** → 不拦（各管各的视图）；
 *   • 其余情况（同一 Agent + direct + 有确定会话目标）→ **拦**：
 *     让导航独占会话选择与加载，杜绝"两个加载在途"。
 */
export function navigationOwnsSessionChoice(
  focus: NavigationFocus | null | undefined,
  view: { chatMode: 'direct' | 'channel' | 'dm'; agentId: string },
): boolean {
  if (!focus) return false;
  if (focus.mode !== 'direct' || view.chatMode !== 'direct') return false;
  if (!focus.sessionId && !focus.preferMain) return false;
  return !!focus.agentId && focus.agentId === view.agentId;
}
