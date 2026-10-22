/**
 * 恢复引擎：把损坏的库尽量完整地重建到一个新文件里，不依赖 sqlite3 CLI。
 *
 * 策略（比 `.recover` 简单但足够）：
 *   1. 重放 schema（先建表 → 搬行 → 再建索引/触发器/视图）
 *   2. 按 rowid 窗口搬行；某个窗口读不动，就**二分**到单行，只跳过真正坏掉的行
 *   3. 校验：恢复库自身完整性通过，且每张表的行数与搬到的行数一致
 *
 * 为什么二分：坏页只影响它覆盖的那几行。整表 `SELECT *` 一报错就放弃，会白白
 * 丢掉同表里 99% 完好的数据 —— 那才是真正的"数据丢失"。
 */

import { DatabaseSync } from 'node:sqlite';
import type { RepairTableReport } from './repair.js';

const CHUNK = 2000;

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

type Log = (message: string, data?: Record<string, unknown>) => void;

function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

interface CopyOutcome {
  /** 从源库**成功读到**的行数 */
  readRows: number;
  /** 真正写进新库的行数 */
  insertedRows: number;
  /** 彻底读不动的行（坏页覆盖，备份里也救不回来） */
  unreadableRows: number;
  skippedWindows: number;
}

/** 搬一张表：rowid 窗口 + 二分降级。 */
function copyTable(
  src: DatabaseSync,
  dst: DatabaseSync,
  table: string,
  log: Log,
): CopyOutcome {
  const cols = columnsOf(src, table);
  if (cols.length === 0) return { readRows: 0, insertedRows: 0, unreadableRows: 0, skippedWindows: 0 };
  const colList = cols.map(quoteIdent).join(', ');
  const placeholders = cols.map(() => '?').join(', ');

  // 一批一个事务。逐行自动提交会让每行都 fsync 一次 —— 实测慢到不可用
  // （17 GB 跑了一小时还没完），而这是用户**开机时**要等的操作。
  //
  // 关键：`INSERT`（不带 OR IGNORE）—— 插入失败必须能被看见。曾经用
  // OR IGNORE 静默吞掉约束失败，结果"修复成功"却丢了可读的行。
  const insert = dst.prepare(`INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${placeholders})`);
  let failedInserts = 0;

  const insertRows = (rows: Array<Record<string, unknown>>): number => {
    let n = 0;
    try { dst.exec('BEGIN'); } catch { /* 已在事务里 */ }
    for (const row of rows) {
      try {
        insert.run(...cols.map(c => (row[c] === undefined ? null : (row[c] as never))));
        n += 1;
      } catch (err) {
        failedInserts += 1;
        if (failedInserts <= 3) log('Insert failed while copying row', { table, error: String(err).slice(0, 120) });
      }
    }
    try { dst.exec('COMMIT'); } catch { /* ignore */ }
    return n;
  };

  // 有没有 rowid？
  let minRid = 0;
  let maxRid = 0;
  let hasRowid = true;
  try {
    const r = src.prepare(`SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${quoteIdent(table)}`).get() as { lo?: number; hi?: number } | undefined;
    minRid = Number(r?.lo ?? 0);
    maxRid = Number(r?.hi ?? 0);
    if (!Number.isFinite(minRid) || !Number.isFinite(maxRid)) hasRowid = false;
  } catch {
    hasRowid = false;
  }

  let readRows = 0;
  let insertedRows = 0;
  let unreadableRows = 0;
  let skippedWindows = 0;

  if (hasRowid) {
    for (let start = minRid; start <= maxRid; start += CHUNK) {
      const end = start + CHUNK - 1;
      try {
        const rows = src
          .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid BETWEEN ? AND ? ORDER BY rowid`)
          .all(start, end) as Array<Record<string, unknown>>;
        if (rows.length) {
          readRows += rows.length;
          insertedRows += insertRows(rows);
        }
      } catch {
        // 二分：只丢掉真正读不动的那几行
        const res = copyRange(src, insertRows, table, start, end);
        readRows += res.readRows;
        insertedRows += res.insertedRows;
        unreadableRows += res.unreadableRows;
        skippedWindows += 1;
        if (res.unreadableRows > 0) {
          log('Skipped unreadable rows (corrupt pages)', { table, failedRows: res.unreadableRows });
        }
      }
    }
  } else {
    // WITHOUT ROWID 表：只能分页试
    let offset = 0;
    for (;;) {
      try {
        const rows = src
          .prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`)
          .all(CHUNK, offset) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        readRows += rows.length;
        insertedRows += insertRows(rows);
        offset += rows.length;
        if (rows.length < CHUNK) break;
      } catch {
        skippedWindows += 1;
        break; // 无法定位坏行，停止该表（已搬到的都保留）
      }
    }
  }

  if (failedInserts > 0) {
    log('Some readable rows could not be inserted', { table, failedInserts });
  }

  return { readRows, insertedRows, unreadableRows, skippedWindows };
}

