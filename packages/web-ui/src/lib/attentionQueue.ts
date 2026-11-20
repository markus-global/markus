/**
 * Overview "needs you" row **rendering** — the queue itself is derived in
 * `lib/deriveInbox.ts` (C9-D).
 *
 * ── What changed and why ────────────────────────────────────────────────
 * This file used to *decide* the list: which approvals count, which tasks are
 * "waiting for you", what collapses with what, and in which order. That is the
 * same fact four clients need ("what does a human have to do now"), so a decision
 * living in a React page's helper is a decision that will be re-derived — and
 * drift — in the next client. Membership, dedupe (`subjectKind:subjectId:needKind`),
 * fold-by-subject, `action`, `blocking` and precedence now live in
 * `deriveInbox()`; the `inbox-single-derivation` invariant in
 * `scripts/architecture-guard.mjs` fails CI if a second decider reappears here.
 *
 * What legitimately stays here is presentation:
 *   · `kind` — the row's visual class (icon/colour/label), a UI vocabulary;
 *   · `id`  — a stable React key derived from the row's anchor source;
 *   · `title` — i18n: notification titles go through `notifyText.notifTitle`;
 *   · `target` — the route of an *existing* single discriminator
 *     (`notifyNavigate.notificationTarget`), injected into the derivation;
 *   · `notices` — the `NotificationInfo` objects of everything folded in, so one
 *     click marks them all read (otherwise the badge keeps counting them and the
 *     user sees "数字 5、列表 4 行").
 *
 * Waiting-duration semantics are unchanged and stay honest: an approval uses
 * `requestedAt`, a requirement `createdAt`, a task `statusChangedAt`; only rows
 * with no exact field fall back to `approximate`, and the UI then says "约".
 */
import type { ApprovalInfo, NotificationInfo, RequirementInfo, TaskInfo } from '../api.ts';
import { blockedReasonOf } from './blockedReason.ts';
import { notificationTarget } from './notifyNavigate.ts';
import { deriveInbox, type InboxItem as DerivedRow, type InboxPorts, type InboxSnapshot } from './deriveInbox.ts';

export type AttentionKind =
  | 'agent_question'
  | 'approval_request'
  | 'requirement_approval'
  | 'task_review'
  | 'blocked_hold'
  | 'task_failed'
  | 'unread_message';

/**
 * 这条审批到底是「请你批准」还是「请你回答」（Owner 2026-11-08 提问点出来的）。
 *
 * `request_user_input` 会**阻塞 Agent 的整个回合**等人答话，但它在数据上和普通审批
 * 走同一张表（`approvals`，带 `questions[]`）—— 于是它一度被当成「审批请求」渲染，
 * 按钮写着「去批准」。可回答一个问题不是批准；措辞错了，用户就会按错语义去理解
 * （“它在求我签字” vs “它在等我一句话”）。
 *
 * 单一判据：`questions[]` 非空 ⇒ 提问。不要再看 `details` 里的任何东西兜底。
 */
export function isAgentQuestion(a: { questions?: readonly unknown[] } | null | undefined): boolean {
  return Array.isArray(a?.questions) && a.questions.length > 0;
}

/** 等待时长的口径：精确 → 近似，界面据此决定要不要加「约」。 */
export type WaitingBasis = 'requested' | 'created' | 'status' | 'approximate';

export interface AttentionTarget {
  page: 'WORK' | 'TEAM';
  params: Record<string, string>;
}

export interface AttentionItem {
  /** 稳定 id：同一实体在同一次渲染里只有一个身份（React key + 埋点都靠它） */
  id: string;
  kind: AttentionKind;
  title: string;
  priority: string;
  /** 进入「等你」状态的时刻（ISO） */
  waitingSince: string;
  waitingBasis: WaitingBasis;
  target: AttentionTarget;
  isNew: boolean;
  /** 一行辅助信息：来自哪个 agent / 谁提的 */
  meta?: string;
  /** 这一行折进来的未读通知（可能多于一）。点击时逐个标已读。 */
  notices?: NotificationInfo[];
}

