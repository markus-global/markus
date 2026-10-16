import { describe, expect, it, vi } from 'vitest';
import { SessionStreamState } from './sessionStreamState.ts';

/**
 * 客户端存活性判据的**唯一**权威：服务端 WS `session:stream_state` 推送 + 批量轮询兜底。
 *
 * 这些用例锁死三件事，它们正是「同一事实多个来源」曾经失守的地方：
 *  ① 服务端事件按**服务端时间**排序，晚到的旧事件不得覆盖新状态；
 *  ② 服务端状态**始终**压过本地乐观提示（权威可否决派生）；
 *  ③ 只有真实变化才通知订阅者（否则 UI 会被无意义的 setState 抖醒）。
 */
describe('SessionStreamState — 存活性单一权威', () => {
  it('服务端事件设置状态；isStreaming / isAgentStreaming 都可读', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', true, 1000);
    expect(s.isStreaming('sess1')).toBe(true);
    expect(s.isAgentStreaming('a1')).toBe(true);
    expect(s.isStreaming('nope')).toBe(false);
    expect(s.isAgentStreaming('a2')).toBe(false);
  });

  it('晚到的旧服务端事件不覆盖新状态（按服务端时间排序）', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', false, 2000);   // 回合已结束
    s.applyServerState('a1', 'sess1', true, 1000);    // 迟到的“开始”，时间更早
    expect(s.isStreaming('sess1')).toBe(false);       // 权威保持“已结束”
    s.applyServerState('a1', 'sess1', true, 3000);    // 真正的新回合
    expect(s.isStreaming('sess1')).toBe(true);
  });

  it('服务端状态始终压过本地乐观提示（含 false 压 true）', () => {
    const s = new SessionStreamState();
    s.applyLocalOptimistic('a1', 'sess1', true);
    expect(s.isStreaming('sess1')).toBe(true);        // 本端立刻反馈
    s.applyServerState('a1', 'sess1', false, 5000);   // 权威说结束了
    expect(s.isStreaming('sess1')).toBe(false);
    s.applyLocalOptimistic('a1', 'sess1', true);      // 本地乐观不得翻案
    expect(s.isStreaming('sess1')).toBe(false);
  });

  it('本地乐观只在没有服务端条目时生效，且可自我覆盖', () => {
    const s = new SessionStreamState();
    s.applyLocalOptimistic('a1', 'sess1', true);
    expect(s.isStreaming('sess1')).toBe(true);
    s.applyLocalOptimistic('a1', 'sess1', false);     // 本端取消，仍是本地条目 → 生效
    expect(s.isStreaming('sess1')).toBe(false);
  });

  it('轮询结果按服务端事件对待（同一套排序/压过规则）', () => {
    const s = new SessionStreamState();
    s.applyLocalOptimistic('a1', 'sess1', true);
    s.reconcileFromServer('a1', { sess1: false, sess2: true }, 9000);
    expect(s.isStreaming('sess1')).toBe(false);
    expect(s.isStreaming('sess2')).toBe(true);
    // 迟到的推送（时间更早）不得覆盖轮询结果
    s.applyServerState('a1', 'sess1', true, 8000);
    expect(s.isStreaming('sess1')).toBe(false);
  });

  it('只有真实变化才通知订阅者（无变化的多写不触发）', () => {
    const s = new SessionStreamState();
    const seen = vi.fn();
    s.subscribe(seen);
    s.applyServerState('a1', 'sess1', true, 1000);
    s.applyServerState('a1', 'sess1', true, 1100);   // 同值 → 不通知
    s.applyServerState('a1', 'sess1', true, 900);    // 陈旧 → 不通知
    expect(seen).toHaveBeenCalledTimes(1);
    s.applyServerState('a1', 'sess1', false, 1200);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('已结束的旧条目会被回收，且回收不影响仍在流的会话（有界增长）', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'old', false, 1_000);
    s.applyServerState('a1', 'live', true, 1_000);
    s.prune(1_000 + 11 * 60_000, 10 * 60_000);        // 10 分钟前的已结束条目
    expect(s.isStreaming('old')).toBe(false);
    expect(s.hasEntry('old')).toBe(false);            // 已回收
    expect(s.isStreaming('live')).toBe(true);         // 仍在流 → 保留
  });

  it('退订后不再收到通知', () => {
    const s = new SessionStreamState();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    off();
    s.applyServerState('a1', 'sess1', true, 1000);
    expect(seen).not.toHaveBeenCalled();
  });
});
