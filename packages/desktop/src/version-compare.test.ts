import { describe, it, expect } from 'vitest';
import { compareVersions, decideBackendAction } from './version-compare.js';

describe('compareVersions', () => {
  it('orders numerically, not lexicographically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('equal versions → 0; missing trailing segments count as 0', () => {
    expect(compareVersions('0.12.3', '0.12.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('unparseable on either side → null', () => {
    expect(compareVersions('', '0.12.3')).toBeNull();
    expect(compareVersions('abc', '0.12.3')).toBeNull();
    expect(compareVersions('0.12.x', '0.12.3')).toBeNull();
    expect(compareVersions('0.12.3-beta.1', '0.12.3')).toBeNull();
    expect(compareVersions('0.12.3', '')).toBeNull();
  });
});

describe('decideBackendAction — port-8056 ownership rule', () => {
  const APP = '0.12.2'; // installed release

  it('no server running → start', () => {
    expect(decideBackendAction({ running: false }, APP)).toBe('start');
    expect(decideBackendAction({ running: false, version: '0.0.1' }, APP)).toBe('start');
  });

  it('same version → reuse', () => {
    expect(decideBackendAction({ running: true, version: '0.12.2' }, APP)).toBe('reuse');
  });

  it('REGRESSION (takeover war): a NEWER running server must be reused, never killed', () => {
    // Dev build 0.12.3 running; installed 0.12.2 app launches.
    // The pre-fix strict-equality rule judged this "old" and killed the port
    // owner — two apps open = mutual kill on every launch. This assertion
    // goes red under that implementation.
    expect(decideBackendAction({ running: true, version: '0.12.3' }, APP)).toBe('reuse');
    expect(decideBackendAction({ running: true, version: '1.0.0' }, APP)).toBe('reuse');
  });

  it('strictly older running server → takeover (upgrade path preserved)', () => {
    expect(decideBackendAction({ running: true, version: '0.12.1' }, APP)).toBe('takeover');
    expect(decideBackendAction({ running: true, version: '0.9.9' }, APP)).toBe('takeover');
  });

  it('unknown / unparseable running version → reuse (never kill on a guess)', () => {
    expect(decideBackendAction({ running: true }, APP)).toBe('reuse');
    expect(decideBackendAction({ running: true, version: '' }, APP)).toBe('reuse');
    expect(decideBackendAction({ running: true, version: 'garbage' }, APP)).toBe('reuse');
    expect(decideBackendAction({ running: true, version: '0.12.3-beta.1' }, APP)).toBe('reuse');
  });

  it('unparseable app version → reuse', () => {
    expect(decideBackendAction({ running: true, version: '0.12.1' }, '')).toBe('reuse');
  });
});
