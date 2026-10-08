/**
 * stopSending 的「是否触发后端取消」决策 —— 见 stopCancelDecision.test.ts 头注。
 *
 * 正确语义（docs/records/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.6 步骤 2b）：
 * - 只有**既有会话**才发 scoped 取消 `{ sessionId }` —— 服务端 `none` 分支
 *   （无在途流）→ no-op，绝不误杀别的会话流；
 * - 占位（无既定 session）→ `skip`：仅前端 abort + 记 userStopped，
 *   不触后端 —— 因为无 target 的请求会让服务端走 `root` 兼容路径，
 *   取消「当前 ALS/根上下文流」（HTTP 线程无 ALS → 取消此刻正在跑的那条流）。
 */
export type StopCancelDecision =
  | { kind: 'skip' }
  | { kind: 'cancel'; target: { sessionId: string } };

export function resolveStopCancelDecision(
  activeSessionId: string | null | undefined,
  placeholderId: string,
): StopCancelDecision {
  if (!activeSessionId || activeSessionId === placeholderId) {
    return { kind: 'skip' };
  }
  return { kind: 'cancel', target: { sessionId: activeSessionId } };
}