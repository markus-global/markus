/**
 * Guards for the update state machine.
 *
 * These assertions exist because the *transitions* are where auto-update breaks
 * in ways nobody notices: an update that was downloaded and then "forgotten" by
 * a later failed check still looks green in every log, and a retry loop that
 * never backs off looks like "the updater is running".
 *
 * Aggressive falsification used while writing this file (each one turned the
 * suite red): dropping the `ready` guard in the `error` branch; returning the
 * base interval without the exponential factor; treating a non-finite percent as
 * 100.
 */
import { describe, it, expect } from 'vitest';
import {
  BASE_CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
  MAX_CHECK_INTERVAL_MS,
  initialUpdateState,
  isActionablePhase,
  nextCheckIntervalMs,
  normalizePercent,
  reduceUpdateState,
  shouldStartUpdater,
  type UpdateState,
} from './update-policy.js';

function downloaded(): UpdateState {
  return reduceUpdateState(
    reduceUpdateState(initialUpdateState(), { type: 'available', version: '0.13.0' }),
    { type: 'downloaded', version: '0.13.0' },
  );
}

describe('reduceUpdateState', () => {
  it('walks available → downloading → ready', () => {
    let s = initialUpdateState();
    s = reduceUpdateState(s, { type: 'available', version: '0.13.0' });
    expect(s).toMatchObject({ phase: 'downloading', version: '0.13.0', percent: 0 });
    s = reduceUpdateState(s, { type: 'progress', percent: 37.4 });
    expect(s).toMatchObject({ phase: 'downloading', percent: 37 });
    s = reduceUpdateState(s, { type: 'downloaded', version: '0.13.0' });
    expect(s).toMatchObject({ phase: 'ready', version: '0.13.0', percent: 100, error: null });
  });

  it('keeps a downloaded update through a later failed check', () => {
    const s = reduceUpdateState(downloaded(), { type: 'error', message: 'ETIMEDOUT' });
    expect(s.phase).toBe('ready');
    expect(s.version).toBe('0.13.0');
    expect(s.error).toBeNull();
  });

  it('keeps a downloaded update through "not available" (channel flip-flop)', () => {
    const s = reduceUpdateState(downloaded(), { type: 'not-available' });
    expect(s.phase).toBe('ready');
    expect(s.version).toBe('0.13.0');
  });

  it('ignores a trailing progress frame after the download settled', () => {
    const s = reduceUpdateState(downloaded(), { type: 'progress', percent: 99 });
    expect(s.phase).toBe('ready');
    expect(s.percent).toBe(100);
  });

  it('clears the previous error when a new check starts', () => {
    let s = reduceUpdateState(initialUpdateState(), { type: 'error', message: 'ENOTFOUND' });
    expect(s.phase).toBe('error');
    s = reduceUpdateState(s, { type: 'checking' });
    expect(s).toMatchObject({ phase: 'checking', error: null });
  });

  it('never drops requiresMoveToApplications once set', () => {
    let s = reduceUpdateState(downloaded(), { type: 'location-blocked' });
    expect(s.requiresMoveToApplications).toBe(true);
    s = reduceUpdateState(s, { type: 'checking' });
    expect(s.requiresMoveToApplications).toBe(true);
  });
});

describe('normalizePercent', () => {
  it('clamps and rounds', () => {
    expect(normalizePercent(-5)).toBe(0);
    expect(normalizePercent(150)).toBe(100);
    expect(normalizePercent(37.6)).toBe(38);
  });

  it('maps a non-finite value to 0 rather than 100 (a NaN must not read as complete)', () => {
    expect(normalizePercent(Number.NaN)).toBe(0);
    expect(normalizePercent(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('nextCheckIntervalMs', () => {
  it('uses the healthy cadence when nothing is failing', () => {
    expect(nextCheckIntervalMs(0)).toBe(BASE_CHECK_INTERVAL_MS);
    expect(INITIAL_CHECK_DELAY_MS).toBeLessThan(BASE_CHECK_INTERVAL_MS);
  });

  it('backs off exponentially and caps at 24h', () => {
    expect(nextCheckIntervalMs(1)).toBe(BASE_CHECK_INTERVAL_MS * 2);
    expect(nextCheckIntervalMs(2)).toBe(BASE_CHECK_INTERVAL_MS * 4);
    expect(nextCheckIntervalMs(3)).toBe(MAX_CHECK_INTERVAL_MS);
    expect(nextCheckIntervalMs(50)).toBe(MAX_CHECK_INTERVAL_MS);
  });
});

describe('shouldStartUpdater', () => {
  it('runs only for packaged, non-MAS builds', () => {
    expect(shouldStartUpdater({ isMas: false, isPackaged: true })).toBe(true);
    expect(shouldStartUpdater({ isMas: true, isPackaged: true })).toBe(false);
    expect(shouldStartUpdater({ isMas: false, isPackaged: false })).toBe(false);
  });
});

describe('isActionablePhase', () => {
  it('only downloading/ready deserve UI', () => {
    expect(isActionablePhase('downloading')).toBe(true);
    expect(isActionablePhase('ready')).toBe(true);
    expect(isActionablePhase('idle')).toBe(false);
    expect(isActionablePhase('checking')).toBe(false);
    expect(isActionablePhase('error')).toBe(false);
  });
});
