import type { ApprovalInfo, NotificationInfo } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { isToolExecutionApproval } from './toolApproval.ts';

/**
 * 「点一条通知 → 去哪儿」的唯一实现。
 *
 * 为什么需要这个文件（Owner 2026-11-02 指出概览的跳转不对）：
 * 原实现长在 NotificationBell 内部（`navigateForNotification`），是一套完整的**按类型分派**：
 *   actionType=open_chat  → TEAM {agentId, sessionId}   跳到发送者那条会话
 *   actionType=navigate   → 按 path 前缀分流（/team、/work）
 *   approval_request      → 反解出 approval；**提问类直接打开回答弹窗**
 *   task_* / requirement_*→ WORK openTask / openRequirement
 *   direct_message        → TEAM {dm}      group_message → TEAM {channel}
 *   agent_report / system → TEAM {agentId, sessionId}
 * 我重做概览时把它简化成「只看 actionTarget 前缀」，于是这些语义全丢了。
 *
 * 现在抽成纯函数：铃铛、概览行动台、历史弹窗都调它，只有一处需要维护。
 * 判定一律基于**结构字段**（actionType / n.type / metadata.xxx），从不比对标题文本。
 */

export interface NotifyNavContext {
  /** 已知的待批审批，用来把 approval_request 反解到具体实体 */
  approvals?: ApprovalInfo[];
  /** 调用方有自己的回答弹窗时接管（铃铛）；不传则交给 Team 页的 UserInputModal */
  onOpenApproval?: (a: ApprovalInfo) => void;
  onCreditExhausted?: () => void;
  onTemplateUpdates?: () => void;
}

/** 提问类审批 = 带 questions。这类不能「跳去批」，要人回答。 */
export function isInputApproval(a: ApprovalInfo): boolean {
  return Array.isArray(a.questions) && a.questions.length > 0;
}

function parseTarget(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function queryParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  const q = path.split('?')[1];
  if (!q) return params;
  for (const [k, v] of new URLSearchParams(q).entries()) params[k] = v;
  return params;
}

/**
 * 这条通知有没有「明确去处」。
 * 没有的话（纯系统广播），点它不如打开历史列表，而不是被干巴巴地丢到任务页。
 */
export function notificationHasTarget(n: NotificationInfo): boolean {
  if (n.actionType === 'open_chat' || n.actionType === 'navigate') return true;
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  return Boolean(
    m['agentId'] || m['taskId'] || m['requirementId'] || m['projectId'] ||
    m['channel'] || m['senderId'] || m['approvalId'] || m['sessionId'],
  );
}

/**
 * 一条**审批**要跳去哪儿。
 * 提问类：优先交给调用方的弹窗；没有弹窗能力就跳 Team，那边有 UserInputModal/横幅。
 */
export function navigateForApproval(a: ApprovalInfo, ctx: NotifyNavContext = {}): void {
  if (isInputApproval(a)) {
    if (ctx.onOpenApproval) {
      ctx.onOpenApproval(a);
      return;
    }
    const sessionId = (a.details as { sessionId?: string } | undefined)?.sessionId;
    const params: Record<string, string> = {};
    if (a.agentId) params.agentId = a.agentId;
    if (sessionId) params.sessionId = sessionId;
    navBus.navigate(PAGE.TEAM, Object.keys(params).length > 0 ? params : undefined);
    return;
  }
  const details = a.details as { taskId?: string; requirementId?: string } | undefined;
  // 原则：**动作在哪，人就该去哪。**审批不是一类东西，落点必须按类型分流，
  // 否则人会被送到一个"看得见事、看不见按钮"的页面（本轮实测踩到）。
  //
  //   ① 提问类（带 questions）        → Team Chat（UserInputModal 在那儿）
  //   ② 工具执行审批（git 写等）      → Team 页横幅 + ToolApprovalModal
  //   ③ 任务卡审批（task 建卡闸）     → Work 页（Work.tsx:2827 tasks.approve）
  //   ④ 需求审批                     → Work 页
  //
  // 教训：我曾把 ③ 也统一改跳 Team，结果 Team 页只收 ①②，③ 落地后没有任何按钮。
  // "目标页面没有 approvals.respond" 不等于"那儿不能批"——任务卡走的是 tasks.approve，
  // 不是 approvals.respond。判断"能不能批"不能只看一个 API 名。
  if (isToolExecutionApproval(a) && a.agentId) {
    return void navBus.navigate(PAGE.TEAM, { agentId: a.agentId });
  }
  if (details?.taskId) return void navBus.navigate(PAGE.WORK, { openTask: details.taskId });
  if (details?.requirementId) return void navBus.navigate(PAGE.WORK, { openRequirement: details.requirementId });
  if (a.agentId) return void navBus.navigate(PAGE.TEAM, { agentId: a.agentId, preferMain: '1' });
  return void navBus.navigate(PAGE.WORK);
}

