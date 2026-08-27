import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type * as CrashNS from './crash.js';
let crashMod: typeof CrashNS;
let tmpHome: string;
const originalHome = process.env.HOME;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'markus-crash-guard-'));
  process.env.HOME = tmpHome;
  mkdirSync(join(tmpHome, '.markus', 'logs'), { recursive: true });
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh module instance per test so singletons (installed flag, run-state) reset.
  vi.resetModules();
  crashMod = await import('./crash.js');
});

describe('crash attribution: memory snapshot', () => {
  it('returns a memory snapshot with plausible MB values', () => {
    const m = crashMod.getMemorySnapshot();
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.heapUsedMb).toBeGreaterThan(0);
    expect(m.heapTotalMb).toBeGreaterThanOrEqual(m.heapUsedMb);
    expect(m.systemTotalMb).toBeGreaterThan(0);
    expect(m.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('crash attribution: report building & env redaction', () => {
  it('buildCrashReport produces a full report with redacted env', () => {
    process.env['MARKUS_TEST_APIKEY'] = 'super-secret';
    process.env['MARKUS_TEST_VISIBLE'] = 'hello';
    const r = crashMod.buildCrashReport('manualTest');
    expect(r.reason).toBe('manualTest');
    expect(r.pid).toBeGreaterThan(0);
    expect(r.timestamp).toBeTruthy();
    expect(r.memory.rssMb).toBeGreaterThan(0);
    // Secret filtered
    expect(r.env['MARKUS_TEST_API_KEY']).toBeUndefined();
    expect(r.env['MARKUS_TEST_VISIBLE']).toBe('hello');
  });

  it('writeCrashReport appends to crash.log and last-crash.json', () => {
    const r = crashMod.buildCrashReport('manualTest');
    crashMod.writeCrashReport(r);
    const logPath = crashMod.getCrashLogPath();
    const lastPath = crashMod.getLastCrashPath();
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(lastPath)).toBe(true);
    const line = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(line[0]!).reason).toBe('manualTest');
    expect(JSON.parse(readFileSync(lastPath, 'utf-8')).reason).toBe('manualTest');
  });
});

describe('crash attribution: unclean-shutdown detection', () => {
  it('flags an unclean shutdown when prior run-state is still running', () => {
    crashMod.markRunStarted();
    const d = crashMod.detectUncleanShutdown();
    expect(d.unclean).toBe(true);
    expect(d.previous?.status).toBe('running');
  });

  it('does NOT flag crash after a clean shutdown marker', () => {
    crashMod.markRunStarted();
    crashMod.markCleanShutdown();
    const d = crashMod.detectUncleanShutdown();
    expect(d.unclean).toBe(false);
    expect(d.previous?.status).toBe('clean-shutdown');
  });

  it('lastCrash is surfaced when a crash.json exists', () => {
    crashMod.markRunStarted();
    crashMod.writeCrashReport(crashMod.buildCrashReport('uncaughtException', { message: 'boom' }));
    const d = crashMod.detectUncleanShutdown();
    expect(d.lastCrash?.reason).toBe('uncaughtException');
    expect(d.lastCrash?.message).toBe('boom');
  });

  it('returns nulls when no prior state', () => {
    // Remove any prior state
    rmSync(crashMod.getRunStatePath(), { force: true });
    rmSync(crashMod.getLastCrashPath(), { force: true });
    const d = crashMod.detectUncleanShutdown();
    expect(d.previous).toBeNull();
    expect(d.lastCrash).toBeNull();
    expect(d.unclean).toBe(false);
  });
});

describe('memory watermark watchdog', () => {
  it('samples and records peak values, then stops', () => {
    const wd = crashMod.memoryWatermarkWatchdog({ intervalMs: 5 });
    wd.start();
    // Let a few samples run
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        wd.stop();
        const w = wd.watermark();
        expect(w.samples).toBeGreaterThan(0);
        expect(w.peakRssMb).toBeGreaterThan(0);
        resolve();
      }, 25);
    });
  });

  it('raises an alarm exactly once when RSS exceeds the limit', () => {
    let alarms = 0;
    const wd = crashMod.memoryWatermarkWatchdog({
      intervalMs: 2,
      rssLimitMb: 0.001, // trivially exceeded
      onAlarm: () => { alarms += 1; },
    });
    wd.start();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        wd.stop();
        expect(alarms).toBe(1);
        expect(wd.watermark().alarmed).toBe(true);
        resolve();
      }, 20);
    });
  });
});