/**
 * 回合回复落库执行者决策 —— 「谁负责把这一轮的回复写回 DB 会话（cs_*）」。
 *
 * 历史：本模块原为 P3「重启恢复项」专用判据（docs/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.4）。
 * P5 把它**泛化**为唯一判据，因为「谁落库」这条不变量只有**一个**度量口径：
 *
 *   **发起方（HTTP/SSE 请求线程）是否还活着并负责落库？**
 *
 *   - 活着（`metadata.responsePromise.resolve` 仍是函数）→ 它自己 persist，worker 绝不写
 *     （双写会生成重复回复行）。覆盖：正常 SSE、正常非流式 sendMessage、SSE 断线但进程
 *     仍等待的 fallback 路径。
 *   - 已死 / 压根没有发起方 → **处理该 item 的 worker 兜底落库**。覆盖两类：
 *       (a) 重启后从 DB 恢复的排队项（闭包随 JSON 丢失）；
 *       (b) 本来就**没有发起方**的 turn —— 如 `callback_result`（`background_exec` 完成、
 *           a2a in_session 回复）。这类 turn 过去回复只写 MemoryStore，用户在 Team Chat
 *           里永远看不到（P5 修复的问题）。
 *
 * 目标会话的定位（**两级**，后者用于无发起方的 turn）：
 *   1. `extra.sessionId`（请求身份，cs_*）→ `metadata.dbSessionId`（发送时快照，cs_*）；
 *   2. 本轮**内存会话 id**（sess_*）→ 由装配层反查 cs_*（`chat_sessions.metadata.memorySessionId`）。
 *
 * 都定位不到 → 不写（宁可缺失，也不落错会话）。
 */

export interface TurnReplyPersistContext {
  /** typeof metadata?.responsePromise?.resolve === 'function'（发起方是否仍活着并负责落库） */
  resolveIsFunction: boolean;
  /** extra.sessionId —— 请求携带的 DB 会话 id（cs_*，随 JSON 保留） */
  sessionId?: unknown;
  /** metadata.dbSessionId —— 发送时快照的 DB 会话 id（cs_*，随 JSON 保留） */
  dbSessionId?: unknown;
  /** 本轮的内存会话 id（sess_* …）—— 无发起方的 turn 用它反查 cs_* */
  memorySessionId?: unknown;
}

/** 为什么做出该决策（可观测性：日志/测试断言用，不参与控制流）。 */
export type TurnReplyPersistReason =
  | 'live-initiator' // 发起方活着 → worker 不写
  | 'no-target'      // 定位不到任何 DB 会话 → 不写
  | 'cs-known'       // 已知 cs_* → 直接写
  | 'mem-only';      // 只知道内存会话 → 由装配层反查 cs_*

export interface TurnReplyPersistDecision {
  shouldPersist: boolean;
  /** 已知的 DB 会话 id（cs_*）。 */
  sessionId?: string;
  /** 已知的内存会话 id（sess_* 等）——装配层据此反查 cs_*。 */
  memorySessionId?: string;
  reason: TurnReplyPersistReason;
}

export function shouldPersistTurnReply(
  ctx: TurnReplyPersistContext,
): TurnReplyPersistDecision {
  // 发起方 promise 仍存活 → 发起方负责落库（SSEHandler / api-server 非流式分支）。
  if (ctx.resolveIsFunction) {
    return { shouldPersist: false, reason: 'live-initiator' };
  }
  const asId = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  // 一级：请求身份 / 发送时快照里的 DB 会话 id。
  const cs = asId(ctx.sessionId) ?? asId(ctx.dbSessionId);
  if (cs) return { shouldPersist: true, sessionId: cs, reason: 'cs-known' };
  // 二级：只知道内存会话（callback_result / 系统 turn）→ 交给装配层反查。
  const mem = asId(ctx.memorySessionId);
  if (mem) return { shouldPersist: true, memorySessionId: mem, reason: 'mem-only' };
  // 无任何会话身份 → 无法定位目标会话；宁可缺失也不落错会话。
  return { shouldPersist: false, reason: 'no-target' };
}
