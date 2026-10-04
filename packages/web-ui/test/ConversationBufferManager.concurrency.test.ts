import { describe, it, expect } from 'vitest';
import { ConversationBufferManager } from '../src/lib/ConversationBufferManager.ts';
import type { ChatMsg } from '../src/pages/ChatHelpers.ts';

function msg(o: Partial<ChatMsg> & { id: string }): ChatMsg {
  return { sender: 'user', text: '', time: '', ...o };
}

const A = 'sess-A';
const B = 'sess-B';

/** user + in-flight agent reply, tagged by session. */
function turn(tag: string, text: string): ChatMsg[] {
  return [
    msg({ id: `u-${tag}`, sender: 'user', text: 'hi', rawCreatedAt: '2026-10-04T00:00:00Z' }),
    msg({
      id: `a-${tag}`, sender: 'agent', text, isStreaming: true,
      rawCreatedAt: '2026-10-04T00:00:01Z',
    }),
  ];
}

/**
 * Concurrency: several turns can be in flight at once — multiple session tabs
 * of the SAME agent, and several agents' tabs. These pin down whether the
 * shared-per-agent view (one convKey = one phase = one display buffer) stays
 * correct when more than one stream is live.
 */
describe('ConversationBufferManager — concurrent live turns', () => {
  it('same agent, A and B both streaming: a background load for B must not clobber the viewed A', () => {
    const m = new ConversationBufferManager();
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    m.addStreamSession('agent1', A);
    m.addStreamSession('agent1', B);
    m.incrementSend('agent1');
    m.incrementSend('agent1');
    m.setActiveSession('agent1', A);
    m.updateMessages('agent1', () => turn('A', 'answer A'), A);
    // B's deltas must be routed to B's own cache, never the shared display.
    m.updateMessages('agent1', () => turn('B', 'answer B'), B);
    expect(m.getMessages('agent1')?.map(x => x.id)).toEqual(['u-A', 'a-A']);

    // A DB load lands for the BACKGROUND session B.
    m.loadingSession = B;
    const r = m.applyLoadResult('agent1', B, [msg({ id: 'u-B', sender: 'user', text: 'hi' })]);
    const displayed = r.displayChanged ? r.newMessages : m.getMessages('agent1');

    // The user is still looking at A — the view must keep A's live bubble.
    expect(displayed?.find(x => x.id === 'a-A')?.isStreaming).toBe(true);
    expect(displayed?.find(x => x.id === 'a-B')).toBeUndefined();
  });

  it('same agent, A and B both streaming: each tab keeps its own in-flight bubble across switches', () => {
    const m = new ConversationBufferManager();
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    m.addStreamSession('agent1', A);
    m.addStreamSession('agent1', B);
    m.incrementSend('agent1');
    m.incrementSend('agent1');
    m.setActiveSession('agent1', A);
    m.updateMessages('agent1', () => turn('A', 'answer A'), A);
    m.updateMessages('agent1', () => turn('B', 'answer B'), B);

    // A -> B -> A
    m.saveToCache('agent1', A);
    m.setActiveSession('agent1', B);
    const onB = m.restoreFromCache('agent1', B);
    expect(onB?.find(x => x.id === 'a-B')?.isStreaming).toBe(true);

    m.saveToCache('agent1', B);
    m.setActiveSession('agent1', A);
    const onA = m.restoreFromCache('agent1', A);
    expect(onA?.find(x => x.id === 'a-A')?.isStreaming).toBe(true);
  });

  it('two different agents streaming at once: each conversation keeps its own live bubble', () => {    const m = new ConversationBufferManager();
    // agent1 streaming in sess-A
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    m.addStreamSession('agent1', A);
    m.incrementSend('agent1');
    m.setActiveSession('agent1', A);
    m.updateMessages('agent1', () => turn('1', 'answer 1'), A);
    // agent2 streaming in sess-B, simultaneously
    m.currentConvKey = 'agent2';
    m.beginStream('agent2');
    m.addStreamSession('agent2', B);
    m.incrementSend('agent2');
    m.setActiveSession('agent2', B);
    m.updateMessages('agent2', () => turn('2', 'answer 2'), B);

    // agent1's live turn is untouched by agent2's activity.
    expect(m.getMessages('agent1')?.find(x => x.id === 'a-1')?.isStreaming).toBe(true);
    expect(m.getMessages('agent2')?.find(x => x.id === 'a-2')?.isStreaming).toBe(true);

    // Leaving and returning to agent1 keeps its bubble.
    m.currentConvKey = 'agent2';
    const back = m.restoreFromCache('agent1', A);
    expect(back?.find(x => x.id === 'a-1')?.isStreaming).toBe(true);
  });

  it('one tab finishing must not mark the agent idle nor drop the sibling tab’s live bubble', () => {
    const m = new ConversationBufferManager();
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    m.addStreamSession('agent1', A);
    m.addStreamSession('agent1', B);
    m.incrementSend('agent1');
    m.incrementSend('agent1');
    m.setActiveSession('agent1', A);
    m.updateMessages('agent1', () => turn('A', 'answer A'), A);
    m.updateMessages('agent1', () => turn('B', 'answer B'), B);

    // Tab A finishes: the turn-level phase collapses and A's mark is released,
    // exactly as useChatStream does it (endStream, then clearStreamSession).
    m.endStream('agent1');
    m.removeStreamSession('agent1', A);

    // B is still running, so the AGENT is still streaming — the phase is
    // derived from the ownership set, not from the last turn-level event.
    expect(m.hasLiveStream('agent1')).toBe(true);
    expect(m.getPhase('agent1')).toBe('streaming');

    // …and B's in-flight bubble survives a switch away and back.
    m.saveToCache('agent1', A);
    m.setActiveSession('agent1', B);
    const onB = m.restoreFromCache('agent1', B);
    expect(onB?.find(x => x.id === 'a-B')?.isStreaming).toBe(true);

    // Only when the LAST stream goes away does the agent report ready.
    m.endStream('agent1');
    m.removeStreamSession('agent1', B);
    expect(m.hasLiveStream('agent1')).toBe(false);
    expect(m.getPhase('agent1')).toBe('ready');
  });

  /**
   * The seam that made the phase veto necessary (see shouldSweepGhostStreaming).
   * Consumers must not read chatStore's per-agent set as the ONLY authority for
   * "is this conversation streaming": the phase legitimately reports 'streaming'
   * with an empty ownership set.
   */
  it('pre-registration window: phase reads streaming while the ownership set is empty', () => {
    const m = new ConversationBufferManager();
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    // beginStream flips the phase; session_start has not landed the mark yet.
    expect(m.hasLiveStream('agent1')).toBe(false);
    expect(m.getPhase('agent1')).toBe('streaming');
  });

  it('ending a turn with no resolved session id must NOT release a sibling tab', () => {
    const m = new ConversationBufferManager();
    m.currentConvKey = 'agent1';
    m.beginStream('agent1');
    m.addStreamSession('agent1', A);
    m.addStreamSession('agent1', B);

    // The finished turn never resolved a session id (new-chat tab, or a message
    // the server merged into the in-flight run). Its unresolved turn can only
    // own the placeholder mark — releasing the WHOLE key would silently drop B.
    m.removeStreamSession('agent1', ConversationBufferManager.NEW_CHAT_ID);
    expect(m.hasLiveStream('agent1')).toBe(true);
    expect(m.getStreamSessions('agent1')?.has(B)).toBe(true);

    // Contrast: the whole-key release does wipe every sibling — which is exactly
    // why the terminal path must never call it with an unresolved id.
    m.removeStreamSession('agent1');
    expect(m.hasLiveStream('agent1')).toBe(false);
  });
});