export interface AttentionInput {
  /** 全部任务（已按状态分好组也行，这里自己判状态，避免调用方各写一遍过滤） */
  tasks: readonly TaskInfo[];
  requirements: readonly RequirementInfo[];
  /** 全部审批（只读；「哪条算待办」由 deriveInbox 判定，这里不再过滤） */
  approvals: readonly ApprovalInfo[];
  /** 未读通知（含 agent 报告 / @ / 私信） */
  notifications: readonly NotificationInfo[];
  /** 依赖查找，用于旧行 blockedReason 的回退推断 */
  taskById?: (id: string) => TaskInfo | undefined;
  lastSeenAt?: string | null;
  /** 未读通知的标题渲染器（注入 `notifyText.notifTitle`）——保持派生纯、可测。 */
  notifyTitle?: (n: NotificationInfo) => string;
  /** 未读消息是否进队列（Owner 2026-11-08：放进来，排在审批/验收之后） */
  includeUnread?: boolean;
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 一条通知的落点 —— 判定委托给 `notifyNavigate.notificationTarget`（唯一实现），
 * 只有它返回 `null`（需上下文：审批实体反解 / 额度耗尽 / 模板更新）时才回退到
 * 「发送者会话」。回退也定不出实体 ⇒ `null`：这条没有可执行去处，派生层会丢弃它，
 * 而不是渲染一行点了没反应的待办。
 */
function notificationAction(
  n: InboxSnapshot['notifications'][number],
  approvals?: readonly ApprovalInfo[],
): AttentionTarget | null {
  // An approval_request notification is the bell/channel mirror of an approval
  // entity that deriveInbox ① already renders as the actionable reminder.
  // Reverse-resolve it to that entity (metadata.approvalId → details.taskId /
  // requirementId) so it FOLDS into the approval row by subject and only
  // contributes its unreadness. Without this, notificationTarget returns null
  // for approval_request (it needs the approvals context) and the fallback
  // below sends it to "the sender's main chat" — a SECOND inbox row for the
  // same creation event that clicks into an empty conversation (the duplicate
  // 审批 + 消息 reminder). The entity params must match ①'s subject derivation
  // (openTask / openRequirement) so noticeSubject folds the two together.
  if (n.type === 'approval_request') {
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    const approvalId = asStr(meta['approvalId']);
    const a = approvalId ? approvals?.find(x => x.id === approvalId) : undefined;
    const details = (a?.details ?? {}) as Record<string, unknown>;
    const taskId = asStr(details['taskId']);
    if (taskId) return { page: 'WORK', params: { openTask: taskId } };
    const reqId = asStr(details['requirementId']);
    if (reqId) return { page: 'WORK', params: { openRequirement: reqId } };
  }
  const resolved = notificationTarget(n as unknown as NotificationInfo);
  if (resolved) return resolved;
  const meta = (n.metadata ?? {}) as Record<string, unknown>;
  const agentId = asStr(meta['agentId']);
  const sessionId = asStr(meta['sessionId']);
  const params: Record<string, string> = {};
  if (agentId) params.agentId = agentId;
  if (sessionId) params.sessionId = sessionId;
  else if (agentId) params.preferMain = '1';
  return Object.keys(params).length > 0 ? { page: 'TEAM', params } : null;
}

function kindOf(row: DerivedRow): AttentionKind {
  switch (row.needKind) {
    case 'answer':
      return 'agent_question';
    case 'approve':
      return row.subjectKind === 'requirement' ? 'requirement_approval' : 'approval_request';
    case 'review':
      return 'task_review';
    case 'unblock':
      return 'blocked_hold';
    case 'resolve_failure':
      return 'task_failed';
    case 'read':
      return 'unread_message';
  }
}

/** 稳定 id：由**锚点来源**决定，同一实体在同一次渲染里只有一个身份。 */
function idOf(row: DerivedRow): string {
  switch (row.needKind) {
    case 'answer':
    case 'approve':
      return row.anchor.kind === 'approval'
        ? `approval:${row.anchor.ref}`
        : row.subjectKind === 'requirement'
          ? `requirement:${row.subjectId}`
          : `approval:${row.anchor.ref}`;
    case 'review':
      return `task:${row.subjectId}`;
    case 'unblock':
      return `blocked:${row.subjectId}`;
    case 'resolve_failure':
      return `failed:${row.subjectId}`;
    case 'read':
      return `notice:${row.anchor.ref}`;
  }
}

/**
 * 构建队列。**排序即优先级契约**（实现在 `deriveInbox`）：
 *   ① 等得最久的最上面；② 同一刻按优先级；③ 再按类型（要你决定的在前）；④ 按 key。
 */
export function buildAttentionQueue(input: AttentionInput): AttentionItem[] {
  const {
    tasks, requirements, approvals, notifications,
    taskById, lastSeenAt = null, includeUnread = true, notifyTitle,
  } = input;

  const snapshot: InboxSnapshot = {
    approvals: approvals as unknown as InboxSnapshot['approvals'],
    notifications: notifications as unknown as InboxSnapshot['notifications'],
    tasks: tasks as unknown as InboxSnapshot['tasks'],
    requirements: requirements as unknown as InboxSnapshot['requirements'],
  };

  const ports: InboxPorts = {
    resolveNotificationTarget: n => notificationAction(n, approvals),
    resolveBlockedReason: t => blockedReasonOf(t, id => taskById?.(id)),
    ...(notifyTitle
      ? { renderNotificationTitle: (n: InboxSnapshot['notifications'][number]) => notifyTitle(n as unknown as NotificationInfo) }
      : {}),
  };

  const { items } = deriveInbox(snapshot, ports, { lastSeenAt, includeUnread });
  const noticeById = new Map(notifications.map(n => [n.id, n]));

  return items.map(row => {
    const notices = row.noticeIds.map(id => noticeById.get(id)).filter((n): n is NotificationInfo => Boolean(n));
    return {
      id: idOf(row),
      kind: kindOf(row),
      title: row.title,
      priority: row.priority,
      waitingSince: row.waitingSince,
      waitingBasis: row.waitingBasis,
      target: row.action,
      isNew: row.isNew,
      ...(row.meta ? { meta: row.meta } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    };
  });
}

/** 徽标口径：只有「要你动手」的进计数；未读由 `lib/attentionCount` 单独合并。 */
export function actionableCount(items: readonly AttentionItem[]): number {
  return items.filter(i => i.kind !== 'unread_message').length;
}

/**
 * 等待时长的**唯一格式化**实现。
 * `approximate` 的口径必须显式说「约」，否则我们就在用一个会漂移的字段冒充事实。
 */
export function formatWaiting(item: Pick<AttentionItem, 'waitingSince' | 'waitingBasis'>, now = Date.now()): string {
  const started = Date.parse(item.waitingSince);
  if (!Number.isFinite(started)) return '—';
  const ms = Math.max(0, now - started);
  const min = Math.floor(ms / 60000);
  const hours = Math.floor(min / 60);
  const days = Math.floor(hours / 24);
  let core: string;
  if (min < 1) core = '<1 分钟';
  else if (min < 60) core = `${min} 分钟`;
  else if (hours < 24) core = `${hours} 小时`;
  else if (days < 30) core = hours % 24 > 0 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
  else core = '>30 天';
  return item.waitingBasis === 'approximate' ? `约 ${core}` : core;
}

