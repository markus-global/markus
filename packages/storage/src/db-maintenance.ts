/**
 * 数据库维护：大字段外置回填 + 终态邮件清理（M1/M2/M4 的回填 + M5）。
 *
 * 两条纪律
 * ────────
 *  D1 **默认 dry-run**：任何会改数据的操作，先报告"将要做什么"，确认后才执行。
 *  D2 **可断点续跑**：按 rowid 游标分片，进程被杀之后从 cursor 继续，不重复不遗漏。
 *
 * 外置回填做的事：把库里已有的超大 JSON 列改写成 `{"$blob":...}` 指针，
 * 内容落到内容寻址的文件里（同一份内容只存一次）。读取方向由 `fromJson`
 * 透明还原，所以**不需要改任何读路径**，也不需要前端配合。
 */

import type { DatabaseSync } from 'node:sqlite';
import { BlobStore, projectJsonForStorage, isBlobRef } from './blob-store.js';

export interface ExternalizeTarget {
  table: string;
  column: string;
}

/** 外置目标：所有"大 JSON 载荷"列。新增表时在这里加一行，别在别处写第二次。 */
export const EXTERNALIZE_TARGETS: ExternalizeTarget[] = [
  { table: 'chat_messages', column: 'metadata' },
  { table: 'task_logs', column: 'metadata' },
  { table: 'agent_activity_logs', column: 'metadata' },
  { table: 'mailbox_items', column: 'payload' },
];

export interface ExternalizeOptions {
  thresholdBytes?: number;
  batchSize?: number;
  dryRun?: boolean;
  store?: BlobStore;
  /** 只处理这些表（默认全部目标表）。 */
  only?: string[];
  /** 每批之后的进度回调（脚本用来打印）。 */
  onProgress?: (p: { table: string; scanned: number; externalized: number; bytesSaved: number }) => void;
}

export interface ExternalizeResult {
  dryRun: boolean;
  scanned: number;
  externalized: number;
  bytesBefore: number;
  bytesAfter: number;
  byTable: Record<string, { scanned: number; externalized: number; bytesSaved: number }>;
  errors: string[];
}

/**
 * 把已有的大字段搬出数据库。
 *
 * 幂等：已经是 `{"$blob":...}` 的行会被跳过（用 `instr` 判定，不解析 JSON）。
 */
export function externalizeLargeFields(db: DatabaseSync, opts: ExternalizeOptions = {}): ExternalizeResult {
  const threshold = opts.thresholdBytes ?? 8 * 1024;
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const dryRun = opts.dryRun ?? true;
  const store = opts.store ?? new BlobStore();
  const targets = opts.only
    ? EXTERNALIZE_TARGETS.filter(t => opts.only!.includes(t.table))
    : EXTERNALIZE_TARGETS;

  const result: ExternalizeResult = { dryRun, scanned: 0, externalized: 0, bytesBefore: 0, bytesAfter: 0, byTable: {}, errors: [] };

  for (const { table, column } of targets) {
    const stat = { scanned: 0, externalized: 0, bytesSaved: 0 };
    result.byTable[table] = stat;

    // 表不存在（老库可能缺表）→ 跳过，不报错
    const exists = db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { one?: number } | undefined;
    if (!exists?.one) continue;

    let cursor = 0;
    for (;;) {
      const rows = db
        .prepare(
          `SELECT rowid AS rid, "${column}" AS val
             FROM "${table}"
            WHERE rowid > ?
              AND "${column}" IS NOT NULL
              AND length("${column}") > ?
              AND instr("${column}", '"$blob"') = 0
            ORDER BY rowid ASC
            LIMIT ?`
        )
        .all(cursor, threshold, batchSize) as Array<{ rid: number; val: string }>;

      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.rid;
      stat.scanned += rows.length;
      result.scanned += rows.length;

      for (const row of rows) {
        result.bytesBefore += row.val.length;

        // dry-run 必须零副作用：**不写 blob 文件**，只按指针形状估算体积。
        // （之前这里会真的落盘，等于"干跑"往磁盘写了几个 GB。）
        if (dryRun) {
          const estimated = 96; // {"$blob":"<64 hex>","$bytes":N}
          stat.externalized += 1;
          stat.bytesSaved += Math.max(0, row.val.length - estimated);
          result.bytesAfter += Math.min(row.val.length, estimated);
          continue;
        }

        let projected = row.val;
        try {
          projected = projectJsonForStorage(row.val, store, threshold);
          if (projected === row.val) { result.bytesAfter += row.val.length; continue; }
          // 防御：投影结果必须是指针形状，且能还原出原文
          const check = JSON.parse(projected) as unknown;
          if (!isBlobRef(check)) { result.errors.push(`${table}#${row.rid}: projection is not a blob ref`); result.bytesAfter += row.val.length; continue; }
          if (store.getText(check.$blob) !== row.val) { result.errors.push(`${table}#${row.rid}: blob content mismatch`); result.bytesAfter += row.val.length; continue; }

          db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(projected, row.rid);
          stat.externalized += 1;
          stat.bytesSaved += row.val.length - projected.length;
          result.bytesAfter += projected.length;
        } catch (err) {
          result.errors.push(`${table}#${row.rid}: ${String(err)}`);
          result.bytesAfter += row.val.length;
        }
      }

      result.externalized += 0; // 计数已在上面累加
      opts.onProgress?.({ table, ...stat });
    }
  }

  result.externalized = Object.values(result.byTable).reduce((a, s) => a + s.externalized, 0);
  return result;
}

