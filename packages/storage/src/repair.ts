/**
 * 开库前自愈：探测 → 备份 → 修复 → 校验 → 原子替换（备份永不删除）。
 *
 * 两条执行路径
 * ────────────
 *  · **内联**（小库，默认 ≤512 MB）：启动时直接修完，用户感知不到；
 *  · **两段式**（大库）：本次启动派后台工人重建，**下次启动**用两个 rename 换库。
 *    大库重建是分钟级，绝不能压在启动路径上 —— 那就不是"无感知"了。
 *
 * 三条不可让步的安全约束
 * ─────────────────────
 *  S1 **先备份，且永不删**：备份没写成功，绝不动原库。
 *  S2 **校验通过才替换**：可读的行必须全部写入（自己弄丢的不行），重建库自身
 *     必须通过完整性检查。任何一项不满足 → 放弃，原库原样保留。
 *  S3 **原子替换**：同目录 rename，连同 `-wal`/`-shm` 一起处理（否则旧 WAL 会被
 *     套用到新库上，等于制造新损坏）。
 *
 * 无外部依赖：`.recover` 只有官方 CLI 有（Windows 没有、Linux 版本参差、PATH 可能
 * 指向阉割版），所以重建用 node:sqlite 自己实现（见 repair-rebuild.ts）。
 */