/** 在 [lo,hi] 区间内二分找出能读的子区间并搬走。 */
function copyRange(
  src: DatabaseSync,
  insertRows: (rows: Array<Record<string, unknown>>) => number,
  table: string,
  lo: number,
  hi: number,
): { readRows: number; insertedRows: number; unreadableRows: number } {
  if (lo > hi) return { readRows: 0, insertedRows: 0, unreadableRows: 0 };
  try {
    const rows = src
      .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid BETWEEN ? AND ? ORDER BY rowid`)
      .all(lo, hi) as Array<Record<string, unknown>>;
    return { readRows: rows.length, insertedRows: insertRows(rows), unreadableRows: 0 };
  } catch {
    if (lo === hi) return { readRows: 0, insertedRows: 0, unreadableRows: 1 };
    const mid = Math.floor((lo + hi) / 2);
    const left = copyRange(src, insertRows, table, lo, mid);
    const right = copyRange(src, insertRows, table, mid + 1, hi);
    return {
      readRows: left.readRows + right.readRows,
      insertedRows: left.insertedRows + right.insertedRows,
      unreadableRows: left.unreadableRows + right.unreadableRows,
    };
  }
}

/** 重放 schema + 搬数据。返回逐表报告。 */
export function rebuildInto(srcPath: string, workPath: string, log: Log): { tables: RepairTableReport[] } {
  const src = openReadOnly(srcPath);
  const dst = new DatabaseSync(workPath);
  const tables: RepairTableReport[] = [];

  try {
    // 目标文件是**一次性**的：校验通过才替换，失败就丢弃。所以不需要 WAL/fsync，
    // 用内存日志 + 关闭同步换吞吐；原库全程只读，不受影响。
    dst.exec('PRAGMA journal_mode = MEMORY');
    dst.exec('PRAGMA synchronous = OFF');

    const schema = src
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as SchemaRow[];

    const tableRows = schema.filter(s => s.type === 'table');
    const indexRows = schema.filter(s => s.type === 'index');
    const otherRows = schema.filter(s => s.type === 'view' || s.type === 'trigger');

    // 1) 建表
    for (const t of tableRows) {
      try { dst.exec(t.sql!); } catch (err) { log('Table DDL failed — skipped', { table: t.name, error: String(err).slice(0, 120) }); }
    }

    // 2) 搬行
    for (const t of tableRows) {
      let sourceCount: number | 'unreadable' = 'unreadable';
      try {
        const c = src.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n?: number } | undefined;
        sourceCount = Number(c?.n ?? 0);
      } catch { /* 计数本身就失败 → 标记 unreadable */ }

      const outcome = copyTable(src, dst, t.name, log);
      tables.push({
        name: t.name,
        source: sourceCount,
        readRows: outcome.readRows,
        recovered: outcome.insertedRows,
        unreadableRows: outcome.unreadableRows,
        skippedWindows: outcome.skippedWindows,
      });
      if (outcome.unreadableRows > 0) {
        log('Corrupt region: some rows were physically unreadable', { table: t.name, unreadableRows: outcome.unreadableRows });
      }
    }

    // 3) 索引 / 视图 / 触发器（数据到位后再建，快且不会因中途失败留下半成品）
    for (const idx of indexRows) {
      try { dst.exec(idx.sql!); } catch (err) { log('Index DDL failed — skipped', { index: idx.name, error: String(err).slice(0, 120) }); }
    }
    for (const o of otherRows) {
      try { dst.exec(o.sql!); } catch (err) { log('Object DDL failed — skipped', { name: o.name, error: String(err).slice(0, 120) }); }
    }

    // AUTOINCREMENT 序列：不复制会让新插入的 id 从 1 重新开始 → 主键冲突
    try {
      const seqRows = src.prepare('SELECT name, seq FROM sqlite_sequence').all() as Array<{ name: string; seq: number }>;
      const ins = dst.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      for (const r of seqRows) { try { ins.run(r.name, r.seq); } catch { /* 目标无该表时忽略 */ } }
    } catch { /* 没有 sqlite_sequence 也正常 */ }
  } finally {
    try { src.close(); } catch { /* ignore */ }
    try { dst.close(); } catch { /* ignore */ }
  }

  return { tables };
}

/** 校验恢复库：自身完整 + 每张表行数与报告一致。 */
export function verifyRecovered(workPath: string, tables: RepairTableReport[]): { ok: boolean; reason?: string } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(workPath);
    const chk = db.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined;
    const verdict = String(Object.values(chk ?? {})[0] ?? '');
    if (verdict !== 'ok') return { ok: false, reason: `recovered db not clean: ${verdict.slice(0, 160)}` };

    for (const t of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n?: number } | undefined;
      const actual = Number(row?.n ?? 0);
      if (actual !== t.recovered) {
        return { ok: false, reason: `row count mismatch for ${t.name}: reported ${t.recovered}, actual ${actual}` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verify error: ${String(err).slice(0, 160)}` };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
