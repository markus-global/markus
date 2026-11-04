import { describe, it, expect } from 'vitest';
import { mergeTimeline, sourceForRef, timelineView, toEpochMs } from './threadTimeline.ts';
import type { DispositionAPI, EnrichedMailboxItem, ThreadEventAPI } from '../api.ts';

/**
 * 时间线的**唯一实现**：合流规则 + 「有没有东西」的单一判据。
 *
 * 这组测试咬的是两件在 B4-3 之前真实错掉的事：
 *   1. **同一件事两个来源二选一**（有事件就不显示投递，有投递就断言「还没有正式事件记录」）
 *      → 现在必须同时出现，且按真实时刻交错；
 *   2. **抓取失败被伪装成空态**（`.catch(() => [])` + 一句「还没有」）
 *      → 现在 `empty` 在「有来源读失败」时**必须为 false**。
 *
 * 把实现怎么改坏会让它变红：
 *   · 把 `mergeTimeline` 里的 deliveries 那一行删掉 → 「合并三类事实」用例红；
 *   · 把 `timelineView.empty` 改回只看 `rows.length === 0` → 「读失败不得算空」用例红；
 *   · 把同一毫秒的次序改成 `decision` 在前 → 「同一毫秒输入先于反应」用例红。
 */
const ev = (id: string, at: number, summary = id): ThreadEventAPI => ({
  id,
  threadId: 'tsk_1',
  kind: 'chat',
  summary,
  createdAt: at,
});

const dsp = (id: string, at: number): DispositionAPI => ({
  id,
  triggerId: 'trg_1',
  threadId: 'thr_1',
  action: 'dispatch',
  reason: id,
  matchedRule: null,
  wouldAccept: null,
  actor: 'router',
  createdAt: at,
});

const dlv = (id: string, atIso: string): EnrichedMailboxItem => ({
  id,
  agentId: 'agt_1',
  sourceType: 'task_assignment',
  priority: 1,
  status: 'completed',
  payload: { summary: id },
  metadata: {},
  queuedAt: atIso,
});

describe('mergeTimeline', () => {
  it('按时间升序合流两类事实', () => {
    const nodes = mergeTimeline([ev('e2', 200), ev('e1', 100)], [dsp('d1', 150), dsp('d2', 300)]);
    expect(nodes.map(n => (n.kind === 'event' ? n.event.id : n.kind === 'decision' ? n.decision.id : n.delivery.id)))
      .toEqual(['e1', 'd1', 'e2', 'd2']);
  });

  it('同一毫秒：事件排在前（输入先于反应）', () => {
    const nodes = mergeTimeline([ev('e1', 500)], [dsp('d1', 500)]);
    expect(nodes[0]!.kind).toBe('event');
    expect(nodes[1]!.kind).toBe('decision');
  });

  it('两类都为空时返回空数组（不是 null —— 调用方不必两套判空）', () => {
    expect(mergeTimeline([], [])).toEqual([]);
  });

  it('不去重、不丢行：两条内容相同的事件都保留（它们真的发生过两次）', () => {
    const nodes = mergeTimeline([ev('e1', 1, '同一句话'), ev('e2', 2, '同一句话')], []);
    expect(nodes).toHaveLength(2);
  });

  it('合并三类事实：事件与投递同时出现，且按真实时刻交错（不再二选一）', () => {
    const nodes = mergeTimeline(
      [ev('trg_2', Date.parse('2026-11-03T10:30:00Z'))],
      [dsp('dsp_1', Date.parse('2026-11-03T10:40:00Z'))],
      [dlv('mbx_1', '2026-11-03T10:00:00Z'), dlv('mbx_2', '2026-11-03T10:50:00Z')],
    );
    expect(nodes.map(n => n.kind)).toEqual(['delivery', 'event', 'decision', 'delivery']);
    expect(nodes.map(n => (n.kind === 'delivery' ? n.delivery.id : n.kind === 'event' ? n.event.id : n.decision.id)))
      .toEqual(['mbx_1', 'trg_2', 'dsp_1', 'mbx_2']);
  });

  it('同一毫秒的次序固定为 投递 → 事件 → 判断（输入 → 登记 → 反应）', () => {
    const at = 1_700_000_000_000;
    const nodes = mergeTimeline([ev('e1', at)], [dsp('d1', at)], [dlv('m1', new Date(at).toISOString())]);
    expect(nodes.map(n => n.kind)).toEqual(['delivery', 'event', 'decision']);
  });

  it('投递的非法时间不产生 NaN 排序（顺序仍是确定的）', () => {
    expect(toEpochMs('not-a-date')).toBe(0);
    const nodes = mergeTimeline([ev('e1', 5)], [], [dlv('bad', 'not-a-date'), dlv('ok', '1970-01-01T00:00:00.001Z')]);
    expect(nodes.map(n => (n.kind === 'delivery' ? n.delivery.id : 'ev'))).toEqual(['bad', 'ok', 'ev']);
  });
});

