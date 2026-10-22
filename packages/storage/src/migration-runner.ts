/**
 * 后台数据迁移执行器（升级零感知的核心）。
 *
 * 为什么需要它
 * ────────────
 * 用户的旧库里躺着几 GB 需要搬家的数据（base64 图片、超大 payload）。要求是：
 * **装上新版、重启、照常用** —— 不跑脚本、不看进度条、不丢数据。
 *
 * 所以迁移必须满足四条：
 *   M1 **自动**：进程启动后自己跑，不需要任何人工触发。
 *   M2 **不挡路**：分批 + 批间让出事件循环，服务始终可用。
 *   M3 **可断点续跑**：进度写 `data_migrations`，进程随时被杀都能从 cursor 继续。
 *   M4 **幂等**：跑第二遍是 no-op（按形状判定，不按"跑过没跑过"判定）。
 *
 * 与 `PRAGMA user_version` 的分工：那个管**结构**（建表加列，同步、毫秒级），
 * 这个管**数据**（百万行，异步、分钟级）。两件事不该挤在一个闸门里。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AttachmentStore } from './attachments-store.js';
import { isDataUrl, isAttachmentRef, type AttachmentRef } from './attachments-store.js';
import { BlobStore } from './blob-store.js';
import { projectJsonForStorage, isBlobRef } from './blob-store.js';

export interface MigrationContext {
  db: DatabaseSync;
  attachments: AttachmentStore;
  blobs: BlobStore;
  cursor: number;
  batchSize: number;
}

export interface MigrationBatchResult {
  processed: number;
  nextCursor: number;
  done: boolean;
  errors?: string[];
}

export interface Migration {
  id: string;
  title: string;
  run(ctx: MigrationContext): MigrationBatchResult;
}

export interface MigrationProgress {
  id: string;
  status: string;
  cursor: number;
  processed: number;
  total: number | null;
  lastError: string | null;
  updatedAt: string;
}

/** 多表共用一条 cursor：高位存表序号，低位存 rowid。 */
const TABLE_STRIDE = 1_000_000_000_000;
function encodeCursor(tableIdx: number, rowid: number): number {
  return tableIdx * TABLE_STRIDE + rowid;
}
function decodeCursor(cursor: number): { tableIdx: number; rowid: number } {
  return { tableIdx: Math.floor(cursor / TABLE_STRIDE), rowid: cursor % TABLE_STRIDE };
}

// ─── 迁移 1：把 base64 图片搬进附件存储 ─────────────────────────────────────

const IMAGE_TABLES = ['chat_messages', 'channel_messages'] as const;

export const migrateImagesToAttachments: Migration = {
  id: '001-images-to-attachments',
  title: '消息里的 base64 图片 → 附件文件（metadata.imageRefs）',
  run({ db, attachments, cursor, batchSize }) {
    const errors: string[] = [];
    let processed = 0;
    let { tableIdx, rowid } = decodeCursor(cursor);

    while (tableIdx < IMAGE_TABLES.length) {
      const table = IMAGE_TABLES[tableIdx]!;
      const exists = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (!exists) { tableIdx += 1; rowid = 0; continue; }

      const rows = db
        .prepare(
          `SELECT rowid AS rid, metadata AS meta FROM "${table}"
            WHERE rowid > ? AND metadata LIKE '%data:%'
            ORDER BY rowid ASC LIMIT ?`
        )
        .all(rowid, batchSize) as Array<{ rid: number; meta: string }>;

      if (rows.length === 0) { tableIdx += 1; rowid = 0; continue; }

      for (const row of rows) {
        rowid = row.rid;
        processed += 1;
        try {
          const meta = JSON.parse(row.meta) as Record<string, unknown>;
          const images = meta['images'];
          if (!Array.isArray(images) || images.length === 0) continue;

          const existingRefs = Array.isArray(meta['imageRefs'])
            ? (meta['imageRefs'] as unknown[]).filter(isAttachmentRef)
            : [];
          const refs: AttachmentRef[] = [...existingRefs];
          const keep: unknown[] = [];

          for (const img of images) {
            if (isDataUrl(img)) {
              const ref = attachments.putDataUrl(img);
              if (ref) refs.push(ref);
              // 解析失败就保留原值：宁可留着 base64，也不丢用户的图
              else keep.push(img);
            } else {
              keep.push(img);
            }
          }

          if (refs.length === existingRefs.length) continue; // 没有可搬的

          const next: Record<string, unknown> = { ...meta };
          if (refs.length) next['imageRefs'] = refs;
          if (keep.length) next['images'] = keep;
          else delete next['images'];

          db.prepare(`UPDATE "${table}" SET metadata = ? WHERE rowid = ?`).run(JSON.stringify(next), row.rid);
        } catch (err) {
          errors.push(`${table}#${row.rid}: ${String(err)}`);
        }
      }

      // 一批只处理一张表的一小段，交给调用方让出事件循环
      return { processed, nextCursor: encodeCursor(tableIdx, rowid), done: false, errors };
    }

    return { processed, nextCursor: encodeCursor(IMAGE_TABLES.length, 0), done: true, errors };
  },
};

