/**
 * 「这张卡有没有评审、评审到哪一步了」—— **唯一判据**。
 *
 * 数据源是**权威的状态迁移历史**（`GET /tasks/:id/history`），不是正文里
 * 猜「评审」字样、也不是只看 `task.status`。一次评审 = 一条 `→ review` 的
 * 迁移；它被其后第一条迁移关闭。当前仍停在 review 的那条即「评审中」。
 *
 * 为什么单独成纯函数：tab 徽标、按钮上方横幅、空态三处都要这个答案，
 * 任何一处自己再推一遍就会「横幅说有 agent 在审、tab 说没有」。
 */
import type { StatusTransitionInfo } from '../api.ts';

export type ReviewSessionStatus = 'queued' | 'reviewing' | 'completed';

export interface ReviewSession {
  /** 稳定身份：进入 review 的那条迁移 id */
  id: string;
  reviewerId: string;
  reviewerName: string;
  status: ReviewSessionStatus;
  queuedAt: string;
  completedAt: string | null;
}

/**
 * 从状态迁移历史派生评审会话。纯函数：同输入同输出，不读时钟、不读网络。
 *
 * @param history 已按时间升序（服务端 ORDER BY created_at ASC 保证）
 * @param reviewerNameOf 把迁移里的 changedById 解析成可读名（可选）
 */
export function deriveReviewSessions(
  history: readonly StatusTransitionInfo[],
  opts: { reviewerId?: string; reviewerNameOf?: (id: string | null) => string | undefined } = {},
): ReviewSession[] {
  const sessions: ReviewSession[] = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    if (h.toStatus !== 'review') continue;
    const next = history[i + 1];
    const open = !next; // 停在 review 的必是最后一条
    const id = `review:${h.id}`;
    const reviewerId = opts.reviewerId ?? h.changedById ?? '';
    const reviewerName =
      (h.changedByName ?? undefined)
      ?? (h.changedById ? opts.reviewerNameOf?.(h.changedById) : undefined)
      ?? reviewerId
      ?? 'reviewer';
    sessions.push({
      id,
      reviewerId,
      reviewerName,
      // 停在 review = 评审进行中（服务端此刻正在等/跑评审这一轮）。
      status: open ? 'reviewing' : 'completed',
      queuedAt: h.createdAt,
      completedAt: next ? next.createdAt : null,
    });
  }
  return sessions;
}

/** 当前正在评审的那条（决定是否展示脉冲动画 / 横幅）。 */
export function activeReviewSession(sessions: readonly ReviewSession[]): ReviewSession | null {
  return sessions.find(s => s.status === 'reviewing') ?? null;
}

/** 是否有评审正在跑。 */
export function hasLiveReview(sessions: readonly ReviewSession[]): boolean {
  return sessions.some(s => s.status === 'reviewing');
}
