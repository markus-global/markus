import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ActiveStreamRegistry } from '../src/active-stream-registry.js';

class MockResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  body = '';
  writeHead() { this.headersSent = true; }
  write(chunk: string) { this.body += chunk; return true; }
  end() { this.writableEnded = true; }
}

describe('ActiveStreamRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('replays buffered events on attach then live-tails', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'Hello' });
    session.push({ type: 'text_delta', text: ' world' });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('reattach');
    expect(res.body).toContain('Hello');
    expect(res.body).toContain(' world');

    session.push({ type: 'text_delta', text: '!' });
    expect(res.body).toContain('!');

    session.complete({ type: 'done', content: 'Hello world!' });
    expect(res.body).toContain('"type":"done"');
    expect((res as unknown as MockResponse).writableEnded).toBe(true);
  });

  it('status reports active while streaming and briefly after done (TTL reattach)', () => {
    const reg = new ActiveStreamRegistry();
    reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' });
    expect(reg.status('a1', 'sess1').active).toBe(true);
    expect(reg.status('a1', 'sess1').status).toBe('streaming');
    reg.getByAgentSession('a1', 'sess1')!.complete({ type: 'done', content: 'x' });
    // Still attachable within DONE_TTL so a late refresh can drain terminal done.
    expect(reg.status('a1', 'sess1').active).toBe(true);
    expect(reg.status('a1', 'sess1').status).toBe('done');
  });

  it('allows attach after done to replay terminal event', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'Hi' });
    session.complete({ type: 'done', content: 'Hi' });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('"type":"done"');
    expect((res as unknown as MockResponse).writableEnded).toBe(true);
  });

  it('emits UI snapshot on attach and skips historical ring text when snapshot exists', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    session.push({ type: 'text_delta', text: 'old-' });
    session.push({ type: 'agent_tool', tool: 'generate_image', phase: 'start' });
    session.setUiSnapshot({
      content: 'Hello from tools',
      segments: [
        { type: 'tool', tool: 'generate_image', status: 'done' },
        { type: 'text', content: 'Hello from tools' },
      ],
    });

    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    expect(res.body).toContain('"type":"snapshot"');
    expect(res.body).toContain('generate_image');
    expect(res.body).toContain('Hello from tools');
    // Historical text_delta must not be replayed (would duplicate snapshot text).
    expect(res.body).not.toContain('"text":"old-"');

    session.push({ type: 'text_delta', text: '!' });
    expect(res.body).toContain('"text":"!"');
  });

  // P1-3：重连流以前不发心跳 → 前端 60s stall 看门狗误判死连接并 cancel。
  it('P1-3: reattached stream emits 15s heartbeats so the stall watchdog is not tripped', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    const m = res as unknown as MockResponse;
    expect(m.body).not.toContain('"type":"heartbeat"');

    vi.advanceTimersByTime(15_000);
    expect(m.body).toContain('"type":"heartbeat"');

    // 60s 窗口（前端看门狗阈值）内应至少 4 帧心跳。
    vi.advanceTimersByTime(45_000);
    const beats = (m.body.match(/"type":"heartbeat"/g) ?? []).length;
    expect(beats).toBe(4);
  });

  it('P1-3: heartbeat stops once the stream completes (no timer leak)', () => {
    const reg = new ActiveStreamRegistry();
    const session = reg.register({
      streamId: 's1',
      agentId: 'a1',
      sessionId: 'sess1',
      messageId: 'm1',
    });
    const res = new MockResponse() as unknown as ServerResponse;
    session.attach(res, 0);
    const m = res as unknown as MockResponse;

    session.complete({ type: 'done', content: 'x' });
    const before = (m.body.match(/"type":"heartbeat"/g) ?? []).length;
    vi.advanceTimersByTime(120_000);
    const after = (m.body.match(/"type":"heartbeat"/g) ?? []).length;
    expect(after).toBe(before);
    expect(m.writableEnded).toBe(true);
  });
});

/**
 * 「这个会话在不在输出」的权威通知契约（2026-10-16）。
 *
 * 客户端此前用多个本地派生量**近似**这个事实（视图级 `sending`、400ms 最短展示闩、
 * 显示缓冲里的 `isStreaming`），寿命各不相同 → 切 tab 时顶部状态假亮「工作中」、
 * session tab 圆点消失。现在改为：注册表每次状态变化在**同一处**广播一次（经 WS
 * `session:stream_state`），客户端只读它。
 */
describe('ActiveStreamRegistry — 权威状态变化通知（唯一的存活性来源）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Change = { agentId: string; sessionId: string; streaming: boolean; status: string };
  const collect = (reg: ActiveStreamRegistry): Change[] => {
    const seen: Change[] = [];
    reg.setStateChangeListener((c) => seen.push(c as Change));
    return seen;
  };
  const last = (a: Change[]): Change => a[a.length - 1]!;

  it('register 发 true、complete 发 false 且各恰好一次', () => {
    const reg = new ActiveStreamRegistry();
    const seen = collect(reg);
    const s = reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' });
    expect(seen).toEqual([{ agentId: 'a1', sessionId: 'sess1', streaming: true, status: 'streaming' }]);
    s.complete({ type: 'done', content: 'x' });
    expect(seen).toEqual([
      { agentId: 'a1', sessionId: 'sess1', streaming: true, status: 'streaming' },
      { agentId: 'a1', sessionId: 'sess1', streaming: false, status: 'done' },
    ]);
  });

  it('cancel 与 error 终态都发 false', () => {
    const reg = new ActiveStreamRegistry();
    const seen = collect(reg);
    reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' }).cancel();
    expect(last(seen)).toEqual({ agentId: 'a1', sessionId: 'sess1', streaming: false, status: 'cancelled' });

    const seen2 = collect(reg);
    const s2 = reg.register({ streamId: 's2', agentId: 'a1', sessionId: 'sess2', messageId: 'm2' });
    s2.complete({ type: 'error', content: '' } as unknown as Parameters<typeof s2.complete>[0]);
    expect(seen2.map((c) => [c.streaming, c.status])).toEqual([[true, 'streaming'], [false, 'error']]);
  });

  it('TTL 释放（unregister）不补发 false —— 否则同会话换回合会出现无意义的 false→true 闪烁', () => {
    const reg = new ActiveStreamRegistry();
    const seen = collect(reg);
    const s = reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' });
    s.complete({ type: 'done', content: 'x' });
    const countBefore = seen.length;   // true + false
    vi.advanceTimersByTime(120_000);   // 越过 DONE_TTL_MS → dispose → unregister
    expect(reg.getByAgentSession('a1', 'sess1')).toBeUndefined();
    expect(seen.length).toBe(countBefore);
  });

  it('done 在 TTL 内 status().active 仍为 true，但通知里的 streaming 必须是 false', () => {
    // 「圆点滞留 90 秒」回归闸：广播口径若误用 status().active，本用例变红。
    const reg = new ActiveStreamRegistry();
    const seen = collect(reg);
    reg.register({ streamId: 's1', agentId: 'a1', sessionId: 'sess1', messageId: 'm1' })
      .complete({ type: 'done', content: 'x' });
    expect(reg.status('a1', 'sess1').active).toBe(true);   // 仍可重连
    expect(last(seen).streaming).toBe(false);              // 但已不在输出
  });
});
