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
