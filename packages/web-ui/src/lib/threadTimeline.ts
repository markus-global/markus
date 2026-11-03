/**
 * 时间线合流 + 「这条流有没有东西」的**唯一实现**。
 *
 * 为什么需要合流而不是并排几个列表：读者要回答的是「这件事先后发生了什么」。
 * 「谁评论了」（事件）、「系统为什么把它挂给他」（判断）、「这条流投给谁办过」（投递）
 * 拼起来才是来龙去脉；只给其中一部分，等于让读者自己猜另外两段之间发生了什么。
 *
 * 三条纪律（改它就是改语义）：
 *   1. 只按真实时刻排序 —— 没有任何一条线可以插到前面去；
 *   2. 同一毫秒按「投递 → 事件 → 判断」：投递是输入，事件是它的登记，判断是对事件的反应，
 *      把反应排在输入前面会读成因果倒置；
 *   3. **失败不等于空**：来源的 `state` 与 `items` 分开表达，「读取失败」永远不能
 *      被渲染成「没有记录」（这曾是生产缺陷：`.catch(() => [])` 把失败吞成确定性的「还没有」）。
 *
 * 单一判据：**「有没有东西」只能由 `timelineView()` 回答**。UI 不得再各自写
 * `length === 0` —— 那是同一问题的第二份实现，迟早会和这里对不上。
 */
import type { DispositionAPI, EnrichedMailboxItem, ThreadEventAPI } from '../api.ts';

/**
 * 时间线节点的三种来源。取值集合固定：行形状由 `kind` 决定，
 * **不随来源数量变化**（否则列表缓存键会漂移）。
 */
export type TimelineNode =
  | { kind: 'delivery'; at: number; delivery: EnrichedMailboxItem }
  | { kind: 'event'; at: number; event: ThreadEventAPI }
  | { kind: 'decision'; at: number; decision: DispositionAPI };

export type TimelineKind = TimelineNode['kind'];

/** 来源的读取状态。'error' 与「读到 0 条」是两件不同的事，绝不允许折叠成一个空数组。 */
export type SourceState = 'loading' | 'ok' | 'error';

export interface TimelineSource<T> {
  state: SourceState;
  items: readonly T[];
}

export interface TimelineSources {
  events: TimelineSource<ThreadEventAPI>;
  dispositions: TimelineSource<DispositionAPI>;
  /** 投递：这条流在某个 agent 邮箱里收到过的条目。缺省 = 该视角不读投递（**不是**「没有投递」）。 */
  deliveries?: TimelineSource<EnrichedMailboxItem>;
}

export interface TimelineView {
  /** 仍有来源在读 */
  loading: boolean;
  /** 读取失败的来源（人话标签） */
  failures: string[];
  /** 按时间升序合并后的行 */
  rows: TimelineNode[];
  /** **唯一**「这条流什么都没有」的判据：不在读取中、没有失败、也没有行 */
  empty: boolean;
}

/** 来源 → 人话。集中一处，避免各渲染处各写一套。 */
const SOURCE_LABEL = { events: '事件', dispositions: '判断', deliveries: '投递' } as const;

/**
 * 这份数据属于当前的流吗？不属于就一律当作「在读取」。
 *
 * 为什么需要它：React 的 effect 在首帧渲染**之后**才跑。所以挂载时、以及切到另一条流时，
 * 手上有两种「旧值」——初始值（空）与上一条流的数据。两者若直接被 timelineView() 计算，
 * 首帧就会得出 `empty: true` 并画出空态（或先闪一下别人的内容），下一帧才纠正。
 * 用户看到的就是「一瞬间闪了个丑东西」。
 *
 * 判据：「还没读」与「确实没有」不能共用一个值（契约 R2）；而「这份数据是给哪条流的」
 * 只有调用方知道，所以由它作为入参传进来，而不是在组件里再写一遍三处判断。
 */
export function sourceForRef<T>(
  ref: string | null,
  loadedForRef: string | null,
  source: TimelineSource<T>,
): TimelineSource<T> {
  return loadedForRef === ref ? source : { state: 'loading', items: [] };
}

/** 同一毫秒内的固定次序：输入（投递）< 登记（事件）< 反应（判断）。 */
const KIND_RANK: Record<TimelineKind, number> = { delivery: 0, event: 1, decision: 2 };

/** ISO 字符串或 epoch ms → epoch ms，非法值折成 0（排序里 NaN 会让顺序变成未定义）。 */
export function toEpochMs(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 合流并按时间升序。
 *
 * 不做去重、不改写正文：两条内容相同的事件是真的发生过两次（契约 H3：只并排呈现）。
 */
export function mergeTimeline(
  events: readonly ThreadEventAPI[],
  dispositions: readonly DispositionAPI[],
  deliveries: readonly EnrichedMailboxItem[] = [],
): TimelineNode[] {
  const merged: TimelineNode[] = [
    ...deliveries.map(d => ({ kind: 'delivery' as const, at: toEpochMs(d.queuedAt), delivery: d })),
    ...events.map(e => ({ kind: 'event' as const, at: toEpochMs(e.createdAt), event: e })),
    ...dispositions.map(d => ({ kind: 'decision' as const, at: toEpochMs(d.createdAt), decision: d })),
  ];
  return merged.sort((a, b) => a.at - b.at || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

/**
 * 一次调用回答三件事：还在读吗 / 哪几个来源失败了 / 有没有东西。
 *
 * `empty` 只有在「没在读、没有失败、也没有行」时才为 true —— 因此调用方
 * 不需要（也不允许）自己再判一次 `rows.length === 0`。
 */
export function timelineView(sources: TimelineSources): TimelineView {
  const order = ['events', 'dispositions', 'deliveries'] as const;
  const failures: string[] = [];
  let loading = false;
  for (const key of order) {
    const src = sources[key];
    if (!src) continue;
    if (src.state === 'loading') loading = true;
    if (src.state === 'error') failures.push(SOURCE_LABEL[key]);
  }
  const rows = mergeTimeline(
    sources.events.items,
    sources.dispositions.items,
    sources.deliveries?.items ?? [],
  );
  return { loading, failures, rows, empty: !loading && failures.length === 0 && rows.length === 0 };
}
