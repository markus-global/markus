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
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { probeDatabaseHealthInChild, deriveProbeTimeoutMs, LARGE_DATABASE_BYTES } from './health-probe.js';
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
  /**
   * 大库损坏时是否允许在**启动路径上**重建（默认允许）。
   *
   * 默认允许是安全选择：重建必须在一个没有任何写者的窗口里做完，
   * 否则快照必然陈旧，而陈旧快照换库 = 吃掉那段时间的写入。
   * 代价是一次性启动等待（普通用户秒级，17 GB 约 5 分钟）。
   * 置 true 则退回旧的两段式 —— 现在有指纹保护，陈旧快照会被拒绝而非吞数据。
   */
  deferLargeRepairToBackground?: boolean;
  /**
   * 只探测、不重建：探测到损坏时只写「需要重建」标记，重建留给**下一次启动**在
   * 独占状态下做。
   *
   * 这是大库在应用已运行时唯一安全的选项：此刻库正被写入，任何快照都会陈旧。
   */
  probeOnly?: boolean;
  /**
   * 是否允许在启动路径上同步探测。
   *
   * 大库**必须**置 false：健康的大库整库扫描是分钟级，压在启动路径上等于
   * 用一个更糟的问题（启动冻住两分半）去换修复。此时调用方应把它放到后台跑，
   * 探测结论照样能排期重建，只是换库要等到下一次启动。
   */
  allowBlockingProbe?: boolean;
}

const READY_SUFFIX = '.repair-ready.json';
const PENDING_SUFFIX = '.repair-pending.json';
const FAILED_SUFFIX = '.repair-failed.json';
/**
 * 「这个库需要重建」的持久标记。
 *
 * 为何需要它：大库的完整性扫描是分钟级（实测 16.7 GB → 155 s），不能每次启动都跑。
 * 所以大库只在**后台**探一次，探到损坏就把结论写在这里；下一次启动读到该标记，
 * 就跳过探测、直接在**独占状态**（还没有任何进程打开它）下重建并替换。
 * 独占是这里的关键：只有在没有并发写入的窗口里做的快照，才允许被换进活库。
 */
const NEEDED_SUFFIX = '.repair-needed.json';

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
 * 源库指纹：用来证明「这份重建快照与当前活库是同一个状态」。
 *
 * 为何必须有：两段式（先重建、下次启动换库）在**有并发写入**的系统上必然陈旧 ——
 * 实测一台多 agent 常驻的机器，重建完成后 15 分钟内库里新增了 45 行。
 * 无条件 rename 会把这段写入直接删掉（旧库随后被 rm），那是真实的数据丢失。
 *
 * 判据只对「有没有变」负责，不对「变了多少」负责 —— 变了就拒绝，不猜。
 */
export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
  /** 每张表的最大 rowid：新增行一定让这个数变大（廉价且不被缓存干扰） */
  maxRowIds: Record<string, number>;
}

/** 读取源库当前指纹。只读打开，任何异常都退化为「读不到」，绝不修改源库。 */
export function fingerprintSource(dbPath: string): SourceFingerprint {
  const st = statSync(dbPath);
  let walSize = 0;
  let walMtimeMs = 0;
  try {
    const w = statSync(`${dbPath}-wal`);
    walSize = w.size;
    walMtimeMs = w.mtimeMs;
  } catch { /* 没有 WAL 文件（已 checkpoint） */ }

  const maxRowIds: Record<string, number> = {};
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      for (const t of tables) {
        try {
          const row = db.prepare(`SELECT MAX(rowid) AS hi FROM "${t.name.replace(/"/g, '""')}"`).get() as { hi?: number } | undefined;
          maxRowIds[t.name] = Number(row?.hi ?? 0);
        } catch {
          maxRowIds[t.name] = -1; // 读不动（坏页）：记成哨兵，比较时不会误判「没变」
        }
      }
    } finally {
      db.close();
    }
  } catch { /* 整库都打不开：留空，比较时判为不可信 */ }

  return { size: st.size, mtimeMs: st.mtimeMs, walSize, walMtimeMs, maxRowIds };
}

