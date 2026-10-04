import { describe, it, expect } from 'vitest';
import {
  withJitter,
  TASK_RETRY_DELAYS_MS,
  END_TURN_REPLY_SENTINEL,
  stripLegacyCompletionToken,
} from '../src/limits.js';

describe('withJitter', () => {
  it('returns a value close to the base', () => {
    const base = 10000;
    for (let i = 0; i < 50; i++) {
      const result = withJitter(base);
      expect(result).toBeGreaterThanOrEqual(base * 0.8);
      expect(result).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it('never returns negative', () => {
    for (let i = 0; i < 50; i++) {
      expect(withJitter(0)).toBeGreaterThanOrEqual(0);
      expect(withJitter(1)).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects custom factor', () => {
    const base = 1000;
    for (let i = 0; i < 50; i++) {
      const result = withJitter(base, 0.5);
      expect(result).toBeGreaterThanOrEqual(base * 0.5);
      expect(result).toBeLessThanOrEqual(base * 1.5);
    }
  });

  it('returns integer values', () => {
    for (let i = 0; i < 20; i++) {
      const result = withJitter(12345);
      expect(Number.isInteger(result)).toBe(true);
    }
  });
});

describe('constants', () => {
  it('TASK_RETRY_DELAYS_MS is ascending', () => {
    for (let i = 1; i < TASK_RETRY_DELAYS_MS.length; i++) {
      expect(TASK_RETRY_DELAYS_MS[i]).toBeGreaterThan(TASK_RETRY_DELAYS_MS[i - 1]!);
    }
  });

  // The text-marker protocol is fully retired; the only remaining completion
  // signal is this typed sentinel (produced by the end_turn tool / heartbeat path).
  it('END_TURN_REPLY_SENTINEL is the typed end-of-turn signal', () => {
    expect(END_TURN_REPLY_SENTINEL).toBe('[end_turn]');
  });
});

describe('stripLegacyCompletionToken', () => {
  it('removes the retired <<HANDLE_COMPLETE>> token', () => {
    expect(stripLegacyCompletionToken('done <<HANDLE_COMPLETE>>')).toBe('done ');
  });

  it('removes malformed variants a weak model emits as prose', () => {
    expect(stripLegacyCompletionToken('带上 <HANDLE_COMPLETE> 标记')).toBe('带上  标记');
    expect(stripLegacyCompletionToken('end < HANDLE_COMPLETE >')).toBe('end ');
    expect(stripLegacyCompletionToken('x <<HANDLE_COMPLETE> y')).toBe('x  y');
    expect(stripLegacyCompletionToken('x <handle_complete> y')).toBe('x  y');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The task is complete and handled successfully.';
    expect(stripLegacyCompletionToken(text)).toBe(text);
  });

  it('does not touch the end_turn sentinel or ordinary non-marker replies', () => {
    expect(stripLegacyCompletionToken(END_TURN_REPLY_SENTINEL)).toBe(END_TURN_REPLY_SENTINEL);
    expect(stripLegacyCompletionToken('all done, nothing to see here')).toBe('all done, nothing to see here');
  });
});
