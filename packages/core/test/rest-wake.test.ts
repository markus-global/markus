import { describe, it, expect } from 'vitest';
import {
  buildWakePayload,
  matchRestConditions,
  restConditionMatches,
  type WakeEvent,
} from '../src/rest-wake.js';

/**
 * 匹配逻辑决定「叫醒谁」。错了的两种形态都很坏：
 * 漏叫 → agent 永远不醒（静默失败）；错叫 → 无关 agent 被吵醒并白跑一轮 LLM。
 * 所以每条分支都要有正反两侧断言。
 */

const trig = (threadRef?: string): WakeEvent => ({
  kind: 'trigger',
  ...(threadRef ? { threadRef } : {}),
  summary: 's',
});

describe('restConditionMatches — trigger', () => {
  it('不指定 threadRef → 任何流的新 trigger 都命中', () => {
    expect(restConditionMatches({ kind: 'trigger' }, trig('gh:o/r#1'))).toBe(true);
    expect(restConditionMatches({ kind: 'trigger' }, trig('xhs:b1'))).toBe(true);
  });

  it('指定 threadRef → 只命中同一条流', () => {
    const cond = { kind: 'trigger' as const, threadRef: 'gh:o/r#1' };
    expect(restConditionMatches(cond, trig('gh:o/r#1'))).toBe(true);
    expect(restConditionMatches(cond, trig('gh:o/r#2'))).toBe(false);
  });

  it('事件 kind 不同 → 不算命中（stage 事件不该触发 trigger 条件）', () => {
    expect(restConditionMatches({ kind: 'trigger' }, { kind: 'stage', threadRef: 'a', stage: 'x', summary: 's' })).toBe(false);
  });
});

describe('restConditionMatches — stage / dependency', () => {
  it('stage 必须 ref 与 stage 双双相等', () => {
    const cond = { kind: 'stage' as const, threadRef: 'tsk_1', stage: 'review' };
    expect(restConditionMatches(cond, { kind: 'stage', threadRef: 'tsk_1', stage: 'review', summary: 's' })).toBe(true);
    // ref 对、stage 不对 → 不是我要等的那个阶段
    expect(restConditionMatches(cond, { kind: 'stage', threadRef: 'tsk_1', stage: 'completed', summary: 's' })).toBe(false);
    // stage 对、ref 不对 → 别人家的事
    expect(restConditionMatches(cond, { kind: 'stage', threadRef: 'tsk_2', stage: 'review', summary: 's' })).toBe(false);
  });

  it('dependency 按 taskId 精确匹配', () => {
    const cond = { kind: 'dependency' as const, taskId: 'tsk_1' };
    expect(restConditionMatches(cond, { kind: 'dependency', taskId: 'tsk_1', summary: 's' })).toBe(true);
    expect(restConditionMatches(cond, { kind: 'dependency', taskId: 'tsk_2', summary: 's' })).toBe(false);
  });
});

describe('restConditionMatches — timeout 不参与事件匹配', () => {
  it('timeout 条件永远不会被事件命中（它由 wakeAt/sweep 负责）', () => {
    const cond = { kind: 'timeout' as const, ms: 1000 };
    expect(restConditionMatches(cond, trig('any'))).toBe(false);
    expect(restConditionMatches(cond, { kind: 'stage', threadRef: 'a', stage: 'b', summary: 's' })).toBe(false);
    expect(restConditionMatches(cond, { kind: 'dependency', taskId: 't', summary: 's' })).toBe(false);
  });
});

describe('matchRestConditions — OR 语义与去重', () => {
  const ev = trig('gh:o/r#1');

  it('任一条件命中即算命中（OR，不是全部满足）', () => {
    const r = matchRestConditions(
      [{ id: 'r1', agentId: 'a', restWakeOn: [{ kind: 'stage', threadRef: 'zzz', stage: 'x' }, { kind: 'trigger', threadRef: 'gh:o/r#1' }] }],
      ev,
    );
    expect(r).toHaveLength(1);
  });

  it('一个等待者多条条件命中同一事件 → 只返回一次（不重复唤醒）', () => {
    const r = matchRestConditions(
      [{ id: 'r1', agentId: 'a', restWakeOn: [{ kind: 'trigger' }, { kind: 'trigger', threadRef: 'gh:o/r#1' }] }],
      ev,
    );
    expect(r).toHaveLength(1);
  });

  it('条件不匹配 → 不返回（不吵醒无关 agent）', () => {
    const r = matchRestConditions(
      [{ id: 'r1', agentId: 'a', restWakeOn: [{ kind: 'trigger', threadRef: 'other' }] }],
      ev,
    );
    expect(r).toHaveLength(0);
  });

  it('没有 wakeOn 的 rest → 跳过（不因字段缺失而误唤醒）', () => {
    const r = matchRestConditions([{ id: 'r1', agentId: 'a' }], ev);
    expect(r).toHaveLength(0);
  });

  it('多个 agent 各自匹配 → 都返回', () => {
    const r = matchRestConditions(
      [
        { id: 'r1', agentId: 'a', restWakeOn: [{ kind: 'trigger', threadRef: 'gh:o/r#1' }] },
        { id: 'r2', agentId: 'b', restWakeOn: [{ kind: 'trigger' }] },
      ],
      ev,
    );
    expect(r.map(x => x.id).sort()).toEqual(['r1', 'r2']);
  });
});

describe('buildWakePayload — 只给摘要，不给全部历史（C2.2）', () => {
  it('载荷含事件摘要与结构化字段', () => {
    const p = buildWakePayload(trig('gh:o/r#1'));
    expect(p).toContain('gh:o/r#1');
    expect(p).toContain('kind=trigger');
  });

  it('带上注册时写的 note（未来的自己需要这个上下文）', () => {
    expect(buildWakePayload(trig('x'), '等 CI 结果')).toContain('等 CI 结果');
  });

  it('明确要求先判断要不要动手，而不是醒来就干', () => {
    // 防的是「被叫醒就等于有活干」的误读——大多数事件其实不需要它出手
    expect(buildWakePayload(trig('x'))).toContain('不需要重读全部历史');
  });
});