import { copyFileSync, existsSync, renameSync, rmSync, statSync, statfsSync, openSync, fsyncSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { probeDatabaseHealthInChild } from './health-probe.js';
import { rebuildInto, verifyRecovered } from './repair-rebuild.js';

export interface RepairTableReport {
  name: string;
  /** 原库里 COUNT(*) 的结果（连计数都失败则为 unreadable） */
  source: number | 'unreadable';
  /** 实际从坏库里**读出来**的行数 */
  readRows: number;
  /** 真正写进新库的行数 */
  recovered: number;
  /** 坏页覆盖、物理上救不回来的行 */
  unreadableRows: number;
  skippedWindows: number;
}

export interface RepairResult {
  action: 'none' | 'repaired' | 'scheduled' | 'applied' | 'aborted';
  reason?: string;
  backupPath?: string;
  workPath?: string;
  tables?: RepairTableReport[];
  durationMs: number;
}

export interface RepairOptions {
  probeTimeoutMs?: number;
  diskSafetyFactor?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  forceCorrupt?: boolean;
  /** 超过这个大小的库走两段式（后台重建 + 下次启动换库）。默认 512 MB。 */
  deferAboveBytes?: number;
}

const READY_SUFFIX = '.repair-ready.json';
const PENDING_SUFFIX = '.repair-pending.json';
const FAILED_SUFFIX = '.repair-failed.json';

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function freeDiskBytes(path: string): number {
  try {
    const s = statfsSync(dirname(path)) as unknown as { bsize?: number; bavail?: number };
    return Number(s.bsize ?? 0) * Number(s.bavail ?? 0);
  } catch { return 0; }
}

/** 同目录 copy + fsync：备份必须真的落盘，不能只停在 page cache。 */
function durableCopy(from: string, to: string): void {
  copyFileSync(from, to);
  try {
    const fd = openSync(to, 'r+');
    fsyncSync(fd);
    closeSync(fd);
  } catch { /* fsync 不可用时退化为普通 copy */ }
}

function writeJson(path: string, data: unknown): void {
  try { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

/** 备份（原库 + WAL/SHM）。失败则抛错 —— 调用方必须因此放弃修复。 */
function backupDatabase(dbPath: string): string {
  const size = statSync(dbPath).size;
  const backupPath = `${dbPath}.backup-${timestamp()}`;
  durableCopy(dbPath, backupPath);
  if (statSync(backupPath).size !== size) throw new Error('backup size mismatch');
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) durableCopy(`${dbPath}${suffix}`, `${backupPath}${suffix}`);
  }
  return backupPath;
}

/** 无损检查：读出来的行必须全部写进新库。 */
function assertNotLossy(tables: RepairTableReport[]): string | null {
  const lossy = tables.filter(t => t.recovered < t.readRows);
  if (lossy.length === 0) return null;
  return `lossy-copy: ${lossy.map(t => `${t.name} read ${t.readRows} wrote ${t.recovered}`).join('; ')}`;
}

/** 原子替换：原库挪开 → 新库就位；备份确认存在后才删掉挪开的那份。 */
function swapInPlace(dbPath: string, workPath: string, backupPath: string): void {
  const replacedPath = `${dbPath}.replaced-${timestamp()}`;
  renameSync(dbPath, replacedPath);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${replacedPath}${suffix}`);
  }
  renameSync(workPath, dbPath);

  if (existsSync(backupPath)) {
    try { rmSync(replacedPath, { force: true }); } catch { /* ignore */ }
    for (const suffix of ['-wal', '-shm']) {
      try { rmSync(`${replacedPath}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** 重建 + 校验到一个工作文件（不含替换）。 */
function buildRepairedCopy(
  dbPath: string,
  log: (m: string, d?: Record<string, unknown>) => void,
): { workPath: string; tables: RepairTableReport[] } {
  const workPath = `${dbPath}.repairing-${timestamp()}`;
  const report = rebuildInto(dbPath, workPath, log);
  const lossy = assertNotLossy(report.tables);
  if (lossy) {
    try { rmSync(workPath, { force: true }); } catch { /* ignore */ }
    throw new Error(lossy);
  }
  const verified = verifyRecovered(workPath, report.tables);
  if (!verified.ok) {
    try { rmSync(workPath, { force: true }); } catch { /* ignore */ }
    throw new Error(`verify-failed: ${verified.reason}`);
  }
  return { workPath, tables: report.tables };
}

/**
 * 下次启动时应用上一次排期的修复。整个过程只有两个 rename，毫秒级。
 */
export function tryApplyPendingRepair(
  dbPath: string,
  log: (m: string, d?: Record<string, unknown>) => void = () => {},
): RepairResult {
  const started = Date.now();
  const ready = readJson<{ workPath?: string; tables?: RepairTableReport[]; applied?: boolean }>(`${dbPath}${READY_SUFFIX}`);
  if (!ready || ready.applied) return { action: 'none', reason: 'no-pending-repair', durationMs: 0 };

  const workPath = ready.workPath;
  if (!workPath || !existsSync(workPath)) {
    try { rmSync(`${dbPath}${READY_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    return { action: 'none', reason: 'pending-work-missing', durationMs: Date.now() - started };
  }

  // 换库前再验一次：工作文件可能被中途杀进程写坏
  const verified = verifyRecovered(workPath, ready.tables ?? []);
  if (!verified.ok) {
    try { rmSync(`${dbPath}${READY_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    try { rmSync(workPath, { force: true }); } catch { /* ignore */ }
    log('Pending repair failed verification — discarded', { reason: verified.reason });
    return { action: 'aborted', reason: `pending-verify-failed: ${verified.reason}`, durationMs: Date.now() - started };
  }

  // 备份必须在：否则拒绝换库
  const backupPath = readJson<{ backupPath?: string }>(`${dbPath}${READY_SUFFIX}`)?.backupPath;
  if (!backupPath || !existsSync(backupPath)) {
    log('Refusing to swap — backup missing', { backupPath });
    return { action: 'aborted', reason: 'backup-missing', durationMs: Date.now() - started };
  }

  try {
    swapInPlace(dbPath, workPath, backupPath);
  } catch (err) {
    return { action: 'aborted', reason: `swap-failed: ${String(err).slice(0, 160)}`, durationMs: Date.now() - started };
  }

  try { rmSync(`${dbPath}${READY_SUFFIX}`, { force: true }); } catch { /* ignore */ }
  log('Pending repair applied — original preserved as backup', { backupPath });
  return { action: 'applied', backupPath, tables: ready.tables, durationMs: Date.now() - started };
}

/** 派后台工人（大库专用）。工人只重建 + 校验，不动原库。 */
export interface RepairWorkerSpawnSpec {
  command: string;
  args: string[];
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv };
}

/**
 * 后台修复工人的启动参数 —— **纯函数，可测**。
 *
 * 见 `health-probe.ts` 里的同款说明：打包后的 Electron 中 `process.execPath`
 * 是主程序，必须是 `ELECTRON_RUN_AS_NODE=1` 才执行脚本，否则会静默启动第二个
 * GUI 实例（detached + stdio:'ignore' 让这个错误完全不可见）。
 */
export function buildRepairWorkerSpawnSpec(
  dbPath: string,
  workerPath: string,
  execPath: string = process.execPath,
  baseEnv: NodeJS.ProcessEnv = process.env,
): RepairWorkerSpawnSpec {
  return {
    command: execPath,
    args: [workerPath, dbPath],
    options: {
      detached: true,
      stdio: 'ignore',
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
    },
  };
}

function scheduleBackgroundRepair(dbPath: string, log: (m: string, d?: Record<string, unknown>) => void): void {
  const workerPath = new URL('./repair-worker.js', import.meta.url).pathname;
  writeJson(`${dbPath}${PENDING_SUFFIX}`, { pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const spec = buildRepairWorkerSpawnSpec(dbPath, workerPath);
    const child = spawn(spec.command, spec.args, spec.options);
    child.unref();
    log('Background repair scheduled (applies on next start)', { workerPath });
  } catch (err) {
    log('Failed to spawn repair worker', { error: String(err) });
  }
}

/**
 * 后台工人的入口：只重建 + 校验 + 写就绪标记，**不动原库**。
 * 真正换库留到下次启动（那时原库没有被任何进程占用，rename 才安全）。
 */
export async function runBackgroundRepair(
  dbPath: string,
  log: (m: string, d?: Record<string, unknown>) => void = () => {},
): Promise<RepairResult> {
  const started = Date.now();
  if (!existsSync(dbPath)) return { action: 'aborted', reason: 'database-missing', durationMs: 0 };

  let backupPath: string;
  try {
    backupPath = backupDatabase(dbPath);
  } catch (err) {
    const reason = `backup-failed: ${String(err).slice(0, 160)}`;
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    try { rmSync(`${dbPath}${PENDING_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    return { action: 'aborted', reason, durationMs: Date.now() - started };
  }
  log('Background repair: backup written', { backupPath });

  try {
    const built = buildRepairedCopy(dbPath, log);
    writeJson(`${dbPath}${READY_SUFFIX}`, {
      workPath: built.workPath,
      tables: built.tables,
      backupPath,
      readyAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
    try { rmSync(`${dbPath}${PENDING_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    log('Background repair ready — will be applied on next start', { workPath: built.workPath });
    return { action: 'scheduled', backupPath, workPath: built.workPath, tables: built.tables, durationMs: Date.now() - started };
  } catch (err) {
    const reason = String(err).slice(0, 240);
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    try { rmSync(`${dbPath}${PENDING_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    log('Background repair failed — original untouched', { reason });
    return { action: 'aborted', reason, backupPath, durationMs: Date.now() - started };
  }
}

export async function prepareDatabaseFile(dbPath: string, opts: RepairOptions = {}): Promise<RepairResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  if (!existsSync(dbPath)) return { action: 'none', reason: 'no-database', durationMs: 0 };

  const probe = opts.forceCorrupt
    ? { status: 'corrupt' as const, detail: 'forced' }
    : await probeDatabaseHealthInChild(dbPath, opts.probeTimeoutMs ?? 20_000);

  if (probe.status === 'ok') return { action: 'none', reason: 'healthy', durationMs: Date.now() - started };
  if (probe.status === 'unknown') {
    // 拿不到结论（超时）→ 绝不猜。错修比不修更糟。
    return { action: 'none', reason: `probe-unknown: ${probe.detail ?? ''}`.slice(0, 200), durationMs: Date.now() - started };
  }

  const dbSize = statSync(dbPath).size;
  const deferAbove = opts.deferAboveBytes ?? 512 * 1024 * 1024;

  // 大库：排期到后台，下次启动换库（本次启动不受影响）
  if (dbSize > deferAbove) {
    const pending = readJson<{ startedAt?: string }>(`${dbPath}${PENDING_SUFFIX}`);
    const fresh = pending?.startedAt ? Date.now() - Date.parse(pending.startedAt) < 30 * 60_000 : false;
    if (!fresh) scheduleBackgroundRepair(dbPath, log);
    log('Database is corrupt — repair deferred to background (too large to block startup)', {
      sizeMb: Math.round(dbSize / 1048576),
    });
    return { action: 'scheduled', reason: 'deferred-large-database', durationMs: Date.now() - started };
  }

  log('Database is corrupt — repairing inline', { detail: probe.detail });

  const need = dbSize * (opts.diskSafetyFactor ?? 2.3);
  const free = freeDiskBytes(dbPath);
  if (free > 0 && free < need) {
    return {
      action: 'aborted',
      reason: `not-enough-disk: need ${Math.round(need / 1048576)}MB, have ${Math.round(free / 1048576)}MB`,
      durationMs: Date.now() - started,
    };
  }

  let backupPath: string;
  try {
    backupPath = backupDatabase(dbPath); // S1
  } catch (err) {
    return { action: 'aborted', reason: `backup-failed: ${String(err).slice(0, 160)}`, durationMs: Date.now() - started };
  }
  log('Backup written (kept forever)', { backupPath, sizeMb: Math.round(dbSize / 1048576) });

  let built: { workPath: string; tables: RepairTableReport[] };
  try {
    built = buildRepairedCopy(dbPath, log); // 重建 + 无损检查 + 校验（S2）
  } catch (err) {
    return { action: 'aborted', reason: String(err).slice(0, 200), backupPath, durationMs: Date.now() - started };
  }

  try {
    swapInPlace(dbPath, built.workPath, backupPath); // S3
  } catch (err) {
    try { rmSync(built.workPath, { force: true }); } catch { /* ignore */ }
    return { action: 'aborted', reason: `swap-failed: ${String(err).slice(0, 160)}`, backupPath, durationMs: Date.now() - started };
  }

  log('Repair complete — original preserved as backup', { backupPath });
  return { action: 'repaired', backupPath, workPath: built.workPath, tables: built.tables, durationMs: Date.now() - started };
}
