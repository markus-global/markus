import { describe, it, expect } from 'vitest';
import { decideOnStreamEnd, normalizeServerStreamStatus } from './streamLiveness';

/**
 * 事故回归（2026-10-08）：Team Chat 流式气泡「动态边框消失、内容却还在更新」。
 *
 * 单一不变量：`isStreaming`（"这轮还在跑"）**只能由服务端终态、或用户显式 stop 改写。
 * 传输结束永远不构成改写理由。**
 *
 * 服务端在 SSE 断开时并不会停止生成（SSE_DISCONNECT_FORCE_STOP_MS = 45min，日志
 * "detaching (agent continues)"）。旧代码在传输一旦结束时就把本回合就地定型
 * （setSending(false) + clearStreamSession + finalizeLastStreamingBubble），
 * 由此连锁出：边框被抹掉、在途气泡被 DB 合并当"陈旧副本"丢弃、ghost sweep 反噬。
 */
describe('decideOnStreamEnd —— 传输结束不是回合结束', () => {
  // ── 事故本身 ──────────────────────────────────────────────────────────────
  it('传输断了、但权威说还在 streaming → 必须续接，绝不结案', () => {
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: 'streaming' }))
      .toBe('reattach');
  });

  it('问不到权威（null）→ 歧义时永不结案，宁可多续一次', () => {
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: null }))
      .toBe('reattach');
  });

  // ── 真正的终态 ────────────────────────────────────────────────────────────
  it('收到了服务端终态事件 → 结案', () => {
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: true, serverStatus: 'done' }))
      .toBe('finalize');
  });

  it.each(['done', 'error', 'stopped', 'idle', 'not_found'] as const)(
    '传输结束 + 权威说 %s → 结案',
    (status) => {
      expect(decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: status }))
        .toBe('finalize');
    },
  );

  // ── 终态事件优先于状态接口的 TTL ───────────────────────────────────────────
  it('已收到 done，但状态接口因 TTL 仍报 streaming → 终态事件优先，结案', () => {
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: true, serverStatus: 'streaming' }))
      .toBe('finalize');
  });

  // ── 用户显式停止 ──────────────────────────────────────────────────────────
  it('用户显式 stop → 结案，即使权威说还在流', () => {
    expect(decideOnStreamEnd({ aborted: true, sawTerminal: false, serverStatus: 'streaming' }))
      .toBe('finalize');
  });

  it('用户在终态之后又 stop → 仍然结案（幂等）', () => {
    expect(decideOnStreamEnd({ aborted: true, sawTerminal: true, serverStatus: 'done' }))
      .toBe('finalize');
  });

  // ── 反向保护：不得把"还在跑"判成结束 ───────────────────────────────────────
  it('只有「传输结束 + 权威明确说非 streaming」这些组合才允许结案', () => {
    const cases = [
      { aborted: false, sawTerminal: false, serverStatus: 'done' as const },
      { aborted: false, sawTerminal: false, serverStatus: 'error' as const },
      { aborted: false, sawTerminal: false, serverStatus: 'idle' as const },
      { aborted: false, sawTerminal: false, serverStatus: 'not_found' as const },
    ];
    for (const c of cases) expect(decideOnStreamEnd(c)).toBe('finalize');

    // 其余任何组合都不得结案为"轮次已结束"而未问过权威
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: 'streaming' }))
      .toBe('reattach');
    expect(decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: null }))
      .toBe('reattach');
  });

  // ── 结构保证：传输层的理由在判据里没有入口 ─────────────────────────────────
  it('传输层的中断理由（attach 冷却 / socket 断开 / 看门狗）都不构成结案理由', () => {
    expect([
      decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: 'streaming' }),
      decideOnStreamEnd({ aborted: false, sawTerminal: false, serverStatus: null }),
    ]).toEqual(['reattach', 'reattach']);
  });
});

describe('normalizeServerStreamStatus —— 未知取值必须归为"问不到"', () => {
  it('协议里出现未知状态时归为 null，绝不当成"已结束"', () => {
    // 服务端把该字段声明为开放 string；每新增一个状态，老客户端若把它当成终态
    // 就会误判在途回合结束 —— 正是 2026-10-08 那类事故的复发路径。
    expect(normalizeServerStreamStatus('some_future_state')).toBeNull();
    expect(normalizeServerStreamStatus(undefined)).toBeNull();
    expect(normalizeServerStreamStatus('')).toBeNull();
    expect(decideOnStreamEnd({
      aborted: false,
      sawTerminal: false,
      serverStatus: normalizeServerStreamStatus('some_future_state'),
    })).toBe('reattach');
  });

  it('已声明的取值原样透传', () => {
    for (const s of ['streaming', 'done', 'error', 'stopped', 'idle', 'not_found'] as const) {
      expect(normalizeServerStreamStatus(s)).toBe(s);
    }
  });
});
