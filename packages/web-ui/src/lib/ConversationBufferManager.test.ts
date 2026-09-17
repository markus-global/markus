import { describe, expect, it } from 'vitest';
import { ConversationBufferManager } from './ConversationBufferManager.ts';
import type { ChatMsg } from '../pages/ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

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
        { ...msg('tail', 'agent', 'streaming tail not yet in DB', '2026-08-02T07:06:00.000Z'), isStreaming: true },
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

  it('regression: streaming tail with optimistic (earlier) timestamp never lands above the user message', () => {
    // Multi-tab direct mode: user sends M in tab A, switches to tab B, then back
    // to A while the agent is still streaming. On return the DB already persisted
    // M (server time LATER than the optimistic send-time), but the agent reply is
    // cache-only with an OPTIMISTIC rawCreatedAt (earlier). Chronological merge
    // previously inserted the streaming agent bubble BEFORE the persisted user
    // message — "user bubble appears below the agent streaming bubble".
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';

    // Cache: user M (server id) + still-streaming agent tail. The tail's
    // rawCreatedAt is the optimistic send-time (EARLIER than DB persist time).
    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hello', '2026-08-02T07:05:00.000Z'),
        { ...msg('tail', 'agent', 'partial stream', '2026-08-02T07:04:30.000Z'), isStreaming: true },
      ],
      'sess_1',
    );

    // DB only has the persisted user message (agent reply not flushed yet).
    const dbMsgs = [
      msg('u1', 'user', 'hello', '2026-08-02T07:05:00.000Z'),
    ];

    const r = mgr.applyLoadResult('conv', 'sess_1', dbMsgs);
    const ids = r.newMessages!.map(m => m.id);
    // User bubble MUST come before the streaming agent tail.
    expect(ids.indexOf('u1')).toBeLessThan(ids.indexOf('tail'));
    expect(ids).toEqual(['u1', 'tail']);
  });

  it('allows a DB load for a session while ANOTHER session of the same agent is streaming (phase is per-convKey, guard is per-session)', () => {
    // Multi-tab direct mode: session A is streaming (agent-wide phase becomes
    // 'streaming'), user Ctrl+Tab switches to session B and its history loads
    // from the DB. Previously the per-convKey `phase !== 'streaming'` gate
    // rejected the write → B looked like a brand-new empty chat ("new chat"
    // state) even though it has history. The guard must be the SESSION's own
    // streaming membership, not the agent-wide phase.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    mgr.setActiveSession('agt_x', 'sess_b');
    mgr.loadingSession = 'sess_b';
    mgr.beginStream('agt_x');               // agent-wide phase → streaming
    mgr.addStreamSession('agt_x', 'sess_a'); // but the streaming SESSION is A

    const dbMsgs = [
      msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
      msg('a1', 'agent', 'old reply', '2026-08-02T07:05:00.000Z'),
    ];
    const r = mgr.applyLoadResult('agt_x', 'sess_b', dbMsgs);
    expect(r.displayChanged).toBe(true);
    expect(r.newMessages!.map(m => m.id)).toEqual(['u1', 'a1']);
  });

  it('still blocks the DB load display for the SAME session that is streaming', () => {
    // The original streaming-phase protection must stay: when loading the very
    // session whose stream is in flight, DB rows go to cache only so the live
    // stream content in the display buffer is never clobbered mid-flight.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    mgr.setActiveSession('agt_x', 'sess_a');
    mgr.loadingSession = 'sess_a';
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_a');

    const dbMsgs = [msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z')];
    const r = mgr.applyLoadResult('agt_x', 'sess_a', dbMsgs);
    expect(r.displayChanged).toBe(false);
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

  it('resetConv with repinTo keeps stale PREVIOUS-session streams out of the fresh buffer (regression: order bug)', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';

    // Scenario: user clicks "new conversation" while 'sess_old' is still streaming.
    // resetConv(key, NEW_CHAT_ID) must atomically reset AND re-pin so the running
    // old stream routes to its own cache, not the fresh display buffer.
    mgr.resetConv('agt_x', ConversationBufferManager.NEW_CHAT_ID);

    // Stale stream from the old session keeps pushing SSE events.
    const rOld = mgr.updateMessages(
      'agt_x',
      () => [msg('a_old', 'agent', 'stale chunk', '2026-08-02T07:06:00.000Z')],
      'sess_old',
    );
    expect(rOld.displayChanged).toBe(false);
    expect(mgr.msgBuffers.get('agt_x')).toBeUndefined();

    // Fresh new-chat optimistic message still lands in the visible buffer.
    const rNew = mgr.updateMessages(
      'agt_x',
      () => [msg('u_new', 'user', 'hello', '2026-08-02T07:07:00.000Z')],
      null,
    );
    expect(rNew.displayChanged).toBe(true);
    expect(mgr.msgBuffers.get('agt_x')!.map(m => m.id)).toEqual(['u_new']);

    // If repinTo were NOT applied (the old bug), activeSession would be undefined
    // and the stale stream would have been treated as same-session and written
    // into the display buffer. Assert it stayed clean.
    expect(mgr.activeSession.get('agt_x')).toBe(ConversationBufferManager.NEW_CHAT_ID);
    expect(mgr.msgBuffers.get('agt_x')!.some(m => m.id === 'a_old')).toBe(false);
  });

  it('resetConv repins to an existing session id when switching to it (remember/evolution path)', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    // handleRememberConfirm: resetConv(key, childSession.id) after creating the child.
    mgr.resetConv('agt_x', 'sess_child');

    // Parent session stream still running — must NOT leak into the child buffer.
    const rParent = mgr.updateMessages(
      'agt_x',
      () => [msg('a_parent', 'agent', 'parent still streaming', '2026-08-02T07:06:00.000Z')],
      'sess_parent',
    );
    expect(rParent.displayChanged).toBe(false);

    // Child's own send (sessionIdOverride) writes to the child's display buffer.
    const rChild = mgr.updateMessages(
      'agt_x',
      () => [msg('a_child', 'agent', 'child reply', '2026-08-02T07:08:00.000Z')],
      'sess_child',
    );
    expect(rChild.displayChanged).toBe(true);
    expect(mgr.activeSession.get('agt_x')).toBe('sess_child');
    expect(mgr.msgBuffers.get('agt_x')!.map(m => m.id)).toEqual(['a_child']);
  });

  it('switchSession pin: a background session stream routes to its own cache, never the shared display buffer', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    // User is viewing tab A → switchSession pins the gate to sess_a.
    mgr.setActiveSession('agt_x', 'sess_a');

    // Session A streaming in the foreground: same-session writes hit the display buffer.
    const rA = mgr.updateMessages('agt_x', () => [
      msg('u_a', 'user', 'q', '2026-08-02T07:00:00.000Z'),
      msg('a_a', 'agent', 'partial', '2026-08-02T07:01:00.000Z'),
    ], 'sess_a');
    expect(rA.displayChanged).toBe(true);
    expect(mgr.msgBuffers.get('agt_x')!.map(m => m.id)).toEqual(['u_a', 'a_a']);

    // User switches to tab B → switchSession re-pins the gate to sess_b.
    mgr.setActiveSession('agt_x', 'sess_b');

    // A's stream is STILL running in the background. Its chunk must go to
    // session A's cache only — NOT into the display buffer (which is B's view).
    const rA2 = mgr.updateMessages('agt_x', (prev) => {
      const u = [...prev];
      u[u.length - 1] = { ...u[u.length - 1]!, text: 'partial + more' };
      return u;
    }, 'sess_a');
    expect(rA2.displayChanged).toBe(false);
    // Shared display buffer untouched by A's background stream.
    expect(mgr.msgBuffers.get('agt_x')!.map(m => m.id)).toEqual(['u_a', 'a_a']);

    // Lateral cache must NOT have picked up A's stream either.
    expect((mgr.sessionMsgCache.get('sess_a') ?? []).map(m => m.id)).toEqual(['u_a', 'a_a']);
    expect(mgr.sessionMsgCache.get('sess_a')![1]!.text).toBe('partial + more');

    // Switching back to A (switchSession again) restores the accumulated stream.
    mgr.setActiveSession('agt_x', 'sess_a');
    const restored = mgr.restoreFromCache('agt_x', 'sess_a')!;
    expect(restored.map(m => m.id)).toEqual(['u_a', 'a_a']);
    expect(restored[restored.length - 1]!.text).toBe('partial + more');
  });
});

