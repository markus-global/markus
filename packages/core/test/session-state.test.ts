import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStateRegistry } from '../src/session-state.js';

/**
 * P1 回归：以「会话」为单位的处理状态机（后端唯一真相源）。
 *
 * 需求原文（老板 2026-10-06）：
 *  - 每个 session 在后端有一个状态机；
 *  - 处理在消息创建/进入处理时就标记「处理中」；
 *  - 只有 end_turn / 取消 才结束；
 *  - agent 的「工作中」= 各 session 状态的并集。
 *
 * 本文件钉死单调、幂等、会话隔离与安全 no-op 这些纯逻辑不变量。
 * 与 agent 的接线（status 派生）在 agent-session-invariant 测试中覆盖。
 */
describe('SessionStateRegistry — 会话状态机（P1）', () => {
  let reg: SessionStateRegistry;
  beforeEach(() => {
    reg = new SessionStateRegistry();
  });

  it('begin → processing；anyProcessing 为真；processingSince 只设一次', () => {
    expect(reg.anyProcessing()).toBe(false);
    reg.begin('sess_a', 'item1');
    expect(reg.getSession('sess_a')?.state).toBe('processing');
    const since1 = reg.getSession('sess_a')!.processingSince;
    expect(typeof since1).toBe('number');
    reg.begin('sess_a', 'item2');
    expect(reg.getSession('sess_a')!.processingSince).toBe(since1);
    expect(reg.anyProcessing()).toBe(true);
  });

  it('会话内多条 item：全部 settle 后才回 idle（会话内串行）', () => {
    reg.begin('sess_a', 'i1');
    reg.begin('sess_a', 'i2');
    reg.settle('sess_a', 'i1', 'ok');
    expect(reg.getSession('sess_a')!.state).toBe('processing');
    reg.settle('sess_a', 'i2', 'ok');
    expect(reg.getSession('sess_a')!.state).toBe('idle');
    expect(reg.anyProcessing()).toBe(false);
  });

  it('不同会话互相独立：任一 processing ⇒ anyProcessing 为真（并集）', () => {
    reg.begin('sess_a', 'i1');
    reg.begin('sess_b', 'i2');
    reg.settle('sess_a', 'i1', 'ok');
    expect(reg.getSession('sess_a')!.state).toBe('idle');
    expect(reg.getSession('sess_b')!.state).toBe('processing');
    expect(reg.anyProcessing()).toBe(true);
  });

  it('settle 未知会话 / 未知 item 不得抛错（安全 no-op，绝不误伤其它会话）', () => {
    expect(() => reg.settle('nope', 'x', 'ok')).not.toThrow();
    reg.begin('sess_a', 'i1');
    expect(() => reg.settle('sess_a', 'other', 'ok')).not.toThrow();
    expect(reg.getSession('sess_a')!.state).toBe('processing');
  });

  it('error 终止：记录 lastOutcome，但回到 idle（error 不粘滞）', () => {
    reg.begin('sess_a', 'i1');
    reg.settle('sess_a', 'i1', 'error', 'boom');
    const s = reg.getSession('sess_a')!;
    expect(s.state).toBe('idle');
    expect(s.lastOutcome).toBe('error');
    expect(s.lastErrorMessage).toBe('boom');
  });

  it('cancelled 终止：记录 lastOutcome=cancelled，回到 idle', () => {
    reg.begin('sess_a', 'i1');
    reg.settle('sess_a', 'i1', 'cancelled');
    const s = reg.getSession('sess_a')!;
    expect(s.state).toBe('idle');
    expect(s.lastOutcome).toBe('cancelled');
  });

  it('activeSessionKeys 只列正在处理的会话；list 含全部（含已 idle 的历史）', () => {
    reg.begin('sess_a', 'i1');
    reg.begin('sess_b', 'i2');
    reg.settle('sess_b', 'i2', 'ok');
    expect(reg.activeSessionKeys().sort()).toEqual(['sess_a']);
    expect(reg.list().map(s => s.sessionKey).sort()).toEqual(['sess_a', 'sess_b']);
  });

  it('空 sessionKey 被忽略（防御：调用方未解析出会话身份）', () => {
    reg.begin('', 'i1');
    expect(reg.anyProcessing()).toBe(false);
    expect(reg.activeSessionKeys()).toEqual([]);
  });
});
