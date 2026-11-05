import { useCallback, useEffect, useMemo, useState } from 'react';
import { stageLabel, formatRelative } from '../lib/threadPresentation.ts';
import { fetchThreads } from '../api.ts';
import type { ThreadAPI } from '../api.ts';

/**
 * 收件箱视图：**概览页与独立页共用同一份渲染**。
 *
 * 为什么要抽出来：概览页要和独立页显示同一批流，如果各写一套渲染，
 * 就会出现「同一个 stage 在概览是橙色、在独立页是蓝色」这类分叉，
 * 更糟的是筛选口径也会各自漂移（两个尺子量同一件事）。
 *
 * 两种密度：
 *  - `compact`：概览页用。只显示「在等人」的四类 stage，最多 N 条，一行一条。
 *  - `full`：独立页用。全部流 + 处置历史侧栏。
 */

// 展示层唯一实现见 lib/threadPresentation.ts（E 区收敛）。
// 原先这里有一份 STAGE_LABEL，与 ThreadView 那份已经在生产上分叉
// （两个待回答 stage 当时用了不同措辞，已收敛到 lib/threadPresentation）。
export { stageLabel };

/**
 * 「在等谁」角标 —— **唯一渲染点**。
 *
 * 为什么必须是组件而不是各处内联：任务板有两种渲染路径（看板卡片 / 列表行），
 * 曾经只给卡片加了角标，结果切到列表视图角标就凭空消失。同一个事实有两个写者，
 * 迟早会分叉。所有需要角标的地方都渲染这个组件，文案/配色只认 STAGE_LABEL。
 *
 * 只显示 person:*（在等人的四类）——working/idle 对一张任务卡没有信息量，
 * 给每张卡挂灰标签只会把真正需要人处理的信号洗掉。
 */
export function StageChip({ stage }: { stage?: string | null }) {
  if (!stage || !stage.startsWith('person:')) return null;
  const s = stageLabel(stage);
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 ${s.cls}`} title={s.hint}>
      {s.label}
    </span>
  );
}

export function isWaitingOnPerson(t: ThreadAPI): boolean {
  return t.stage.startsWith('person:');
}



/** 「有没有在等我的」——唯一判定点。铃铛、概览、独立页都调它，不各自 setTimeout/过滤。 */
export function countWaiting(list: ThreadAPI[]): number {
  return list.reduce((n, t) => (isWaitingOnPerson(t) ? n + 1 : n), 0);
}

export function useThreads() {
  const [threads, setThreads] = useState<ThreadAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { threads: rows } = await fetchThreads();
      // 排序键来自服务端（stageRank），客户端不再另做一套启发式
      setThreads([...rows].sort((a, b) => a.stageRank - b.stageRank || b.lastActivity - a.lastActivity));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  return { threads, loading, error, reload: load };
}

export function ThreadRow({
  thread,
  onClick,
  active,
}: {
  thread: ThreadAPI;
  onClick?: () => void;
  active?: boolean;
}) {
  const meta = stageLabel(thread.stage);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors hover:bg-surface-overlay/60 ${
        active ? 'bg-surface-overlay' : ''
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${meta.cls}`}>{meta.label}</span>
        <span className="text-xs font-medium text-fg-primary truncate">{thread.ref}</span>
        <span className="ml-auto text-[10px] text-fg-tertiary shrink-0">{formatRelative(thread.lastActivity)}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-fg-tertiary truncate">
        {thread.ownerAgent ? `负责人 ${thread.ownerAgent}` : '暂无负责人'} · {meta.hint}
        {thread.stageBasis === 'partial' && ' · 状态部分推断'}
      </div>
    </button>
  );
}

/**
 * 概览页用的紧凑卡：只呈现「在等我」的流。
 *
 * 空态不是留白，而是一句明确的话 —— 空卡片会让人怀疑功能坏了；
 * 明说「现在没有等你的」才让人放心离开。
 */
export function InboxCard({
  onViewAll,
  limit = 5,
}: {
  onViewAll?: () => void;
  limit?: number;
}) {
  const { threads, loading, error, reload } = useThreads();
  const waiting = useMemo(() => threads.filter(isWaitingOnPerson), [threads]);
  const shown = waiting.slice(0, limit);

  return (
    <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${waiting.length > 0 ? 'bg-amber-500 animate-pulse' : 'bg-fg-tertiary'}`} />
          <h3 className="text-sm font-semibold text-fg-primary">等你处理</h3>
          {!loading && waiting.length > 0 && (
            <span className="text-[11px] text-fg-tertiary">{waiting.length} 条</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void reload()}
            className="text-[11px] text-fg-tertiary hover:text-fg-secondary"
            title="刷新"
          >
            刷新
          </button>
          {onViewAll && (
            <button onClick={onViewAll} className="text-[11px] text-brand-400 hover:text-brand-300 font-medium">
              查看全部
            </button>
          )}
        </div>
      </div>

      {error && <div className="mx-4 mb-2 rounded bg-rose-500/10 text-rose-600 text-[11px] px-3 py-2">读取失败：{error}</div>}

      <div className="px-2 pb-3">
        {loading && <div className="px-3 py-3 text-[11px] text-fg-tertiary">加载中…</div>}
        {!loading && shown.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-fg-tertiary">
            {threads.length === 0
              ? '现在没有等你处理的流。任务与审批见下方；要让 agent 长期盯某个外部资源，让它用 resource_bind 声明。'
              : `共 ${threads.length} 条流，都不需要你介入（agent 正在处理或已结束）。`}
          </div>
        )}
        {shown.map(t => (
          <ThreadRow key={t.id} thread={t} onClick={onViewAll} />
        ))}
        {waiting.length > limit && onViewAll && (
          <button
            onClick={onViewAll}
            className="w-full text-center text-[11px] text-brand-400 hover:text-brand-300 py-2"
          >
            还有 {waiting.length - limit} 条 →
          </button>
        )}
      </div>
    </div>
  );
}