describe('ConversationBufferManager.abortStream', () => {
  it('is idempotent and no-ops when nothing is active', () => {
    const mgr = new ConversationBufferManager();
    expect(mgr.abortStream('agt_x')).toBe(false);
    // Second call must also be a harmless no-op.
    expect(mgr.abortStream('agt_x')).toBe(false);
    expect(mgr.getPhase('agt_x')).toBe('idle');
  });

  it('tears down send counter, phase, stream mark, and activity buffer in one pass', () => {
    const mgr = new ConversationBufferManager();
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_1');
    mgr.incrementSend('agt_x');
    mgr.appendActivity('agt_x', { tool: 'shell', phase: 'start', ts: Date.now() } as ActivityStep, 'sess_1');

    expect(mgr.abortStream('agt_x', 'sess_1')).toBe(true);
    expect(mgr.getPhase('agt_x')).toBe('ready');
    expect(mgr.isSending('agt_x')).toBe(false);
    expect(mgr.getStreamSessions('agt_x')).toBeUndefined();
    expect(mgr.getActivities('sess_1')).toEqual([]);
  });

  it('clears ALL stream marks when no specific session is given (session-agnostic teardown)', () => {
    const mgr = new ConversationBufferManager();
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_1');
    mgr.addStreamSession('agt_x', 'sess_2');
    mgr.incrementSend('agt_x');

    expect(mgr.abortStream('agt_x')).toBe(true);
    expect(mgr.getStreamSessions('agt_x')).toBeUndefined();
    expect(mgr.isSending('agt_x')).toBe(false);
    expect(mgr.getPhase('agt_x')).toBe('ready');
  });

  it('removes only the named session mark when a sessionId is given', () => {
    const mgr = new ConversationBufferManager();
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_a');
    mgr.addStreamSession('agt_x', 'sess_b');

    expect(mgr.abortStream('agt_x', 'sess_a')).toBe(true);
    expect(mgr.getStreamSessions('agt_x')).toEqual(new Set(['sess_b']));
  });

  it('does not clear a fresh send counter for a DIFFERENT active send', () => {
    const mgr = new ConversationBufferManager();
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_old');
    // A newer invocation owns the key and already re-incremented the counter.
    mgr.incrementSend('agt_x');
    mgr.incrementSend('agt_x');

    expect(mgr.abortStream('agt_x', 'sess_old')).toBe(true);
    // abortStream is a hard teardown: it resets the counter to 0 by design
    // (the caller re-increments when it starts its own send afterwards).
    expect(mgr.isSending('agt_x')).toBe(false);
    expect(mgr.getStreamSessions('agt_x')).toBeUndefined();
  });
});
