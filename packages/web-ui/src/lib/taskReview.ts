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

/** 一次评审的落点。由**关闭该会话的那条迁移的 toStatus** 决定，不猜文案。 */
export type ReviewOutcome =
  /** review → completed：通过 */
  | 'approved'
  /** review → in_progress：打回返工 */
  | 'revision_requested'
  /** review → cancelled（或任何其它落点）：关闭，未通过 */
  | 'closed';

export interface ReviewSession {
  /** 稳定身份：进入 review 的那条迁移 id */
  id: string;
  reviewerId: string;
  /**
   * 评审人的可读名。**空串 = 名字未知**（名册里还没有这个人），UI 必须按「不显示」处理，
   * 不允许拿任何别人顶替——提交评审的执行者不是评审者。
   */
  reviewerName: string;
  status: ReviewSessionStatus;
  queuedAt: string;
  completedAt: string | null;
  /** 第几轮评审（1-based，按 → review 迁移出现的顺序） */
  round: number;
  /** 本次评审的结论；仍在评审中为 null */
  outcome: ReviewOutcome | null;
  /** 做出结论的人（通过者 / 打回者）；仍在评审中为 null */
  decidedByName: string | null;
  /** 关闭迁移携带的说明（评审结论 / 打回原因），没有就是 null */
  note: string | null;
}

/**
 * 从状态迁移历史派生评审会话。纯函数：同输入同输出，不读时钟、不读网络。
 *
 * @param history 已按时间升序（服务端 ORDER BY created_at ASC 保证）
 * @param opts.reviewerId / opts.reviewerName 任务的**指定评审人**（唯一来源；名字没解析出来就传空）
 */
export function deriveReviewSessions(
  history: readonly StatusTransitionInfo[],
  opts: { reviewerId?: string; reviewerName?: string } = {},
): ReviewSession[] {
  const sessions: ReviewSession[] = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    if (h.toStatus !== 'review') continue;
    const next = history[i + 1];
    const open = !next; // 停在 review 的必是最后一条
    const id = `review:${h.id}`;
    // 评审人 = 任务的**指定 reviewer**，只有一个来源。历史里的 changedById / changedByName 是
    // 「把任务推进 review 的提交者」——**不是评审者**。曾经这里兜底到 changedByName，于是
    // 「CTO 提交评审」被显示成「CTO 正在评审」，人类评审者时更是拿提交者顶替（真机事故）。
    // 拿不到名字就留空串，交给 UI 按「不知道是谁」处理；绝不换一个语义不同的人。
    const reviewerId = opts.reviewerId ?? '';
    const reviewerName = opts.reviewerName ?? '';
    sessions.push({
      id,
      reviewerId,
      reviewerName,
      // 停在 review = 评审进行中（服务端此刻正在等/跑评审这一轮）。
      status: open ? 'reviewing' : 'completed',
      queuedAt: h.createdAt,
      completedAt: next ? next.createdAt : null,
      round: sessions.length + 1,
      outcome: next ? outcomeOf(next.toStatus) : null,
      decidedByName: next ? (next.changedByName ?? null) : null,
      note: next ? (next.reason ?? null) : null,
    });
  }
  return sessions;
}

/**
 * 评审的落点只看 FSM 的真实可达集：`TASK_TRANSITIONS.review = { completed, in_progress, cancelled }`。
 * 任何其它落点一律归为「关闭」——宁可少说，不编造第三种语义。
 */
function outcomeOf(toStatus: string): ReviewOutcome {
  if (toStatus === 'completed') return 'approved';
  if (toStatus === 'in_progress') return 'revision_requested';
  return 'closed';
}

/**
 * 评审人的显示名：按**权威字段** `reviewerType` 查对应名册——人类查 users、Agent 查 agents。
 *
 * 不用 id 前缀（`user_` / `agt_`）猜角色：前缀是记号，`reviewerType` 是事实。
 * 两边都查不到就返回空串 ⇒ UI 不显示，**不回退到提交者**。
 */
export function reviewerDisplayName(
  reviewer: { reviewerId?: string; reviewerType?: 'agent' | 'human' },
  rosters: {
    agents: readonly { id: string; name: string }[];
    users: readonly { id: string; name: string }[];
  },
): string {
  if (!reviewer.reviewerId) return '';
  const roster = (reviewer.reviewerType ?? 'agent') === 'human' ? rosters.users : rosters.agents;
  return roster.find(p => p.id === reviewer.reviewerId)?.name ?? '';
}

/**
 * 「{reviewer} 正在评审」横幅该显示谁——`null` = **不显示这条横幅**。
 *
 * 三条判据，全部来自权威字段，页面不再自己推：
 *  1. 任务确实停在 `review`；
 *  2. 评审者必须是 **Agent**。人类评审者按 Owner 裁定不显示这条横幅——人类的手就在
 *     「通过 / 打回」按钮上，不需要一个「某人正在评审」的提示；
 *  3. 评审者的名字必须是**他自己的**名字。解析不到就不显示，绝不拿提交者顶替。
 */
export function reviewBannerName(
  sessions: readonly ReviewSession[],
  opts: { status: string; reviewerType?: 'agent' | 'human' },
): string | null {
  if (opts.status !== 'review') return null;
  if ((opts.reviewerType ?? 'agent') === 'human') return null;
  const live = activeReviewSession(sessions);
  const name = live?.reviewerName.trim() ?? '';
  return name === '' ? null : name;
}

/** 当前正在评审的那条（决定是否展示脉冲动画 / 横幅）。 */
export function activeReviewSession(sessions: readonly ReviewSession[]): ReviewSession | null {
  return sessions.find(s => s.status === 'reviewing') ?? null;
}

/** 是否有评审正在跑。 */
export function hasLiveReview(sessions: readonly ReviewSession[]): boolean {
  return sessions.some(s => s.status === 'reviewing');
}
