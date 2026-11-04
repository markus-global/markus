/**
 * 「待办排序」契约的行为测试 —— 断言的是**顺序**，不是源码文本。
 *
 * 为什么必须写成行为测试：排序的实现可以被重写成任何形状（比较器 / 桶排序 / SQL ORDER BY），
 * 只要顺序符合契约就该绿。反过来，源码文本断言（`toContain('PRIORITY_WEIGHT')`）在改名后
 * 就失效，是纯栅栏，挡不住真正的回归。
 *
 * 每一条用例都能咬人：把 `compareTodoOrder` 的四段键任意一段改坏，至少一条会红
 * （已实测：删掉 stage 段 → 用例 1 红；把 `activityKey` 缺省值改成 0 → 用例 5 红）。
 */
import { describe, it, expect } from 'vitest';
import {
  compareTodoOrder,
  orderTodos,
  todoPriorityRank,
  todoStageRank,
  NO_PRIORITY_RANK,
  type TodoOrderInput,
} from './todo-order.js';

const T = 1_700_000_000_000;
const MIN = 60_000;

const row = (id: string, stage: string, priority: string | null, agoMs: number | null): TodoOrderInput => ({
  id,
  stage,
  priority,
  lastActivity: agoMs === null ? null : T - agoMs,
});

describe('orderTodos — 契约顺序（四段键）', () => {
  it('① stage 序压过优先级：一条「很多人以为该先」的紧急阻塞，仍排在审批之后', () => {
    // 这就是 2026-11-04 实测到的分叉现场：概览把 urgent 的 blocked 排第 1，API 把审批排在前。
    const urgentBlocked = row('tsk_blocked', 'person:blocked', 'urgent', 1 * MIN);
    const mediumApproval = row('tsk_approval', 'person:approval', 'medium', 5 * MIN);
    expect(orderTodos([urgentBlocked, mediumApproval]).map(r => r.id)).toEqual(['tsk_approval', 'tsk_blocked']);
  });

  it('① 完整的 person 四档顺序：approval → answer → review → blocked', () => {
    const rows = [
      row('d_blocked', 'person:blocked', null, 1 * MIN),
      row('c_review', 'person:review', null, 1 * MIN),
      row('b_answer', 'person:answer', null, 1 * MIN),
      row('a_approval', 'person:approval', null, 1 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['a_approval', 'b_answer', 'c_review', 'd_blocked']);
  });

  it('② 同一 stage 内：urgent → high → medium → low → 无优先级', () => {
    const rows = [
      row('e_none', 'person:review', null, 1 * MIN),
      row('d_low', 'person:review', 'low', 1 * MIN),
      row('c_medium', 'person:review', 'medium', 1 * MIN),
      row('b_high', 'person:review', 'high', 1 * MIN),
      row('a_urgent', 'person:review', 'urgent', 1 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['a_urgent', 'b_high', 'c_medium', 'd_low', 'e_none']);
  });

  it('③ 同 stage + 同优先级内：等得最久的在前（lastActivity 升序）', () => {
    const rows = [
      row('tsk_new', 'person:blocked', 'urgent', 1 * MIN),
      row('tsk_old', 'person:blocked', 'urgent', 300 * MIN),
      row('tsk_mid', 'person:blocked', 'urgent', 60 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_old', 'tsk_mid', 'tsk_new']);
  });

  it('④ 前 3 段全等时按 id 升序兜底 —— 保证「同一个输入只有一个序列」', () => {
    const rows = [
      row('tsk_c', 'person:blocked', null, 10 * MIN),
      row('tsk_a', 'person:blocked', null, 10 * MIN),
      row('tsk_b', 'person:blocked', null, 10 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_a', 'tsk_b', 'tsk_c']);
  });

  it('④ 幂等：已排好的序列再排一次不变（这就是「API 序 == 概览首屏序」的结构前提）', () => {
    const rows = [
      row('tsk_2', 'person:review', 'high', 5 * MIN),
      row('tsk_1', 'person:approval', null, 90 * MIN),
      row('apr_9', 'person:approval', 'urgent', 10 * MIN),
      row('tsk_3', 'person:blocked', 'urgent', 3 * MIN),
    ];
    const once = orderTodos(rows).map(r => r.id);
    const twice = orderTodos(orderTodos(rows)).map(r => r.id);
    expect(twice).toEqual(once);
  });

  it('④ 确定性：同一批输入的任意排列，排出来必须是同一个序列', () => {
    const rows = [
      row('tsk_x', 'person:blocked', 'urgent', 10 * MIN),
      row('tsk_y', 'person:blocked', 'urgent', 10 * MIN),
      row('tsk_z', 'person:approval', null, 200 * MIN),
      row('req_w', 'person:review', 'low', 0),
    ];
    const canonical = orderTodos(rows).map(r => r.id);
    const shuffled = [rows[3]!, rows[1]!, rows[2]!, rows[0]!];
    expect(orderTodos(shuffled).map(r => r.id)).toEqual(canonical);
    expect(orderTodos([...rows].reverse()).map(r => r.id)).toEqual(canonical);
  });
});

describe('orderTodos — 缺省值与未知值的落点', () => {
  it('缺 lastActivity 的排在同组最后，而不是排最前（把 0 当时间戳 = 排到 1970 的坑）', () => {
    const rows = [
      { id: 'tsk_unknown', stage: 'person:blocked', priority: 'urgent', lastActivity: null } as TodoOrderInput,
      row('tsk_known', 'person:blocked', 'urgent', 999 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_known', 'tsk_unknown']);
  });

  it('两条都没有 lastActivity 时不产生 NaN 比较（排序必须仍然确定）', () => {
    const rows = [
      { id: 'tsk_b', stage: 'person:blocked', priority: null, lastActivity: null } as TodoOrderInput,
      { id: 'tsk_a', stage: 'person:blocked', priority: null, lastActivity: undefined } as TodoOrderInput,
    ];
    expect(Number.isNaN(compareTodoOrder(rows[0]!, rows[1]!))).toBe(false);
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_a', 'tsk_b']);
  });

  it('未知 stage 回退为 none:idle：落在所有已知 stage 之后，且不抛错', () => {
    // 注意别把「同一档内的优先级」误当成 stage 比较：未知 stage 与 none:idle 同档，
    // 它们之间由优先级决定先后。要验的是「未知 stage 不越到 person:* 前面」。
    const rows = [
      { id: 'tsk_future', stage: 'person:some-new-stage', priority: 'urgent', lastActivity: T } as TodoOrderInput,
      row('tsk_blocked', 'person:blocked', null, 999 * MIN),
    ];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_blocked', 'tsk_future']);
    expect(todoStageRank('person:some-new-stage')).toBe(todoStageRank('none:idle'));
    expect(todoStageRank('person:some-new-stage')).toBeGreaterThan(todoStageRank('person:blocked'));
  });

  it('未知优先级排在同 stage 已知优先级之后', () => {
    expect(todoPriorityRank('whatever')).toBe(NO_PRIORITY_RANK);
    const rows = [row('tsk_low', 'person:review', 'low', 1 * MIN), row('tsk_odd', 'person:review', 'whatever', 99 * MIN)];
    expect(orderTodos(rows).map(r => r.id)).toEqual(['tsk_low', 'tsk_odd']);
  });
});

describe('orderTodos — 不修改入参', () => {
  it('返回新数组，原数组顺序不变（调用方常把 store 数组直接传进来）', () => {
    const rows = [row('tsk_b', 'person:blocked', null, 1 * MIN), row('tsk_a', 'person:approval', null, 5 * MIN)];
    const before = rows.map(r => r.id);
    const out = orderTodos(rows);
    expect(out).not.toBe(rows);
    expect(rows.map(r => r.id)).toEqual(before);
  });
});
