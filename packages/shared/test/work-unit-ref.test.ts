/**
 * 第八刀 C8-A —— `ref` → 实体键 / 会话身份的唯一派生。
 *
 * 为什么这些断言值得单独存在：C8-A 的根因不是「A2A 会话分裂」这个症状，而是
 * **「这件事是谁」有两个写者**（投递通道 vs WorkUnit）。所以真正的护栏是：
 * 「给定一个 ref，它能落到的实体集合与会话 id 只有一个答案」。任何试图把
 * `channel:` / 时间戳重新塞回实体或会话的改动，都必须在这里变红。
 */
import { describe, it, expect } from 'vitest';
import {
  WORK_UNIT_REF,
  entityKeysOfWorkUnitRef,
  turnSessionIdOfWorkUnitRef,
} from '../src/work-unit.js';

describe('WORK_UNIT_REF.a2a — 身份是「这件事」，不是「这次投递」', () => {
  it('同一实体两次投递得到同一个 ref（不再把 deliveryId 编进身份）', () => {
    const first = WORK_UNIT_REF.a2a('task:tsk_abc');
    const second = WORK_UNIT_REF.a2a('task:tsk_abc');
    expect(first).toBe(second);
    expect(first).toBe('a2a:task:tsk_abc');
  });

  it('ref 里带实体命名空间，调用方不必再猜', () => {
    expect(WORK_UNIT_REF.a2a('channel:dm:a2a:x:y')).toBe('a2a:channel:dm:a2a:x:y');
  });
});

describe('entityKeysOfWorkUnitRef — ref 属于哪个实体', () => {
  const cases: Array<[string, string[]]> = [
    ['task_tsk_a_r2', ['task:tsk_a']],
    ['a2a:task:tsk_a', ['task:tsk_a']],
    ['a2a:channel:dm:a2a:x:y', ['wu:a2a:channel:dm:a2a:x:y']],
    ['session:cs_123:r4', ['conv:cs_123']],
    ['delegation:task_tsk_a_r1#sub_1', ['wu:delegation:task_tsk_a_r1#sub_1']],
    ['something-new-entirely', ['wu:something-new-entirely']],
  ];

  for (const [ref, expected] of cases) {
    it(`${ref} → ${expected.join(', ')}`, () => {
      expect(entityKeysOfWorkUnitRef(ref)).toEqual(expected);
    });
  }

  it('a2a 的 channel 形态**不得**产出 channel: 键', () => {
    // 这是本卡的核心护栏：channel: 是投递通道身份。一旦这里吐出 channel:，
    // 下一个 transport（邮件 / webhook / 新 IM）就能用同样的写法再把会话劈开。
    const keys = entityKeysOfWorkUnitRef('a2a:channel:dm:a2a:x:y');
    expect(keys.some(k => k.startsWith('channel:'))).toBe(false);
  });

  it('永不返回空数组 —— 空键集在运行时会静默关掉互斥', () => {
    for (const [ref] of cases) {
      expect(entityKeysOfWorkUnitRef(ref).length).toBeGreaterThan(0);
    }
  });
});

describe('turnSessionIdOfWorkUnitRef — 这一轮跑进哪个记忆会话', () => {
  it('task ref 沿用既有会话命名（零迁移）', () => {
    expect(turnSessionIdOfWorkUnitRef('task_tsk_a_r2')).toBe('task_tsk_a_r2');
  });

  it('a2a 同一个 task 的三条消息派生同一个会话 id（本卡的可读数判据）', () => {
    const ids = [
      WORK_UNIT_REF.a2a('task:tsk_a'),
      WORK_UNIT_REF.a2a('task:tsk_a'),
      WORK_UNIT_REF.a2a('task:tsk_a'),
    ].map(turnSessionIdOfWorkUnitRef);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('a2a_task_tsk_a');
  });

  it('会话 id 只含安全字符（它同时是落盘文件名的一部分）', () => {
    const id = turnSessionIdOfWorkUnitRef('a2a:channel:dm:a2a:x:y');
    expect(id).toBeDefined();
    expect(id as string).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('不同实体 → 不同会话（不误合并）', () => {
    expect(turnSessionIdOfWorkUnitRef('a2a:task:tsk_a'))
      .not.toBe(turnSessionIdOfWorkUnitRef('a2a:task:tsk_b'));
  });

  it('chat 的 ref 不派生会话 —— 交回既有的 DB→内存绑定', () => {
    // 返回 undefined 明确表示「这个 ref 不带会话身份，走旧路径」，
    // 不是「没有会话」。把它当成 null 会话会让聊天回合平白换会话。
    expect(turnSessionIdOfWorkUnitRef('session:cs_123:r4')).toBeUndefined();
  });

  it('无法识别的 ref 不猜会话', () => {
    expect(turnSessionIdOfWorkUnitRef('delegation:x#y')).toBeUndefined();
  });
});
