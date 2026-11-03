import { describe, it, expect } from 'vitest';
import { mergeTimeline } from './threadTimeline.ts';
import type { DispositionAPI, ThreadEventAPI } from '../api.ts';

/**
 * 时间线合流的唯一实现（全局检索页与就地打开的面板共用）。
 *
 * 这组测试守的是「来龙去脉」的可读性本身：
 *   - 只按真实 createdAt 排序（不允许任何一条线插队）；
 *   - 同一毫秒里「事件先于决定」（事件是输入，决定是对它的反应）；
 *   - 不做去重、不改写正文 —— 并排呈现是契约 H3 的要求。
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

describe('mergeTimeline', () => {
  it('按时间升序合流两类事实', () => {
    const nodes = mergeTimeline([ev('e2', 200), ev('e1', 100)], [dsp('d1', 150), dsp('d2', 300)]);
    expect(nodes.map(n => (n.kind === 'event' ? n.event.id : n.decision.id))).toEqual(['e1', 'd1', 'e2', 'd2']);
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
});