/**
 * 把已释放的页真正还回文件系统。
 *
 * 为什么必须做：SQLite 的 `auto_vacuum` 默认是 OFF，删掉/搬走的行只是进了 freelist，
 * **文件大小一点不变**。实测这个库搬走 4.4 GB 后 `du` 还是 17 GB —— 如果不 VACUUM，
 * 用户会看到磁盘反而多占了 5 GB（旧页 + 新 blob），这是不可接受的"升级体验"。
 *
 * 判据用 `freelist_count`（真正可回收页数），不是"跑过迁移没"。
 * 大库 VACUUM 需要与库等量的临时空间，所以先预检空闲磁盘。
 */
export function reclaimSpace(
  db: DatabaseSync,
  opts: { minFreeBytes?: number; freeDiskBytes?: () => number } = {},
): { reclaimed: boolean; freeBytes: number; reason?: string; durationMs?: number } {
  const minFree = opts.minFreeBytes ?? 200 * 1024 * 1024;
  let pageSize = 4096;
  let freePages = 0;
  let pageCount = 0;
  try {
    pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size?: number })?.page_size ?? 4096);
    freePages = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number })?.freelist_count ?? 0);
    pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count?: number })?.page_count ?? 0);
  } catch {
    return { reclaimed: false, freeBytes: 0, reason: 'pragma-failed' };
  }

  const freeBytes = pageSize * freePages;
  if (freeBytes < minFree) return { reclaimed: false, freeBytes, reason: 'below-threshold' };

  if (opts.freeDiskBytes) {
    const disk = opts.freeDiskBytes();
    const need = pageSize * pageCount * 1.15;
    if (disk > 0 && disk < need) {
      return { reclaimed: false, freeBytes, reason: `not-enough-disk (${Math.round(disk / 1048576)}MB < ${Math.round(need / 1048576)}MB)` };
    }
  }

  const t0 = Date.now();
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('VACUUM');
    return { reclaimed: true, freeBytes, durationMs: Date.now() - t0 };
  } catch (err) {
    return { reclaimed: false, freeBytes, reason: `vacuum-failed: ${String(err).slice(0, 120)}` };
  }
}

export interface PruneOptions {
  olderThanDays?: number;
  dryRun?: boolean;
  statuses?: string[];
  batchSize?: number;
  /** 是否顺带做 incremental_vacuum 把空间还给文件系统。默认 true。 */
  vacuum?: boolean;
}

export interface PruneResult {
  dryRun: boolean;
  candidates: number;
  deleted: number;
  bytes: number;
  vacuumed: boolean;
  error?: string;
}

/**
 * 清理终态邮件项（M5）。
 *
 * 为什么安全：`completed` / `dropped` / `merged` / `failed` / `cancelled` 都是终态，
 * 没有消费者会再读它们；实测这台机器上 >30 天的终态项有 2.3 GB。
 */
export function pruneTerminalMailboxItems(db: DatabaseSync, opts: PruneOptions = {}): PruneResult {
  const days = opts.olderThanDays ?? 30;
  const dryRun = opts.dryRun ?? true;
  const statuses = opts.statuses ?? ['completed', 'dropped', 'merged', 'failed', 'cancelled'];
  const batchSize = Math.max(1, opts.batchSize ?? 2000);
  const cutoff = `-${days} days`;

  const placeholders = statuses.map(() => '?').join(',');
  const where = `status IN (${placeholders}) AND queued_at < datetime('now', ?)`;

  const agg = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(length(payload) + length(metadata)), 0) AS bytes FROM mailbox_items WHERE ${where}`)
    .get(...statuses, cutoff) as { n: number; bytes: number };

  if (dryRun) {
    return { dryRun: true, candidates: agg.n, deleted: 0, bytes: agg.bytes, vacuumed: false };
  }

  let deleted = 0;
  for (;;) {
    const res = db
      .prepare(
        `DELETE FROM mailbox_items
          WHERE id IN (SELECT id FROM mailbox_items WHERE ${where} LIMIT ?)`
      )
      .run(...statuses, cutoff, batchSize);
    const changes = (res as { changes?: number }).changes ?? 0;
    deleted += changes;
    if (changes === 0) break;
  }

  let vacuumed = false;
  if (opts.vacuum !== false) {
    try { db.exec('PRAGMA incremental_vacuum'); vacuumed = true; } catch { /* auto_vacuum=0 → no-op */ }
  }

  return { dryRun: false, candidates: agg.n, deleted, bytes: agg.bytes, vacuumed };
}
