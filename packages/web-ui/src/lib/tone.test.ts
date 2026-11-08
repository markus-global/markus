import { describe, it, expect } from 'vitest';
import {
  TONE, entityTone, taskTone, requirementTone, priorityTone, waitTone,
  type Tone,
} from './tone.ts';

/**
 * 这个测试守的不是「颜色值」，而是**含义**：
 *   ① 一个观察到的颜色只能对应一种含义（任何两个不同 tone 的 chip 不得相同）；
 *   ② 同名不同义必须不同色（task.pending ≠ requirement.pending）；
 *   ③ 「需不需要我」的判定在实体之间一致（review/submitted 都是等你 → attention）。
 *
 * Owner 2026-11-08：「不同的颜色应该有不同的意义，并且在不同地方颜色的意义应该统一」。
 */

const ALL: Tone[] = ['attention', 'active', 'blocked', 'success', 'danger', 'neutral'];

describe('tone — 六个色调，一个含义', () => {
  it('每个 tone 的四种落点类名互不相同（否则「看颜色认含义」不成立）', () => {
    for (const field of ['chip', 'dot', 'solid', 'text', 'border', 'surface', 'btn', 'hex'] as const) {
      const values = ALL.map(t => TONE[t][field]);
      expect(new Set(values).size, `tone.${field} 出现重复值：${values.join(' | ')}`).toBe(ALL.length);
    }
  });

  it('用户不需要动手的语义（active / success / neutral）不得与「等你」同色', () => {
    const attention = TONE.attention.chip;
    for (const t of ['active', 'success', 'neutral'] as Tone[]) {
      expect(TONE[t].chip).not.toBe(attention);
    }
  });
});

describe('taskTone — 按「要不要我动手」分类，而不是按状态名分类', () => {
  it('待验收 = 等你（attention），返工 = agent 的活（active）', () => {
    expect(taskTone('review')).toBe('attention');
    expect(taskTone('revision')).toBe('active');
  });

  it('进行中 = active；完成 = success；失败/被拒 = danger；排队/取消/归档 = neutral', () => {
    expect(taskTone('in_progress')).toBe('active');
    expect(taskTone('completed')).toBe('success');
    expect(taskTone('failed')).toBe('danger');
    expect(taskTone('rejected')).toBe('danger');
    expect(taskTone('pending')).toBe('neutral');
    expect(taskTone('cancelled')).toBe('neutral');
    expect(taskTone('archived')).toBe('neutral');
  });

  it('阻塞 = blocked（卡住）。不再有的「同一状态三处三色」', () => {
    expect(taskTone('blocked')).toBe('blocked');
  });

  it('未知状态退回 neutral —— 不编造含义', () => {
    expect(taskTone('some_future_status')).toBe('neutral');
    expect(taskTone(null)).toBe('neutral');
    expect(taskTone(undefined)).toBe('neutral');
  });
});

describe('同名不同义必须不同色', () => {
  it('task.pending（还没开始）≠ requirement.pending（等你批）', () => {
    expect(taskTone('pending')).toBe('neutral');
    expect(requirementTone('pending')).toBe('attention');
  });

  it('entityTone 把「实体 + 状态」一起看，而不是只看状态字符串', () => {
    expect(entityTone('task', 'pending')).toBe('neutral');
    expect(entityTone('requirement', 'pending')).toBe('attention');
    expect(entityTone('deliverable', 'submitted')).toBe('attention');
    expect(entityTone('unknown', 'review')).toBe('neutral');
  });
});

describe('优先级不占状态色', () => {
  it('只有 urgent 用 danger，其余一律 neutral', () => {
    expect(priorityTone('urgent')).toBe('danger');
    for (const p of ['high', 'medium', 'low', 'none', '', undefined]) {
      expect(priorityTone(p as string | undefined)).toBe('neutral');
    }
  });

  it('「紧急」与「阻塞」不共享颜色（否则并排时只能猜）', () => {
    expect(TONE[priorityTone('urgent')].chip).not.toBe(TONE[taskTone('blocked')].chip);
  });
});

describe('waitTone — 等越久越刺眼，但只借三档', () => {
  const hour = 3_600_000;
  it('1 小时内中性、超过 1 小时 attention、超过 24 小时 danger', () => {
    expect(waitTone(30 * 60_000)).toBe('neutral');
    expect(waitTone(2 * hour)).toBe('attention');
    expect(waitTone(25 * hour)).toBe('danger');
  });

  it('非法输入退回 neutral', () => {
    expect(waitTone(Number.NaN)).toBe('neutral');
    expect(waitTone(-1)).toBe('neutral');
  });
});
