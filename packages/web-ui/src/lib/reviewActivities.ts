/**
 * 把「评审人的活动」归到「哪一轮评审」—— 归属逻辑只此一处。
 *
 * 为什么需要它：评审回合的 activity 过去不带 `task_id`，UI 只能猜。现在新回合会
 * 记上（`agent.ts` 在 review 分支写入），但**历史行仍然是 NULL**，所以保留一个
 * 时间窗兜底。两条路径都必须存在，否则要么历史评审点开是空的，要么新回合靠猜。
 *
 * 判据优先级：
 *   1. 活动**已经记录**了 taskId → 只认事实，不匹配就是不属于（哪怕时间重叠）。
 *   2. 活动**没有** taskId → 退回时间窗（与会话区间有重叠即计入），仅用于历史数据。
 */

export interface ReviewActivityLike {
  id: string;
  taskId?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface ReviewSessionWindow {
  taskId: string;
  /** 进入 review 的时刻 */
  queuedAt: string;
  /** 离开 review 的时刻；仍在评审则为 null */
  completedAt: string | null;
}

/** 容忍时钟/写入抖动：活动与窗口边界相差 1 分钟内仍视为重叠。 */
const WINDOW_TOLERANCE_MS = 60_000;

/**
 * 返回属于这一轮评审的活动（按时间升序）。
 * 纯函数：同输入同输出，不读时钟、不读网络。
 */
export function matchReviewActivities<T extends ReviewActivityLike>(
  activities: readonly T[],
  session: ReviewSessionWindow,
): T[] {
  const windowStart = new Date(session.queuedAt).getTime();
  const windowEnd = session.completedAt
    ? new Date(session.completedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return [];

  return activities
    .filter(a => {
      // 1) 有归属事实：严格按 taskId，不经时间窗
      if (a.taskId) return a.taskId === session.taskId;

      // 2) 历史行无归属：只要与该会话区间有重叠就计入
      const started = new Date(a.startedAt).getTime();
      if (Number.isNaN(started)) return false;
      const ended = a.endedAt ? new Date(a.endedAt).getTime() : Number.POSITIVE_INFINITY;
      const safeEnded = Number.isNaN(ended) ? Number.POSITIVE_INFINITY : ended;
      return (
        started <= windowEnd + WINDOW_TOLERANCE_MS &&
        safeEnded >= windowStart - WINDOW_TOLERANCE_MS
      );
    })
    .sort((x, y) => new Date(x.startedAt).getTime() - new Date(y.startedAt).getTime());
}
