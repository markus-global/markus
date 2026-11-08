/**
 * 概览「需要你的关注」的**唯一队列实现**。
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────────────
 * 旧实现（`Home.tsx` 的 `attentionItems`）只算 **4 个聚合桶的计数**：
 * 「3 个任务需要你审查」。于是三件事同时做不到：
 *   1. 没有标题 —— 用户不知道是哪 3 个，必须点进去自己找；
 *   2. 没有等待时长 —— 也不按它排，最久等的那条可能排在最下面；
 *   3. 缺类别 —— `api.approvals`（agent 要你批准/回答）与未读消息**根本不在里面**，
 *      于是「明明有人等我，这里却说没什么事」。
 *
 * 本文件把这些收敛成**一个纯函数**：输入四类已取到的数据，输出一条条具体事项，
 * 每条自带 标题 / 优先级 / 等待时长 / 跳转参数 / 是否新。排序也只有这一处。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * 1. 等待时长要**诚实标注口径**：审批请求用 `requestedAt`（精确），需求用 `createdAt`，
 *    任务用 `statusChangedAt`（进入当前状态的时刻）；只有老行退回 `updatedAt`，
 *    此时 `waitingBasis = 'approximate'`，界面必须说「约」。
 * 2. 「等依赖」不进队列 —— 那是引擎自己会恢复的等待，不需要人动手。
 *    （`blockedReason === 'hold'` 才进；旧行由 `blockedReasonOf` 回退推断。）
 * 3. 徽标数字不在这里算。侧栏数字由 `lib/attentionCount` 合并（要你动手 + 未读），
 *    本文件只回答「该显示哪几条、按什么顺序」。
 */
import type { ApprovalInfo, NotificationInfo, RequirementInfo, TaskInfo } from '../api.ts';
import { blockedReasonOf } from './blockedReason.ts';

export type AttentionKind =
  | 'approval_request'
  | 'requirement_approval'
  | 'task_review'
  | 'blocked_hold'
  | 'task_failed'
  | 'unread_message';

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
}

/** 同一刻的排序权重：要你决定的排在做之前。 */
const KIND_ORDER: Record<AttentionKind, number> = {
  approval_request: 0,
  blocked_hold: 1,
  task_failed: 2,
  requirement_approval: 3,
  task_review: 4,
  unread_message: 5,
};

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

function priorityRank(p: string | undefined): number {
  return PRIORITY_RANK[(p ?? '').toLowerCase()] ?? 4;
}

