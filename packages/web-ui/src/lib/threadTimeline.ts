/**
 * 时间线合流：**唯一实现**。
 *
 * 为什么需要合流而不是并排两个列表：读者要回答的是「这件事先后发生了什么」，
 * 「谁评论了」和「系统为什么把这条挂给他」拼起来才是来龙去脉；只给一半，
 * 等于让读者自己猜两段之间发生了什么。
 *
 * 两条纪律：
 *   1. 只按真实 `createdAt` 排序 —— 没有任何一条线可以插到前面去；
 *   2. 当前状态（threads 派生快照）**不进排序**：它没有时间戳，属于「此刻在等谁」，
 *      由渲染层单独放在末尾并显式说明。伪造时间戳会让推断变成「证据」。
 */
import type { DispositionAPI, ThreadEventAPI } from '../api.ts';

export type TimelineNode =
  | { kind: 'event'; at: number; event: ThreadEventAPI }
  | { kind: 'decision'; at: number; decision: DispositionAPI };

/**
 * 合流并按时间升序。
 *
 * 时间相同者保持「事件先于决定」：事件是输入，决定是对它的反应，
 * 同一毫秒里把反应排在输入前面会读成因果倒置。
 */
export function mergeTimeline(
  events: readonly ThreadEventAPI[],
  dispositions: readonly DispositionAPI[],
): TimelineNode[] {
  const merged: TimelineNode[] = [
    ...events.map(e => ({ kind: 'event' as const, at: e.createdAt, event: e })),
    ...dispositions.map(d => ({ kind: 'decision' as const, at: d.createdAt, decision: d })),
  ];
  return merged.sort((a, b) => a.at - b.at || (a.kind === 'event' ? -1 : 1));
}