describe('timelineView —— 「有没有东西」的单一判据', () => {
  it('三类都读到、有行 → 不空，且不再是三条并行列表', () => {
    const view = timelineView({
      events: { state: 'ok', items: [ev('e1', 100)] },
      dispositions: { state: 'ok', items: [] },
      deliveries: { state: 'ok', items: [dlv('m1', new Date(300).toISOString())] },
    });
    expect(view.empty).toBe(false);
    expect(view.loading).toBe(false);
    expect(view.failures).toEqual([]);
    expect(view.rows.map(n => n.kind)).toEqual(['event', 'delivery']);
  });

  it('**读失败不得算空**：某个来源 error 且一行都没有时，empty 必须为 false', () => {
    const view = timelineView({
      events: { state: 'error', items: [] },
      dispositions: { state: 'ok', items: [] },
      deliveries: { state: 'ok', items: [] },
    });
    expect(view.empty).toBe(false);
    expect(view.failures).toEqual(['事件']);
  });

  it('还在读也不算空（读取中就说「没有」＝对读者撒谎）', () => {
    const view = timelineView({
      events: { state: 'loading', items: [] },
      dispositions: { state: 'ok', items: [] },
    });
    expect(view.loading).toBe(true);
    expect(view.empty).toBe(false);
  });

  it('三个来源都读到、都没有行 → 这才是「真的没有」', () => {
    const view = timelineView({
      events: { state: 'ok', items: [] },
      dispositions: { state: 'ok', items: [] },
      deliveries: { state: 'ok', items: [] },
    });
    expect(view.empty).toBe(true);
    expect(view.rows).toEqual([]);
  });

  it('不传投递 = 该视角不读投递，不是「投递读取失败」', () => {
    const view = timelineView({
      events: { state: 'ok', items: [ev('e1', 1)] },
      dispositions: { state: 'ok', items: [] },
    });
    expect(view.failures).toEqual([]);
    expect(view.empty).toBe(false);
  });

  it('失败与有数据共存：行照旧渲染，失败照样报出来（不互相掩盖）', () => {
    const view = timelineView({
      events: { state: 'ok', items: [ev('e1', 1)] },
      dispositions: { state: 'error', items: [] },
      deliveries: { state: 'ok', items: [] },
    });
    expect(view.rows).toHaveLength(1);
    expect(view.failures).toEqual(['判断']);
    expect(view.empty).toBe(false);
  });
});

describe('sourceForRef — 旧数据不许被当成「已读完」', () => {
  const loaded = { state: 'ok' as const, items: [ev('e1', 1)] };

  it('数据属于当前流 → 原样返回', () => {
    expect(sourceForRef('tsk_1', 'tsk_1', loaded)).toBe(loaded);
  });

  it('刚切到另一条流（手上还是上一条的）→ 当「在读取」，不先闪旧内容', () => {
    expect(sourceForRef('tsk_2', 'tsk_1', loaded)).toEqual({ state: 'loading', items: [] });
  });

  it('首帧（还没标过属于哪条流）→ 当「在读取」，不画空态', () => {
    const view = timelineView({
      events: sourceForRef('tsk_1', null, { state: 'ok', items: [] }),
      dispositions: sourceForRef('tsk_1', null, { state: 'ok', items: [] }),
      deliveries: sourceForRef('tsk_1', null, { state: 'ok', items: [] }),
    });
    // 关键：empty 必须为 false。否则首帧就会画出「这件事还没有任何记录」。
    expect(view.loading).toBe(true);
    expect(view.empty).toBe(false);
  });
});