/** 两个指纹是否代表同一个库状态。字段缺失（旧格式/读不到）一律判为「不同」。 */
function sameSource(a: SourceFingerprint | undefined, b: SourceFingerprint | undefined): boolean {
  if (!a || !b) return false;
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;
  if (a.walSize !== b.walSize || a.walMtimeMs !== b.walMtimeMs) return false;
  const ka = Object.keys(a.maxRowIds);
  const kb = Object.keys(b.maxRowIds);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a.maxRowIds[k] !== b.maxRowIds[k]) return false;
  }
  return true;
}

/**
 * 下次启动时应用上一次排期的修复。整个过程只有两个 rename，毫秒级。
 *
 * **换库前必须证明源库没变过**（见 SourceFingerprint）。变了 → 丢弃这份快照、
 * 排期为本次启动在独占状态下重建。宁可多花一次重建，也不吃掉那段时间的写入。
 */
export function tryApplyPendingRepair(
  dbPath: string,
  log: (m: string, d?: Record<string, unknown>) => void = () => {},
): RepairResult {
  const started = Date.now();
  const ready = readJson<{ workPath?: string; tables?: RepairTableReport[]; applied?: boolean; source?: SourceFingerprint; backupPath?: string }>(`${dbPath}${READY_SUFFIX}`);
  if (!ready || ready.applied) return { action: 'none', reason: 'no-pending-repair', durationMs: 0 };

  const workPath = ready.workPath;
  if (!workPath || !existsSync(workPath)) {
    try { rmSync(`${dbPath}${READY_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    return { action: 'none', reason: 'pending-work-missing', durationMs: Date.now() - started };
  }

  // ── 陈旧保护：快照必须与当前活库是同一状态，否则绝不能替换 ──────────────
  const discardStale = (reason: string): RepairResult => {
    try { rmSync(`${dbPath}${READY_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    try { rmSync(workPath, { force: true }); } catch { /* ignore */ }
    // 已确认损坏（否则不会有就绪文件）→ 让本次启动在独占状态下重建
    writeJson(`${dbPath}${NEEDED_SUFFIX}`, { reason, at: new Date().toISOString() });
    log('Pending repair snapshot is stale — refused to swap, will rebuild before open', { reason });
    return { action: 'aborted', reason, durationMs: Date.now() - started };
  };

  if (!ready.source) {
    // 旧版本写下的就绪文件没有指纹 —— 不能假定它是对的
    return discardStale('no-source-fingerprint');
  }
  let current: SourceFingerprint | undefined;
  try {
    current = fingerprintSource(dbPath);
  } catch {
    return discardStale('source-unreadable');
  }
  if (!sameSource(ready.source, current)) {
    return discardStale('stale-source: database changed after the snapshot was taken');
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
  const backupPath = ready.backupPath;
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
  try { rmSync(`${dbPath}${NEEDED_SUFFIX}`, { force: true }); } catch { /* ignore */ }
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
 * 工人源码在打包时内联进来（见 `packages/desktop/build.mjs`）。纯 node / CLI 下没有这个标识符。
 *
 * 为什么不用独立入口文件：desktop 的打包只产出 `main.js` / `preload.js` 两个 entry，
 * `@markus/storage` 是**内联**进 main 的 —— `repair-worker.js` 从来没有作为文件存在过。
 * 于是 `spawn(execPath, ['<app.asar>/dist/repair-worker.js'])` 得到 MODULE_NOT_FOUND，
 * 而 `detached + stdio:'ignore'` 把这个错误完全吞掉：日志写着「scheduled」，实际什么都没发生。
 * （实测：同一台机器、同一个二进制直接跑该路径 → `Cannot find module`, exit=1。）
 *
 * 内联成源码字符串后走 `-e`，这条路径已由健康探针在打包后的 Electron 里实测可用。
 */
declare const __REPAIR_WORKER_SOURCE__: string | undefined;

/** 打包时注入的工人源码；未注入（CLI / dev / 测试）返回 null。 */
export function resolveRepairWorkerSource(): string | null {
  try {
    if (typeof __REPAIR_WORKER_SOURCE__ === 'string' && __REPAIR_WORKER_SOURCE__.length > 0) {
      return __REPAIR_WORKER_SOURCE__;
    }
  } catch { /* 标识符不存在 */ }
  return null;
}

/**
 * 后台修复工人的启动参数 —— **纯函数，可测**。
 *
 * 两条必须同时成立：
 *  ① `ELECTRON_RUN_AS_NODE=1` —— 打包后的 Electron 中 `process.execPath` 是主程序，
 *     否则会静默启动第二个 GUI 实例（detached + stdio:'ignore' 让这个错误完全不可见）。
 *  ② 脚本必须**真的存在** —— 走文件路径时在这里校验，缺失就抛错，不再假装成功。
 *
 * dbPath 走环境变量而不是 argv：`-e` 模式下 argv 位移与普通脚本不同，用环境变量两边一致。
 */
export function buildRepairWorkerSpawnSpec(
  dbPath: string,
  workerPath: string | null,
  execPath: string = process.execPath,
  baseEnv: NodeJS.ProcessEnv = process.env,
  inlineSource: string | null = resolveRepairWorkerSource(),
): RepairWorkerSpawnSpec {
  const env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1', MARKUS_REPAIR_DB: dbPath };
  if (inlineSource) {
    return { command: execPath, args: ['-e', inlineSource], options: { detached: true, stdio: 'ignore', env } };
  }
  if (!workerPath || !existsSync(workerPath)) {
    throw new Error(`repair-worker-missing: ${workerPath ?? '(no inline source)'}`);
  }
  return { command: execPath, args: [workerPath], options: { detached: true, stdio: 'ignore', env } };
}

/** pending 标记的版本：v2 = 记录**工人自己的 pid**，且只在 spawn 成功后写。 */
const PENDING_VERSION = 2;
/** 标记最长有效时间（pid 存活是主判据，这里只防 pid 复用）。 */
const PENDING_MAX_AGE_MS = 2 * 60 * 60_000;
/** spawn 后的存活窗口：秒死的工人必须在日志里可见。 */
const WORKER_LIVENESS_WINDOW_MS = 1200;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // 存在但无权限
  }
}

/**
 * pending 标记的语义：**有一个活着的工人在干这件事**。
 *
 * 旧实现把「调度者自己的 pid」写进去（那正是 app 进程，永远 alive），
 * 于是失败一次就会抑制后续 30 分钟的重排 —— 失败被记成了「正在进行」。
 */
function readPendingWorker(dbPath: string): { pid: number } | null {
  const p = readJson<{ pid?: number; startedAt?: string; v?: number }>(`${dbPath}${PENDING_SUFFIX}`);
  if (!p || p.v !== PENDING_VERSION) return null;
  if (!p.pid || p.pid === process.pid || !pidAlive(p.pid)) return null;
  const age = Date.now() - Date.parse(String(p.startedAt ?? ''));
  if (!Number.isFinite(age) || age > PENDING_MAX_AGE_MS) return null;
  return { pid: p.pid };
}

async function scheduleBackgroundRepair(
  dbPath: string,
  log: (m: string, d?: Record<string, unknown>) => void,
): Promise<{ ok: boolean; reason?: string }> {
  if (readPendingWorker(dbPath)) {
    log('Background repair already running — not rescheduling');
    return { ok: true };
  }

  const filePath = new URL('./repair-worker.js', import.meta.url).pathname;
  const inline = resolveRepairWorkerSource();
  let spec: RepairWorkerSpawnSpec;
  try {
    spec = buildRepairWorkerSpawnSpec(dbPath, inline ? null : filePath, process.execPath, process.env, inline);
  } catch (err) {
    const reason = String(err).slice(0, 300);
    log('ERROR: repair worker unavailable — database will NOT be repaired', { error: reason });
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    return { ok: false, reason };
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.command, spec.args, spec.options);
    child.unref();
  } catch (err) {
    const reason = `spawn-failed: ${String(err).slice(0, 200)}`;
    log('ERROR: failed to spawn repair worker', { error: reason });
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    return { ok: false, reason };
  }

  const pid = child.pid ?? 0;
  // spawn 成功 ≠ 工人活着。路径不存在 / 权限 / 语法错都在毫秒级退出，
  // 而 detached + stdio:'ignore' 会把这件事藏起来（本轮事故就是这样）。
  const exitedEarly = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), WORKER_LIVENESS_WINDOW_MS);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    child.once('error', () => { clearTimeout(timer); resolve(-1); });
  });
  if (exitedEarly !== null) {
    const reason = `worker-exited-immediately: code=${exitedEarly}`;
    try { rmSync(`${dbPath}${PENDING_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    log('ERROR: repair worker exited immediately — repair will be retried next start', {
      reason, inline: Boolean(inline), workerPath: inline ? '(inline)' : filePath,
    });
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    return { ok: false, reason };
  }

  writeJson(`${dbPath}${PENDING_SUFFIX}`, {
    v: PENDING_VERSION,
    pid,
    startedAt: new Date().toISOString(),
    inline: Boolean(inline),
  });
  log('Background repair scheduled (applies on next start)', { pid, inline: Boolean(inline) });
  return { ok: true };
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

  // 磁盘闸门必须和"内联 repair"用同一条规则：备份 1 份 + 重建 1 份 ≈ 2.3 倍库大小。
  // 后台工人跑在没有人的时候 —— 空间不够时会先写满磁盘、再留下半个工作文件，
  // 那比"不修"更糟。所以先算清楚，不够就干脆不动。
  const sizeBytes = statSync(dbPath).size;
  const need = sizeBytes * 2.3;
  const free = freeDiskBytes(dbPath);
  if (free > 0 && free < need) {
    const reason = `not-enough-disk: need ${Math.round(need / 1048576)}MB, have ${Math.round(free / 1048576)}MB`;
    writeJson(`${dbPath}${FAILED_SUFFIX}`, { reason, at: new Date().toISOString() });
    try { rmSync(`${dbPath}${PENDING_SUFFIX}`, { force: true }); } catch { /* ignore */ }
    log('Background repair aborted — not enough disk for backup + rebuild', {
      sizeMb: Math.round(sizeBytes / 1048576), needMb: Math.round(need / 1048576), freeMb: Math.round(free / 1048576),
    });
    return { action: 'aborted', reason, durationMs: Date.now() - started };
  }

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

  // 指纹必须在**重建开始前**取：它就是"快照对应的库状态"。换库前会重算并比对。
  let sourceFingerprint: SourceFingerprint | undefined;
  try {
    sourceFingerprint = fingerprintSource(dbPath);
  } catch (err) {
    log('WARN: could not fingerprint source — swap will be refused later', { error: String(err).slice(0, 120) });
  }

  try {
    const built = buildRepairedCopy(dbPath, log);
    writeJson(`${dbPath}${READY_SUFFIX}`, {
      workPath: built.workPath,
      tables: built.tables,
      backupPath,
      source: sourceFingerprint,
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

  const sizeOnEntry = existsSync(dbPath) ? statSync(dbPath).size : 0;
  const deferAbove = opts.deferAboveBytes ?? LARGE_DATABASE_BYTES;
  const needsRepairMarker = existsSync(`${dbPath}${NEEDED_SUFFIX}`);

  // ── ① 已有「需要重建」标记（由上一轮完整性探测或陈旧快照拦下时写下）──────────
  // 跳过探测直接重建：此时是启动早期、还没有任何进程打开这个库 ——
  // 这是唯一能保证「快照 == 活库」的窗口。
  //
  // probeOnly（应用已在运行）绝不能走这条路：那会在库被写入时重建，
  // 产出的正是本提交要禁止的陈旧快照。
  if (!opts.forceCorrupt && needsRepairMarker) {
    if (opts.probeOnly === true) {
      return { action: 'scheduled', reason: 'marked-for-repair', durationMs: Date.now() - started };
    }
    log('Repair required (marked earlier) — rebuilding before open, under exclusive access', {
      sizeMb: Math.round(sizeOnEntry / 1048576),
    });
    return repairInline(dbPath, opts, sizeOnEntry, log, started);
  }

  // 大库 + 不允许阻塞 → 不在这里探测（一行都不能等）。返回 none，让调用方把它丢到后台：
  // 结论要靠后台那一轮拿到，启动路径不能被分钟级的整库扫描占住。
  if (!opts.forceCorrupt && opts.allowBlockingProbe === false && sizeOnEntry > deferAbove) {
    return { action: 'none', reason: 'probe-deferred-background', durationMs: Date.now() - started };
  }

  // 超时按库大小推导，**不再依赖调用方记得传**。
  // 原来默认写死 20 s：17 GB 的库探不完 → unknown → 修复永久跳过（静默失效）。
  const probeTimeoutMs = opts.probeTimeoutMs ?? deriveProbeTimeoutMs(sizeOnEntry);

  const probe = opts.forceCorrupt
    ? { status: 'corrupt' as const, detail: 'forced' }
    : await probeDatabaseHealthInChild(dbPath, probeTimeoutMs);

  if (probe.status === 'ok') return { action: 'none', reason: 'healthy', durationMs: Date.now() - started };
  if (probe.status === 'unknown') {
    // 拿不到结论（超时）→ 绝不猜。错修比不修更糟。
    return { action: 'none', reason: `probe-unknown: ${probe.detail ?? ''}`.slice(0, 200), durationMs: Date.now() - started };
  }

  const dbSize = sizeOnEntry;

  // 只探测：库正被写入，此处**绝不能**重建（快照必然陈旧）—— 只写标记
  if (opts.probeOnly === true) {
    writeJson(`${dbPath}${NEEDED_SUFFIX}`, { reason: `corrupt: ${String(probe.detail ?? '').slice(0, 160)}`, at: new Date().toISOString() });
    log('Database is corrupt — marked for repair, will rebuild before the next open', {
      sizeMb: Math.round(dbSize / 1048576),
    });
    return { action: 'scheduled', reason: 'marked-for-repair', durationMs: Date.now() - started };
  }

  // 大库：默认在启动路径上重建（独占窗口才安全）。
  // 仅在调用方**显式**要求非阻塞时退回两段式；那条路上陈旧快照会被指纹拦下来。
  if (dbSize > deferAbove && opts.deferLargeRepairToBackground === true) {
    const scheduled = await scheduleBackgroundRepair(dbPath, log);
    log('Database is corrupt — repair deferred to background (explicitly requested)', {
      sizeMb: Math.round(dbSize / 1048576),
    });
    return scheduled.ok
      ? { action: 'scheduled', reason: 'deferred-large-database', durationMs: Date.now() - started }
      : { action: 'aborted', reason: scheduled.reason ?? 'schedule-failed', durationMs: Date.now() - started };
  }

  log('Database is corrupt — repairing before open, under exclusive access', { detail: probe.detail });
  return repairInline(dbPath, opts, dbSize, log, started);
}

/**
 * 在**本进程、开库之前**完成备份 → 重建 → 校验 → 替换。
 *
 * 前置条件（由调用方保证）：此刻没有人写这个库。整个流程都是同步阻塞的，
 * 因为一旦中途交回事件循环，就有机会被重启/崩溃打断，留下半成品。
 */
async function repairInline(
  dbPath: string,
  opts: RepairOptions,
  dbSize: number,
  log: (m: string, d?: Record<string, unknown>) => void,
  started: number,
): Promise<RepairResult> {
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

  try { rmSync(`${dbPath}${NEEDED_SUFFIX}`, { force: true }); } catch { /* ignore */ }
  log('Repair complete — original preserved as backup', { backupPath });
  return { action: 'repaired', backupPath, workPath: built.workPath, tables: built.tables, durationMs: Date.now() - started };
}
