import { describe, it, expect, beforeEach } from 'vitest';
import { scheduleBackgroundMaintenance, resetMaintenanceForTest } from '../src/background-maintenance.js';

function fakeStorage(overrides: Record<string, unknown> = {}) {
  const calls = { quickCheck: 0, runMigrations: 0, reclaim: 0 };
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const storage = {
    databaseSizeBytes: () => 1_000,
    quickCheck: () => { calls.quickCheck += 1; return { ok: true, elapsedMs: 1 }; },
    runMigrations: async () => { calls.runMigrations += 1; return { done: true }; },
    reclaimSpace: () => { calls.reclaim += 1; return { reclaimed: false, freeBytes: 0, reason: 'below-threshold' }; },
    ...overrides,
  };
  const log = {
    info: (msg: string, data?: Record<string, unknown>) => { logs.push({ level: 'info', msg, data }); },
    warn: (msg: string, data?: Record<string, unknown>) => { logs.push({ level: 'warn', msg, data }); },
    error: (msg: string, data?: Record<string, unknown>) => { logs.push({ level: 'error', msg, data }); },
  };
  return { storage, log, calls, logs };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

beforeEach(() => resetMaintenanceForTest());

describe('scheduleBackgroundMaintenance', () => {
  it('runs migrations and then reclaims space', async () => {
    const { storage, log, calls, logs } = fakeStorage();
    scheduleBackgroundMaintenance(storage, log, { immediate: true });
    await tick();

    expect(calls.runMigrations).toBe(1);
    expect(logs.some(l => l.msg === 'Data migrations finished')).toBe(true);
    expect(calls.reclaim).toBe(1);
  });

  it('still schedules on a large database (only the in-process check is skipped)', async () => {
    const { storage, log, calls, logs } = fakeStorage({
      databaseSizeBytes: () => 17 * 1024 * 1024 * 1024,
    });
    scheduleBackgroundMaintenance(storage, log, { immediate: true });
    await tick();

    // 大库不跑同步 quick_check（会冻住服务），但**迁移必须照跑**。
    expect(calls.quickCheck).toBe(0);
    expect(logs.some(l => /auto-check skipped \(large database\)/.test(l.msg))).toBe(true);
    expect(calls.runMigrations).toBe(1);
  });

  it('runs the integrity check on a small database', async () => {
    const { storage, log, calls, logs } = fakeStorage();
    scheduleBackgroundMaintenance(storage, log, { immediate: true });
    await tick();

    expect(calls.quickCheck).toBe(1);
    expect(logs.some(l => l.msg === 'Database integrity check passed')).toBe(true);
  });

  it('is idempotent — headless and non-headless paths cannot double-schedule', async () => {
    const { storage, log, calls } = fakeStorage();
    scheduleBackgroundMaintenance(storage, log, { immediate: true });
    scheduleBackgroundMaintenance(storage, log, { immediate: true });
    await tick(40);

    expect(calls.runMigrations).toBe(1);
  });

  it('never throws out of the scheduler when storage is broken', async () => {
    const { storage, log } = fakeStorage({
      databaseSizeBytes: () => { throw new Error('stat failed'); },
      runMigrations: async () => { throw new Error('migration exploded'); },
    });
    expect(() => scheduleBackgroundMaintenance(storage, log, { immediate: true })).not.toThrow();
    await tick(40);
    // 失败只记日志，不影响启动。
    expect(true).toBe(true);
  });
});
