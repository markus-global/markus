import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  emitThreadWake,
  setThreadWakeDeliverer,
  hasThreadWakeDeliverer,
} from '../src/thread-wake-bus.js';
import { pendingCallbackRegistry, type PendingCallback } from '../src/pending-callback.js';

/**
 * 这条总线的职责是「把事件变成一次投递」。
 *
 * 两类失败都很难查：
 *  - 投不出去（等待者被静默吞掉 → timeout 兜底也没了，永久消失）
 *  - 投出去的内容变成「重读全部历史」（rest 退化成心跳）
 * 所以下面每条都盯住这两件事。
 */

const reg = (over: Partial<PendingCallback> & { id: string; agentId: string }): PendingCallback => ({
  originSessionId: 'sess_1',
  type: 'rest',
  deliveryMode: 'in_session',
  registeredAt: Date.now(),
  timeoutMs: 60_000,
  ...over,
  restWakeOn: over.restWakeOn ?? [{ kind: 'trigger' }],
});

describe('emitThreadWake', () => {
  beforeEach(() => {
    for (const cb of pendingCallbackRegistry.getAllRests()) {
      pendingCallbackRegistry.resolve(cb.id);
    }
    setThreadWakeDeliverer(undefined);
  });
  afterEach(() => {
    setThreadWakeDeliverer(undefined);
  });

  it('没有投递器时返回 0，且**不吞掉**等待者（留给 timeout 兜底）', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1' }));
    expect(hasThreadWakeDeliverer()).toBe(false);

    expect(emitThreadWake({ kind: 'trigger', threadRef: 'x', summary: 's' })).toBe(0);

    // 关键断言：等待者必须还在。否则它既没被唤醒、也不会再超时——永久消失。
    expect(pendingCallbackRegistry.getByAgentId('a1')).toHaveLength(1);
  });

  it('注册投递器后：命中即投递，且等待者被取走', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1' }));
    const spy = vi.fn();
    setThreadWakeDeliverer(spy);

    const n = emitThreadWake({ kind: 'trigger', threadRef: 'x', summary: 'S' });

    expect(n).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pendingCallbackRegistry.getByAgentId('a1')).toHaveLength(0);
  });

  it('投递载荷只含摘要，不含历史正文（否则 rest 退化成心跳）', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1', note: '等 CI' }));
    const spy = vi.fn();
    setThreadWakeDeliverer(spy);

    emitThreadWake({ kind: 'trigger', threadRef: 'gh:o/r#1', summary: 'PR 有新评论' });

    const payload = spy.mock.calls[0]![2] as string;
    expect(payload).toContain('PR 有新评论');
    expect(payload).toContain('等 CI');
    expect(payload).toContain('不需要重读全部历史');
  });

  it('自激排除：自己制造的事件不叫醒自己', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1' }));
    const spy = vi.fn();
    setThreadWakeDeliverer(spy);

    // a1 自己发的消息
    const n = emitThreadWake({ kind: 'trigger', threadRef: 'x', actorAgentId: 'a1', summary: 's' });

    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    // 也不该被取走——它等的下一个事件可能是别人发来的
    expect(pendingCallbackRegistry.getByAgentId('a1')).toHaveLength(1);
  });

  it('自激排除只影响动作人自己，不影响同一条流上的其他人', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1' }));
    pendingCallbackRegistry.register(reg({ id: 'r2', agentId: 'a2' }));
    const spy = vi.fn();
    setThreadWakeDeliverer(spy);

    const n = emitThreadWake({ kind: 'trigger', threadRef: 'x', actorAgentId: 'a1', summary: 's' });

    expect(n).toBe(1);
    expect(pendingCallbackRegistry.getByAgentId('a1')).toHaveLength(1); // 自己还在等
    expect(pendingCallbackRegistry.getByAgentId('a2')).toHaveLength(0); // 别人被叫醒
  });

  it('一个投递失败不拖累同批其他人', () => {
    pendingCallbackRegistry.register(reg({ id: 'r1', agentId: 'a1' }));
    pendingCallbackRegistry.register(reg({ id: 'r2', agentId: 'a2' }));
    const spy = vi.fn((cb: PendingCallback) => {
      if (cb.agentId === 'a1') throw new Error('boom');
    });
    setThreadWakeDeliverer(spy);

    expect(() => emitThreadWake({ kind: 'trigger', summary: 's' })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
