/**
 * 开库前的自愈流程：探测 → 备份 → 修复 → 校验 → 原子替换（备份永不删除）。
 *
 * 为什么必须有这个文件
 * ────────────────────
 * 数据库损坏不是某一台机器的偶发事故：断电、强杀进程、磁盘写满、WAL 未落盘崩溃，
 * 都会留下坏页。所以修复必须是**通用能力**，而不是给某个人跑的一次性脚本。
 *
 * 三条不可让步的安全约束
 * ─────────────────────
 *  S1 **先备份，且永不删**：备份是唯一的回滚路径。备份没写成功，绝不动原库。
 *  S2 **校验通过才替换**：恢复库必须自身通过完整性检查，且每张表的行数与
 *     "原库能读出来的行数"一致；任何一项不满足 → 放弃，原库原样保留。
 *  S3 **原子替换**：同目录 rename（同一文件系统，原子）；连同 `-wal`/`-shm`
 *     一起处理，否则旧 WAL 会被套用到新库上，等于制造新损坏。
 *
 * 为什么不用 sqlite3 CLI
 * ─────────────────────
 * `.recover` 只有官方 CLI 有，Windows 上没有、Linux 发行版版本参差、PATH 还可能
 * 指向 Android SDK 的阉割版（我实测踩过）。所以这里用 node:sqlite 自己实现：
 * 重放 schema → 按 rowid 窗口搬行 → 读不动的窗口二分到最小再跳过 → 校验。
 */

import { copyFileSync, existsSync, renameSync, rmSync, statSync, statfsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeDatabaseHealthInChild } from './health-probe.js';

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
  action: 'none' | 'repaired' | 'aborted';
  reason?: string;
  backupPath?: string;
  tables?: RepairTableReport[];
  skippedRows?: number;
  durationMs: number;
}