// ─── 迁移 2：把超大 JSON 载荷搬进 blob 存储 ─────────────────────────────────

const PAYLOAD_TARGETS: Array<{ table: string; column: string }> = [
  { table: 'chat_messages', column: 'metadata' },
  { table: 'task_logs', column: 'metadata' },
  { table: 'agent_activity_logs', column: 'metadata' },
  { table: 'mailbox_items', column: 'payload' },
];

const LARGE_THRESHOLD_BYTES = 8 * 1024;

export const migrateLargePayloadsToBlobs: Migration = {
  id: '002-large-payloads-to-blobs',
  title: '超大 JSON 载荷 → 内容寻址文件（行内只留指针）',
  run({ db, blobs, cursor, batchSize }) {
    const errors: string[] = [];
    let processed = 0;
    let { tableIdx, rowid } = decodeCursor(cursor);

    while (tableIdx < PAYLOAD_TARGETS.length) {
      const { table, column } = PAYLOAD_TARGETS[tableIdx]!;
      const exists = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (!exists) { tableIdx += 1; rowid = 0; continue; }

      const rows = db
        .prepare(
          `SELECT rowid AS rid, "${column}" AS val FROM "${table}"
            WHERE rowid > ? AND "${column}" IS NOT NULL
              AND length("${column}") > ? AND instr("${column}", '"$blob"') = 0
            ORDER BY rowid ASC LIMIT ?`
        )
        .all(rowid, LARGE_THRESHOLD_BYTES, batchSize) as Array<{ rid: number; val: string }>;

      if (rows.length === 0) { tableIdx += 1; rowid = 0; continue; }

      for (const row of rows) {
        rowid = row.rid;
        processed += 1;
        try {
          const projected = projectJsonForStorage(row.val, blobs, LARGE_THRESHOLD_BYTES);
          if (projected === row.val) continue;
          const parsed = JSON.parse(projected) as unknown;
          if (!isBlobRef(parsed)) { errors.push(`${table}#${row.rid}: not a blob ref`); continue; }
          // 写之前先验证能原样还原 —— 搬数据不能靠"应该没问题"
          if (blobs.getText(parsed.$blob) !== row.val) { errors.push(`${table}#${row.rid}: round-trip mismatch`); continue; }
          db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(projected, row.rid);
        } catch (err) {
          errors.push(`${table}#${row.rid}: ${String(err)}`);
        }
      }

      return { processed, nextCursor: encodeCursor(tableIdx, rowid), done: false, errors };
    }

    return { processed, nextCursor: encodeCursor(PAYLOAD_TARGETS.length, 0), done: true, errors };
  },
};

export const DEFAULT_MIGRATIONS: Migration[] = [migrateImagesToAttachments, migrateLargePayloadsToBlobs];

// ─── 执行器 ─────────────────────────────────────────────────────────────────

export interface MigrationRunnerOptions {
  migrations?: Migration[];
  batchSize?: number;
  /** 批间让路（毫秒）。越小越快，越大对前台越友好。 */
  delayMs?: number;
  onProgress?: (p: MigrationProgress) => void;
  /** 测试用：单次运行最多跑多少批，防止同步测试挂住。 */
  maxBatches?: number;
}

