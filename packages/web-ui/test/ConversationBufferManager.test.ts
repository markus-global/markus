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
    it('matching session writes to msgBuffers and returns displayChanged: true', () => {
      mgr.setActiveSession('agent1', 'sess1');
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sess1');
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toHaveLength(1);
      expect(mgr.msgBuffers.get('agent1')).toHaveLength(1);
    });

    it('mismatched session writes to sessionMsgCache only, displayChanged: false', () => {
      mgr.setActiveSession('agent1', 'sessA');
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sessB');
      expect(r.displayChanged).toBe(false);
      expect(r.newMessages).toBeUndefined();
      expect(mgr.sessionMsgCache.get('sessB')).toHaveLength(1);
      expect(mgr.msgBuffers.has('agent1')).toBe(false);
    });

    it('null sessionId writes to msgBuffers (isSameSession = true)', () => {
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], null);
      expect(r.displayChanged).toBe(true);
      expect(mgr.msgBuffers.get('agent1')).toHaveLength(1);
    });

    it('undefined sessionId writes to msgBuffers (isSameSession = true)', () => {
      const r = mgr.updateMessages('agent1', () => [msg({ id: 'u1' })]);
      expect(r.displayChanged).toBe(true);
      expect(mgr.msgBuffers.get('agent1')).toHaveLength(1);
    });

    it('non-current convKey writes to buffer but displayChanged: false', () => {
      const r = mgr.updateMessages('agent2', () => [msg({ id: 'u1' })]);
      expect(r.displayChanged).toBe(false);
      expect(r.newMessages).toBeUndefined();
      expect(mgr.msgBuffers.get('agent2')).toHaveLength(1);
    });

    it('truncates at MAX_MESSAGES', () => {
      const bigList = Array.from({ length: 600 }, (_, i) => msg({ id: `m${i}` }));
      const r = mgr.updateMessages('agent1', () => bigList);
      expect(r.newMessages!.length).toBe(ConversationBufferManager.MAX_MESSAGES);
      expect(r.newMessages![0].id).toBe('m100');
    });

    it('also writes to sessionMsgCache when sessionId is provided', () => {
      mgr.setActiveSession('agent1', 'sess1');
      mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], 'sess1');
      expect(mgr.sessionMsgCache.get('sess1')).toHaveLength(1);
    });

    it('does not write to sessionMsgCache for NEW_CHAT_ID', () => {
      mgr.updateMessages('agent1', () => [msg({ id: 'u1' })], ConversationBufferManager.NEW_CHAT_ID);
      expect(mgr.sessionMsgCache.has(ConversationBufferManager.NEW_CHAT_ID)).toBe(false);
    });
  });

  // ── Load guard tests (core race condition fix) ──

  describe('applyLoadResult (phase-aware load guard)', () => {
    it('in loading phase writes to display', () => {
      mgr.beginLoad('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toEqual(dbMsgs);
      expect(mgr.getPhase('agent1')).toBe('ready');
    });

    it('in ready phase writes to display', () => {
      mgr.beginLoad('agent1');
      mgr.completeLoad('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(true);
      expect(r.newMessages).toEqual(dbMsgs);
    });

    it('in streaming phase -> cache only, displayChanged: false', () => {
      mgr.beginStream('agent1');
      mgr.loadingSession = 'sess1';
      const dbMsgs = [msg({ id: 'db1', text: 'from db' })];
      const r = mgr.applyLoadResult('agent1', 'sess1', dbMsgs);
      expect(r.displayChanged).toBe(false);
      expect(mgr.sessionMsgCache.get('sess1')).toEqual(dbMsgs);
      expect(mgr.msgBuffers.has('agent1')).toBe(false);
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

    it('keeps DB rows and appends fresher cache-only rows', () => {
      const cachedMsgs = [
        msg({ id: 'c1', text: 'cached reply with more text' }),
        msg({ id: 'c2', text: 'extra message' }),
      ];
      mgr.sessionMsgCache.set('sess1', cachedMsgs);
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
      expect(mgr.sessionMsgCache.get('sess_old')).toEqual(oldMsgs);
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
    it('load for new session writes to cache only, streaming data preserved', () => {
      mgr.setActiveSession('agent1', 'sessA');
      mgr.beginStream('agent1');
      mgr.updateMessages('agent1', () => [
        msg({ id: 'u1', text: 'hi' }),
        msg({ id: 'a1', sender: 'agent', text: 'partial...' }),
      ]);

      mgr.saveToCache('agent1', 'sessA');
      mgr.setActiveSession('agent1', 'sessB');
      mgr.beginLoad('agent1');
      expect(mgr.getPhase('agent1')).toBe('streaming');

      mgr.loadingSession = 'sessB';
      const result = mgr.applyLoadResult('agent1', 'sessB', [
        msg({ id: 'b1', text: 'session B msg' }),
      ]);
      expect(result.displayChanged).toBe(false);
      expect(mgr.sessionMsgCache.get('sessA')).toHaveLength(2);
    });
  });

  // ── Cache freshness tests ──

  describe('isCacheFresher', () => {
    it('empty cache is not fresher', () => {
      expect(mgr.isCacheFresher('sess1', [msg({ id: 'db1' })])).toBe(false);
    });

    it('more messages -> fresher', () => {
      mgr.sessionMsgCache.set('sess1', [msg({ id: 'c1' }), msg({ id: 'c2' })]);
      expect(mgr.isCacheFresher('sess1', [msg({ id: 'db1' })])).toBe(true);
    });

    it('more total text -> fresher', () => {
      mgr.sessionMsgCache.set('sess1', [msg({ id: 'c1', text: 'a long cached reply here' })]);
      expect(mgr.isCacheFresher('sess1', [msg({ id: 'db1', text: 'short' })])).toBe(true);
    });

    it('more segments -> fresher', () => {
      mgr.sessionMsgCache.set('sess1', [
        msg({ id: 'c1', segments: [{ type: 'text' as const, content: 'a' }, { type: 'text' as const, content: 'b' }] }),
      ]);
      expect(mgr.isCacheFresher('sess1', [
        msg({ id: 'db1', segments: [{ type: 'text' as const, content: 'a' }] }),
      ])).toBe(true);
    });

    it('equal content is not fresher', () => {
      const m = [msg({ id: 'x', text: 'hello' })];
      mgr.sessionMsgCache.set('sess1', m);
      expect(mgr.isCacheFresher('sess1', m)).toBe(false);
    });
  });

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
    it('saveToCache and restoreFromCache round-trip', () => {
      const msgs = [msg({ id: 'u1' }), msg({ id: 'a1', sender: 'agent' })];
      mgr.msgBuffers.set('agent1', msgs);
      mgr.saveToCache('agent1', 'sess1');
      mgr.msgBuffers.delete('agent1');

      const restored = mgr.restoreFromCache('agent1', 'sess1');
      expect(restored).toEqual(msgs);
      expect(mgr.msgBuffers.get('agent1')).toEqual(msgs);
    });

    it('saveToCache skips NEW_CHAT_ID', () => {
      mgr.msgBuffers.set('agent1', [msg({ id: 'u1' })]);
      mgr.saveToCache('agent1', ConversationBufferManager.NEW_CHAT_ID);
      expect(mgr.sessionMsgCache.has(ConversationBufferManager.NEW_CHAT_ID)).toBe(false);
    });

    it('restoreFromCache with no cached data deletes buffer', () => {
      mgr.msgBuffers.set('agent1', [msg({ id: 'u1' })]);
      const restored = mgr.restoreFromCache('agent1', 'nonexistent');
      expect(restored).toBeUndefined();
      expect(mgr.msgBuffers.has('agent1')).toBe(false);
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
    it('evicts oldest buffers when exceeding MAX_CONVERSATIONS', () => {
      for (let i = 0; i < 25; i++) {
        mgr.updateMessages(`key${i}`, () => [msg({ id: `m${i}` })]);
      }
      expect(mgr.msgBuffers.size).toBeLessThanOrEqual(ConversationBufferManager.MAX_CONVERSATIONS + 1);
    });

    it('never evicts currentConvKey', () => {
      mgr.currentConvKey = 'keep_me';
      mgr.updateMessages('keep_me', () => [msg({ id: 'keep' })]);
      for (let i = 0; i < 25; i++) {
        mgr.updateMessages(`key${i}`, () => [msg({ id: `m${i}` })]);
      }
      expect(mgr.msgBuffers.has('keep_me')).toBe(true);
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