export interface RepairOptions {
  /** 探测超时（子进程），默认 20 秒。 */
  probeTimeoutMs?: number;
  /** 需要预留的磁盘倍数（备份 + 恢复库），默认 2.3。 */
  diskSafetyFactor?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** 测试用：强制认为库损坏（跳过探针）。 */
  forceCorrupt?: boolean;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function freeDiskBytes(path: string): number {
  try {
    const s = statfsSync(dirname(path)) as unknown as { bsize?: number; bavail?: number };
    return Number(s.bsize ?? 0) * Number(s.bavail ?? 0);
  } catch { return 0; }
}

/** 同目录 copy + fsync，确保备份真的落盘（不是只在 page cache 里）。 */
function durableCopy(from: string, to: string): void {
  copyFileSync(from, to);
  try {
    const fd = openSync(to, 'r+');
    fsyncSync(fd);
    closeSync(fd);
  } catch { /* fsync 不可用时退化为普通 copy */ }
}

/**
 * 开库前自愈。默认在库健康时是**零成本 no-op**（一次子进程探测）。
 */
export async function prepareDatabaseFile(dbPath: string, opts: RepairOptions = {}): Promise<RepairResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});

  if (!existsSync(dbPath)) return { action: 'none', reason: 'no-database', durationMs: 0 };

  const probe = opts.forceCorrupt
    ? { status: 'corrupt' as const, detail: 'forced' }
    : await probeDatabaseHealthInChild(dbPath, opts.probeTimeoutMs ?? 20_000);

  if (probe.status === 'ok') return { action: 'none', reason: 'healthy', durationMs: Date.now() - started };
  if (probe.status === 'unknown') {
    // 拿不到结论（超时/无 node 子进程）→ 绝不能猜。修错了比不修更糟。
    return { action: 'none', reason: `probe-unknown: ${probe.detail ?? ''}`.slice(0, 200), durationMs: Date.now() - started };
  }

  log('Database is corrupt — starting backup + repair', { detail: probe.detail });

  const dbSize = statSync(dbPath).size;
  const need = dbSize * (opts.diskSafetyFactor ?? 2.3);
  const free = freeDiskBytes(dbPath);
  if (free > 0 && free < need) {
    return {
      action: 'aborted',
      reason: `not-enough-disk: need ${Math.round(need / 1048576)}MB, have ${Math.round(free / 1048576)}MB`,
      durationMs: Date.now() - started,
    };
  }

  // ── S1 备份（永不删除） ──────────────────────────────────────────────
  const stamp = timestamp();
  const backupPath = `${dbPath}.backup-${stamp}`;
  try {
    durableCopy(dbPath, backupPath);
    if (statSync(backupPath).size !== dbSize) throw new Error('backup size mismatch');
    // WAL 也要一起备份，否则"原库"其实不完整
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) durableCopy(`${dbPath}${suffix}`, `${backupPath}${suffix}`);
    }
  } catch (err) {
    try { if (existsSync(backupPath)) rmSync(backupPath); } catch { /* ignore */ }
    return { action: 'aborted', reason: `backup-failed: ${String(err).slice(0, 160)}`, durationMs: Date.now() - started };
  }
  log('Backup written (kept forever)', { backupPath, sizeMb: Math.round(dbSize / 1048576) });

  // ── 修复到临时文件 ──────────────────────────────────────────────────
  const workPath = `${dbPath}.repairing-${stamp}`;
  let report: { tables: RepairTableReport[]; skippedRows: number };
  try {
    report = rebuildInto(dbPath, workPath, log);
  } catch (err) {
    try { if (existsSync(workPath)) rmSync(workPath); } catch { /* ignore */ }
    return { action: 'aborted', reason: `rebuild-failed: ${String(err).slice(0, 160)}`, backupPath, durationMs: Date.now() - started };
  }

  // ── S2a 无损检查：读到的行必须全部写进去 ────────────────────────
  // 比"行数看起来差不多"严格得多：可以容忍"坏页里的行读不出来"（备份里同样救不回），
  // 绝不能容忍"读出来了但没写进去"（那才是我们自己弄丢的）。
  const lossy = report.tables.filter(t => t.recovered < t.readRows);
  if (lossy.length > 0) {
    try { if (existsSync(workPath)) rmSync(workPath); } catch { /* ignore */ }
    return {
      action: 'aborted',
      reason: `lossy-copy: ${lossy.map(t => `${t.name} read ${t.readRows} wrote ${t.recovered}`).join('; ')}`,
      backupPath,
      tables: report.tables,
      durationMs: Date.now() - started,
    };
  }

  // ── S2 校验 ─────────────────────────────────────────────────────────
  const verified = verifyRecovered(workPath, report.tables);
  if (!verified.ok) {
    try { if (existsSync(workPath)) rmSync(workPath); } catch { /* ignore */ }
    return { action: 'aborted', reason: `verify-failed: ${verified.reason}`, backupPath, tables: report.tables, durationMs: Date.now() - started };
  }

  // ── S3 原子替换（原库移到 .replaced-*，仅在备份确认存在后清理） ──────
  const replacedPath = `${dbPath}.replaced-${stamp}`;
  try {
    renameSync(dbPath, replacedPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${replacedPath}${suffix}`);
    }
    renameSync(workPath, dbPath);
  } catch (err) {
    // 尽力回滚：把原库放回去
    try { if (existsSync(replacedPath) && !existsSync(dbPath)) renameSync(replacedPath, dbPath); } catch { /* ignore */ }
    return { action: 'aborted', reason: `swap-failed: ${String(err).slice(0, 160)}`, backupPath, durationMs: Date.now() - started };
  }

  // 备份已确认存在 → 删掉 .replaced 这份重复拷贝（省一份库大小的磁盘）
  if (existsSync(backupPath)) {
    try { rmSync(replacedPath); } catch { /* ignore */ }
    for (const suffix of ['-wal', '-shm']) {
      try { if (existsSync(`${replacedPath}${suffix}`)) rmSync(`${replacedPath}${suffix}`); } catch { /* ignore */ }
    }
  }

  log('Repair complete — original preserved as backup', { backupPath, skippedRows: report.skippedRows });
  return {
    action: 'repaired',
    backupPath,
    tables: report.tables,
    skippedRows: report.skippedRows,
    durationMs: Date.now() - started,
  };
}

// 恢复引擎在 repair-rebuild.ts（搬行 + 校验），此处只做编排。
import { rebuildInto, verifyRecovered } from './repair-rebuild.js';
