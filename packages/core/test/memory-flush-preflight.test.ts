import { describe, it, expect } from 'vitest';
import {
  shouldMemoryFlushPreflight,
  MEMORY_FLUSH_PREFLIGHT_THRESHOLD,
} from '../src/agent.js';

describe('shouldMemoryFlushPreflight (A2)', () => {
  const base = {
    sessionId: 'chat_agent1_123',
    lastUsagePercent: 90,
    alreadyFlushed: false,
  };

  it('fires when usage crosses the threshold and the session has not flushed', () => {
    expect(shouldMemoryFlushPreflight(base)).toBe(true);
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: MEMORY_FLUSH_PREFLIGHT_THRESHOLD })).toBe(true);
  });

  it('does not fire below the threshold', () => {
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: MEMORY_FLUSH_PREFLIGHT_THRESHOLD - 1 })).toBe(false);
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: 10 })).toBe(false);
  });

  it('does not fire twice for the same session (dedup)', () => {
    expect(shouldMemoryFlushPreflight({ ...base, alreadyFlushed: true })).toBe(false);
  });

  it('never fires for sys_ sessions (prevents flush → compact → flush reentry)', () => {
    expect(shouldMemoryFlushPreflight({ ...base, sessionId: 'sys_agent1_999' })).toBe(false);
  });

  it('does not fire when no prior usage is known', () => {
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: undefined })).toBe(false);
  });

  it('does not fire without a session id', () => {
    expect(shouldMemoryFlushPreflight({ ...base, sessionId: undefined })).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: 50, threshold: 40 })).toBe(true);
    expect(shouldMemoryFlushPreflight({ ...base, lastUsagePercent: 50, threshold: 60 })).toBe(false);
  });
});