/** 一条通知的落点（不含「怎么跳」）。 */
export interface NavTarget {
  page: 'WORK' | 'TEAM';
  params: Record<string, string>;
}

/**
 * 一条**通知**的落点 —— 概览队列与铃铛共用的**唯一**判定实现。
 *
 * 为什么把「判定」从「跳转」里拆出来（Owner 2026-11-10 报障）：
 * `navigateForNotification` 把判定和 `navBus.navigate` 焊在一起，概览「需要你的关注」
 * 拿不到落点就只能自己猜 —— 猜成的结果是**一律 TEAM**，于是「任务已完成 / 任务待审核 /
 * 需求已批准」点开全被送到团队聊天，而通知里明明带着 `metadata.taskId` 与
 * `actionTarget(/work?openTask=…)`。这正是本文件头注释记录过的同一个回归
 * （「我重做概览时把它简化成只看 actionTarget 前缀，于是这些语义全丢了」）。
 *
 * 返回 `null` = 必须借助调用方上下文才能定（审批实体反解 / 额度耗尽 / 模板更新钩子），
 * 由 `navigateForNotification` 接着处理。
 */
export function notificationTarget(n: NotificationInfo): NavTarget | null {
  const meta = (n.metadata ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

  // ⓪ 「具体优先于笼统」（Owner 2026-11-04）：
  //
  // `agent_report` 写「某任务已批准」时，actionType 是 open_chat → 以前一律跳聊天，
  // 用户看到“点了没反应/没到该去的地方”。若 metadata 里带着具体实体，就直接打开它：
  // 人想知道的是「那张卡/那个需求现在怎样」，不是「回到聊天窗口」。
  // 拿不到实体时才退回聊天——那个兜底仍在，只是不再抢在实体前面。
  if (n.actionType === 'open_chat') {
    const concreteTask = asStr(meta['taskId']);
    const concreteReq = asStr(meta['requirementId']);
    if (concreteTask) return { page: 'WORK', params: { openTask: concreteTask } };
    if (concreteReq) return { page: 'WORK', params: { openRequirement: concreteReq } };
    const t0 = parseTarget(n.actionTarget);
    const agentId = asStr(t0?.['agentId']);
    if (agentId) {
      const params: Record<string, string> = { agentId };
      const sid = asStr(t0?.['sessionId']);
      if (sid) params.sessionId = sid;
      return { page: 'TEAM', params };
    }
  }

  // ① 明确要求「导航到某路径」
  if (n.actionType === 'navigate') {
    const t0 = parseTarget(n.actionTarget);
    const path = asStr(t0?.['path']);
    if (path) {
      if (path.startsWith('/team')) return { page: 'TEAM', params: queryParams(path) };
      if (path.startsWith('/work')) return { page: 'WORK', params: queryParams(path) };
      if (path.startsWith('/approvals/')) return null; // 需 approvals 上下文反解
    }
  }

  switch (n.type) {
    case 'approval_request':
      return null; // 需要 approvals 才能反解到具体实体
    case 'task_completed':
    case 'task_created':
    case 'task_review':
    case 'task_failed': {
      const taskId = asStr(meta['taskId']);
      return { page: 'WORK', params: taskId ? { openTask: taskId } : {} };
    }
    case 'requirement_created':
    case 'requirement_decision': {
      const reqId = asStr(meta['requirementId']);
      return { page: 'WORK', params: reqId ? { openRequirement: reqId } : {} };
    }
    case 'agent_report':
    case 'system': {
      if (meta['creditExhausted'] || meta['templateUpdates']) return null;
      const ag = asStr(meta['agentId']);
      const params: Record<string, string> = {};
      if (ag) params.agentId = ag;
      const sid = asStr(meta['sessionId']);
      if (sid) params.sessionId = sid;
      // A report that names no session belongs to the agent's MAIN session, not to
      // whichever session this user happened to open last.
      else if (ag) params.preferMain = '1';
      return { page: 'TEAM', params };
    }
    case 'direct_message': {
      const dm = asStr(meta['senderId']);
      return { page: 'TEAM', params: dm ? { dm } : {} };
    }
    case 'group_message': {
      const ch = asStr(meta['channel']);
      return { page: 'TEAM', params: ch ? { channel: ch } : {} };
    }
    default: {
      const taskId = asStr(meta['taskId']);
      if (taskId) return { page: 'WORK', params: { openTask: taskId } };
      const reqId = asStr(meta['requirementId']);
      if (reqId) return { page: 'WORK', params: { openRequirement: reqId } };
      const projId = asStr(meta['projectId']);
      if (projId) return { page: 'WORK', params: { projectId: projId } };
      const ag = asStr(meta['agentId']);
      if (ag) return { page: 'TEAM', params: { agentId: ag } };
      return { page: 'WORK', params: {} };
    }
  }
}

/** 一条**通知**要跳去哪儿。判定全部委托给 `notificationTarget`，这里只负责「跳」。 */
export function navigateForNotification(n: NotificationInfo, ctx: NotifyNavContext = {}): void {
  const target = notificationTarget(n);
  if (target) {
    const params = Object.keys(target.params).length > 0 ? target.params : undefined;
    return void navBus.navigate(target.page === 'WORK' ? PAGE.WORK : PAGE.TEAM, params);
  }

  const meta = (n.metadata ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

  // ── 以下三类必须借助调用方上下文，无法纯判定 ─────────────────────────────
  // ① /approvals/:id 路径 → 反解到具体审批（提问类要打开回答弹窗）
  if (n.actionType === 'navigate') {
    const t0 = parseTarget(n.actionTarget);
    const path = asStr(t0?.['path']);
    if (path?.startsWith('/approvals/')) {
      const id = path.split('?')[0]!.split('/')[2];
      const a = id ? ctx.approvals?.find(x => x.id === id) : undefined;
      if (a) return navigateForApproval(a, ctx);
    }
  }

  // ② 审批请求：反解不到具体审批时按 metadata 里的实体落点
  if (n.type === 'approval_request') {
    const approvalId = asStr(meta['approvalId']);
    const a = approvalId ? ctx.approvals?.find(x => x.id === approvalId) : undefined;
    if (a) return navigateForApproval(a, ctx);
    const taskId = asStr(meta['taskId']);
    if (taskId) return void navBus.navigate(PAGE.WORK, { openTask: taskId });
    const reqId = asStr(meta['requirementId']);
    if (reqId) return void navBus.navigate(PAGE.WORK, { openRequirement: reqId });
    const ag = asStr(meta['agentId']);
    if (ag) return void navBus.navigate(PAGE.TEAM, { agentId: ag, preferMain: '1' });
    return void navBus.navigate(PAGE.WORK);
  }

  // ③ 额度耗尽 / 模板更新：不是「去哪儿」，是「弹什么」
  if (meta['creditExhausted']) {
    ctx.onCreditExhausted?.();
    return;
  }
  if (meta['templateUpdates']) {
    ctx.onTemplateUpdates?.();
    return;
  }
  return void navBus.navigate(PAGE.WORK);
}
