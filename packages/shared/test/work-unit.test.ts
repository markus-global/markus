/**
 * 第七刀 C7-A —— WorkUnit 矩阵与 `ref` 命名的纯行为断言（不依赖数据库）。
 *
 * 为什么要单独测矩阵：它是「一个不变量只有一个执行点」的那条不变量。矩阵写错
 * （例如允许 `archived → running`）不是风格问题，而是让归档变成可撤销的装饰，
 * 之后所有历史读数都会漂移。纯函数测试能在不起库的情况下锁死它。
 */
import { describe, it, expect } from 'vitest';
import {
  WU_TRANSITIONS,
  canTransitionWorkUnit,
  assertWorkUnitTransition,
  WorkUnitTransitionError,
  WORK_UNIT_STATUSES,
  isWorkUnitStatus,
  WORK_UNIT_REF,
} from '../src/work-unit.js';

describe('WU_TRANSITIONS', () => {
  it('archived 是终态：没有任何出边', () => {
    expect(WU_TRANSITIONS.archived).toEqual([]);
  });

  it('archived → running 非法（归档不可复活）', () => {
    expect(canTransitionWorkUnit('archived', 'running')).toBe(false);
    expect(() => assertWorkUnitTransition('archived', 'running', 'session:s1:r1'))
      .toThrow(WorkUnitTransitionError);
  });

  it('非法迁移的错误是结构化的：code + from/to，不靠解析文本', () => {
    try {
      assertWorkUnitTransition('archived', 'running', 'session:s1:r1');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as WorkUnitTransitionError;
      expect(e.code).toBe('invalid_work_unit_transition');
      expect(e.from).toBe('archived');
      expect(e.to).toBe('running');
      expect(e.allowed).toEqual([]);
    }
  });

  it('合法路径按计划 §2 全部可达', () => {
    expect(canTransitionWorkUnit('running', 'idle')).toBe(true);
    expect(canTransitionWorkUnit('running', 'paused_budget')).toBe(true);
    expect(canTransitionWorkUnit('running', 'terminated')).toBe(true);
    expect(canTransitionWorkUnit('idle', 'running')).toBe(true);
    expect(canTransitionWorkUnit('paused_budget', 'running')).toBe(true);
    expect(canTransitionWorkUnit('terminated', 'archived')).toBe(true);
  });

  it('矩阵覆盖面：每个状态都有定义（缺项会被当成「什么都不能做」而静默卡死）', () => {
    for (const status of WORK_UNIT_STATUSES) {
      expect(WU_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(WU_TRANSITIONS[status])).toBe(true);
    }
  });

  it('isWorkUnitStatus 拒绝未知值', () => {
    expect(isWorkUnitStatus('running')).toBe(true);
    expect(isWorkUnitStatus('archived')).toBe(true);
    expect(isWorkUnitStatus('paused')).toBe(false);
    expect(isWorkUnitStatus(undefined)).toBe(false);
  });
});

describe('WORK_UNIT_REF（唯一生成器）', () => {
  it('chat = session:<dbSessionId>:r<round>', () => {
    expect(WORK_UNIT_REF.chat('cs_abc', 3)).toBe('session:cs_abc:r3');
  });

  it('task 复用既有身份格式 task_<id>_r<round>（零迁移，不新造命名）', () => {
    expect(WORK_UNIT_REF.task('tsk_abc', 2)).toBe('task_tsk_abc_r2');
  });

  it('a2a = a2a:<channelKey>:<deliveryId>', () => {
    expect(WORK_UNIT_REF.a2a('dm:a2a:x:y', 'dlv_1')).toBe('a2a:dm:a2a:x:y:dlv_1');
  });

  it('不同 round 产生不同 ref（同一纪元不会被两轮复用）', () => {
    expect(WORK_UNIT_REF.chat('cs_1', 1)).not.toBe(WORK_UNIT_REF.chat('cs_1', 2));
  });
});