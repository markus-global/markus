import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationBufferManager, makeConvKey } from '../src/lib/ConversationBufferManager.ts';
import type { ChatMsg } from '../src/pages/ChatHelpers.ts';
import type { ActivityStep } from '../src/components/ActivityIndicator.tsx';

function msg(overrides: Partial<ChatMsg> & { id: string }): ChatMsg {
  return { sender: 'user', text: '', time: '', ...overrides };
}

function activity(tool: string, phase: 'start' | 'end' = 'start'): ActivityStep {
  return { tool, phase, ts: Date.now() };
}

describe('ConversationBufferManager', () => {
  let mgr: ConversationBufferManager;

  beforeEach(() => {
    mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agent1';
  });

  // ── Phase transition tests ──

  describe('phase transitions', () => {
    it('starts in idle phase', () => {
      expect(mgr.getPhase('agent1')).toBe('idle');
    });

    it('idle -> loading -> ready (normal load)', () => {
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('loading');
      mgr.completeLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('ready');
    });

    it('idle -> loading -> streaming (send during load)', () => {
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('loading');
      mgr.beginStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
    });

    it('ready -> streaming -> ready (normal stream lifecycle)', () => {
      mgr.beginLoad('agent1');
      mgr.completeLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('ready');
      mgr.beginStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
      mgr.endStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('ready');
    });

    it('beginLoad during streaming stays streaming', () => {
      mgr.beginStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
    });

    it('resetConv from any phase -> idle + clears activeSession', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.beginStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
      mgr.resetConv('agent1');
      expect(mgr.getPhase('agent1')).toBe('idle');
      expect(mgr.getActiveSession('agent1')).toBeUndefined();
    });

    it('endStream from non-streaming phase is no-op', () => {
      mgr.beginLoad('agent1');
      mgr.completeLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('ready');
      mgr.endStream('agent1');
      expect(mgr.getPhase('agent1')).toBe('ready');
    });

    it('completeLoad from non-loading phase is no-op', () => {
      mgr.beginStream('agent1');
      mgr.completeLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');
    });
  });

  // ── Write routing tests ──

  describe('updateMessages write routing', () => {
    it('matching session writes to that session buffer and returns displayChanged: true', () => {
      mgr.setActiveSession('agent1', 'sess1');
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sess1');
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toHaveLength(1);
      expect(mgr.getMessages('agent1')).toHaveLength(1);
    });

    it('a background session writes to its OWN buffer, displayChanged: false', () => {
      mgr.setActiveSession('agent1', 'sessA');
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sessB');
      expect(r.displayChanged).toBe(false);
      expect(r.newMessages).toBeUndefined();
      // 写入落在 sessB 自己的 buffer 上，正在看的会话 A 完全不受影响。
      expect(mgr.buffers.get('sessB')).toHaveLength(1);
      expect(mgr.getMessages('agent1')).toBeUndefined();
    });

    it('null sessionId writes to the viewed buffer (optimistic send)', () => {
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], null);
      expect(r.displayChanged).toBe(true);
      expect(mgr.getMessages('agent1')).toHaveLength(1);
    });

    it('undefined sessionId writes to the viewed buffer (optimistic send)', () => {
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })]);
      expect(r.displayChanged).toBe(true);
      expect(mgr.getMessages('agent1')).toHaveLength(1);
    });

    it('non-current convKey writes to buffer but displayChanged: false', () => {
      const r = mgr.updateMessages('agent2', () => [msg({ id: 'u1' })]);
      expect(r.displayChanged).toBe(false);
      expect(r.newMessages).toBeUndefined();
      expect(mgr.getMessages('agent2')).toHaveLength(1);
    });

    it('truncates at MAX_MESSAGES', () => {
      const bigList = Array.from({ length: 600 }, (_, i) => msg({ id: `m${i}` }));
      const r = mgr.updateMessages('agent1', () => bigList);
      expect(r.newMessages!.length).toBe(ConversationBufferManager.MAX_MESSAGES);
      expect(r.newMessages![0].id).toBe('m100');
    });

    it('also lands in the session-keyed store when sessionId is provided', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sess1');
      expect(mgr.buffers.get('sess1')).toHaveLength(1);
    });

    it('a placeholder turn accumulates under NEW_CHAT_ID until session_start promotes it', () => {
      // 新建 tab：真实 session id 还没到，乐观消息先落在占位 buffer 上。
      mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], ConversationBufferManager.NEW_CHAT_ID);
      expect(mgr.buffers.get(ConversationBufferManager.NEW_CHAT_ID)).toHaveLength(1);

      // session_start 到达：占位 buffer 并入真实 session，指针前移。
      mgr.setActiveSession('agent1', 'sess_real');
      expect(mgr.buffers.get('sess_real')?.map(m => m.id)).toEqual(['u1']);
      expect(mgr.buffers.has(ConversationBufferManager.NEW_CHAT_ID)).toBe(false);
      expect(mgr.getMessages('agent1')?.map(m => m.id)).toEqual(['u1']);
    });
  });

  // ── Load guard tests (core race condition fix) ──

  describe('applyLoadResult (phase-aware load guard)', () => {
    it('in loading phase writes to the viewed buffer', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.beginLoad('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toEqual(dbMsgs);
      expect(mgr.getPhase('agent1')).toBe('ready');
    });

    it('in ready phase writes to the viewed buffer', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.beginLoad('agent1');
      mgr.completeLoad('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toEqual(dbMsgs);
    });

    it('a DB load during a live stream MERGES — the in-flight tail is preserved', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.beginStream('agent1');
      mgr.addStreamSession('agent1', 'sess1');
      mgr.updateMessages('agent1', () => [
        msg({ id: 'u1' }),
        msg({ id: 'a1', sender: 'agent', text: 'partial', isStreaming: true }),
      ], 'sess1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      const ids = r.newMessages!.map(m => m.id);
      expect(ids).toContain('db1');
      // 关键：正在流式的气泡不能被 DB 加载抹掉。
      expect(r.newMessages!.find(m => m.id === 'a1')?.isStreaming).toBe(true);
    });

    it('with stale convKey returns no display change', () => {
      mgr.currentConvKey = 'agent2';
      mgr.beginLoad('agent1');
      mgr.loadingSession = 'sess1';
      const r = mgr.applyLoadResult('agent1', 'sess1', [msg({ id: 'db1' })]);
      expect(r.displayChanged).toBe(false);
    });

    it('with stale loadingSession returns no display change', () => {
      mgr.beginLoad('agent1');
      mgr.loadingSession = 'sessOther';
      const r = mgr.applyLoadResult('agent1', 'sess1', [msg({ id: 'db1' })]);
      expect(r.displayChanged).toBe(false);
    });

    it('keeps DB rows and appends buffer-only rows', () => {
      const cachedMsgs = [
        msg({ id: 'c1', text: 'cached reply with more text' }),
        msg({ id: 'c2', text: 'extra message' }),
      ];
      mgr.buffers.set('sess1', cachedMsgs);
      mgr.setActiveSession('agent1', 'sess1');
      mgr.beginLoad('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'short' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      // DB rows are the ordering authority and must never be dropped; cache rows
      // are appended as live-tail supplements.
      const ids = r.newMessages!.map(m => m.id);
      expect(ids).toContain('db1');
      expect(ids).toContain('c1');
      expect(ids).toContain('c2');
    });
  });

  // ── Race condition scenario tests ──

  describe('race condition: send before initial load completes', () => {
    it('does not overwrite streaming data with stale DB data', () => {
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('loading');

      const userMsg = msg({ id: 'u1', text: 'hello' });
      const agentBubble = msg({ id: 'a1', sender: 'agent', text: '', segments: [] });
      mgr.beginStream('agent1');
      mgr.updateMessages('agent1', prev => [...prev, userMsg, agentBubble]);
      expect(mgr.getPhase('agent1')).toBe('streaming');

      const oldMsgs = [
        msg({ id: 'old_u', text: 'old' }),
        msg({ id: 'old_a', sender: 'agent', text: 'old reply' }),
      ];
      mgr.loadingSession = 'sess_old';
      const result = mgr.applyLoadResult('agent1', 'sess_old', oldMsgs);

      expect(result.displayChanged).toBe(false);
      const displayed = mgr.getMessages('agent1');
      expect(displayed).toHaveLength(2);
      expect(displayed![0].id).toBe('u1');
      expect(displayed![1].id).toBe('a1');
      expect(mgr.buffers.get('sess_old')).toEqual(oldMsgs);
    });
  });

  describe('race condition: newConversation then send', () => {
    it('clears activeSession so load guard works', () => {
      mgr.setActiveSession('agent1', 'sess_old');
      mgr.resetConv('agent1');
      expect(mgr.getPhase('agent1')).toBe('idle');
      expect(mgr.getActiveSession('agent1')).toBeUndefined();
    });
  });

  describe('race condition: switchSession during streaming', () => {
    it('load for the newly-viewed session displays, and the other session’s live data stays put', () => {
      mgr.setActiveSession('agent1', 'sessA');
      mgr.beginStream('agent1');
      mgr.addStreamSession('agent1', 'sessA');
      mgr.updateMessages('agent1', () => [
        msg({ id: 'u1', text: 'hi' }),
        msg({ id: 'a1', sender: 'agent', text: 'partial...', isStreaming: true }),
      ], 'sessA');

      // 切到 B：指针前移，A 自己的 buffer 原封不动。
      mgr.restoreFromCache('agent1', 'sessB');
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');

      mgr.loadingSession = 'sessB';
      const result = mgr.applyLoadResult('agent1', 'sessB', [
        msg({ id: 'b1', text: 'session B msg' }),
      ]);
      expect(result.displayChanged).toBe(true);
      expect(mgr.buffers.get('sessA')).toHaveLength(2);
    });
  });

  // ── isCacheFresher：已随双存储模型一并移除 ──
  // 它存在的唯一理由是仲裁“两个存储哪个更新”，而那正是跨 tab 串味的温床。
  // 现在只有一份按会话键的存储，没有“谁更新”这个问题。

  // ── Activity buffer tests ──

  describe('appendActivity', () => {
    it('session-keyed activity storage', () => {
      const step = activity('search');
      const r = mgr.appendActivity('agent1', step, 'sess1');
      expect(r.displayChanged).toBe(true);
      expect(mgr.actBuffers.get('sess1')).toHaveLength(1);
    });

    it('cross-session activities do not leak to display', () => {
      mgr.setActiveSession('agent1', 'sessA');
      const step = activity('search');
      const r = mgr.appendActivity('agent1', step, 'sessB');
      expect(r.displayChanged).toBe(false);
      expect(mgr.actBuffers.get('sessB')).toHaveLength(1);
    });

    it('without sessionId keys by convKey', () => {
      const step = activity('search');
      const r = mgr.appendActivity('agent1', step);
      expect(r.displayChanged).toBe(true);
      expect(mgr.actBuffers.get('agent1')).toHaveLength(1);
    });

    it('without viewed session shows all activities', () => {
      const step = activity('search');
      const r = mgr.appendActivity('agent1', step, 'sess1');
      expect(r.displayChanged).toBe(true);
    });
  });

  // ── Session management tests ──

  describe('session management', () => {
    it('restoreFromCache points the view at that session’s buffer', () => {
      const msgs = [msg({ id: 'u1' }), msg({ id: 'a1', sender: 'agent' })];
      mgr.updateMessages('agent1', () => msgs, 'sess1');

      const restored = mgr.restoreFromCache('agent1', 'sess1');
      expect(restored).toEqual(msgs);
      expect(mgr.getMessages('agent1')).toEqual(msgs);
    });

    it('restoreFromCache on a session with no buffer returns undefined', () => {
      mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sess1');
      const restored = mgr.restoreFromCache('agent1', 'nonexistent');
      expect(restored).toBeUndefined();
      // 另一个会话的 buffer 不受影响。
      expect(mgr.buffers.has('sess1')).toBe(true);
    });
  });

  // ── Send / stream tracking tests ──

  describe('send/stream tracking', () => {
    it('incrementSend / isSending / decrementSend', () => {
      expect(mgr.isSending('agent1')).toBe(false);
      mgr.incrementSend('agent1');
      expect(mgr.isSending('agent1')).toBe(true);
      mgr.incrementSend('agent1');
      const remaining = mgr.decrementSend('agent1');
      expect(remaining).toBe(1);
      expect(mgr.isSending('agent1')).toBe(true);
      mgr.decrementSend('agent1');
      expect(mgr.isSending('agent1')).toBe(false);
    });

    it('resetSend clears count', () => {
      mgr.incrementSend('agent1');
      mgr.incrementSend('agent1');
      mgr.resetSend('agent1');
      expect(mgr.isSending('agent1')).toBe(false);
    });

    it('addStreamSession / getStreamSessions / removeStreamSession', () => {
      mgr.addStreamSession('agent1', 'sessA');
      mgr.addStreamSession('agent1', 'sessB');
      expect(mgr.getStreamSessions('agent1')?.size).toBe(2);
      mgr.removeStreamSession('agent1', 'sessA');
      expect(mgr.getStreamSessions('agent1')?.size).toBe(1);
      mgr.removeStreamSession('agent1', 'sessB');
      expect(mgr.getStreamSessions('agent1')).toBeUndefined();
    });

    it('removeStreamSession without sid clears all', () => {
      mgr.addStreamSession('agent1', 'sessA');
      mgr.addStreamSession('agent1', 'sessB');
      mgr.removeStreamSession('agent1');
      expect(mgr.getStreamSessions('agent1')).toBeUndefined();
    });
  });

  // ── Buffer eviction tests ──

  describe('buffer eviction', () => {
    it('evicts oldest buffers when exceeding MAX_BUFFERS', () => {
      const n = ConversationBufferManager.MAX_BUFFERS + 10;
      for (let i = 0; i < n; i++) {
        mgr.updateMessages(`key${i}`, () => [msg({ id: `m${i}` })]);
      }
      expect(mgr.buffers.size).toBeLessThanOrEqual(ConversationBufferManager.MAX_BUFFERS);
    });

    it('never evicts the viewed buffer', () => {
      mgr.currentConvKey = 'keep_me';
      mgr.updateMessages('keep_me', () => [msg({ id: 'keep' })]);
      const n = ConversationBufferManager.MAX_BUFFERS + 10;
      for (let i = 0; i < n; i++) {
        mgr.updateMessages(`key${i}`, () => [msg({ id: `m${i}` })]);
      }
      expect(mgr.buffers.has('keep_me')).toBe(true);
    });
  });

  // ── makeConvKey tests ──

  describe('makeConvKey', () => {
    it('channel mode', () => {
      expect(makeConvKey('channel', 'agentX', 'general')).toBe('ch:general');
    });

    it('dm mode', () => {
      expect(makeConvKey('dm', 'agentX', 'ch1', 'user123')).toBe('dm:user123');
    });

    it('direct mode', () => {
      expect(makeConvKey('direct', 'agentX', 'ch1')).toBe('agentX');
    });

    it('direct mode with empty agent', () => {
      expect(makeConvKey('direct', '', 'ch1')).toBe('_direct');
    });
  });
});
