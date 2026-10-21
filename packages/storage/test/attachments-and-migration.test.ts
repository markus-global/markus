/**
 * 附件（base64 出库）+ 后台数据迁移（升级零感知）回归。
 *
 * 锁四件事：
 *   1. 图片写进消息后，行里**不再有 base64**，读回来是可用 URL（前端零改动）
 *   2. 同一张图重复出现只占一份磁盘
 *   3. 迁移**幂等**：跑第二遍是 no-op
 *   4. 迁移**可断点续跑**：cursor 落地，中断后用同一 runner 继续不重复不遗漏
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite, closeSqlite, setBlobStoreForTests, BlobStore, AttachmentStore,
  attachmentUrl, expandImageRefs, MigrationRunner,
  migrateImagesToAttachments, migrateLargePayloadsToBlobs,
  SqliteChannelMessageRepo,
} from '../src/index.js';

let tempDir: string;
let dbPath: string;
let blobRoot: string;
let store: BlobStore;

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const dataUrl = () => `data:image/png;base64,${PNG_1x1}`;

function countBlobs(root: string): number {
  let n = 0;
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const b of readdirSync(join(root, a.name), { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      n += readdirSync(join(root, a.name, b.name)).length;
    }
  }
  return n;
}

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-attach-'));
  dbPath = join(tempDir, 'data.db');
  blobRoot = join(tempDir, 'blobs');
  store = new BlobStore(blobRoot);
  setBlobStoreForTests(store);
});

afterEach(() => {
  closeSqlite();
  setBlobStoreForTests(null);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AttachmentStore', () => {
  it('data URL → 引用；字节读回一致；同图只占一份', () => {
    const db = openSqlite(dbPath);
    const attachments = new AttachmentStore(db, store);

    const a = attachments.putDataUrl(dataUrl(), 'a.png');
    const b = attachments.putDataUrl(dataUrl(), 'b.png');
    expect(a).not.toBeNull();
    expect(a!.sha).toBe(b!.sha);
    expect(a!.mime).toBe('image/png');
    expect(countBlobs(blobRoot)).toBe(1);

    const got = attachments.get(a!.sha)!;
    expect(got.mime).toBe('image/png');
    expect(got.buf.toString('base64')).toBe(PNG_1x1);
    expect(attachments.dataUrlFor(a!.sha)).toContain('data:image/png;base64,');
  });

  it('非法 data URL 返回 null（不抛）', () => {
    const db = openSqlite(dbPath);
    const attachments = new AttachmentStore(db, store);
    expect(attachments.putDataUrl('not-a-data-url')).toBeNull();
  });
});

describe('expandImageRefs', () => {
  it('imageRefs → images(URL)', () => {
    const meta = { imageRefs: [{ sha: 'a'.repeat(64), mime: 'image/png', bytes: 10 }] };
    expect(expandImageRefs(meta)['images']).toEqual([attachmentUrl('a'.repeat(64))]);
  });

  it('没有 refs 时原样返回（老数据 data URL 照旧可用）', () => {
    const meta = { images: [dataUrl()] };
    expect(expandImageRefs(meta)).toBe(meta);
  });

  it('null/undefined 不炸', () => {
    expect(expandImageRefs(null)).toEqual({});
    expect(expandImageRefs(undefined)).toEqual({});
  });
});

describe('迁移 1：base64 图片出库', () => {
  function seedLegacyRow(db: ReturnType<typeof openSqlite>, id: string) {
    db.prepare(
      'INSERT INTO channel_messages (id, org_id, channel, sender_id, sender_type, sender_name, text, mentions, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(id, 'default', 'ch_general', 'u1', 'human', 'You', 'look', '[]', JSON.stringify({ images: [dataUrl()] }), new Date().toISOString());
  }

  it('老行被搬走：行变小、读出来是 URL', async () => {
    const db = openSqlite(dbPath);
    seedLegacyRow(db, 'cm_1');
    const before = (db.prepare("SELECT metadata FROM channel_messages WHERE id='cm_1'").get() as { metadata: string }).metadata;
    expect(before).toContain('base64');

    const attachments = new AttachmentStore(db, store);
    const runner = new MigrationRunner(db, attachments, store, { batchSize: 10, delayMs: 0, migrations: [migrateImagesToAttachments] });
    await runner.run();

    const after = (db.prepare("SELECT metadata FROM channel_messages WHERE id='cm_1'").get() as { metadata: string }).metadata;
    expect(after).not.toContain('base64');
    expect(after.length).toBeLessThan(before.length);

    const repo = new SqliteChannelMessageRepo(db);
    const { messages } = repo.getMessages('ch_general') as { messages: Array<{ metadata: { images?: string[] } }> };
    const images = messages[0]!.metadata.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^\/api\/attachments\/[a-f0-9]{64}$/);

    const sha = images[0]!.split('/').pop()!;
    expect(attachments.get(sha)!.buf.toString('base64')).toBe(PNG_1x1);
  });

  it('幂等：第二次跑不再改动任何行', async () => {
    const db = openSqlite(dbPath);
    seedLegacyRow(db, 'cm_2');
    const attachments = new AttachmentStore(db, store);
    const mk = () => new MigrationRunner(db, attachments, store, { batchSize: 10, delayMs: 0, migrations: [migrateImagesToAttachments] });
    const first = await mk().run();
    expect(first.find(p => p.id === '001-images-to-attachments')!.status).toBe('done');

    const snapBefore = (db.prepare("SELECT metadata FROM channel_messages WHERE id='cm_2'").get() as { metadata: string }).metadata;
    await mk().run();
    const snapAfter = (db.prepare("SELECT metadata FROM channel_messages WHERE id='cm_2'").get() as { metadata: string }).metadata;
    expect(snapAfter).toBe(snapBefore);
  });

  it('断点续跑：分批推进，cursor 落库，重开 runner 继续', async () => {
    const db = openSqlite(dbPath);
    for (let i = 0; i < 5; i += 1) seedLegacyRow(db, `cm_r${i}`);
    const attachments = new AttachmentStore(db, store);

    const step = new MigrationRunner(db, attachments, store, { batchSize: 2, delayMs: 0, maxBatches: 1, migrations: [migrateImagesToAttachments] });
    await step.run();
    const mid = db.prepare("SELECT cursor, status FROM data_migrations WHERE id='001-images-to-attachments'").get() as { cursor: number; status: string };
    expect(mid.status).toBe('running');
    expect(mid.cursor).toBeGreaterThan(0);

    const finish = new MigrationRunner(db, attachments, store, { batchSize: 2, delayMs: 0, migrations: [migrateImagesToAttachments] });
    await finish.run();
    const rows = db.prepare('SELECT metadata FROM channel_messages').all() as Array<{ metadata: string }>;
    expect(rows.every(r => !r.metadata.includes('base64'))).toBe(true);
    expect((db.prepare("SELECT status FROM data_migrations WHERE id='001-images-to-attachments'").get() as { status: string }).status).toBe('done');
  });
});

describe('迁移 2：超大载荷出库', () => {
  it('大 payload 变成指针，且可原样还原；幂等', async () => {
    const db = openSqlite(dbPath);
    const big = JSON.stringify({ content: 'Z'.repeat(30_000) });
    db.prepare(
      'INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run('mbx_m', 'agt_1', 'a2a_message', 2, 'completed', big, '{}', new Date().toISOString());

    const attachments = new AttachmentStore(db, store);
    const runner = new MigrationRunner(db, attachments, store, { batchSize: 10, delayMs: 0, migrations: [migrateLargePayloadsToBlobs] });
    await runner.run();

    const raw = (db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_m'").get() as { payload: string }).payload;
    expect(raw.length).toBeLessThan(200);

    await new MigrationRunner(db, attachments, store, { batchSize: 10, delayMs: 0, migrations: [migrateLargePayloadsToBlobs] }).run();
    const raw2 = (db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_m'").get() as { payload: string }).payload;
    expect(raw2).toBe(raw);
  });
});
