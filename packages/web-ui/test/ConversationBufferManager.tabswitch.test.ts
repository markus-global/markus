import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationBufferManager } from '../src/lib/ConversationBufferManager.ts';
import type { ChatMsg } from '../src/pages/ChatHelpers.ts';

function msg(overrides: Partial<ChatMsg> & { id: string }): ChatMsg {
  return { sender: 'user', text: '', time: '', ...overrides };
}

const NEW_CHAT = ConversationBufferManager.NEW_CHAT_ID;

/**
 * Reproduction for: "switching a session tab away and back kills the in-flight
 * agent bubble's streaming effect (animated border disappears) even though the
 * turn is still running on the server".
 *
 * Switching the view is now just moving the `view` pointer (restoreFromCache),
 * exactly as switchSession() does it in Team.tsx.
 */
describe('ConversationBufferManager — live bubble across a session-tab switch', () => {
  let mgr: ConversationBufferManager;
  const KEY = 'agent1';
  const SESSION_A = 'sess-A';
  const SESSION_B = 'sess-B';

  // The user's own bubble + the in-flight agent reply for session A.
  const liveTurn = (): ChatMsg[] => [
    msg({ id: 'u1', sender: 'user', text: 'hi', rawCreatedAt: '2026-10-04T00:00:00Z' }),
    msg({
      id: 'a1', sender: 'agent', text: 'partial answer',
      isStreaming: true, rawCreatedAt: '2026-10-04T00:00:01Z',
    }),
  ];

  const startStreamingInA = (trackedSessionId: string) => {
    mgr.currentConvKey = KEY;
    mgr.beginStream(KEY);
    mgr.addStreamSession(KEY, trackedSessionId);
    mgr.incrementSend(KEY);
    mgr.setActiveSession(KEY, SESSION_A);
    mgr.updateMessages(KEY, () => liveTurn(), SESSION_A);
  };

  const switchTo = (target: string) => {
    mgr.setActiveSession(KEY, target);
    return mgr.restoreFromCache(KEY, target);
  };

  beforeEach(() => {
    mgr = new ConversationBufferManager();
  });

  it('keeps the in-flight bubble (isStreaming) when switching away and back', () => {
    startStreamingInA(SESSION_A);

    switchTo(SESSION_B);
    const back = switchTo(SESSION_A);

    const bubble = back?.find(m => m.id === 'a1');
    expect(bubble?.isStreaming).toBe(true);
  });

  it('treats a stream tracked under the NEW_CHAT placeholder as live for the real session', () => {
    // Stream started before the server assigned a real session id: the mark is
    // under the placeholder while the tab already shows the real session.
    startStreamingInA(NEW_CHAT);

    switchTo(SESSION_B);
    const back = switchTo(SESSION_A);

    const bubble = back?.find(m => m.id === 'a1');
    expect(bubble?.isStreaming).toBe(true);
  });

  it('does not let a DB load drop the in-flight bubble while the turn is live', () => {
    startStreamingInA(NEW_CHAT);

    // A DB load lands for the session being viewed. Mid-turn the DB only holds
    // the user row — it must NOT be allowed to replace the display, or the
    // in-flight bubble disappears and the animated border with it.
    const dbRows: ChatMsg[] = [
      msg({ id: 'u1', sender: 'user', text: 'hi', rawCreatedAt: '2026-10-04T00:00:00Z' }),
    ];
    const r = mgr.applyLoadResult(KEY, SESSION_A, dbRows);

    const displayed = r.displayChanged ? r.newMessages : mgr.getMessages(KEY);
    expect(displayed?.find(m => m.id === 'a1')?.isStreaming).toBe(true);
  });
});