function iso(value: string | undefined | null, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

/** 是否「比上次访问更新」。`lastSeenAt` 为空（首次使用）时全部算旧，避免开局一片「新」。 */
function isNewSince(waitingSince: string, lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return waitingSince > lastSeenAt;
}

export interface AttentionInput {
  /** 全部任务（已按状态分好组也行，这里自己判状态，避免调用方各写一遍过滤） */
  tasks: readonly TaskInfo[];
  requirements: readonly RequirementInfo[];
  /** 待处理审批（`status === 'pending'` 的才进队列，其余忽略） */
  approvals: readonly ApprovalInfo[];
  /** 未读通知（含 agent 报告 / @ / 私信） */
  notifications: readonly NotificationInfo[];
  /** 依赖查找，用于旧行 blockedReason 的回退推断 */
  taskById?: (id: string) => TaskInfo | undefined;
  lastSeenAt?: string | null;
  /** 未读消息是否进队列（Owner 2026-11-08：放进来，排在审批/验收之后） */
  includeUnread?: boolean;
}

/**
 * 构建队列。**排序即优先级契约**：
 *   ① 等得最久的最上面（`waitingSince` 升序）；
 *   ② 同一刻按优先级（urgent > high > medium > low > 无）；
 *   ③ 再按类型（要你决定的在前），最后按 id —— 保证渲染稳定、不会每帧互换。
 */
export function buildAttentionQueue(input: AttentionInput): AttentionItem[] {
  const {
    tasks, requirements, approvals, notifications,
    taskById, lastSeenAt = null, includeUnread = true,
  } = input;
  const nowIso = new Date(0).toISOString(); // 仅作缺值兜底，不引入时序噪声
  const items: AttentionItem[] = [];
  /** 同一个任务既可能「待验收」又挂着审批请求：审批请求更具体，保留它。 */
  const claimedTargets = new Set<string>();

  for (const a of approvals) {
    if (a.status !== 'pending') continue;
    const details = (a.details ?? {}) as { taskId?: string; requirementId?: string; sessionId?: string };
    const params: Record<string, string> = {};
    let page: AttentionTarget['page'] = 'TEAM';
    if (details.taskId) {
      page = 'WORK';
      params.openTask = details.taskId;
      claimedTargets.add(`task:${details.taskId}`);
    } else if (details.requirementId) {
      page = 'WORK';
      params.openRequirement = details.requirementId;
    }
    if (a.agentId) params.agentId = a.agentId;
    // 没有落点实体 → 回 agent 的主会话（提问类在那里有回答弹窗）
    if (page === 'TEAM') params.preferMain = '1';
    items.push({
      id: `approval:${a.id}`,
      kind: 'approval_request',
      title: a.title,
      priority: 'none',
      waitingSince: iso(a.requestedAt, nowIso),
      waitingBasis: 'requested',
      target: { page, params },
      isNew: isNewSince(iso(a.requestedAt, nowIso), lastSeenAt),
      ...(a.agentName ? { meta: a.agentName } : {}),
    });
  }

  for (const r of requirements) {
    if (r.status !== 'pending') continue;
    const since = iso(r.createdAt, nowIso);
    items.push({
      id: `requirement:${r.id}`,
      kind: 'requirement_approval',
      title: r.title,
      priority: r.priority ?? 'none',
      waitingSince: since,
      waitingBasis: 'created',
      target: { page: 'WORK', params: { openRequirement: r.id } },
      isNew: isNewSince(since, lastSeenAt),
    });
  }

  for (const t of tasks) {
    if (t.status === 'review' && t.reviewerType === 'human') {
      if (claimedTargets.has(`task:${t.id}`)) continue;
      const exact = t.statusChangedAt;
      const since = iso(exact ?? t.updatedAt ?? t.createdAt, nowIso);
      items.push({
        id: `task:${t.id}`,
        kind: 'task_review',
        title: t.title,
        priority: t.priority ?? 'none',
        waitingSince: since,
        waitingBasis: exact ? 'status' : 'approximate',
        target: { page: 'WORK', params: { openTask: t.id } },
        isNew: isNewSince(since, lastSeenAt),
      });
      continue;
    }
    if (t.status === 'blocked') {
      // 等依赖不需要人 —— 只是「引擎会自己恢复」。只有 hold 才进队列。
      const reason = blockedReasonOf(t, id => taskById?.(id));
      if (reason !== 'hold') continue;
      const exact = t.statusChangedAt;
      const since = iso(exact ?? t.updatedAt ?? t.createdAt, nowIso);
      items.push({
        id: `blocked:${t.id}`,
        kind: 'blocked_hold',
        title: t.title,
        priority: t.priority ?? 'none',
        waitingSince: since,
        waitingBasis: exact ? 'status' : 'approximate',
        target: { page: 'WORK', params: { openTask: t.id } },
        isNew: isNewSince(since, lastSeenAt),
      });
      continue;
    }
    if (t.status === 'failed') {
      const exact = t.statusChangedAt;
      const since = iso(exact ?? t.updatedAt ?? t.createdAt, nowIso);
      items.push({
        id: `failed:${t.id}`,
        kind: 'task_failed',
        title: t.title,
        priority: t.priority ?? 'none',
        waitingSince: since,
        waitingBasis: exact ? 'status' : 'approximate',
        target: { page: 'WORK', params: { openTask: t.id } },
        isNew: isNewSince(since, lastSeenAt),
      });
    }
  }

  if (includeUnread) {
    for (const n of notifications) {
      if (n.read) continue;
      const since = iso(n.createdAt, nowIso);
      const meta = (n.metadata ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      const agentId = typeof meta['agentId'] === 'string' ? meta['agentId'] : undefined;
      const sessionId = typeof meta['sessionId'] === 'string' ? meta['sessionId'] : undefined;
      if (agentId) params.agentId = agentId;
      if (sessionId) params.sessionId = sessionId;
      else if (agentId) params.preferMain = '1';
      items.push({
        id: `notice:${n.id}`,
        kind: 'unread_message',
        title: n.title,
        priority: n.priority ?? 'none',
        waitingSince: since,
        waitingBasis: 'created',
        target: { page: 'TEAM', params },
        // 未读消息的「新」由服务端 read 标记定义，不看本地时间戳。
        isNew: true,
      });
    }
  }

  return items.sort((a, b) => {
    if (a.waitingSince !== b.waitingSince) return a.waitingSince < b.waitingSince ? -1 : 1;
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const kr = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kr !== 0) return kr;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
