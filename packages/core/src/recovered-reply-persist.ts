/**
 * 【P3】回复落库执行者决策 —— 见 p3-restart-reply-persist.test.ts 头注。
 *
 * 正确语义（docs/records/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.4）：
 * - 正常 SSE / 正常非流式 sendMessage：发起方（SSEHandler / api-server 请求线程）
 *   持有 `metadata.responsePromise`、`extra.onEvent` 闭包，回合完成后由发起方
 *   `persistAssistantMessage` 落库 → worker 绝不重复写（避免双写）。
 * - 重启恢复项：`loadQueued` 从 DB JSON 还原，函数闭包全部丢失（onEvent /
 *   responsePromise 均非函数）→ 发起方线程已死、无人落库 → **worker 必须兜底**把
 *   回复写回 DB 会话（cs_*），否则前端刷新也拉不到回复。
 *
 * 判定键：`responsePromise.resolve` 是否仍存活 = 「发起方是否还在等待并负责落库」。
 * 这是全能判据：正常 SSE（onEvent 是函数）与正常非流式（responsePromise 是函数）
 * 都不触发；只有发起方 promise 已随 JSON 丢失的恢复项才触发。
 */
export interface RecoveredReplyPersistContext {
  /** typeof metadata?.responsePromise?.resolve === 'function'（发起方是否活着） */
  resolveIsFunction: boolean;
  /** extra.sessionId —— 请求携带的 DB 会话 id（JSON 保留） */
  sessionId?: unknown;
  /** metadata.dbSessionId —— 发送时快照的 DB 会话 id（JSON 保留） */
  dbSessionId?: unknown;
}

export interface RecoveredReplyPersistDecision {
  shouldPersist: boolean;
  /** 目标 DB 会话（cs_*）；无可定位会话时为 undefined */
  sessionId?: string;
}

export function shouldPersistRecoveredReply(
  ctx: RecoveredReplyPersistContext,
): RecoveredReplyPersistDecision {
  // 发起方 promise 仍存活 → 发起方负责落库（SSEHandler / api-server 非流式分支）。
  // 包括「SSE 断开但进程活着」的 fallback 路径：responsePromise 还在，api-server
  // 等待中 → 由它写。worker 不写，避免双写。
  if (ctx.resolveIsFunction) {
    return { shouldPersist: false };
  }
  // 定位目标 DB 会话：extra.sessionId（请求身份）优先，metadata.dbSessionId 兜底。
  const sessionId = (ctx.sessionId as string | undefined) ?? (ctx.dbSessionId as string | undefined);
  if (!sessionId) {
    // 无任何 DB 会话身份 → 无法定位目标会话；宁可缺失也不落错会话。
    return { shouldPersist: false };
  }
  return { shouldPersist: true, sessionId };
}