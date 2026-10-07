import { END_TURN_REPLY_SENTINEL } from '@markus/shared';

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
  /**
   * 本轮 mailbox item 的 sourceType —— **fail-closed 白名单**的唯一输入：只有
   * 「可能属于某个用户对话会话」的 turn 类型（CHAT_CONVERSATION_TURN_TYPES）才有
   * 资格走到落库判定；内部 turn（心跳/系统/任务/记忆整理）结构上不可能把回复写
   * 进用户对话。缺失即拒绝（未知来源宁可不写，也不猜）。
   */
  sourceType?: unknown;
  /**
   * 本轮回复正文。类型化控制信号（`[end_turn]` / `[preempted]` / `[cancelled]`）
   * **不是正文** —— 它们是 turn 生命周期信号，落库判据必须拒绝
   * （P5b：心跳轮哨兵曾被当正文写进用户会话，2026-10-07 生产泄漏）。
   */
  reply?: unknown;
  /** extra.sessionId —— 请求携带的 DB 会话 id（cs_*，随 JSON 保留） */
  sessionId?: unknown;
  /** metadata.dbSessionId —— 发送时快照的 DB 会话 id（cs_*，随 JSON 保留） */
  dbSessionId?: unknown;
  /** 本轮的内存会话 id（sess_* …）—— 无发起方的 turn 用它反查 cs_* */
  memorySessionId?: unknown;
}

/** 为什么做出该决策（可观测性：日志/测试断言用，不参与控制流）。 */
export type TurnReplyPersistReason =
  | 'live-initiator'   // 发起方活着 → worker 不写
  | 'not-user-facing'  // sourceType ∉ 白名单（或缺失）→ 结构上不属于用户对话（fail-closed）
  | 'no-user-reply'    // 回复是控制信号（[end_turn] 等）→ 没有用户可见正文
  | 'no-target'        // 定位不到任何 DB 会话 → 不写
  | 'cs-known'         // 已知 cs_* → 直接写
  | 'mem-only';        // 只知道内存会话 → 由装配层反查 cs_*

export interface TurnReplyPersistDecision {
  shouldPersist: boolean;
  /** 已知的 DB 会话 id（cs_*）。 */
  sessionId?: string;
  /** 已知的内存会话 id（sess_* 等）——装配层据此反查 cs_*。 */
  memorySessionId?: string;
  reason: TurnReplyPersistReason;
}

/**
 * 【P5b】哪些 sourceType 的 turn **可能属于某个用户对话会话**（白名单，fail-closed）。
 *
 * 用白名单而不是「所有类型」：心跳 / 任务 / 系统 / 记忆整理等内部 turn 的输出
 * 绝不能泄漏进用户对话。它们多数用 hb_* / task_* / sys_* 会话（本就没有 cs_* 绑定），
 * 但白名单让「不泄漏」成为**结构保证**，而不是依赖下游反查恰好失败
 * （2026-10-07 生产泄漏：心跳轮的当前会话恰是用户聊天会话的内存会话 →
 * mem-only 反查成功 → [end_turn] 哨兵被当正文写进用户对话）。
 *
 * 纳入：
 *  - `human_chat`：正常聊天（正常路径由发起方落库；重启恢复项由 worker 兜底）。
 *  - `callback_result`：异步回调回到发起它的那一轮（P5 修复的目标）。
 *
 * 未纳入 `a2a_message`：其分支的会话身份取自 `opts.sessionId`（a2a_* / awaitOrigin），
 * 并未反映到 `activeSessionKey`，纳入会有「写错会话」的风险（见重构文档 §16 残余）。
 * `session_reply` 无需纳入：生产端带 responsePromise（发起方活着 → 本就不走 worker 落库）。
 */
export const CHAT_CONVERSATION_TURN_TYPES = new Set<string>([
  'human_chat', 'callback_result',
]);

/** 回复不是正文，而是 turn 生命周期控制信号（attention 层消费，绝不落库）。 */
const CONTROL_SIGNAL_REPLIES = new Set<string>([
  END_TURN_REPLY_SENTINEL,
  '[preempted]',
  '[cancelled]',
]);

export function shouldPersistTurnReply(
  ctx: TurnReplyPersistContext,
): TurnReplyPersistDecision {
  // 发起方 promise 仍存活 → 发起方负责落库（SSEHandler / api-server 非流式分支）。
  if (ctx.resolveIsFunction) {
    return { shouldPersist: false, reason: 'live-initiator' };
  }
  // 【P5b】白名单（fail-closed）：不属于用户对话的 turn 类型，结构上就出局。
  const sourceType = typeof ctx.sourceType === 'string' ? ctx.sourceType : undefined;
  if (!sourceType || !CHAT_CONVERSATION_TURN_TYPES.has(sourceType)) {
    return { shouldPersist: false, reason: 'not-user-facing' };
  }
  // 【P5b】控制信号不是正文：[end_turn] / [preempted] / [cancelled] 绝不当回复落库。
  if (typeof ctx.reply === 'string' && CONTROL_SIGNAL_REPLIES.has(ctx.reply)) {
    return { shouldPersist: false, reason: 'no-user-reply' };
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
