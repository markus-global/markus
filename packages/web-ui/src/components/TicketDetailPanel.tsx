/**
 * 票据详情 —— 票自己的页面（就地展开，不新造路由）。
 *
 * 为什么它必须存在：C1 把票建成独立对象（`tickets` 表 + 三态状态机 + HTTP 面），
 * 但 web-ui **零消费点** —— 全仓 grep `ticket` 只命中 RouterDesk 的订阅列表。
 * 于是「从 ticket 详情就地打开这条流」在物理上做不到：没有 ticket 详情。
 *
 * 为什么放在任务详情里展开、而不是做一个 `/tickets/:id` 页面：
 * 票挂在 task 上（`task_id` 可空，`ON DELETE SET NULL`），人真正遇到票的地方
 * 就是他在看的那张任务卡。给它一个独立路由，今天没有任何入口指向它 ——
 * 那是一个死页面（本仓库已经踩过「新增页面漏接线 = 功能不存在」的坑）。
 *
 * 只读：票的状态流转仍走 `POST /api/tickets/:id/transition`（状态机唯一执行点在仓储），
 * 这里不提供第二个写者。
 */
import { useEffect, useState } from 'react';
import { fetchTicket } from '../api.ts';
import type { TicketAPI } from '../api.ts';
import { ThreadTimeline } from './ThreadTimeline.tsx';

const STATUS_LABEL: Record<string, string> = {
  open: '进行中',
  ended: '已结束',
  cancelled: '已取消',
};

export function TicketDetailPanel({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const [ticket, setTicket] = useState<TicketAPI | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTicket(null);
    setError(null);
    fetchTicket(ticketId)
      .then(r => { if (alive) setTicket(r.ticket); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [ticketId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-surface-primary shadow-xl ring-1 ring-border-default/30"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-fg-tertiary">票据</span>
              {ticket && (
                <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-fg-secondary">
                  {STATUS_LABEL[ticket.status] ?? ticket.status}
                </span>
              )}
              <h2 className="min-w-0 truncate text-base font-semibold text-fg-primary">
                {ticket?.subject || ticketId}
              </h2>
            </div>
            <div className="mt-1 text-[11px] text-fg-tertiary">
              <code title={ticketId}>{ticketId}</code>
              {ticket?.kind ? ` · ${ticket.kind}` : ''}
              {ticket?.assignee ? ` · 负责 ${ticket.assignee}` : ' · 未指派'}
              {ticket?.taskId ? ` · 关联任务 ${ticket.taskId}` : ' · 不挂任务'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded px-1.5 py-0.5 text-xl leading-none text-fg-tertiary hover:bg-surface-overlay hover:text-fg-primary"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        {error && (
          <p className="px-5 py-3 text-xs text-rose-600">
            票读取失败：{error}（这不等于「票不存在」，本面板无法判断）
          </p>
        )}

        <div className="px-5 py-4">
          {/* 票的来龙去脉：票也是「一条流」，ref 就是票 id（§7.9 奥卡姆：ref 直接用实体 id） */}
          <ThreadTimeline refId={ticketId} />
        </div>
      </div>
    </div>
  );
}
