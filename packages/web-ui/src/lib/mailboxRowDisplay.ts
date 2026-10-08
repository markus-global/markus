/**
 * Mailbox 行的「展示状态」派生态 —— 单一来源：在途流（currentFocus）为权威。
 *
 * 缺陷（docs/records/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.6 H2 / 步骤 2d）：
 * mailbox history 行的状态点直接使用 `STATUS_COLORS[item.status]`，其中
 * `processing: 'bg-blue-400 animate-pulse'` —— 但 `item.status` 是 **DB 持久化状态**，
 * 取消落空 / 停止 / 崩溃后一行可能长期停在 `processing`（概览页「处理中」的假象来源），
 * 而 agent 其实已经空闲或在跑别的东西。同一事实（「这条消息还在真处理吗」）出现
 * 两个展示源：DB status 说 processing，在途流说 idle → 概览页与前端会话区对不上。
 *
 * 收敛规则：**只有「DB processing ∧ 且就是注意力循环的 currentFocus ∧ agent 在跑」**
 * 才显示活动「处理中」（蓝色脉冲）；否则降级成 queue 色（不再谎称在处理）。
 * 纯展示派生，不改任何 DB 状态 —— 与 canCancelMailboxItem 同一哲学（展示以在途流为准）。
 */
export type MailboxRowDisplayStatus = 'processing' | 'queued' | 'stale' | string;

export type MailboxRowDisplayOpts = {
  itemStatus: string;
  /** Agent 进程是否在跑（停止后 attention 循环不存在） */
  agentRunning: boolean;
  /** 注意力循环当前 focus 的 mailboxItemId；idle / 无 focus 时 undefined */
  currentFocusMailboxItemId: string | null | undefined;
  /** 本行的 mailbox item id */
  itemId: string;
};

export function deriveMailboxRowDisplayStatus({
  itemStatus,
  agentRunning,
  currentFocusMailboxItemId,
  itemId,
}: MailboxRowDisplayOpts): MailboxRowDisplayStatus {
  if (itemStatus !== 'processing') return itemStatus;
  // DB 说 processing，但 agent 已停止 → 没有循环在跑，必然 stale。
  if (!agentRunning) return 'stale';
  // 真在途流 = 本行就是当前 focus。否则 DB 状态已过期 → stale。
  if (currentFocusMailboxItemId === itemId) return 'processing';
  return 'stale';
}