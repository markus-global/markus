/**
 * ThreadView — 一条流的来龙去脉（实现文档 §5.3）。
 *
 * 会话消息 / 任务卡评论 / A2A DM / 路由决定合成同一条按时间排序的流：**只并排呈现，
 * 不合并、不改写正文** —— 消掉「追一件事要来回切三个界面」的成本。
 *
 * 三个来源：
 *   events        → 真实发生过的事（chat / comment / a2a），从 triggers 派生（不落表）
 *   dispositions  → 系统做过的判断（action + reason + actor）
 *   threads       → 当前状态（stage + taskStatus），派生快照，不是事件
 *
 * 前两类带真实 createdAt，参与排序；第三类没有时间戳，单独放末尾并明说它不是事件 ——
 * 把 stage 变化伪造成带时间戳的节点 = 拿今天的推断回填过去，会让人以为那是证据。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchThreadDispositions, fetchThreadEvents, fetchThreads } from '../api.ts';
import type { DispositionAPI, ThreadAPI, ThreadEventAPI } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { stageLabel, actionLabel, stageTone, refDisplay, refKindLabel, shortRef, waitPhrase, wouldAcceptVerdict, THREAD_GROUP_LABEL } from '../lib/threadPresentation.ts';
import { taskStatusLabel } from '../lib/stateVocabulary.ts';
import { entityNavTarget } from '../lib/threadNav.ts';

// 展示层唯一实现见 lib/threadPresentation.ts（E 区收敛）。
// 原先这里有一份与 InboxCard 平行的 STAGE_LABEL / ACTION_LABEL / 时长函数，
// 文案已经在生产上分叉过（两个待处理 stage 各自用了不同措辞），现均取自 lib。

/** 时间线用绝对时刻：相对时间在长列表里无法互相比先后。 */
function clockOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 事件类型 → 中文标签。集中一处，避免渲染处写 switch。 */
const EVENT_KIND_LABEL: Record<string, string> = {
  chat: '会话消息',
  comment: '任务评论',
  a2a: 'Agent 对话',
};

