import { describe, expect, it } from 'vitest';
import { chatStore } from './useChatStore.ts';

describe('chatStore.markAgentStreaming (sidebar busy signal)', () => {
  it('tracks a single stream and clears it on end', () => {
    expect(chatStore.isAgentStreaming('agt_x')).toBe(false);
    chatStore.markAgentStreaming('agt_x', true);
    expect(chatStore.isAgentStreaming('agt_x')).toBe(true);
    expect(chatStore.getStreamingAgents().get('agt_x')).toBe(1);
    chatStore.markAgentStreaming('agt_x', false);
    expect(chatStore.isAgentStreaming('agt_x')).toBe(false);
    expect(chatStore.getStreamingAgents().has('agt_x')).toBe(false);
  });

  it('refcounts overlapping streams: busy until the last stream ends', () => {
    chatStore.markAgentStreaming('agt_y', true); // stream 1
    chatStore.markAgentStreaming('agt_y', true); // stream 2 (concurrent convs)
    expect(chatStore.isAgentStreaming('agt_y')).toBe(true);
    expect(chatStore.getStreamingAgents().get('agt_y')).toBe(2);
    chatStore.markAgentStreaming('agt_y', false); // stream 1 ends
    expect(chatStore.isAgentStreaming('agt_y')).toBe(true); // still stream 2
    chatStore.markAgentStreaming('agt_y', false); // stream 2 ends
    expect(chatStore.isAgentStreaming('agt_y')).toBe(false);
  });

  it('does not go negative or emit on defensive double-end', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_z', false); // no begin
    expect(chatStore.getStreamingVersion()).toBe(before); // no emit
    // begin once, end twice → clamp at 0
    chatStore.markAgentStreaming('agt_z', true);
    chatStore.markAgentStreaming('agt_z', false);
    chatStore.markAgentStreaming('agt_z', false);
    expect(chatStore.isAgentStreaming('agt_z')).toBe(false);
    expect(chatStore.getStreamingAgents().has('agt_z')).toBe(false);
  });

  it('ignores null/undefined agent ids', () => {
    const before = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming(null, true);
    chatStore.markAgentStreaming(undefined, true);
    expect(chatStore.getStreamingVersion()).toBe(before);
    expect(chatStore.getStreamingAgents().size).toBe(0);
  });

  it('increments streamingVersion only on real changes (drives sidebar re-render)', () => {
    const v0 = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_v', true);
    const v1 = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_v', true); // refcount 1→2: version changes
    const v2 = chatStore.getStreamingVersion();
    chatStore.markAgentStreaming('agt_v', false);
    chatStore.markAgentStreaming('agt_v', false);
    const v3 = chatStore.getStreamingVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
  });
});