export class MigrationRunner {
  private readonly migrations: Migration[];
  private readonly batchSize: number;
  private readonly delayMs: number;
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly attachments: AttachmentStore,
    private readonly blobs: BlobStore,
    private readonly opts: MigrationRunnerOptions = {},
  ) {
    this.migrations = opts.migrations ?? DEFAULT_MIGRATIONS;
    this.batchSize = Math.max(1, opts.batchSize ?? 50);
    this.delayMs = Math.max(0, opts.delayMs ?? 25);
  }

  /** 读进度（已完成的迁移也返回，便于 UI/日志展示）。 */
  status(): MigrationProgress[] {
    const rows = this.db
      .prepare('SELECT id, status, cursor, processed, total, last_error, updated_at FROM data_migrations')
      .all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r['id'] as string,
      status: r['status'] as string,
      cursor: r['cursor'] as number,
      processed: r['processed'] as number,
      total: (r['total'] as number | null) ?? null,
      lastError: (r['last_error'] as string | null) ?? null,
      updatedAt: r['updated_at'] as string,
    }));
  }

  private loadOrInit(m: Migration): { cursor: number; processed: number; status: string } {
    const row = this.db
      .prepare('SELECT cursor, processed, status FROM data_migrations WHERE id = ?')
      .get(m.id) as { cursor?: number; processed?: number; status?: string } | undefined;
    if (row) return { cursor: row.cursor ?? 0, processed: row.processed ?? 0, status: row.status ?? 'pending' };
    this.db.prepare('INSERT INTO data_migrations (id, status) VALUES (?, ?)').run(m.id, 'pending');
    return { cursor: 0, processed: 0, status: 'pending' };
  }

  private persist(id: string, patch: { status?: string; cursor?: number; processed?: number; lastError?: string | null }): void {
    const sets: string[] = ["updated_at = datetime('now')"];
    const vals: Array<string | number | null> = [];
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.cursor !== undefined) { sets.push('cursor = ?'); vals.push(patch.cursor); }
    if (patch.processed !== undefined) { sets.push('processed = ?'); vals.push(patch.processed); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); vals.push(patch.lastError); }
    vals.push(id);
    this.db.prepare(`UPDATE data_migrations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** 逐个迁移、逐批推进，直到全部完成。可重复调用（幂等）。 */
  async run(opts: { skip?: string[] } = {}): Promise<MigrationProgress[]> {
    if (this.running) return this.status(); // 单实例保护：同一进程不并发跑
    this.running = true;
    try {
      const maxBatches = this.opts.maxBatches ?? Number.POSITIVE_INFINITY;
      let batches = 0;

      for (const m of this.migrations) {
        if (opts.skip?.includes(m.id)) continue;
        const state = this.loadOrInit(m);
        if (state.status === 'done') continue;

        let cursor = state.cursor;
        let processed = state.processed;
        this.persist(m.id, { status: 'running' });

        for (;;) {
          if (batches >= maxBatches) return this.status();
          batches += 1;

          let res: MigrationBatchResult;
          try {
            res = m.run({ db: this.db, attachments: this.attachments, blobs: this.blobs, cursor, batchSize: this.batchSize });
          } catch (err) {
            // 单批失败不中断整体：记录错误、保留 cursor，下次重启继续
            this.persist(m.id, { status: 'pending', lastError: String(err) });
            break;
          }

          cursor = res.nextCursor;
          processed += res.processed;
          this.persist(m.id, {
            cursor,
            processed,
            status: res.done ? 'done' : 'running',
            lastError: res.errors?.length ? res.errors.slice(0, 3).join(' | ') : null,
          });
          this.opts.onProgress?.({
            id: m.id, status: res.done ? 'done' : 'running', cursor, processed,
            total: null, lastError: res.errors?.slice(0, 3).join(' | ') ?? null, updatedAt: '',
          });

          if (res.done) break;
          if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
        }
      }
      return this.status();
    } finally {
      this.running = false;
    }
  }
}
