/**
 * 守卫：**「哪个气泡是活的」由服务端点名，不由每行自带的快照决定。**
 *
 * 这是「气泡永远转圈」的结构性终点。原来的判据是
 *   `msgIsStreaming && liveStreamForView`
 * 而 `msgIsStreaming` 来自消息载荷上的副本 —— 它可能是**上一次断连时**持久化的
 * 中途快照。于是只要有一行带着陈旧的 true，且这个会话之后又有任何一次活跃，
 * 那一行就会重新点亮并永远转下去：它的 `isStreaming` 没有人会去清。
 *
 * 现在服务端的状态事件同时回答两个问题（在生成吗 / 哪个气泡在生成），
 * 于是不变量变成可判定的：**没有活跃回合 ⇒ 不可能有活跃气泡**。
 *
 * 负向对照：把 `shouldPaintStreamingBubble` 改回 `msgIsStreaming && liveStreamForView`，
 * 第 2 组用例立刻红。
 */
import { describe, it, expect } from 'vitest';
import { shouldPaintStreamingBubble } from './streamLiveness.ts';
import { SessionStreamState } from './sessionStreamState.ts';

describe('为了这条守卫的两种真实故障', () => {
  it('陈旧快照：会话有活跃流，但服务端指名的是 B —— A 不许再亮', () => {
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true,          // A 带着上一次断连时存下的 true
      liveStreamForView: true,       // 这个会话此刻确实在生成
      liveBubbleId: 'msg_B',         // 但服务端说「活的是 B」
      msgId: 'msg_A',
    })).toBe(false);

    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true,
      liveStreamForView: true,
      liveBubbleId: 'msg_B',
      msgId: 'msg_B',
    })).toBe(true);
  });

  it('没有活跃回合 ⇒ 不可能有活跃气泡（哪怕某行自称在流）', () => {
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true,
      liveStreamForView: false,
      liveBubbleId: null,
      msgId: 'msg_A',
    })).toBe(false);
  });

  it('服务端尚未指名时（本地乐观期 / 旧服务端）退回原判据，不退化成「永远不亮」', () => {
    expect(shouldPaintStreamingBubble({
      msgIsStreaming: true,
      liveStreamForView: true,
      liveBubbleId: null,
      msgId: 'msg_A',
    })).toBe(true);
  });
});

describe('SessionStreamState.liveBubbleId — 唯一活跃气泡的出口', () => {
  it('不在流时是 null（不出名任何气泡）', () => {
    const s = new SessionStreamState();
    expect(s.liveBubbleId('sess1')).toBeNull();
    s.applyServerState('a1', 'sess1', false, 1000, 'cm_abc');
    expect(s.liveBubbleId('sess1')).toBeNull();
  });

  it('在流时返回服务端点名的那个 id', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', true, 1000, 'cm_abc');
    expect(s.liveBubbleId('sess1')).toBe('cm_abc');
    expect(s.isStreaming('sess1')).toBe(true);
  });

  it('回合结束 → 立刻不出名任何气泡（不再有 400ms 尾巴）', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', true, 1000, 'cm_abc');
    s.applyServerState('a1', 'sess1', false, 2000, 'cm_abc');
    expect(s.liveBubbleId('sess1')).toBeNull();
  });

  it('同一会话换了一个回合 → 点名换到新的那条', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', true, 1000, 'cm_first');
    s.applyServerState('a1', 'sess1', false, 2000, 'cm_first');
    s.applyServerState('a1', 'sess1', true, 3000, 'cm_second');
    expect(s.liveBubbleId('sess1')).toBe('cm_second');
  });

  it('本地乐观提示不会抹掉已知的服务端 id', () => {
    const s = new SessionStreamState();
    s.applyServerState('a1', 'sess1', true, 1000, 'cm_abc');
    // 发送时的本地提示：不知道服务端铸的 id，但也不能把已知的丢掉
    s.applyLocalOptimistic('a1', 'sess1', true);
    expect(s.liveBubbleId('sess1')).toBe('cm_abc');
  });
});
