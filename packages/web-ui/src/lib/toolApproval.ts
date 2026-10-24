/**
 * toolApproval — 判定 / 排序「工具执行审批」。
 *
 * 背景：Agent 执行受审批保护的工具（Git 写操作等）时，整个回合会被挂起。这类审批
 * 此前只出现在通知铃铛里，用户没打开浮窗就完全不知道 Agent 在等什么。它应当和
 * `request_user_input` 一样，出现在聊天输入区上方的近场横幅里。
 *
 * 判据刻意用 `details.toolName`：它是**工具审批路径独有**的标记（见
 * packages/cli/src/commands/start.ts 的 setApprovalHandler）。这条判据能自然排除：
 *   - 带 `questions` 的 request_user_input（那是另一条 UI 通道）；
 *   - task / requirement 等**结构化审批**（它们有 options、应由工作台处理，
 *     不该冒到聊天输入框上方）。
 *
 * ── 会话归属：只决定顺序，绝不决定可见性（2026-10-23 修复）─────────────────
 *
 * 这里曾经按「`details.sessionId` 必须等于当前会话」过滤。两个 id 来自**不同的
 * 命名空间**，永远不可能相等：
 *
 *   details.sessionId → `sess_…`（内存会话，core/agent.ts 写入）
 *   activeSessionId   → `cs_…`  （DB 聊天会话，UI 所有表面都以它为键）
 *
 * 于是从 2026-10-11（第一条带 sessionId 的审批）起，**所有工具审批都不再渲染**：
 * 横幅与弹窗被过滤掉，只剩通知铃铛里那一行。回归正好随「弹窗」这个功能一起上线
 * （61a30284），且没有测试——因为没有测试能发现它。
 *
 * 不变量：**工具审批会阻塞 Agent 回合。作用域可以决定排序，绝不能决定可见性。**
 * 认不出的 / 外来的 id 空间一律降级为「显示」，而不是「隐藏」。理由很直接：
 * 按会话隐藏会让「切个 tab 就看不见 Agent 正在等你」成为一种合法状态。
 *
 * 纯函数、无 React —— 可单测，避免「看起来像审批」的东西混进聊天横幅。
 */

export interface ApprovalLike {
  id: string;
  agentId: string;
  type: string;
  /** 未提供时视为 pending（后端 DTO 一定带，测试夹具可省）。 */
  status?: string;
  questions?: readonly unknown[];
  details?: Record<string, unknown>;
}

/** 该审批是否是一次「工具执行审批」。 */
export function isToolExecutionApproval(a: ApprovalLike | null | undefined): boolean {
  if (!a) return false;
  if (a.status && a.status !== 'pending') return false;
  if (a.type !== 'action') return false;
  if (Array.isArray(a.questions) && a.questions.length > 0) return false;
  const toolName = a.details?.toolName;
  return typeof toolName === 'string' && toolName.length > 0;
}

export interface ToolApprovalScope {
  agentId: string;
  /** 当前打开的会话（`cs_…`）；缺省表示「不确定」，此时不做本地优先排序。 */
  sessionId?: string | null;
}

/** 审批归属的 Agent：载荷里的显式声明优先，退回行上的 agentId。 */
function ownerOf(a: ApprovalLike): string {
  return (a.details?.agentId as string | undefined) ?? a.agentId;
}

/**
 * 载荷可能携带的会话 id，按**两个命名空间**显式列出。
 *
 * 两个都看，是因为历史行只有 `sessionId`（旧语义里可能是 `sess_`，也曾被塞过
 * `cs_`），新行则把 `chatSessionId`（`cs_`）与 `sessionId`（`sess_`）分开写清。
 * 这里只用于「是不是当前这一栏」，认不出就当作不是——但见上文：那只是排序上的
 * 降级，不是隐藏。
 */
function conversationIdsOf(a: ApprovalLike): string[] {
  const d = a.details ?? {};
  return [d.chatSessionId, d.sessionId]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * 挑出属于指定 Agent 的工具审批：**全部**返回，按「属于当前会话」优先排序。
 *
 * 唯一被过滤掉的是**别的 Agent** 的审批——那是别人的活，冒到这条聊天里只会误导。
 */
export function selectToolApprovals<T extends ApprovalLike>(
  approvals: readonly T[],
  scope: ToolApprovalScope,
): T[] {
  const mine = approvals.filter((a) => isToolExecutionApproval(a) && ownerOf(a) === scope.agentId);
  if (!scope.sessionId) return mine;

  const local: T[] = [];
  const rest: T[] = [];
  for (const a of mine) {
    (conversationIdsOf(a).includes(scope.sessionId) ? local : rest).push(a);
  }
  // 稳定：同组内保持服务端顺序（按 requestedAt DESC）。
  return [...local, ...rest];
}
