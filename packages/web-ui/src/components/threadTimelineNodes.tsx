/**
 * 时间线节点的**唯一渲染实现**。
 *
 * 两个消费方：
 *   - `pages/ThreadView.tsx`      —— 全局检索页（主视图已降级为检索）
 *   - `components/ThreadTimeline.tsx` —— 任务 / 票据 / agent 详情里**就地**打开的面板
 *
 * 为什么必须只有一份：这两处原来各写一套节点渲染与文案（stage 词、时长短语），
 * 生产上真的分叉过 —— 概览说「等你回话」、Thread 视图说「等你回答」。
 * 判据与 `lib/threadPresentation.ts` 相同：**同一个事实可以有多个渲染点，
 * 但只能有一个实现。**（`scripts/architecture-guard.mjs` 会拦第二份。）
 *
 * 三条不变式（照抄原实现，改它就是改语义）：
 *   1. **只并排呈现，不改写正文**（契约 H3）：`summary` / `reason` 原样输出；
 *   2. 时间线只由真实 `createdAt` 排序；当前状态**没有时间戳**，单独放末尾并明说它不是事件
 *      —— 把派生状态伪造成带时间戳的节点，等于拿今天的推断回填过去；
 *   3. 决定节点里的「本可接单」是 observe 档位**唯一**的可观测面，判据必须来自
 *      `wouldAcceptVerdict()`，不能在渲染处另写一套真假判断（历史上判据写反过，
 *      于是这条提示从来没有显示过，且不报错）。
 */
import type { DispositionAPI, ThreadAPI, ThreadEventAPI } from '../api.ts';
import { actionLabel, shortRef, stageLabel, wouldAcceptVerdict } from '../lib/threadPresentation.ts';

/** 时间线用绝对时刻：相对时间在长列表里无法互相比先后。 */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 事件类型 → 人话。集中一处，避免渲染处写 switch。 */
export const EVENT_KIND_LABEL: Record<string, string> = {
  chat: '会话消息',
  comment: '任务评论',
  a2a: 'Agent 对话',
};

/** 时间线节点：真实发生过的一件事（来自 triggers，只追加不可修改）。 */
export function EventNode({ e }: { e: ThreadEventAPI }) {
  return (
    <li className="relative border-l border-border-subtle pl-3">
      <span className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-fg-secondary" />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-tertiary">
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-fg-secondary">
          {EVENT_KIND_LABEL[e.kind] ?? e.kind}
        </span>
        <span>{clockOf(e.createdAt)}</span>
        {e.actor && <span>· {e.actor}</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-fg-primary">{e.summary}</p>
    </li>
  );
}

/** 时间线节点之一：决定 —— 系统做了什么判断。 */
export function DecisionNode({ d }: { d: DispositionAPI }) {
  return (
    <li className="relative border-l border-border-subtle pl-3">
      <span className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-brand-500" />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-tertiary">
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-fg-secondary">决定 · {actionLabel(d.action)}</span>
        <span>{clockOf(d.createdAt)}</span><span>· {d.actor}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-fg-primary">{d.reason || '未记录理由'}</p>
      {wouldAcceptVerdict(d) === 'accept' && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700">
          <span className="shrink-0 font-medium">本可接单</span>
          <span className="text-amber-600/90">放行的话它会接下这件事，但当前档位没有动手。</span>
        </p>
      )}
      <p className="mt-1 text-[11px] text-fg-muted">触发 <code title={d.triggerId}>{shortRef(d.triggerId)}</code></p>
    </li>
  );
}

/** 时间线末节点：当前状态 = threads 的派生快照。无时间戳 → 不入排序，并明说它不是事件。 */
export function CurrentStateNode({ t }: { t: ThreadAPI }) {
  return (
    <li className="relative border-l border-dashed border-border-subtle pl-3">
      <span className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-fg-tertiary" />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-tertiary">
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-fg-secondary">当前状态 · 派生快照</span><span>无时间戳</span>
      </div>
      <p className="mt-1 text-sm text-fg-primary">
        {stageLabel(t.stage).label}{t.taskStatus ? ` · 任务 ${t.taskStatus}` : ''}
        {t.ownerAgent ? ` · 负责 ${t.ownerAgent}` : ' · 无负责 agent'}
      </p>
      <p className="mt-1 text-[11px] text-fg-muted">
        依据 threads 表的 stage / taskStatus，最后活动 {clockOf(t.lastActivity)}。这不是一条历史事件 —— 它只回答「此刻在等谁」。
      </p>
    </li>
  );
}
