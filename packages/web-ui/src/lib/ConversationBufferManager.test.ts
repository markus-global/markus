import { describe, expect, it } from 'vitest';
import { ConversationBufferManager } from './ConversationBufferManager.ts';
import type { ChatMsg } from '../pages/ChatHelpers.ts';

function msg(id: string, sender: 'user' | 'agent', text: string, rawCreatedAt?: string): ChatMsg {
  return {
    id,
    sender,
    text,
    time: '12:00',
    ...(rawCreatedAt ? { rawCreatedAt } : {}),
  } as ChatMsg;
}

describe('ConversationBufferManager.applyLoadResult cache merge', () => {
  it('keeps DB order (user before agent) even when cache claims freshness', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';

    // Cache only holds the agent reply (e.g. from live WS streaming) — user row missing.
    mgr.updateMessages(
      'conv',
      () => [msg('a2', 'agent', 'long agent reply that makes cache "fresher"', '2026-08-02T07:05:00.000Z')],
      'sess_1',
    );

    // DB rows: user BEFORE agent (authoritative order).
    const dbMsgs = [
      msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
      msg('a2', 'agent', 'long agent reply that makes cache "fresher"', '2026-08-02T07:05:00.000Z'),
    ];

    const r = mgr.applyLoadResult('conv', 'sess_1', dbMsgs);
    expect(r.displayChanged).toBe(true);
    const ids = r.newMessages!.map(m => m.id);
    // User bubble must come before the agent reply — never behind it.
    expect(ids.indexOf('u1')).toBeLessThan(ids.indexOf('a2'));
    expect(ids).toEqual(['u1', 'a2']);
  });

  it('merges cache-only streaming tail after DB loads', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
        msg('tail', 'agent', 'streaming tail not yet in DB', '2026-08-02T07:06:00.000Z'),
      ],
      'sess_1',
    );

    const dbMsgs = [
      msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
      msg('a2', 'agent', 'committed reply', '2026-08-02T07:05:00.000Z'),
    ];

    const r = mgr.applyLoadResult('conv', 'sess_1', dbMsgs);
    const ids = r.newMessages!.map(m => m.id);
    expect(ids).toEqual(['u1', 'a2', 'tail']);
  });
});

describe('ConversationBufferManager multi-session stream isolation', () => {
  it('routes a stream from a PREVIOUS session away from the new-chat buffer when activeSession is re-pinned to placeholder', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    // Simulate newConversation(): resetConv deletes activeSession, then Team.tsx
    // re-pins it to the placeholder so stale streams can't mix into the fresh buffer.
    mgr.resetConv('agt_x');
    mgr.setActiveSession('agt_x', ConversationBufferManager.NEW_CHAT_ID);

    // Old session 'sess_old' is still streaming on the backend and its SSE events
    // keep arriving — they must be routed to sess_old's cache, NOT the new buffer.
    const rOld = mgr.updateMessages(
      'agt_x',
      () => [msg('a_old', 'agent', 'stale stream chunk', '2026-08-02T07:06:00.000Z')],
      'sess_old',
    );
    // displayChanged must stay false: the visible buffer is the placeholder chat.
    expect(rOld.displayChanged).toBe(false);
    expect(mgr.msgBuffers.get('agt_x')).toBeUndefined();

    // The new chat's own optimistic message (no session yet → placeholder) still
    // renders into the visible buffer.
    const rNew = mgr.updateMessages(
      'agt_x',
      () => [msg('u_new', 'user', 'fresh question', '2026-08-02T07:07:00.000Z')],
      null,
    );
    expect(rNew.displayChanged).toBe(true);
    expect(mgr.msgBuffers.get('agt_x')!.map(m => m.id)).toEqual(['u_new']);

    // No cross-session mixing in the visible buffer.
    const visibleIds = mgr.msgBuffers.get('agt_x')!.map(m => m.id);
    expect(visibleIds).not.toContain('a_old');
    expect(visibleIds).toContain('u_new');
  });
});
