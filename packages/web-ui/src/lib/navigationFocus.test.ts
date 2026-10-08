import { describe, expect, it } from 'vitest';
import { navigationOwnsSessionChoice, type NavigationFocus } from './navigationFocus.ts';

const focus = (over: Partial<NavigationFocus> = {}): NavigationFocus => ({
  messageId: 'm1',
  mode: 'direct',
  agentId: 'agt_b',
  sessionId: 'sess_target',
  ...over,
});

const view = (
  over: Partial<{ chatMode: 'direct' | 'channel' | 'dm'; agentId: string }> = {},
) => ({ chatMode: 'direct', agentId: 'agt_b', ...over }) as {
  chatMode: 'direct' | 'channel' | 'dm';
  agentId: string;
};

describe('navigationOwnsSessionChoice —— 导航在途时，换视图的 effect 必须让出「会话选择与加载」', () => {
  it('没有在途导航 → 不拦（effect 照常挑会话）', () => {
    expect(navigationOwnsSessionChoice(null, view())).toBe(false);
    expect(navigationOwnsSessionChoice(undefined, view())).toBe(false);
  });

  it('目标就是本视图的 direct 会话 → 拦（否则两个加载同时在途，窗口边界会互相污染）', () => {
    expect(navigationOwnsSessionChoice(focus(), view())).toBe(true);
  });

  it('preferMain（审阅完成后落主会话）也算「有确定的会话目标」→ 拦', () => {
    expect(navigationOwnsSessionChoice(focus({ sessionId: null, preferMain: true }), view())).toBe(true);
  });

  it('导航没指会话（只说要回该 Agent）→ 不拦，交给 effect 的正常路径', () => {
    expect(navigationOwnsSessionChoice(focus({ sessionId: null, preferMain: false }), view())).toBe(false);
    expect(navigationOwnsSessionChoice(focus({ sessionId: undefined }), view())).toBe(false);
  });

  it('别的 Agent 的导航 → 不拦', () => {
    expect(navigationOwnsSessionChoice(focus({ agentId: 'agt_other' }), view())).toBe(false);
  });

  it('目标是频道 / 当前是频道视图 → 不拦（频道没有会话选择，加载正是导航的前提）', () => {
    expect(navigationOwnsSessionChoice(focus({ mode: 'channel', channel: 'general' }), view())).toBe(false);
    expect(navigationOwnsSessionChoice(focus(), view({ chatMode: 'channel' }))).toBe(false);
  });
});
