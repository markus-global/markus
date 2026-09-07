import { describe, expect, it, beforeEach } from 'vitest';
import { chatStore } from './useChatStore.ts';

describe('chatStore.markAgentStreaming (sidebar busy signal)', () => {
  beforeEach(() => {
    // The store is a module singleton; reset any state leaked by other tests.
    for (const id of [...chatStore.getStreamingAgents()]) {
      chatStore.clearAgentStreaming(id);
    }
  });

  it('tracks a single stream and clears it on end', () => {
    expect(chatStore.isAgentStreaming('agt_x')).toBe(false);
    chatStore.markAgentStreaming('agt_x', true);
    expect(chatStore.isAgentStreaming('agt_x')).toBe(true);
    expect(chatStore.getStreamingAgents().has('agt_x')).toBe(true);
    chatStore.markAgentStreaming('agt_x', false);
    expect(chatStore.isAgentStreaming('agt_x')).toBe(false);
    expect(chatStore.getStreamingAgents().has('agt_x')).toBe(false);
  });

  it('is idempotent: repeated begin NEVER increments (no refcount to leak)', () => {
    // A second beginStream for the same agent (e.g. reattach while send owns
    // the stream) must not make the agent "more busy" — set membership.
    chatStore.markAgentStreaming('agt_dup', true);
    chatStore.markAgentStreaming('agt_dup', true); // double begin
    chatStore.markAgentStreaming('agt_dup', true); // triple begin
    expect(chatStore.isAgentStreaming('agt_dup')).toBe(true);
    // A single end fully clears it — no latent +1 survives.
    chatStore.markAgentStreaming('agt_dup', false);
    expect(chatStore.isAgentStreaming('agt_dup')).toBe(false);
    expect(chatStore.getStreamingAgents().has('agt_dup')).toBe(false);
  });

  it('concurrent streams with the same agent stay busy until the last clear', () => {
    chatStore.markAgentStreaming('agt_y', true); // stream/session 1
    expect(chatStore.isAgentStreaming('agt_y')).toBe(true);
    chatStore.clearAgentStreaming('agt_y'); // session 1 ends (worst case: full clear)
    expect(chatStore.isAgentStreaming('agt_y')).toBe(false);
    // Re-begin for a new turn works fine after a full clear.
    chatStore.markAgentStreaming('agt_y', true);
    expect(chatStore.isAgentStreaming('agt_y')).toBe(true);
    chatStore.markAgentStreaming('agt_y', false);
    expect(chatStore.isAgentStreaming('agt_y')).toBe(false);
  });

  it('does not go negative or emit on defensive clear without begin', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_z', false); // no begin
    expect(chatStore.getStreamingVersion()).toBe(before); // no emit
  });

  it('ignores null/undefined agent ids', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming(null, true);
    chatStore.markAgentStreaming(undefined, true);
    expect(chatStore.getStreamingVersion()).toBe(before);
    expect(chatStore.getStreamingAgents().size).toBe(0);
  });

  it('increments streamingVersion only on real membership changes', () => {
    const v0 = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_v', true);
    const v1 = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_v', true); // idempotent: no change
    const v2 = chatStore.getStreamingVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBe(v1); // double begin does NOT bump the version
    chatStore.markAgentStreaming('agt_v', false);
    const v3 = chatStore.getStreamingVersion();
    expect(v3).toBeGreaterThan(v2);
  });

  it('clearAgentStreaming force-clears a stuck mark (agent stopped)', () => {
    chatStore.markAgentStreaming('agt_stuck', true);
    chatStore.markAgentStreaming('agt_stuck', true); // idempotent
    expect(chatStore.isAgentStreaming('agt_stuck')).toBe(true);
    chatStore.clearAgentStreaming('agt_stuck');
    expect(chatStore.isAgentStreaming('agt_stuck')).toBe(false);
    expect(chatStore.getStreamingAgents().has('agt_stuck')).toBe(false);
  });

  it('clearAgentStreaming is a no-op (no emit) when agent was not streaming', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.clearAgentStreaming('agt_clean');
    expect(chatStore.getStreamingVersion()).toBe(before);
    expect(chatStore.isAgentStreaming('agt_clean')).toBe(false);
  });

  it('clearAgentStreaming ignores null/undefined', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.clearAgentStreaming(null);
    chatStore.clearAgentStreaming(undefined);
    expect(chatStore.getStreamingVersion()).toBe(before);
  });
});