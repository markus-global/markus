import { describe, it, expect } from 'vitest';
import { withJitter, TASK_RETRY_DELAYS_MS, COMPLETION_MARKER, hasCompletionMarker, stripCompletionMarkerLeak } from '../src/limits.js';

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

  it('COMPLETION_MARKER is non-empty and unique', () => {
    expect(COMPLETION_MARKER.length).toBeGreaterThan(5);
    expect(COMPLETION_MARKER).toContain('<<');
  });
});

describe('stripCompletionMarkerLeak', () => {
  it('removes the exact marker', () => {
    expect(stripCompletionMarkerLeak(`done ${COMPLETION_MARKER}`)).toBe('done ');
  });

  it('removes malformed variants a weak model emits as prose', () => {
    expect(stripCompletionMarkerLeak('带上 <HANDLE_COMPLETE> 标记')).toBe('带上  标记');
    expect(stripCompletionMarkerLeak('end < HANDLE_COMPLETE >')).toBe('end ');
    expect(stripCompletionMarkerLeak('x <<HANDLE_COMPLETE> y')).toBe('x  y');
    expect(stripCompletionMarkerLeak('x <handle_complete> y')).toBe('x  y');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The task is complete and handled successfully.';
    expect(stripCompletionMarkerLeak(text)).toBe(text);
  });

  it('detection stays strict — a malformed variant is NOT a real marker', () => {
    expect(hasCompletionMarker('带上 <HANDLE_COMPLETE> 标记')).toBe(false);
    expect(hasCompletionMarker(`done ${COMPLETION_MARKER}`)).toBe(true);
  });
});
