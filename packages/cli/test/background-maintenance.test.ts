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

/**
 * ③ 终态邮件项清理的**周期性**排期。
 *
 * 为什么这组测试必须存在：`pruneTerminalMailboxItems` 早就有实现、有单测，但生产里
 * 没有任何调用者 —— 真库 243,692 行里 243,531 行是终态（99.93%）、文件 12.3 GB。
 * 「函数存在」和「有人在守」是两件事，本组锁的是后者。
 */
describe('marketing: 终态邮件项清理必须被排期（不是只存在于单测里）', () => {
  function pruneStorage(plan: { candidates: number; deleted?: number }) {
    const calls: Array<{ olderThanDays?: number; dryRun?: boolean }> = [];
    const storage = {
      databaseSizeBytes: () => 1_000,
      quickCheck: () => ({ ok: true, elapsedMs: 1 }),
      runMigrations: async () => ({ done: true }),
      reclaimSpace: () => ({ reclaimed: false, freeBytes: 0, reason: 'below-threshold' }),
      pruneMailbox: (opts?: { olderThanDays?: number; dryRun?: boolean }) => {
        calls.push(opts ?? {});
        const dryRun = opts?.dryRun ?? true;
        return {
          dryRun,
          candidates: plan.candidates,
          deleted: dryRun ? 0 : (plan.deleted ?? plan.candidates),
          bytes: plan.candidates * 1024,
          vacuumed: !dryRun,
        };
      },
    };
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const log = {
      info: (msg: string, data?: Record<string, unknown>) => { logs.push({ msg, data }); },
      warn: (msg: string, data?: Record<string, unknown>) => { logs.push({ msg, data }); },
      error: (msg: string, data?: Record<string, unknown>) => { logs.push({ msg, data }); },
    };
    return { storage, log, calls, logs };
  }

  it('有候选 ⇒ 先 dry-run 再真删，并把数字写进日志（运维要能回答"清了什么"）', async () => {
    const { storage, log, calls, logs } = pruneStorage({ candidates: 7, deleted: 7 });
    const handle = scheduleBackgroundMaintenance(storage, log, { immediate: true, pruneIntervalMs: 60_000 });
    await tick();

    expect(calls[0]).toEqual({ olderThanDays: 30, dryRun: true });
    expect(calls[1]).toEqual({ olderThanDays: 30, dryRun: false });
    const entry = logs.find(l => l.msg === 'Mailbox prune finished');
    expect(entry).toBeDefined();
    expect(entry!.data).toMatchObject({ candidates: 7, deleted: 7, retentionDays: 30 });
    handle.cancel();
  });

  it('零候选 ⇒ 只跑 dry-run，绝不下删除语句', async () => {
    const { storage, log, calls, logs } = pruneStorage({ candidates: 0 });
    const handle = scheduleBackgroundMaintenance(storage, log, { immediate: true, pruneIntervalMs: 60_000 });
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.dryRun).toBe(true);
    expect(logs.some(l => l.msg === 'Mailbox prune: nothing to delete')).toBe(true);
    handle.cancel();
  });

  it('保留天数可配（默认 30 天，不改代码就能调）', async () => {
    const { storage, log, calls } = pruneStorage({ candidates: 0 });
    const handle = scheduleBackgroundMaintenance(storage, log, {
      immediate: true, pruneIntervalMs: 60_000, mailboxRetentionDays: 7,
    });
    await tick();

    expect(calls[0]!.olderThanDays).toBe(7);
    handle.cancel();
  });

  it('周期会重排（不是只跑一次就再也不管）', async () => {
    const { storage, log, calls } = pruneStorage({ candidates: 0 });
    const handle = scheduleBackgroundMaintenance(storage, log, { immediate: true, pruneIntervalMs: 15 });
    await tick();

    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    await tick(60);
    expect(calls.length).toBeGreaterThan(afterFirst);
    handle.cancel();
  });

  it('storage 不支持清理 ⇒ 明确记一条日志，而不是静默什么都不做', async () => {
    const { storage, log, logs } = pruneStorage({ candidates: 0 });
    delete (storage as { pruneMailbox?: unknown }).pruneMailbox;
    const handle = scheduleBackgroundMaintenance(storage, log, { immediate: true, pruneIntervalMs: 60_000 });
    await tick();

    expect(logs.some(l => l.msg.includes('Mailbox pruning unavailable'))).toBe(true);
    handle.cancel();
  });

  it('清理抛错 ⇒ 不拖垮启动路径，只记 warn', async () => {
    const { storage, log, logs } = pruneStorage({ candidates: 0 });
    (storage as { pruneMailbox: () => never }).pruneMailbox = () => { throw new Error('db locked'); };
    expect(() => scheduleBackgroundMaintenance(storage, log, { immediate: true, pruneIntervalMs: 60_000 })).not.toThrow();
    await tick();

    expect(logs.some(l => l.msg === 'Mailbox prune could not run')).toBe(true);
  });
});
