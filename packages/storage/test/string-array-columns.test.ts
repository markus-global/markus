/**
 * 「标签列一定是 string[]」这条不变量，在**读写两个边界**上都要成立。
 *
 * 真实事故（2026-11-01）：右栏点通知里的第一条「需求审批」→ 跳到任务页 → 整页空白。
 * 根因不是路由，而是 `requirements.tags` 里 8 行历史脏数据：
 *   `"内容运营,工作流,Easel"`（JSON 字符串）、`{"item":["Q3"]}`（包了一层对象）
 * 读路径 `fromJson<string[]>()` 是**盲转换**，把它们原样交给前端；
 * `(req.tags ?? []).join(', ')` 抛 TypeError，React 卸载整棵树 → 白屏。
 *
 * 这些用例对真实 sqlite 行为断言（不是断言源码文本）：把读路径改回盲转换，
 * 它们必须变红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteRequirementRepo } from '../src/sqlite-storage.js';
import { normalizeStringArrayColumns } from '../src/migration-runner.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-tags-'));
  dbPath = join(tempDir, 'tags.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function insertRaw(db: DatabaseSync, id: string, tags: string) {
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_id) VALUES ('org_1', 'Test', 'usr_1')").run();
  db.prepare(
    `INSERT INTO requirements (id, org_id, title, description, status, priority, source, created_by, tags, created_at, updated_at)
     VALUES (?, 'org_1', 't', '', 'pending', 'high', 'agent', 'agt_1', ?, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  ).run(id, tags);
}

describe('requirements.tags — 读边界把形状收口成 string[]', () => {
  it('历史编码的行读出来仍然是数组（这正是白屏的那三行）', () => {
    const db = openSqlite(dbPath);
    insertRaw(db, 'req_json_string', '"内容运营,工作流,Easel"');
    insertRaw(db, 'req_object', '{"item":["Q3","Skills生态"]}');
    insertRaw(db, 'req_raw_text', '前端,UX优化');
    insertRaw(db, 'req_contract', '["cleanup","linking"]');

    const repo = new SqliteRequirementRepo(db);

    expect(repo.findById('req_json_string')!.tags).toEqual(['内容运营', '工作流', 'Easel']);
    expect(repo.findById('req_object')!.tags).toEqual(['Q3', 'Skills生态']);
    expect(repo.findById('req_raw_text')!.tags).toEqual(['前端', 'UX优化']);
    expect(repo.findById('req_contract')!.tags).toEqual(['cleanup', 'linking']);

    // 列表路径同样是消费方（Work 页就是从这里拿数据的）
    for (const req of repo.listByOrg('org_1') as Array<{ tags: unknown }>) {
      expect(Array.isArray(req.tags)).toBe(true);
    }
  });
});

describe('requirements.tags — 写边界不接受非数组编码', () => {
  it('调用方在运行期传进来一个字符串，落库也必须是 JSON 数组', async () => {
    const db = openSqlite(dbPath);
    db.prepare("INSERT OR IGNORE INTO organizations (id, name, owner_id) VALUES ('org_1', 'Test', 'usr_1')").run();
    const repo = new SqliteRequirementRepo(db);

    // TS 类型挡不住 HTTP/MCP 的入参：真实事故就是这么来的（api-server 直接 as string[]）
    await repo.create({
      id: 'req_write', orgId: 'org_1', title: 't', source: 'agent', createdBy: 'agt_1',
      tags: '内容运营,工作流' as unknown as string[],
    });

    const stored = db.prepare('SELECT tags FROM requirements WHERE id = ?').get('req_write') as { tags: string };
    expect(stored.tags).toBe('["内容运营","工作流"]');
    expect(repo.findById('req_write')!.tags).toEqual(['内容运营', '工作流']);
  });
});

describe('migration 004 — 库里的历史编码被改写，读不懂的行保持原样', () => {
  it('把三种历史编码统一成 JSON 数组，并且重复执行是 no-op', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE requirements (id TEXT PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]')");
    db.exec('INSERT INTO requirements (id, tags) VALUES (\'a\', \'"x,y"\')');
    db.exec('INSERT INTO requirements (id, tags) VALUES (\'b\', \'{"item":["z"]}\')');
    db.exec('INSERT INTO requirements (id, tags) VALUES (\'c\', \'["ok"]\')');
    db.exec('INSERT INTO requirements (id, tags) VALUES (\'d\', \'{"weird":{"nested":1}}\')');

    const run = () => normalizeStringArrayColumns.run({ db, cursor: 0, batchSize: 10 } as never);
    const first = run();

    const rows = () => db.prepare('SELECT id, tags FROM requirements ORDER BY id').all() as Array<{ id: string; tags: string }>;
    expect(rows()).toEqual([
      { id: 'a', tags: '["x","y"]' },
      { id: 'b', tags: '["z"]' },
      { id: 'c', tags: '["ok"]' },
      { id: 'd', tags: '{"weird":{"nested":1}}' }, // 读不懂 → 不抹掉，报错给它可见性
    ]);
    expect(first.processed).toBe(4);
    expect(first.errors?.join(' ')).toContain('unreadable value');

    // 幂等：第二遍不产生任何写入。读不懂的那行会被再次报出来——它是永久可见的
    // 事实（数据还在，只是我们不敢猜），不是需要被抹掉的噪声。
    const before = JSON.stringify(rows());
    const second = run();
    expect(JSON.stringify(rows())).toBe(before);
    expect(second.processed).toBe(4);
    expect(second.errors?.every(e => e.includes('unreadable value'))).toBe(true);
  });
});
