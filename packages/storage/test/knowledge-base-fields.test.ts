import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  SqliteDeliverableRepo,
  SqliteProjectRepo,
  SqliteOrgRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-kb-'));
  dbPath = join(tempDir, 'kb.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('知识库 V2 数据模型 — deliverables.source / knowledge_root / content', () => {
  it('create 未指定 source 时默认 agent（向后兼容）', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    const d = await repo.create({
      id: 'dlv-a1',
      type: 'file',
      title: '普通产出物',
      summary: 's',
    });
    expect(d?.source).toBe('agent');
    expect(d?.knowledgeRoot).toBeNull();
    expect(d?.content).toBeNull();
  });

  it('create 可写入 source=knowledge + knowledge_root + content 并正确读回', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    const d = await repo.create({
      id: 'dlv-k1',
      type: 'file',
      title: '知识库文档',
      summary: '项目规划',
      reference: '/kb/plan.md',
      source: 'knowledge',
      knowledgeRoot: '/kb',
      content: '这是关于项目知识库的全文内容，包含关键词 deep-dive。',
    });
    expect(d?.source).toBe('knowledge');
    expect(d?.knowledgeRoot).toBe('/kb');
    expect(d?.content).toContain('deep-dive');

    const found = await repo.findById('dlv-k1');
    expect(found?.source).toBe('knowledge');
    expect(found?.knowledgeRoot).toBe('/kb');
    expect(found?.content).toContain('deep-dive');
  });

  it('update 可修改 source / knowledge_root / content', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({ id: 'dlv-k2', type: 'file', title: 'T', summary: 's' });
    await repo.update('dlv-k2', {
      source: 'knowledge',
      knowledgeRoot: '/docs',
      content: '更新后的正文 abc123',
    });
    const found = await repo.findById('dlv-k2');
    expect(found?.source).toBe('knowledge');
    expect(found?.knowledgeRoot).toBe('/docs');
    expect(found?.content).toBe('更新后的正文 abc123');
  });

  it('search 可按 source 过滤', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({ id: 'dlv-s1', type: 'file', title: 'Agent 报告', summary: '产出' });
    await repo.create({
      id: 'dlv-s2',
      type: 'file',
      title: '知识条目',
      summary: '知识',
      source: 'knowledge',
      knowledgeRoot: '/kb',
    });
    const knowledge = await repo.search({ source: 'knowledge' });
    expect(knowledge.map(r => r.id)).toEqual(['dlv-s2']);
    const agents = await repo.search({ source: 'agent' });
    expect(agents.map(r => r.id)).toEqual(['dlv-s1']);
  });

  it('search query 可命中 content 全文', async () => {
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    await repo.create({
      id: 'dlv-c1',
      type: 'file',
      title: '隐秘标题',
      summary: '无关键词',
      source: 'knowledge',
      content: '正文中藏有关键词 unicorn-needle',
    });
    const hit = await repo.search({ query: 'unicorn-needle' });
    expect(hit.map(r => r.id)).toContain('dlv-c1');
  });
});

describe('知识库 V2 数据模型 — projects.knowledge_base_paths', () => {
  function seedOrg(db: ReturnType<typeof openSqlite>) {
    new SqliteOrgRepo(db).createOrg({
      id: 'org-1',
      name: 'Test Org',
      ownerId: 'user-1',
      plan: 'pro',
      maxAgents: 20,
    });
  }

  it('create 写入后正确读回', async () => {
    const db = openSqlite(dbPath);
    seedOrg(db);
    const repo = new SqliteProjectRepo(db);
    const created = await repo.create({
      id: 'proj-kb1',
      orgId: 'org-1',
      name: '知识项目',
      knowledgeBasePaths: ['/shared/kb/alpha', '/shared/kb/beta'],
    });
    expect(created.knowledgeBasePaths).toEqual(['/shared/kb/alpha', '/shared/kb/beta']);

    const found = repo.findById('proj-kb1');
    expect(found?.knowledgeBasePaths).toEqual(['/shared/kb/alpha', '/shared/kb/beta']);
  });

  it('update 可更新 knowledge_base_paths', async () => {
    const db = openSqlite(dbPath);
    seedOrg(db);
    const repo = new SqliteProjectRepo(db);
    await repo.create({ id: 'proj-kb2', orgId: 'org-1', name: 'P' });
    await repo.update('proj-kb2', { knowledgeBasePaths: ['/shared/kb/gamma'] });
    const found = repo.findById('proj-kb2');
    expect(found?.knowledgeBasePaths).toEqual(['/shared/kb/gamma']);
  });

  it('未提供时默认空数组', async () => {
    const db = openSqlite(dbPath);
    seedOrg(db);
    const repo = new SqliteProjectRepo(db);
    const d = await repo.create({ id: 'proj-kb3', orgId: 'org-1', name: 'P' });
    expect(d.knowledgeBasePaths).toEqual([]);
  });
});

describe('迁移回填（旧库打开后自动加列 + 默认值）', () => {
  it('旧 schema deliverables 打开后新增三列且默认 agent、旧数据无损', async () => {
    // 手工构造旧 schema（不含新列），插入旧数据
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE deliverables (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'file',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        reference TEXT NOT NULL DEFAULT '',
        format TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        task_id TEXT,
        agent_id TEXT,
        project_id TEXT,
        requirement_id TEXT,
        diff_stats TEXT,
        test_results TEXT,
        artifact_type TEXT,
        artifact_data TEXT,
        access_count INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO deliverables (id, type, title, summary, reference, status, created_at, updated_at)
      VALUES ('dlv-legacy-1', 'file', '旧报告', '旧摘要', '/old/report.md', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    old.close();

    // openSqlite 触发迁移
    const repo = new SqliteDeliverableRepo(openSqlite(dbPath));
    const migrated = await repo.findById('dlv-legacy-1');
    expect(migrated).not.toBeNull();
    expect(migrated?.source).toBe('agent'); // 默认回填
    expect(migrated?.title).toBe('旧报告'); // 旧数据完整
    expect(migrated?.reference).toBe('/old/report.md');
    expect(migrated?.knowledgeRoot).toBeNull();
    expect(migrated?.content).toBeNull();
  });

  it('旧 schema projects 打开后新增 knowledge_base_paths 且默认空数组、旧数据无损', () => {
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        repositories TEXT DEFAULT '[]',
        team_ids TEXT DEFAULT '[]',
        governance_policy TEXT,
        archive_policy TEXT,
        report_schedule TEXT,
        onboarding_config TEXT,
        created_by TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO projects (id, org_id, name, description, status, repositories, team_ids, created_at, updated_at)
      VALUES ('proj-legacy-1', 'org-1', '旧项目', 'desc', 'active', '[]', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    old.close();

    const repo = new SqliteProjectRepo(openSqlite(dbPath));
    const found = repo.findById('proj-legacy-1');
    expect(found).not.toBeUndefined();
    expect(found?.knowledgeBasePaths).toEqual([]);
    expect(found?.name).toBe('旧项目');
  });
});