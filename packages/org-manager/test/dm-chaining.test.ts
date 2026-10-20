import { describe, it, expect } from 'vitest';
import { shouldChainDmReply } from '../src/dm-chaining.js';

describe('shouldChainDmReply', () => {
  it('always chains when a HUMAN spoke in the channel', () => {
    expect(shouldChainDmReply('收到', 'human')).toEqual({ chain: true, reason: 'human_sender' });
    expect(shouldChainDmReply('', 'human').chain).toBe(true);
  });

  it('does NOT chain agent status reports (the measured storm shape)', () => {
    // This is the exact content type that produced 43 turns / 35 min.
    const report =
      'Git 规范已更新，你的开发位已建好：/Users/x/workspace/wt。当前分支是 feat/x，基线已同步。';
    expect(shouldChainDmReply(report, 'agent')).toEqual({ chain: false, reason: 'no_ask' });
  });

  it('does NOT chain pure acknowledgements', () => {
    for (const ack of ['收到', '好的。', 'OK', 'noted.', '明白！']) {
      expect(shouldChainDmReply(ack, 'agent').chain).toBe(false);
    }
  });

  it('does NOT chain when the author explicitly says no reply is needed', () => {
    expect(shouldChainDmReply('仅同步：契约已冻结，无需回复。', 'agent')).toEqual({
      chain: false,
      reason: 'explicit_no_reply',
    });
  });

  it('chains when the reply actually asks the peer something', () => {
    const cases = [
      'Can you confirm the schema diff before I merge?',
      '请确认一下 §11.6 的口径。',
      '这个值要不要改成 cents？',
      'Which branch should I branch from?',
      'pipeline 红了，麻烦帮我看看日志。',
    ];
    for (const text of cases) {
      expect(shouldChainDmReply(text, 'agent').chain, text).toBe(true);
    }
  });

  it('does not chain an empty agent reply', () => {
    expect(shouldChainDmReply('   ', 'agent')).toEqual({ chain: false, reason: 'empty' });
  });
});
