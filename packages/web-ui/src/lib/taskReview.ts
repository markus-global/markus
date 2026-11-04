/**
 * 「这张任务卡有没有审核人正在审」—— **唯一判据**。
 *
 * 为什么单独成一个纯函数：这个问题的答案决定三处 UI（tab 徽标、待审核横幅、
 * 空态文案），任何一处自己再推一遍，就会出现「横幅说有 agent 在审、tab 说没有」
 * 这种自相矛盾。判据只有一份，三个入口都调它。
 *
 * 什么**不是**判据：正文里出现「review」「审核」等字样；任务状态是不是 `review`
 * （待审核 ≠ 有 agent 在审 —— 人工审核时永远没有 agent session）。
 * 只有审核投递行（review_request）的状态是事实。
 */

/** 服务端判定的审核投递状态（`GET /tasks/:id/reviews`）。 */
export type ReviewSessionStatus = 'queued' | 'reviewing' | 'completed' | 'dropped';

/** 判定所需的最小形状 —— 不绑定 API 类型，便于单测与复用。 */
export interface ReviewSessionLike {
  status: string;
}

/** 审核正在进行中（审核人已在跑这一轮）。 */
export function isReviewing(s: ReviewSessionLike): boolean {
  return s.status === 'reviewing';
}

/** 已派发但审核人还没开始 —— 同样是「有人要审了」，只是还没动。 */
export function isReviewQueued(s: ReviewSessionLike): boolean {
  return s.status === 'queued';
}

/**
 * 当前「活跃」的那条审核投递：优先 `reviewing`，其次 `queued`，都没有则 null。
 * 顺序即语义 —— 正在审比排队中更值得让用户看见。
 */
export function activeReviewSession<T extends ReviewSessionLike>(sessions: readonly T[]): T | null {
  return sessions.find(isReviewing) ?? sessions.find(isReviewQueued) ?? null;
}

/** 是否有审核人正**在跑**（决定是否展示脉冲动画）。 */
export function hasLiveReview(sessions: readonly ReviewSessionLike[]): boolean {
  return sessions.some(isReviewing);
}