/** 时间线节点：真实发生过的一件事（来自 triggers，只追加不可修改）。 */
function EventNode({ e }: { e: ThreadEventAPI }) {
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
function DecisionNode({ d }: { d: DispositionAPI }) {
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
function CurrentStateNode({ th }: { th: ThreadAPI }) {
  // 参数名叫 `th` 而不是 `t`：`t` 在这个文件里是 i18n 函数，同名会让「治理态词」无从使用。
  const { t } = useTranslation();
  return (
    <li className="relative border-l border-dashed border-border-subtle pl-3">
      <span className="absolute -left-[3px] top-1.5 h-1.5 w-1.5 rounded-full bg-fg-tertiary" />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-tertiary">
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-fg-secondary">当前状态 · 派生快照</span><span>无时间戳</span>
      </div>
      {/* 两级显示，不是一个「·」串起来的平级三元组。
          `stage` 的主语是**这条流**；`taskStatus` 的主语是**流挂载的那个对象**（任务 / 需求 /
          会话都可能是），它取自 describeThread 的 `taskStatus: status ?? null`
          （org-manager/src/event-routes.ts），不是这条流自己的态。曾经两者拼在同一行、且写死
          「任务」二字，于是 `req_…` / `cs_…` 的流上会显示「任务 评审中」——主语是错的，
          读者也自然把「流在等你验收」读成「任务在等你验收」。 */}
      <p className="mt-1 text-sm text-fg-primary">
        这条流：{stageLabel(th.stage).label}
        {th.ownerAgent ? ` · 负责 ${th.ownerAgent}` : ' · 无负责 agent'}
      </p>
      {th.taskStatus && (
        <p className="mt-1 text-[11px] text-fg-secondary">
          {/* 对象类别由 ref 前缀决定（refDisplay → refKindLabel），不写死「任务」 */}
          挂载对象 {refDisplay(th.ref)} · 治理态 {taskStatusLabel(th.taskStatus, t)}
        </p>
      )}
      <p className="mt-1 text-[11px] text-fg-muted">
        依据 threads 表的 stage 与挂载对象的治理态，最后活动 {clockOf(th.lastActivity)}。这不是一条历史事件 ——
        主行只回答「这条流此刻在等谁」，第二行是挂载对象自己的治理态（两者允许不一致）。
      </p>
    </li>
  );
}

export function ThreadViewPage() {
  const [threads, setThreads] = useState<ThreadAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dispositions, setDispositions] = useState<DispositionAPI[]>([]);
  const [dLoading, setDLoading] = useState(false);
  const [dError, setDError] = useState<string | null>(null);
  const [events, setEvents] = useState<ThreadEventAPI[]>([]);

  // 排序：stageRank 小的先（在等人 → 排队 → 进行中 → 空闲），同级按最后活动新的先。
  const sorted = useMemo(() => [...threads].sort((a, b) => a.stageRank - b.stageRank || b.lastActivity - a.lastActivity), [threads]);
  /**
   * 分组 —— 让「为什么是这个顺序」一眼可见。
   *
   * 原来只有一个平铺列表 + 隐含的 stageRank 排序：13 条流排在一起，
   * 用户看不出「哪些现在需要我」。排序规则不显示出来，等于没有规则。
   * 分组同时把「空闲」这类**不需要动作**的流视觉降权，让需要处理的浮上来。
   */
  const groups = useMemo(() => {
    const isPerson = (s?: string | null) => !!s && s.startsWith('person:');
    const buckets = [
      { key: 'need', label: THREAD_GROUP_LABEL.waiting, hint: '在等你批准 / 回答 / 验收 / 解阻', items: sorted.filter(t => isPerson(t.stage)) },
      { key: 'active', label: THREAD_GROUP_LABEL.active, hint: 'agent 在跑，或在排队等资源', items: sorted.filter(t => !isPerson(t.stage) && t.stage !== 'none:idle') },
      { key: 'idle', label: THREAD_GROUP_LABEL.idle, hint: '回合已结束，等新事件', items: sorted.filter(t => !isPerson(t.stage) && t.stage === 'none:idle') },
    ];
    return buckets.filter(b => b.items.length > 0);
  }, [sorted]);
  const selected = useMemo(() => sorted.find(t => t.id === selectedId) ?? sorted[0] ?? null, [sorted, selectedId]);
  const selId = selected?.id ?? null;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchThreads()
      .then(r => {
        if (!alive) return;
        setThreads(r.threads ?? []);
        setError(null);
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // 从「等你处理」详情里点「看这条流的来龙去脉」进来时，要直接选中那条流。
  //
  // 为什么监听导航事件、而不是在挂载时读一次：App 会保留已挂载的页面（mountedPages），
  // 第二次进本页**组件不会重新挂载** —— 只跑一次的 effect 会让参数永远没被消费，
  // 而且残留在 localStorage 里，下一次从别处进来会莫名其妙跳到上次那条。
  // 交接机制与 openTask / installItem 同一套（markus_nav_*），不另造一种。
  useEffect(() => {
    const consume = () => {
      const wantRef = localStorage.getItem('markus_nav_threadRef');
      if (!wantRef) return;
      localStorage.removeItem('markus_nav_threadRef'); // 读完即清，避免陈旧跳转
      setThreads(cur => {
        const hit = cur.find(t => t.ref === wantRef);
        if (hit) setSelectedId(hit.id);
        return cur;
      });
    };
    consume(); // 首次进入（含直接带参数挂载）
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page?: string }>).detail;
      if (detail?.page === PAGE.THREAD) consume();
    };
    window.addEventListener('markus:navigate', onNav);
    return () => window.removeEventListener('markus:navigate', onNav);
  }, []);

  // 决定按流单独查：全局接口分不清「这条流一条都没有」和「读失败了」，这两件事必须分开说。
  useEffect(() => {
    if (!selId) { setDispositions([]); return; }
    let alive = true;
    setDLoading(true); setDError(null);
    fetchThreadDispositions(selId)
      .then(r => { if (alive) setDispositions(r.dispositions ?? []); })
      .catch(e => { if (alive) { setDispositions([]); setDError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (alive) setDLoading(false); });
    return () => { alive = false; };
  }, [selId]);

  // 事件与决定分开取：前者是「发生了什么」，后者是「系统做了什么判断」。
  // 两件事都能失败，但失败语义不同，混在一个请求里就分不清是哪一种。
  useEffect(() => {
    if (!selId) { setEvents([]); return; }
    let alive = true;
    fetchThreadEvents(selId)
      .then(r => { if (alive) setEvents(r.events ?? []); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [selId]);

  // 时间线只由真实 createdAt 排序；当前状态无时间戳，单独放末尾，不混进排序。
  //
  // events 与 dispositions 合流，而不是只显示其中一类：
  // 「谁评论了」和「系统为什么把这条挂给他」拼起来才是来龙去脉，
  // 只给其中一半等于让读者自己猜两段之间发生了什么。
  const timeline = useMemo(() => {
    const merged = [
      ...events.map(e => ({ kind: 'event' as const, at: e.createdAt, event: e })),
      ...dispositions.map(d => ({ kind: 'decision' as const, at: d.createdAt, decision: d })),
    ];
    return merged.sort((a, b) => a.at - b.at);
  }, [dispositions, events]);
  const now = Date.now();

  return (
    // `flex-1 min-h-0 overflow-auto` 是滚动的前提：App 的 <main> 是 overflow-hidden，
    // 页面自己不声明滚动区 → 超出视口的内容被裁掉且滚不动（Owner 实测「没法正常滚动」）。
    // 与 Work.tsx 等既有页面同一套容器约定，不另造。
    <div className="flex-1 min-h-0 overflow-auto">
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-3">
        <button
          onClick={() => navBus.navigate(PAGE.HOME)}
          className="mb-2 flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-primary transition-colors rounded-lg px-1.5 py-1 -ml-1.5 hover:bg-surface-overlay"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          概览
        </button>
        <h1 className="text-xl font-semibold text-fg-primary">Thread 视图</h1>
        <p className="mt-1 text-sm text-fg-secondary">一条流的来龙去脉，按时间合成一条流。</p>
      </header>

      {/* 时间线数据源是 `triggers` 的派生查询（thread_events 表已于 2026-11-03 删除）。
          没事件时不再挂一条全页告示，而是在时间线位置就地说明「这条流还没有事件」。 */}

      {loading && <div className="text-sm text-fg-tertiary">加载中…</div>}
      {error && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-600">读取流列表失败：{error}</div>}
      {!loading && !error && sorted.length === 0 && <div className="rounded-lg border border-border-subtle bg-surface-secondary p-6 text-sm text-fg-secondary">还没有流。外部来源（任务 / 需求 / 事件）接入后，每条流会在这里展开它的来龙去脉。</div>}

      {sorted.length > 0 && (
        <div className="flex flex-col gap-3 md:flex-row md:items-start">
          {/* 流列表：按「要不要我动手」分组，窄屏摞在上，宽屏在左 */}
          <div className="w-full shrink-0 space-y-3 md:w-80">
            {groups.map(g => (
              <section key={g.key}>
                <h2
                  className="mb-1.5 flex items-baseline gap-1.5 px-0.5 text-[11px] font-medium text-fg-tertiary"
                  title={g.hint}
                >
                  <span className="uppercase tracking-wide">{g.label}</span>
                  <span className="rounded bg-surface-overlay px-1 text-fg-muted">{g.items.length}</span>
                </h2>
                <ul className="space-y-1.5">
                  {g.items.map(t => {
                    const active = selected?.id === t.id;
                    return (
                      <li key={t.id} className="group relative">
                        <button
                          onClick={() => setSelectedId(t.id)}
                          className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                            active ? 'border-selected-border bg-selected-bg' : 'border-border-subtle bg-surface-secondary hover:bg-surface-elevated'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[11px] ${stageTone(t.stage)}`}>
                              {stageLabel(t.stage).label}
                            </span>
                            {/* 标题给两行：一件事的名字比它的 id 重要得多 */}
                            <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-fg-primary">
                              {t.title || t.detail || refDisplay(t.ref)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-tertiary">
                            <code className="shrink-0 text-fg-muted" title={t.ref}>{refDisplay(t.ref)}</code>
                            <span className="text-fg-muted">·</span>
                            <span className="truncate">{waitPhrase(t.stage, now - t.lastActivity)}</span>
                          </div>
                        </button>
                        {/* 打开真实实体：这是整页「有没有信息量」的关键 ——
                            看不懂 ref 没关系，点一下就到那张任务卡 / 那个 agent。
                            只有确定存在入口的才渲染成按钮，避免假链接。 */}
                        {(() => {
                          const nav = entityNavTarget(t.ref);
                          if (!nav) return null;
                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); navBus.navigate(nav.page as never, nav.params); }}
                              title={`打开${refKindLabel(t.ref)}`}
                              className="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[11px] text-fg-tertiary opacity-0 transition-opacity hover:bg-surface-overlay hover:text-fg-primary group-hover:opacity-100 focus:opacity-100"
                            >打开 ↗</button>
                          );
                        })()}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          {/* 时间线：只并排呈现，不改写任何正文 */}
          {selected && (
            <div className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-secondary">
              <div className="border-b border-border-subtle px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${stageTone(selected.stage)}`}>
                    {stageLabel(selected.stage).label}
                  </span>
                  <h2 className="truncate text-sm font-medium text-fg-primary">{selected.title || selected.ref}</h2>
                </div>
                <div className="mt-1 text-[11px] text-fg-tertiary">
                  <code title={selected.ref}>{refDisplay(selected.ref)}</code> · {selected.taskStatus ? `任务状态 ${selected.taskStatus}` : '无关联任务状态'} · 最后活动 {clockOf(selected.lastActivity)}
                </div>
                {selected.detail && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-fg-secondary">{selected.detail}</p>}
                {(selected.missingFacts?.length ?? 0) > 0 && <p className="mt-2 text-[11px] text-amber-600">部分事实未接线：{selected.missingFacts.join('、')} —— 当前状态是凭已有事实推断的。</p>}
                {selected.approvalHint && <p className="mt-1 text-[11px] text-fg-tertiary">{selected.approvalHint}</p>}
              </div>

              {dLoading && <div className="px-4 py-3 text-xs text-fg-tertiary">读取决定记录…</div>}
              {dError && <div className="px-4 py-3 text-xs text-rose-600">决定记录读取失败：{dError}（这不等于「没有决定」，本页无法判断）</div>}
              {!dLoading && !dError && timeline.length === 0 && <div className="px-4 py-3 text-xs text-fg-tertiary">这条流还没有事件或决定记录，只有下面的当前状态。</div>}

              <ol className="space-y-3 px-4 py-3">
                {timeline.map(node =>
                  node.kind === 'event'
                    ? <EventNode key={`e-${node.event.id}`} e={node.event} />
                    : <DecisionNode key={`d-${node.decision.id}`} d={node.decision} />,
                )}
                <CurrentStateNode th={selected} />
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
