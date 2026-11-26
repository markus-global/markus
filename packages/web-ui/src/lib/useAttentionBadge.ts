/**
 * 侧栏/底栏「概览」徽标的**全局驱动器** —— 徽标数字的唯一发布点。
 *
 * 背景（Owner 2026-11-20 发现）：徽标此前只在**概览页挂载且激活**时才重算发布
 * （Home 的 `publishAttentionCount` / `publishUnreadCount` 两个 effect 都被
 * `isActive`/页面生命周期闸住）。用户停在 Team/Work/Chat 页时，新审批、新通知、
 * 任务转待验收都不会触发重算 —— 徽标冻结在最后一次进概览时的数字，直到再点概览。
 *
 * 修法：把「取快照 → 走唯一派生 → 发布」这件事从概览页的生命周期里搬出来，放到
 * App 根部**常驻**的一个 hook 里。它与当前在哪个页面无关，由三类信号驱动：
 *   · 挂载 / 登录用户变化（立即算一次）；
 *   · 全局变更事件 `markus:notifications-changed`（WS 通知）与 `markus:data-changed`
 *     （任务/审批改动）—— 防抖合并，避免事件风暴打爆接口；
 *   · 60s 兜底轮询（事件丢失时仍会收敛）。
 *
 * 单一事实源不被破坏：
 *   · 「哪些算待办」仍只由 `deriveInbox()` 判定（经 `buildAttentionQueue`）——
 *     本 hook 与概览页都是它的**调用方**，不是第二个判定器；
 *   · 发布通道仍只有 `lib/attentionCount`；本 hook 是它**唯一**的写者，
 *     概览页不再自行发布（否则同一数字两个写者，取决于谁最后跑）。
 *
 * 诚实口径：任一接口读失败就**整次放弃发布**，保留上一次已知数字 ——
 * 宁可显示旧值，也不拿一次失败把徽标谎报成 0。
 */
import { useEffect } from 'react';
import { api } from '../api.ts';
import { buildAttentionQueue, actionableCount } from './attentionQueue.ts';
import { publishAttentionCount, publishUnreadCount } from './attentionCount.ts';

/** 事件防抖窗口：`markus:data-changed` 会连发，合并成一次取数。 */
const EVENT_DEBOUNCE_MS = 1000;
/** 兜底轮询：与概览页同节奏，事件丢失时徽标仍会收敛。 */
const FALLBACK_INTERVAL_MS = 60_000;

export function useAttentionBadge(userId: string | undefined): void {
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let debounceTimer: number | undefined;

    const recompute = () => {
      void (async () => {
        try {
          // 与概览页完全相同的四个输入口径（boardSummary 只取 active/failed 列、
          // requirements lean、全量审批、未读通知）——保证两处算出的数字一致。
          const [boardR, reqsR, apprR, notifR] = await Promise.all([
            api.tasks.boardSummary(),
            api.requirements.list({ lean: true }),
            api.approvals.list(),
            api.notifications.list(userId, true, { limit: 20 }),
          ]);
          if (!alive) return;
          const tasks = Object.values(boardR.board).flat();
          const taskById = new Map(tasks.map(t => [t.id, t]));
          const queue = buildAttentionQueue({
            tasks,
            requirements: reqsR.requirements,
            approvals: apprR.approvals ?? [],
            notifications: notifR.notifications ?? [],
            taskById: id => taskById.get(id),
            // 计数与「新/旧」标记、标题本地化无关：lastSeenAt/notifyTitle 只影响
            // isNew 与标题文案，不影响 actionableCount，这里不需要。
            lastSeenAt: null,
          });
          publishAttentionCount(actionableCount(queue));
          publishUnreadCount(notifR.unreadCount ?? 0);
        } catch {
          /* 读失败不改写徽标：保留上一次已知数字，比谎报 0 诚实。 */
        }
      })();
    };

    const schedule = () => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(recompute, EVENT_DEBOUNCE_MS);
    };

    recompute();
    const interval = window.setInterval(recompute, FALLBACK_INTERVAL_MS);
    window.addEventListener('markus:notifications-changed', schedule);
    window.addEventListener('markus:data-changed', schedule);
    return () => {
      alive = false;
      window.clearInterval(interval);
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      window.removeEventListener('markus:notifications-changed', schedule);
      window.removeEventListener('markus:data-changed', schedule);
    };
  }, [userId]);
}
