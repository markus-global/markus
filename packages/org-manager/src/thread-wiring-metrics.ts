/**
 * Thread / Trigger 接线的**计数台账**（内存，进程级）。
 *
 * 为什么需要它：这一轮反复出现的失效模式是「机制存在、没人用」——`ensureThread` 没被调用、
 * `threadRepo` 没装配、`ingest()` 只有 webhook 调用者。这些都不是异常，**一个日志都没有**
 * （或者只有一条没人看的 warn）。所以把「实际发生了什么」变成可读数字，挂在 `/api/health`
 * 上：装配级缺陷会在第一次真实流量后立刻显形，而不是等验收时靠 grep 源码猜。
 *
 * 边界：只统计**结论**，不统计耗时；不落库（重启即清零——它是「这一进程里接线活不活」的
 * 体检表，不是历史台账；历史事实在 `triggers` / `threads` 两张表里）。
 */
import type { ThreadEnsureOutcome, ThreadEventOutcome } from './thread-ensure.js';

export interface ThreadWiringHealth {
  ensure: Record<ThreadEnsureOutcome, number>;
  event: Record<ThreadEventOutcome, number>;
  /**
   * 影子判定（`observe` 模式）按「入口 → 结论」两维聚合：
   * `{ 'task.comment': { deferred: 12, filtered: 1 }, … }`
   *
   * 这是「切换行为之前先看会变成什么」的唯一数据源 —— 切换的那张卡必须拿它做依据。
   */
  observed: Record<string, Record<string, number>>;
}

const counts: ThreadWiringHealth = {
  ensure: { ensured: 0, 'no-thread-repo': 0, failed: 0 },
  event: { recorded: 0, duplicate: 0, 'no-trigger-repo': 0, failed: 0 },
  observed: {},
};

export function bumpEnsure(outcome: ThreadEnsureOutcome): void {
  counts.ensure[outcome] += 1;
}

export function bumpEvent(outcome: ThreadEventOutcome): void {
  counts.event[outcome] += 1;
}

/** 影子判定的计数入口（`thread-observe.ts` 用）。 */
export function bumpObserved(link: string, outcome: string): void {
  const row = (counts.observed[link] ??= {});
  row[outcome] = (row[outcome] ?? 0) + 1;
}

/**
 * 读接线计数（`/api/health` 的 `threadWiring` 字段）。
 * 返回副本 —— 调用方改不到内部状态（否则 `/api/health` 就成了第二个写者）。
 */
export function threadWiringHealth(): ThreadWiringHealth {
  return {
    ensure: { ...counts.ensure },
    event: { ...counts.event },
    observed: Object.fromEntries(Object.entries(counts.observed).map(([k, v]) => [k, { ...v }])),
  };
}

/** 仅供测试：把计数清零，让用例之间不互相污染。 */
export function resetThreadWiringHealth(): void {
  for (const k of Object.keys(counts.ensure) as Array<ThreadEnsureOutcome>) counts.ensure[k] = 0;
  for (const k of Object.keys(counts.event) as Array<ThreadEventOutcome>) counts.event[k] = 0;
  counts.observed = {};
}
