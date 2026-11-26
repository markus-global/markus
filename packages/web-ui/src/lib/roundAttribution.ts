/**
 * 任务评论 → 执行轮次的归属（纯函数，可单测）。
 *
 * 2026-11-15 真机事故（Owner 报障）：「r2 执行期间投的评论，前端仍显示在 r1 名下」。
 *
 * 后端是对的：日志证明评论被注入到 `task_<id>_r2` 会话。问题在**展示层的锚点选错**：
 *
 *   旧口径：第 i 轮的窗口 = [第 i 轮 firstAt, 第 i+1 轮 firstAt)
 *   真实现象：r1 settled 于 07:35:49，r2 于 07:36:14 启动并开始执行，
 *            但 r2 的**第一条日志**要到 07:36:20 才产生；
 *            人类在 07:36:17 投的评论落在 (07:35:49, 07:36:20) 这个间隙里
 *            → 被算进 r1 的窗口，于是显示在 r1 名下。
 *
 * 语义上的正确答案：**间隙属于下一轮**。上一轮已经结束（settled），
 * 人此刻投评论不可能是对着一轮已经结束的执行说话，只能是冲着即将开始/
 * 正在跑的下一轮。所以边界应当取「上一轮结束时刻」`lastAt`，而不是
 * 「下一轮首条日志」`firstAt`。
 *
 * 为什么不需要在 DB 里加 `execution_round` 列：轮次的起止时刻本来就在
 * `RoundSummary` 里（`firstAt` / `lastAt`），后端已经知道真值；
 * 前端只需把锚点选对，不必再存一份副本（存副本 = 同一事实两个所有者）。
 */

export interface RoundWindow {
  round: number;
  firstAt: string;
  lastAt: string;
}

export interface CommentStamp {
  createdAt: string;
}

const ms = (iso: string | undefined | null): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
};

/**
 * 第 `round` 轮的评论窗口 `[start, end)`。
 *
 * - 第 0 轮：从自己的首条日志开始；
 * - 后续轮次：从**上一轮的结束时刻**接上（含两轮之间的间隙）；
 * - 最后一轮：无上界（可能仍在执行）。
 */
export function roundWindow(rounds: RoundWindow[], round: number): { start: number; end: number } {
  const idx = rounds.findIndex(r => r.round === round);
  if (idx < 0) return { start: 0, end: Infinity };

  const prev = idx > 0 ? rounds[idx - 1] : undefined;
  const start = prev
    ? (ms(prev.lastAt) ?? ms(prev.firstAt) ?? 0)
    : (ms(rounds[idx]!.firstAt) ?? 0);

  const isLast = idx === rounds.length - 1;
  // 非最后一轮：到本轮结束为止；最后一轮：不设上界。
  const end = isLast ? Infinity : (ms(rounds[idx]!.lastAt) ?? ms(rounds[idx]!.firstAt) ?? Infinity);

  return { start, end };
}

/** 某一轮的评论（按窗口归属）。 */
export function commentsForRound<C extends CommentStamp>(comments: C[], rounds: RoundWindow[], round: number): C[] {
  const { start, end } = roundWindow(rounds, round);
  return comments.filter(c => {
    const t = ms(c.createdAt);
    if (t === undefined) return false;
    return t >= start && t < end;
  });
}

/** 第一条轮次日志之前的评论（开卡前的讨论），单独渲染。 */
export function commentsBeforeFirstRound<C extends CommentStamp>(comments: C[], rounds: RoundWindow[]): C[] {
  const first = rounds[0];
  if (!first) return [];
  const t0 = ms(first.firstAt);
  if (t0 === undefined) return [];
  return comments.filter(c => {
    const t = ms(c.createdAt);
    return t !== undefined && t < t0;
  });
}
