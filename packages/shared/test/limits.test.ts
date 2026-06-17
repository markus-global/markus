import { describe, it, expect } from 'vitest';
import { withJitter, TASK_RETRY_DELAYS_MS, COMPLETION_MARKER } from '../src/limits.js';

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
