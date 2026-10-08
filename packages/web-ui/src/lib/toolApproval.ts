/**
 * toolApproval — 判定 / 筛选「工具执行审批」。
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
  /** 当前打开的 session；缺省表示「不确定」，此时不做会话过滤。 */
  sessionId?: string | null;
}

/**
 * 从 pending 审批列表里挑出属于指定 Agent（以及可能的话，指定 session）的工具审批。
 *
 * 会话归属：新数据带 `details.sessionId`（本次由 core→cli 透传）；旧数据没有，
 * 此时退回按 agentId 匹配（可能在同 Agent 的多个 tab 重复出现，属可接受的降级）。
 */
export function selectToolApprovals<T extends ApprovalLike>(
  approvals: readonly T[],
  scope: ToolApprovalScope,
): T[] {
  return approvals.filter((a) => {
    if (!isToolExecutionApproval(a)) return false;
    const owner = (a.details?.agentId as string | undefined) ?? a.agentId;
    if (owner !== scope.agentId) return false;
    const sid = a.details?.sessionId as string | undefined;
    if (sid && scope.sessionId && sid !== scope.sessionId) return false;
    return true;
  });
}
