import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  SqliteDeliverableRepo,
} from '../src/sqlite-storage.js';
import type { DeliverableRow } from '../src/types.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-dlv-share-'));
  dbPath = join(tempDir, 'share.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteDeliverableRepo — Hub 分享字段', () => {
  it('create 时可写入 4 个分享字段并正确读回', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    const d = await repo.create({
      id: 'del-share-1',
      type: 'report',
      title: '行业调研报告',
      summary: 'AI 行业深度报告',
      reference: '/data/report.md',
      format: 'markdown',
      tags: ['ai', 'report'],
      hubShareId: 'dlv_share_abc123',
      shareStatus: 'pending_review',
      shareUrl: null,
      shareVisibility: 'link',
    });

    expect(d?.title).toBe('行业调研报告');
    expect(d?.hubShareId).toBe('dlv_share_abc123');
    expect(d?.shareStatus).toBe('pending_review');
    // published 前 shareUrl 为 null
    expect(d?.shareUrl).toBeNull();
    expect(d?.shareVisibility).toBe('link');

    const found = await repo.findById('del-share-1');
    expect(found).toEqual(d);
  });

  it('未提供分享字段时默认全部为 null（none=未分享，向后兼容）', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    const d = await repo.create({
      id: 'del-share-2',
      type: 'file',
      title: '普通产出物',
      summary: 's',
    });

    expect(d).not.toBeNull();
    expect(d!.hubShareId).toBeNull();
    expect(d!.shareStatus).toBeNull();
    expect(d!.shareUrl).toBeNull();
    expect(d!.shareVisibility).toBeNull();
  });

  it('update 可回填/更新分享字段（如 published 后写入 shareUrl）', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({ id: 'del-share-3', type: 'file', title: 'T', summary: 's' });

    await repo.update('del-share-3', {
      hubShareId: 'dlv_share_xyz',
      shareStatus: 'published',
      shareUrl: 'https://hub.example/dlv/some-slug',
      shareVisibility: 'public',
    });

    const found = await repo.findById('del-share-3');
    expect(found?.hubShareId).toBe('dlv_share_xyz');
    expect(found?.shareStatus).toBe('published');
    expect(found?.shareUrl).toBe('https://hub.example/dlv/some-slug');
    expect(found?.shareVisibility).toBe('public');
  });

  it('update 可将分享字段重置为 null（如 revoke 后清空 link）', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({
      id: 'del-share-4',
      type: 'file',
      title: 'T',
      summary: 's',
      hubShareId: 'dlv_share_old',
      shareStatus: 'published',
      shareUrl: 'https://hub.example/dlv/old',
      shareVisibility: 'link',
    });

    await repo.update('del-share-4', { shareStatus: 'revoked', shareUrl: null });

    const found = await repo.findById('del-share-4');
    expect(found?.shareStatus).toBe('revoked');
    expect(found?.shareUrl).toBeNull();
    // hubShareId / visibility 保持不变
    expect(found?.hubShareId).toBe('dlv_share_old');
    expect(found?.shareVisibility).toBe('link');
  });

  it('search 结果同样携带分享字段', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({
      id: 'del-share-5',
      type: 'report',
      title: 'Web3 报告',
      summary: 'Web3 趋势',
      reference: '/r.md',
      format: 'markdown',
      hubShareId: 'dlv_share_web3',
      shareStatus: 'published',
      shareUrl: 'https://hub.example/dlv/web3',
      shareVisibility: 'public',
    });

    const results = await repo.search({ query: 'Web3' });
    expect(results).toHaveLength(1);
    expect(results[0].hubShareId).toBe('dlv_share_web3');
    expect(results[0].shareStatus).toBe('published');
    expect(results[0].shareVisibility).toBe('public');
  });

  it('迁移：旧库自动增加分享列，历史数据分享字段为 null 且可写入', async () => {
    // 1) 直接用原生 DatabaseSync 构造一个缺失分享列的旧版 deliverables 表
    closeSqlite();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE deliverables (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'file',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        reference TEXT NOT NULL DEFAULT '',
        format TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        task_id TEXT, agent_id TEXT, project_id TEXT, requirement_id TEXT,
        diff_stats TEXT, test_results TEXT, artifact_type TEXT, artifact_data TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    raw
      .prepare(
        `INSERT INTO deliverables (id, type, title, summary, reference, status)
         VALUES ('legacy-1', 'file', '旧报告', '旧摘要', '/old', 'active')`,
      )
      .run();
    raw.close();

    // 2) 通过 openSqlite 重新打开 —— 触发迁移补充分享列
    const db = openSqlite(dbPath);
    const cols = db
      .prepare('PRAGMA table_info(deliverables)')
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('hub_share_id');
    expect(names).toContain('share_status');
    expect(names).toContain('share_url');
    expect(names).toContain('share_visibility');

    // 3) 历史数据保留，且新增分享字段默认 null
    const repo = new SqliteDeliverableRepo(db);
    const legacy = await repo.findById('legacy-1');
    expect(legacy?.id).toBe('legacy-1');
    expect(legacy?.title).toBe('旧报告');
    expect(legacy?.hubShareId).toBeNull();
    expect(legacy?.shareStatus).toBeNull();
    expect(legacy?.shareUrl).toBeNull();
    expect(legacy?.shareVisibility).toBeNull();

    // 4) 迁移后的新列可正常写入
    await repo.update('legacy-1', { shareStatus: 'published', shareVisibility: 'link' });
    const updated = await repo.findById('legacy-1');
    expect(updated?.shareStatus).toBe('published');
    expect(updated?.shareVisibility).toBe('link');
  });

  it('类型导出：DeliverableRow 包含 4 个分享字段', () => {
    const row: DeliverableRow = {
      id: 'x',
      type: 'file',
      title: 't',
      summary: 's',
      reference: '',
      format: null,
      tags: [],
      status: 'active',
      taskId: null,
      agentId: null,
      projectId: null,
      requirementId: null,
      artifactType: null,
      artifactData: null,
      diffStats: null,
      testResults: null,
      accessCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      hubShareId: null,
      shareStatus: null,
      shareUrl: null,
      shareVisibility: null,
    };
    expect(row.hubShareId).toBeNull();
    expect(row.shareStatus).toBeNull();
  });
});
