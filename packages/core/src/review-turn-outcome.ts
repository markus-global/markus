/**
 * 评审回合结果判定 —— 「评审做完了没有」的唯一判据。
 *
 * ## 为什么需要它（2026-11-11 事故）
 *
 * 旧实现（`packages/core/src/agent.ts` 的 `review_request` 分支）用**一个信号回答
 * 两个问题**：`reply = ''` 既表示「这一轮 LLM 抖动 / 提前结束，值得重试」，又表示
 * 「评审人读了材料但没做决定」。注意力层对空 reply 的唯一反应是「重投」。
 *
 * 于是：LLM 抖动 → 重投是对的；评审人没做决定 → 重投一万次也不会变好。
 * 现场证据：评审人 6 个回合、20 个工具、618,091 tokens，卡片一次都没改；两条
 * `review_request` 被陈旧 processing 清理静默标 `dropped`，卡片永久停在 `review`。
 *
 * ## 修法
 *
 * 把「做完了没有」变成一个显式判定，三种结局各自有归宿：
 *  - `settled`  卡片被改过（approve / revision / 实质备注）→ 正常收口。
 *  - `retry`    未决策且未超上限 → 重投（容忍抖动）。
 *  - `escalate` 未决策且超上限 → **停止重投**，交给既有的人级升级通道
 *               （`StaleDetector`：reviewReminder 提醒评审人 → maxReviewWait 通知人）。
 *               这条通道本来就在，只是过去永远走不到——请求在重投循环里就被丢弃了。
 *
 * 纯函数、无 IO、无副作用：判定逻辑只有这一处，调用方不重复实现。
 */

/**
 * 未决策允许的重投次数上限。
 *
 * 为什么是 2：一次重投足够吸收「首轮工具报错 / LLM 提前收束」这类瞬时问题；
 * 连续三次读完材料仍不落决定，是**协议或人**的问题，不是重试能修的。
 * 上界必须有限且小——无限重投正是本 bug 的成因。
 */
export const REVIEW_TURN_MAX_RETRIES = 2;

export type ReviewTurnAction = 'settled' | 'retry' | 'escalate';

export interface ReviewTurnOutcomeInput {
  /** 本回合是否对该卡片做过实质性写入（approve / revision / task_note / submit）。 */
  cardMutated: boolean;
  /** 该卡片此前已经「未决策」过几次（由调用方按 taskId 记账并传入）。 */
  priorUndecidedTurns: number;
}

export interface ReviewTurnOutcome {
  action: ReviewTurnAction;
  /** 结算后的未决策计数：settled 归零，其它为递增后的值。 */
  attempts: number;
}

/**
 * 判定一个评审回合的结局。
 *
 * 判据只有「卡片有没有被改」这一个事实——它是权威的，且与 `StaleDetector`
 * 使用的「有人动过这张卡吗」口径完全一致（同一个事实，一种度量）。
 */
export function resolveReviewTurnOutcome(input: ReviewTurnOutcomeInput): ReviewTurnOutcome {
  if (input.cardMutated) return { action: 'settled', attempts: 0 };

  const prior = Number.isFinite(input.priorUndecidedTurns)
    ? Math.max(0, Math.trunc(input.priorUndecidedTurns))
    : 0;
  const attempts = prior + 1;

  return attempts > REVIEW_TURN_MAX_RETRIES
    ? { action: 'escalate', attempts }
    : { action: 'retry', attempts };
}
