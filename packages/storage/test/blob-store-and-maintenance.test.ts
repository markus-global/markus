/**
 * 大字段外置（M1/M2/M4）+ 终态清理（M5）回归。
 *
 * 这里锁的是**数据搬移**的两条纪律：
 *   D1 dry-run 默认不改数据，报告的数字必须与真实候选集一致
 *   D2 已外置的行再跑一次是 no-op（幂等），不能反复重写
 * 以及一条更关键的：**外置之后读回来的值必须与原来完全一致**（透明还原），
 * 否则就是"省了空间、丢了数据"。
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite, closeSqlite, setBlobStoreForTests, BlobStore,
  projectJsonForStorage, resolveJsonFromStorage, isBlobRef,
  externalizeLargeFields, pruneTerminalMailboxItems, SqliteMailboxRepo,
} from '../src/index.js';

let tempDir: string;
let dbPath: string;
let blobRoot: string;
let store: BlobStore;

function countBlobFiles(root: string): number {
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-blob-'));
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

describe('BlobStore', () => {
  it('写入后能读回，且相同内容只落一份文件（B1）', () => {
    const a = store.put('hello world');
    const b = store.put('hello world');
    expect(a.$blob).toBe(b.$blob);
    expect(store.getText(a.$blob)).toBe('hello world');
    expect(countBlobFiles(blobRoot)).toBe(1);
  });

  it('不同内容 → 不同文件', () => {
    const a = store.put('one');
    const b = store.put('two');
    expect(a.$blob).not.toBe(b.$blob);
    expect(countBlobFiles(blobRoot)).toBe(2);
  });
});

describe('project / resolve（透明还原，B2）', () => {
  it('小于阈值原样返回', () => {
    const json = JSON.stringify({ a: 1 });
    expect(projectJsonForStorage(json, store, 1024)).toBe(json);
  });

  it('超过阈值 → 指针；resolve 还原原文', () => {
    const json = JSON.stringify({ big: 'x'.repeat(4000) });
    const projected = projectJsonForStorage(json, store, 1024);
    expect(projected).not.toBe(json);
    expect(isBlobRef(JSON.parse(projected))).toBe(true);
    expect(resolveJsonFromStorage(projected, store)).toBe(json);
  });

  it('指针文件丢失时保留指针而不是伪造内容', () => {
    const projected = JSON.stringify({ $blob: 'deadbeef', $bytes: 10 });
    expect(resolveJsonFromStorage(projected, store)).toBe(projected);
  });
});

describe('仓库写入自动外置（M1/M2/M4 的写路径）', () => {
  it('大 payload 落库为指针，读回来仍是原始对象', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    const bigContent = 'T'.repeat(20_000);
    repo.save({
      id: 'mbx_big', agentId: 'agt_1', sourceType: 'task_status_update',
      priority: 2, status: 'queued',
      payload: { summary: 's', content: bigContent, taskId: 't1' },
      queuedAt: new Date().toISOString(),
    });

    const raw = db.prepare("SELECT payload FROM mailbox_items WHERE id = 'mbx_big'").get() as { payload: string };
    expect(raw.payload.length).toBeLessThan(200);
    expect(isBlobRef(JSON.parse(raw.payload))).toBe(true);

    const back = repo.getHistory('agt_1');
    expect(back).toHaveLength(1);
    expect((back[0]!.payload as { content: string }).content).toBe(bigContent);
  });
});

describe('externalizeLargeFields（历史回填）', () => {
  function seed(db: ReturnType<typeof openSqlite>) {
    const ins = db.prepare(
      "INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    const big = JSON.stringify({ content: 'B'.repeat(20_000) });
    const small = JSON.stringify({ content: 'tiny' });
    ins.run('mbx_1', 'agt_1', 'a2a_message', 2, 'completed', big, '{}', '2026-01-01T00:00:00Z');
    ins.run('mbx_2', 'agt_1', 'a2a_message', 2, 'completed', small, '{}', '2026-01-01T00:00:00Z');
  }

  it('dry-run 只报告不写库（D1）', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const before = (db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_1'").get() as { payload: string }).payload;
    const res = externalizeLargeFields(db, { store, dryRun: true, only: ['mailbox_items'] });
    expect(res.externalized).toBe(1);
    const after = (db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_1'").get() as { payload: string }).payload;
    expect(after).toBe(before);
  });

  it('应用后行变小、内容可由读路径还原，且再跑一次是 no-op（D2）', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const res = externalizeLargeFields(db, { store, dryRun: false, only: ['mailbox_items'] });
    expect(res.externalized).toBe(1);
    expect(res.errors).toEqual([]);

    const raw = db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_1'").get() as { payload: string };
    expect(raw.payload.length).toBeLessThan(200);
    expect(resolveJsonFromStorage(raw.payload, store)).toContain('BBBB');

    const again = externalizeLargeFields(db, { store, dryRun: false, only: ['mailbox_items'] });
    expect(again.externalized).toBe(0);
  });

  it('小行完全不受影响', () => {
    const db = openSqlite(dbPath);
    seed(db);
    externalizeLargeFields(db, { store, dryRun: false, only: ['mailbox_items'] });
    const raw = db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_2'").get() as { payload: string };
    expect(JSON.parse(raw.payload)).toEqual({ content: 'tiny' });
  });
});

describe('pruneTerminalMailboxItems（M5）', () => {
  function seed(db: ReturnType<typeof openSqlite>) {
    const ins = db.prepare(
      "INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    ins.run('old_done', 'agt_1', 'a2a_message', 2, 'completed', '{"a":1}', '{}', '2020-01-01T00:00:00Z');
    ins.run('old_dropped', 'agt_1', 'a2a_message', 2, 'dropped', '{"a":1}', '{}', '2020-01-01T00:00:00Z');
    ins.run('new_done', 'agt_1', 'a2a_message', 2, 'completed', '{"a":1}', '{}', new Date().toISOString());
    ins.run('old_queued', 'agt_1', 'a2a_message', 2, 'queued', '{"a":1}', '{}', '2020-01-01T00:00:00Z');
  }

  it('dry-run 只统计（D1）', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const res = pruneTerminalMailboxItems(db, { dryRun: true });
    expect(res.candidates).toBe(2);
    expect(res.deleted).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM mailbox_items').get() as { n: number }).n).toBe(4);
  });

  it('只删终态且超期的行，queued 与新的不动', () => {
    const db = openSqlite(dbPath);
    seed(db);
    pruneTerminalMailboxItems(db, { dryRun: false });
    const ids = (db.prepare('SELECT id FROM mailbox_items ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
    expect(ids).toEqual(['new_done', 'old_queued']);
  });
});
