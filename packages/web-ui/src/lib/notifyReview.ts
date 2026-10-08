/**
 * notifyReview —— 「点某个 Agent → 审阅它发给我的通知」的判定逻辑。
 *
 * 背景：Agent 用 `notify_user` 发的通知此前只按**当前会话**过滤渲染横幅；用户从 L1 名册点进某个
 * Agent 时，落到的是「上次看过的会话」，通知横幅因会话不匹配而不显示 → 用户以为什么都没有，
 * 困惑且找不到通知。
 *
 * 根因是「有没有待处理通知」这个不变量在不同入口各有一套度量，而且 L1 入口压根没有度量点。
 * 这里把它收敛成**唯一实现**（纯函数、可单测），所有入口（L1 / L2 / profile / 横幅）都调它。
 */
import type { NotificationInfo } from '../api.ts';

export type { NotificationInfo };

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** 优先级 → 可比较秩（未知 / 缺省按 normal）。 */
export function notificationPriorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[priority ?? 'normal'] ?? PRIORITY_RANK.normal;
}

/**
 * 审阅队列顺序：先按优先级（urgent → low），同级按时间倒序（新的在前）。
 * 「先看最要紧的」对收件箱式审阅是标准做法；同级用时间保证稳定。
 */
export function sortNotificationsForReview(list: readonly NotificationInfo[]): NotificationInfo[] {
  return [...list].sort((a, b) => {
    const byPriority = notificationPriorityRank(a.priority) - notificationPriorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/** 该通知是由哪个 Agent 发出的（`notify_user` 会在 metadata 落 agentId）。 */
export function notificationAgentId(n: NotificationInfo): string | undefined {
  const v = n.metadata?.agentId;
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * 会话 id 的两条载体：`metadata.sessionId`（新），或 `actionTarget(open_chat).sessionId`（旧）。
 * 唯一实现 —— 之前这段内联在 Team.tsx 且只有一处调用。
 */
export function notifySessionId(n: NotificationInfo): string | undefined {
  const meta = n.metadata ?? {};
  if (typeof meta.sessionId === 'string' && meta.sessionId) return meta.sessionId;
  if (n.actionType === 'open_chat' && n.actionTarget) {
    try {
      const target = typeof n.actionTarget === 'string' ? JSON.parse(n.actionTarget) : n.actionTarget;
      if (target && typeof target === 'object' && typeof (target as { sessionId?: unknown }).sessionId === 'string') {
        return (target as { sessionId: string }).sessionId;
      }
    } catch { /* 非法 JSON —— 当作没有会话线索 */ }
  }
  return undefined;
}

/**
 * 某 Agent 名下**待用户确认**的通知：未读 + `agent_report` + 非额度耗尽 + 属于该 Agent。
 * 这是「这个 Agent 有没有通知要我看」的唯一度量点。
 */
export function selectAgentReviewNotifications(
  list: readonly NotificationInfo[],
  agentId: string,
): NotificationInfo[] {
  if (!agentId) return [];
  return sortNotificationsForReview(
    list.filter(n =>
      !n.read
      && n.type === 'agent_report'
      && !n.metadata?.creditExhausted
      && notificationAgentId(n) === agentId,
    ),
  );
}

export interface ReviewLanding {
  /** 落点会话；null = 无单一答案，由调用方落「主会话」。 */
  sessionId: string | null;
  /** 落点后要定位到的消息；null = 只切会话不定位。 */
  messageId: string | null;
}

const NO_LANDING: ReviewLanding = { sessionId: null, messageId: null };

/**
 * 审阅完结后的落点决策。
 *
 * - 所有通知来自**同一个会话** → 落到那个会话，并定位到其中**最早**那条通知的消息
 *   （按时间线读；滚动到最早一条，后续几条自然进入视野）。
 * - 来自**多个会话**（没有单一正确答案）或都没有会话线索 → `null`，由调用方落主会话。
 *
 * 为什么不是「一律落主会话」：会话内的通知横幅是按会话过滤的，落到主会话会让刚读完的通知
 * 立刻从视野里消失；落到通知所在会话才能看到它的上下文。
 */
export function resolveReviewLanding(items: readonly NotificationInfo[]): ReviewLanding {
  if (items.length === 0) return NO_LANDING;

  const sessionIds = new Set(items.map(notifySessionId).filter((id): id is string => !!id));
  // 跨会话、或完全没有会话线索 → 没有单一答案。
  // 注意：只有一部分带 sessionId 时也算「跨会话」之外的歧义 —— 这里保守地落主会话。
  if (sessionIds.size !== 1 || items.some(n => !notifySessionId(n))) return NO_LANDING;

  const sessionId = [...sessionIds][0]!;
  const oldestFirst = [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const messageId = oldestFirst
    .map(n => n.metadata?.messageId)
    .find((m): m is string => typeof m === 'string' && m.length > 0) ?? null;

  return { sessionId, messageId };
}
