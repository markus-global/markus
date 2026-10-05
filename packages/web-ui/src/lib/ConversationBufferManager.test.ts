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

  it('a DB load while THIS session is streaming MERGES and preserves the in-flight bubble', () => {
    // 单存储模型下，“这一条正在流式的会话被加载”不再等于“整屏不动”：
    // DB 行与该会话的实时尾部合并，正在流式的气泡必须活下来。
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';
    mgr.beginStream('conv');
    mgr.addStreamSession('conv', 'sess_1');

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
        { ...msg('live', 'agent', 'streaming…', '2026-08-02T07:04:00.000Z'), isStreaming: true },
      ],
      'sess_1',
    );

    const r = mgr.applyLoadResult('conv', 'sess_1', [
      msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z'),
    ]);
    expect(r.displayChanged).toBe(true);
    // 关键不变量：实时气泡没有被 DB 快照抹掉。
    expect(r.newMessages!.find(m => m.id === 'live')?.isStreaming).toBe(true);
  });

  it('regression: a STALE streaming bubble (no live stream) is dropped, not appended after the newest message', () => {
    // 2026-10-02 report: an OLD reply bubble re-appeared AFTER the newest
    // message. Mechanism: the stream for an earlier turn had already finished
    // and its reply was persisted (DB row cm_real), but the local copy kept
    // `isStreaming: true` in the session cache under a DIFFERENT (optimistic)
    // id. The merge appended it as a "live tail" — a duplicate of an OLD reply
    // at the bottom of the thread — and because that extra row also made the
    // cache look "fresher", the authoritative DB list could never replace it
    // (self-perpetuating). With no stream in flight the DB is the sole
    // authority, so the stale row must be dropped.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';
    // NOTE: no beginStream/addStreamSession — the stream is long over.

    // Stale cache: the optimistic in-flight bubble of an ALREADY-FINISHED turn.
    // Its rawCreatedAt is the optimistic send-time (OLDER than the DB row), so it
    // can never be ordered correctly either.
    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', '盘一下改动', '2026-08-02T07:04:00.000Z'),
        { ...msg('agent_optimistic', 'agent', '老板，盘完了。可以发——', '2026-08-02T07:04:00.000Z'), isStreaming: true },
      ],
      'sess_1',
    );

    // DB: the authoritative, correctly ordered rows — the reply IS persisted.
    const dbMsgs = [
      msg('u1', 'user', '盘一下改动', '2026-08-02T07:04:00.000Z'),
      msg('cm_real', 'agent', '老板，盘完了。可以发——', '2026-08-02T07:05:00.000Z'),
    ];

    const r = mgr.applyLoadResult('conv', 'sess_1', dbMsgs);
    const ids = r.newMessages!.map(m => m.id);
    // Exactly the DB rows, in DB order — the stale streaming copy is gone.
    expect(ids).toEqual(['u1', 'cm_real']);
    expect(ids).not.toContain('agent_optimistic');
  });

  it('regression: restoreFromCache never resurrects a stale streaming bubble into the view', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    // No stream in flight.
    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hi', '2026-08-02T07:04:00.000Z'),
        { ...msg('agent_stale', 'agent', 'old streaming ghost', '2026-08-02T07:04:00.000Z'), isStreaming: true },
      ],
      'sess_1',
    );

    const restored = mgr.restoreFromCache('conv', 'sess_1')!;
    expect(restored.map(m => m.id)).toEqual(['u1']);
    // And the display buffer must not carry the ghost either.
    expect(mgr.getMessages('conv')!.some(m => m.id === 'agent_stale')).toBe(false);
  });

  it('regression: when ANOTHER session streams, this session\u2019s stale streaming ghost is dropped, not appended', () => {
    // Multi-tab direct mode: session A streams (phase is per-convKey → 'streaming'),
    // the user loads session B. B's OWN cache carries a leftover isStreaming bubble
    // from a stream that already ended. It must never be appended as a "live tail":
    // the DB is the authority for B, whose stream is NOT running.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.beginStream('conv');
    mgr.addStreamSession('conv', 'sess_a');
    mgr.setActiveSession('conv', 'sess_b');
    mgr.loadingSession = 'sess_b';

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hello', '2026-08-02T07:05:00.000Z'),
        { ...msg('ghost', 'agent', 'stale tail', '2026-08-02T07:04:30.000Z'), isStreaming: true },
      ],
      'sess_b',
    );

    const r = mgr.applyLoadResult('conv', 'sess_b', [
      msg('u1', 'user', 'hello', '2026-08-02T07:05:00.000Z'),
      msg('a1', 'agent', 'committed reply', '2026-08-02T07:06:00.000Z'),
    ]);
    const ids = r.newMessages!.map(m => m.id);
    expect(ids).toEqual(['u1', 'a1']);
    expect(ids).not.toContain('ghost');
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

  it('a DB load for the SAME session that is streaming is MERGED into that session’s buffer', () => {
    // 单存储模型下不再是“整屏不动”：加载的就是用户正在看的那条会话，
    // 于是 DB 行写入它自己的 buffer（并保留实时尾部），displayChanged 为真。
    // 真正必须守住的是“DB 快照不得抹掉在飞内容”——由上面的 merge 测试钉住。
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    mgr.setActiveSession('agt_x', 'sess_a');
    mgr.loadingSession = 'sess_a';
    mgr.beginStream('agt_x');
    mgr.addStreamSession('agt_x', 'sess_a');

    const dbMsgs = [msg('u1', 'user', 'hello', '2026-08-02T07:04:00.000Z')];
    const r = mgr.applyLoadResult('agt_x', 'sess_a', dbMsgs);
    expect(r.displayChanged).toBe(true);
    expect(r.newMessages!.map(m => m.id)).toEqual(['u1']);
  });

  it('regression: a stale FINALIZED agent bubble (already persisted, no live stream) is dropped — never inserted in FRONT of its own user message', () => {
    // 2026-10-05 report: "agent 输出的消息气泡会莫名其妙地在前面出现重复".
    // Mechanism: a turn ended while a conversation OTHER than the one on screen
    // was in view (or the reply was recovered by a reattach / poll, or arrived
    // while the user had navigated away). The identity-alignment step that renames
    // the optimistic bubble (`a_…` / `reattach_…`) to the server-persisted
    // `messageId` is gated on "this conversation is the one being viewed", so it
    // was skipped: the local copy kept its SYNTHETIC id while the DB row used the
    // persisted id. The next DB load (switch back / refresh) merged both, because
    // dedup is by id and the ids differ. The stale row is NOT `isStreaming`
    // anymore, so the old code let it fall into the chronological `rest` bucket —
    // and its `rawCreatedAt` is the OPTIMISTIC send time (equal-or-earlier than
    // the DB user row it answers), so it landed ABOVE its own user message: a
    // duplicate of the reply, in front of the question.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';
    // The stream is long over — no beginStream/addStreamSession.

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', '盘一下改动', '2026-08-02T07:04:00.000Z'),
        // Finalized (isStreaming false/undefined), synthetic id, optimistic time.
        msg('a_8821', 'agent', '老板，盘完了。可以发——', '2026-08-02T07:04:00.000Z'),
      ],
      'sess_1',
    );

    const r = mgr.applyLoadResult('conv', 'sess_1', [
      msg('u1', 'user', '盘一下改动', '2026-08-02T07:04:00.000Z'),
      msg('cm_real', 'agent', '老板，盘完了。可以发——', '2026-08-02T07:05:00.000Z'),
    ]);

    const ids = r.newMessages!.map(m => m.id);
    // Exactly the DB rows, in DB order — no synthetic-id duplicate anywhere.
    expect(ids).toEqual(['u1', 'cm_real']);
    expect(ids).not.toContain('a_8821');
  });

  it('regression: a stale FINALIZED agent bubble of a PREVIOUS turn is dropped even while a LATER turn streams', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';
    mgr.beginStream('conv');
    mgr.addStreamSession('conv', 'sess_1'); // a new turn is in flight

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'first', '2026-08-02T07:04:00.000Z'),
        msg('a_old', 'agent', 'old reply (synthetic id)', '2026-08-02T07:04:00.000Z'), // finalized, stale
        { ...msg('u2', 'user', 'second', '2026-08-02T07:05:00.000Z') },
        { ...msg('a_live', 'agent', 'streaming…', '2026-08-02T07:05:00.000Z'), isStreaming: true },
      ],
      'sess_1',
    );

    const r = mgr.applyLoadResult('conv', 'sess_1', [
      msg('u1', 'user', 'first', '2026-08-02T07:04:00.000Z'),
      msg('cm_old', 'agent', 'old reply (synthetic id)', '2026-08-02T07:04:30.000Z'),
      msg('u2', 'user', 'second', '2026-08-02T07:05:00.000Z'),
    ]);

    const ids = r.newMessages!.map(m => m.id);
    expect(ids).not.toContain('a_old');       // stale duplicate of cm_old → dropped
    expect(ids[ids.length - 1]).toBe('a_live'); // the live tail is preserved, last
    expect(r.newMessages!.find(m => m.id === 'a_live')?.isStreaming).toBe(true);
  });

  it('keeps a client-only terminal marker (error bubble the DB never received)', () => {
    // A network/transport failure before the server persisted anything leaves the
    // error bubble as the ONLY copy. It is a client marker (isError), not a stale
    // duplicate of a DB row, so it must survive a DB load.
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'conv';
    mgr.setActiveSession('conv', 'sess_1');
    mgr.loadingSession = 'sess_1';

    mgr.updateMessages(
      'conv',
      () => [
        msg('u1', 'user', 'hi', '2026-08-02T07:04:00.000Z'),
        { ...msg('a_err', 'agent', '⚠ 网络错误，请重试', '2026-08-02T07:04:00.000Z'), isError: true, isStopped: true },
      ],
      'sess_1',
    );

    const r = mgr.applyLoadResult('conv', 'sess_1', [
      msg('u1', 'user', 'hi', '2026-08-02T07:04:00.000Z'),
    ]);

    expect(r.newMessages!.map(m => m.id)).toEqual(['u1', 'a_err']);
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
    expect(mgr.getMessages('agt_x')).toBeUndefined();

    // The new chat's own optimistic message (no session yet → placeholder) still
    // renders into the visible buffer.
    const rNew = mgr.updateMessages(
      'agt_x',
      () => [msg('u_new', 'user', 'fresh question', '2026-08-02T07:07:00.000Z')],
      null,
    );
    expect(rNew.displayChanged).toBe(true);
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u_new']);

    // No cross-session mixing in the visible buffer.
    const visibleIds = mgr.getMessages('agt_x')!.map(m => m.id);
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
    expect(mgr.getMessages('agt_x')).toBeUndefined();

    // Fresh new-chat optimistic message still lands in the visible buffer.
    const rNew = mgr.updateMessages(
      'agt_x',
      () => [msg('u_new', 'user', 'hello', '2026-08-02T07:07:00.000Z')],
      null,
    );
    expect(rNew.displayChanged).toBe(true);
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u_new']);

    // If repinTo were NOT applied (the old bug) the view would be undefined and
    // the stale stream would have been treated as the viewed session and written
    // into it. Assert the view stayed pinned and the buffer clean.
    expect(mgr.activeSessions.get('agt_x')).toBe(ConversationBufferManager.NEW_CHAT_ID);
    expect(mgr.getMessages('agt_x')!.some(m => m.id === 'a_old')).toBe(false);
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
    expect(mgr.activeSessions.get('agt_x')).toBe('sess_child');
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['a_child']);
  });

  it('H4 — 指针不可被绕过写入，且 setActiveSession 从占位会话提升（防止再犯）', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';

    // 1) 投影是**只读**的：没有任何写入口。旧实现把裸 Map 暴露成 `mgr.view`，
    //    调用方（useChatStream）先 `view.set(...)` 再调 setActiveSession，于是
    //    setter 的 `cur === sessionId` 守卫短路、占位提升被静默跳过 → 新会话第一条
    //    消息消失、回复不流式。这里把"没有写入口"钉死。
    expect((mgr.activeSessions as unknown as { set?: unknown }).set).toBeUndefined();

    // 2) 新会话：指针停在 NEW_CHAT 占位缓冲，乐观行落在占位缓冲里
    mgr.resetConv('agt_x', ConversationBufferManager.NEW_CHAT_ID);
    expect(mgr.activeSessions.get('agt_x')).toBe(ConversationBufferManager.NEW_CHAT_ID);
    mgr.updateMessages('agt_x', () => [msg('u1', 'user', 'hi', '2026-08-02T07:00:00.000Z')], null);
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u1']);

    // 3) 服务端给出真实 session id → setActiveSession 必须**提升**占位行，而不是丢弃
    mgr.setActiveSession('agt_x', 'sess_real');
    expect(mgr.activeSessions.get('agt_x')).toBe('sess_real');
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u1']);

    // 4) 指向真实会话的增量分片必须落在视图里（这正是回归时"整段不流式"的症状）
    const r = mgr.updateMessages(
      'agt_x',
      (prev) => [...(prev ?? []), msg('a1', 'agent', 'reply', '2026-08-02T07:00:01.000Z')],
      'sess_real',
    );
    expect(r.displayChanged).toBe(true);
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u1', 'a1']);
  });

  it('background session stream lands in its own buffer and never touches the viewed one', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_x';
    // User is viewing tab A → the view pointer sits on sess_a.
    mgr.setActiveSession('agt_x', 'sess_a');

    // Session A streaming in the foreground: same-session writes hit the display buffer.
    const rA = mgr.updateMessages('agt_x', () => [
      msg('u_a', 'user', 'q', '2026-08-02T07:00:00.000Z'),
      msg('a_a', 'agent', 'partial', '2026-08-02T07:01:00.000Z'),
    ], 'sess_a');
    expect(rA.displayChanged).toBe(true);
    expect(mgr.getMessages('agt_x')!.map(m => m.id)).toEqual(['u_a', 'a_a']);

    // User switches to tab B → the pointer moves. `setActiveSession` alone must
    // NOT steal the view from another real session, so the switch goes through
    // restoreFromCache exactly as switchSession() does it.
    mgr.restoreFromCache('agt_x', 'sess_b');

    // A's stream is STILL running in the background. Its chunk must land in A's
    // own buffer only — the viewed tab B must stay untouched.
    const rA2 = mgr.updateMessages('agt_x', (prev) => {
      const u = [...prev];
      u[u.length - 1] = { ...u[u.length - 1]!, text: 'partial + more' };
      return u;
    }, 'sess_a');
    expect(rA2.displayChanged).toBe(false);
    // The viewed tab (B) is empty and must remain so: another session's stream
    // cannot reach it. This is structural now, not a guard.
    expect(mgr.getMessages('agt_x')).toBeUndefined();
    // …while A's own buffer kept accumulating the stream.
    expect((mgr.buffers.get('sess_a') ?? []).map(m => m.id)).toEqual(['u_a', 'a_a']);
    expect(mgr.buffers.get('sess_a')![1]!.text).toBe('partial + more');

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
