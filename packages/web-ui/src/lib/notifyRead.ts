import { api, type NotificationInfo } from '../api.ts';

/**
 * 「点开一条通知 = 读过它」的**唯一实现**。
 *
 * 为什么必须收成一个函数（2026-11-04 Owner 实测）：同一个动作（点通知）此前有三套语义 ——
 *   · 概览右栏「重要」：标已读 + 派发变更事件，再跳转；
 *   · 概览「历史」弹窗：**只跳转，从不标已读** → 点完任务待评审跳到 Work，回到概览仍是未读；
 *   · 通知铃铛：标已读 + 派发变更事件。
 * 三份实现，错了那份没人发现，因为每份单看都「有道理」。
 *
 * 一个例外必须保留：`agent_report` 不在这里标已读 —— 它要在 Chat 里显示「知道了」确认卡，
 * 提前标已读会把那张卡抹掉，等于吞掉一次确认。这条规则原先只写在两个调用点里，
 * 现在只写在这里。
 */
export function markNotificationRead(n: NotificationInfo): void {
  if (n.read || n.type === 'agent_report') return;
  api.notifications.markRead(n.id).catch(() => undefined);
  // 让所有「未读数 / 未读点」的持有者重新取数：它们分布在概览、铃铛、历史弹窗三处，
  // 各自持有自己的副本，没有事件就只能靠重新挂载才刷新。
  window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
}

/** 一条通知指向的实体键（用于「同一条事实的多条通知一起标已读」）。 */
function entityKey(n: NotificationInfo): string | null {
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const task = s(m['taskId']);
  const req = s(m['requirementId']);
  if (task) return `task:${task}`;
  if (req) return `req:${req}`;
  return null;
}

/**
 * 点开一条通知：它自己 + **同一任务/需求的其它未读通知**一起标已读，返回被标已读的 id 集合。
 *
 * 为什么必须连坐（铃铛早就是这么做的，历史弹窗漏了）：同一件事会先后发多条通知
 * （建卡 / 进 review / 批准），它们指向同一个 taskId。只标点中的那一条，剩下几条
 * 继续顶着未读——用户点完了、徽标还在，只能挨个再点一次。
 *
 * 不按标题/正文匹配（那是载荷匹配），只看 metadata 里的实体 id。
 */
export function markNotificationThreadRead(
  n: NotificationInfo,
  all: readonly NotificationInfo[],
): Set<string> {
  const marked = new Set<string>();
  const key = entityKey(n);
  const targets = key
    ? all.filter(x => !x.read && x.type !== 'agent_report' && entityKey(x) === key)
    : [n];
  for (const x of targets) {
    if (x.read || x.type === 'agent_report') continue;
    marked.add(x.id);
  }
  if (!n.read && n.type !== 'agent_report') marked.add(n.id);
  for (const id of marked) api.notifications.markRead(id).catch(() => undefined);
  if (marked.size > 0) window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
  return marked;
}
