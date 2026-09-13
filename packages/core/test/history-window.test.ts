/**
 * Prefix-cache regression guard: the request-history window must NOT slide by a
 * message or two on every turn.
 *
 * Bug this encodes: `memory.getRecentMessages(sessionId, 200)` returns the last
 * 200 messages, so once a session is longer than 200 messages `messages[0]`
 * changes on EVERY LLM call → the implicit prefix cache (byte-prefix based)
 * misses on the whole replayed history (~90k tokens re-billed per call).
 */
import { describe, it, expect } from 'vitest';
import { requestHistoryStart, requestHistoryWindow } from '../src/history-window.js';

const MIN = 400;
const BLOCK = 100;

describe('requestHistoryStart / requestHistoryWindow', () => {
  it('does not cut at all while the session is within the minimum', () => {
    expect(requestHistoryStart(0, MIN, BLOCK)).toBe(0);
    expect(requestHistoryStart(1, MIN, BLOCK)).toBe(0);
    expect(requestHistoryStart(MIN, MIN, BLOCK)).toBe(0);
  });

  it('only ever cuts on a block boundary', () => {
    for (let total = 0; total <= 1200; total++) {
      const start = requestHistoryStart(total, MIN, BLOCK);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start % BLOCK).toBe(0);
      // Never cuts below the minimum window.
      expect(total - start).toBeGreaterThanOrEqual(Math.min(total, MIN));
    }
  });

  it('advances in 100-message jumps, not one message at a time', () => {
    expect(requestHistoryStart(499, MIN, BLOCK)).toBe(0);
    expect(requestHistoryStart(500, MIN, BLOCK)).toBe(100);
    expect(requestHistoryStart(599, MIN, BLOCK)).toBe(100);
    expect(requestHistoryStart(600, MIN, BLOCK)).toBe(200);
  });

  it('keeps the window head byte-identical for ~BLOCK turns (vs sliding every turn)', () => {
    const all = Array.from({ length: 1200 }, (_, i) => `m${i}`);
    let naiveChanges = 0;
    let quantizedChanges = 0;
    for (let total = 401; total <= 500; total++) {
      const cur = all.slice(0, total);
      const prev = all.slice(0, total - 1);
      if (cur.slice(-MIN)[0] !== prev.slice(-MIN)[0]) naiveChanges++;
      if (requestHistoryWindow(cur, MIN, BLOCK)[0] !== requestHistoryWindow(prev, MIN, BLOCK)[0]) {
        quantizedChanges++;
      }
    }
    // 100 turns (401..500): the naive slice moves its head on every single one.
    expect(naiveChanges).toBe(100);
    // Quantized: exactly one jump, at the total=500 block boundary.
    expect(quantizedChanges).toBe(1);
  });

  it('window content is the tail of the transcript (nothing in the middle)', () => {
    const all = Array.from({ length: 550 }, (_, i) => `m${i}`);
    const win = requestHistoryWindow(all, MIN, BLOCK);
    expect(win.length).toBe(450);
    expect(win[0]).toBe('m100');
    expect(win[win.length - 1]).toBe('m549');
  });

  it('is defensive about pathological inputs', () => {
    expect(requestHistoryStart(Number.NaN, MIN, BLOCK)).toBe(0);
    expect(requestHistoryStart(-5, MIN, BLOCK)).toBe(0);
    expect(requestHistoryStart(1000, 0, 0)).toBeGreaterThanOrEqual(0);
  });
});
