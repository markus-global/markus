/**
 * `ThreadTimeline` —— **只给 ref** 就能渲染一条流的来龙去脉。
 *
 * 为什么要有它（B4 的结构理由）：
 * Thread 是「视角」而不是对象，所以视角应该能在**被看的那个东西旁边**打开：
 * 任务详情 / 票据详情 / agent 详情各自就地渲染 `<ThreadTimeline refId={...} />`。
 * 这三处手里只有实体 id（`tsk_…` / `tkt_…` / `agent:…`）。
 *
 * 因此本组件**只调用按 ref 的读取面**（`/api/threads/one?ref=` + `/:ref/events` +
 * `/:ref/dispositions`），**不拉全局列表**：拉列表再按 id 找是「必须先到目录页」的
 * 旧心智，也是同一件事的第二套查找实现（两个写者）。
 * 这条约束由 `ThreadTimeline.test.tsx` 钉住：测试里把列表接口换成**抛错**的实现，
 * 改回列表路线立刻变红。
 *
 * 失败语义分三段说，不合并（与全局页同一条纪律）：
 *   - 头部事实读不到 → 明说「读失败」，不冒充「这条流没有内容」；
 *   - 事件读不到     → 明说，且**不要**渲染成空时间线（空 = 真的没有事件）；
 *   - 决定读不到     → 同上。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchThreadByRef, fetchThreadDispositions, fetchThreadEvents } from '../api.ts';
import type { DispositionAPI, ThreadAPI, ThreadEventAPI } from '../api.ts';
import { refDisplay, refKindLabel, stageLabel, stageTone } from '../lib/threadPresentation.ts';
import { mergeTimeline, type TimelineNode } from '../lib/threadTimeline.ts';
import { clockOf, CurrentStateNode, DecisionNode, EventNode } from './threadTimelineNodes.tsx';

export function ThreadTimeline({
  refId,
  onClose,
  className = '',
}: {
  /** 实体 id（`tsk_…` / `tkt_…` / `agent:…` / `gh:owner/repo`）。也接受内部 `thr_…`（后端兼容）。 */
  refId: string;
  onClose?: () => void;
  className?: string;
}) {
  const [thread, setThread] = useState<ThreadAPI | null>(null);
  const [events, setEvents] = useState<ThreadEventAPI[]>([]);
  const [dispositions, setDispositions] = useState<DispositionAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [dispositionsError, setDispositionsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setThreadError(null);
    setEventsError(null);
    setDispositionsError(null);
    setThread(null);
    setEvents([]);
    setDispositions([]);

    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

    // 头部事实：只按 ref 读，不依赖任何列表
    fetchThreadByRef(refId)
      .then(r => { if (alive) setThread(r.thread); })
      .catch(e => { if (alive) setThreadError(msg(e)); })
      .finally(() => { if (alive) setLoading(false); });

    // 两段历史分开取：都会失败，但失败的含义不同，混在一个请求里就分不清是哪一种
    fetchThreadEvents(refId)
      .then(r => { if (alive) setEvents(r.events ?? []); })
      .catch(e => { if (alive) setEventsError(msg(e)); });

    fetchThreadDispositions(refId)
      .then(r => { if (alive) setDispositions(r.dispositions ?? []); })
      .catch(e => { if (alive) setDispositionsError(msg(e)); });

    return () => { alive = false; };
  }, [refId]);

  // 本面板只读事件与判断（它没有 agentId，投递在这条读取路径上不存在）。
  // `mergeTimeline` 的三类行由调用方按需取用 —— 这里显式窄化，不留未处理分支。
  const timeline = useMemo(
    () => mergeTimeline(events, dispositions).filter(
      (n): n is Exclude<TimelineNode, { kind: 'delivery' }> => n.kind !== 'delivery',
    ),
    [events, dispositions],
  );

  return (
    <section className={`rounded-lg border border-border-subtle bg-surface-secondary ${className}`} data-thread-ref={refId}>
      <header className="border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-fg-tertiary">
            {refKindLabel(refId)}的来龙去脉
          </span>
          {thread && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${stageTone(thread.stage)}`}>
              {stageLabel(thread.stage).label}
            </span>
          )}
          {/* `data-thread-title`：时间线头部的标题（与检索结果行的 `data-thread-row` 配对）。
              两处都可能出现同一个标题，测试必须能指名道姓地取其中一个。 */}
          <h3 data-thread-title className="min-w-0 flex-1 truncate text-sm font-medium text-fg-primary">
            {thread?.title || refDisplay(refId)}
          </h3>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 rounded px-1.5 py-0.5 text-lg leading-none text-fg-tertiary hover:bg-surface-overlay hover:text-fg-primary"
              aria-label="关闭"
            >
              ×
            </button>
          )}
        </div>
        <div className="mt-1 text-[11px] text-fg-tertiary">
          <code title={refId}>{refDisplay(refId)}</code>
          {thread?.taskStatus ? ` · 任务状态 ${thread.taskStatus}` : ''}
          {thread ? ` · 最后活动 ${clockOf(thread.lastActivity)}` : ''}
        </div>
        {thread?.detail && (
          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-fg-secondary">{thread.detail}</p>
        )}
        {(thread?.missingFacts?.length ?? 0) > 0 && (
          <p className="mt-2 text-[11px] text-amber-600">
            部分事实未接线：{thread!.missingFacts.join('、')} —— 当前状态是凭已有事实推断的。
          </p>
        )}
        {thread?.approvalHint && <p className="mt-1 text-[11px] text-fg-tertiary">{thread.approvalHint}</p>}
      </header>

      {loading && <div className="px-4 py-3 text-xs text-fg-tertiary">读取这条流…</div>}

      {threadError && (
        <div className="px-4 py-3 text-xs text-rose-600">
          头部事实读取失败：{threadError}（这不等于「这条流不存在」，本面板无法判断）
        </div>
      )}
      {dispositionsError && (
        <div className="px-4 py-3 text-xs text-rose-600">
          决定记录读取失败：{dispositionsError}（这不等于「没有决定」）
        </div>
      )}
      {eventsError && (
        <div className="px-4 py-3 text-xs text-rose-600">
          事件读取失败：{eventsError}（这不等于「这条流没有发生过事」）
        </div>
      )}

      {!loading && !threadError && !eventsError && !dispositionsError && timeline.length === 0 && (
        <div className="px-4 py-3 text-xs text-fg-tertiary">
          {refId.startsWith('agent:')
            // 缺陷 C 的裁定（B4-3）：**agent 轴不登记生命周期事件**。
            // agent 是「主体」，不是「发生了什么」——它的启停/状态已经在 agents 表与审计里，
            // 再往 triggers 写一份就是同一事实的第二个写者。所以这里必须把口径说清楚，
            // 不能让一个空白面板被读成「这个 agent 什么都没经历过」。
            ? 'agent 是主体而不是事件：这条轴不登记生命周期事件。它经手过的事（每件都有自己的来龙去脉）在该 agent 详情的「来龙去脉」区块里逐条展开。'
            : '这条流还没有事件或决定记录，只有下面的当前状态。'}
        </div>
      )}

      <ol className="space-y-3 px-4 py-3">
        {timeline.map(node =>
          node.kind === 'event'
            ? <EventNode key={`e-${node.event.id}`} e={node.event} />
            : <DecisionNode key={`d-${node.decision.id}`} d={node.decision} />,
        )}
        {thread && <CurrentStateNode t={thread} />}
      </ol>
    </section>
  );
}
