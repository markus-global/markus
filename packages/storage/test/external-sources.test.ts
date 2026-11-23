/**
 * C10-B —— external_sources 持久配置 + kill switch（post-#474 持久存储模式）。
 *
 * 判据：
 *   · 新表有写者（repo）+ 真流量（验收 ≥1 真事件）—— 满足建表门；
 *   · kill switch = enabled 列，**重启后状态保持**（关库重开仍读到）；
 *   · fresh-init 与 upgrade 后逻辑 schema 完全一致（C10-A 纪律：按名排序列形）；
 *   · kind 闭集 {webhook, rss}，address 经唯一解析器 parseAddress 校验。
 *
 * base（37c817aa）上必须红：表与 repo 都不存在（namespace 导入做行为断言）。
 * 关库纪律：openSqlite 是单例，统一用 storage.closeSqlite() 关（不 raw db.close()，
 * 否则单例 _db 悬空，下一次 closeSqlite 抛 "database is not open"）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as storage from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  storage.closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-extsrc-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  storage.closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const ORG = 'acme';
const AGENT = 'agt_content';

function open() {
  const db = storage.openSqlite(dbPath);
  db.prepare("INSERT INTO organizations (id, name, owner_id, org_slug) VALUES (?, ?, 'usr_o', ?)").run(ORG, ORG, ORG);
  const Repo = (storage as Record<string, unknown>)['SqliteExternalSourceRepo'] as
    | (new (db: DatabaseSync) => {
        register(i: { orgId: string; agentId: string; kind: string; address: string; config?: Record<string, unknown> }): { status: string; source?: { id: string }; reason?: string };
        get(id: string): { id: string; orgId: string; agentId: string; kind: string; address: string; config: string; enabled: boolean; cursor: string | null; lastEventAt: string | null; lastError: string | null } | undefined;
        listByOrg(orgId: string): Array<{ id: string }>;
        listEnabledByKind(kind: string): Array<{ id: string; enabled: boolean }>;
        setEnabled(id: string, enabled: boolean): boolean;
        updateCursor(id: string, cursor: string | null, lastEventAt?: string): void;
        recordError(id: string, error: string | null): void;
      })
    | undefined;
  return { db, Repo };
}

describe('C10-B：external_sources 表 + 唯一 repo 写者', () => {
  it('repo 导出存在；fresh init 后表存在', () => {
    const { db, Repo } = open();
    expect(typeof Repo, 'SqliteExternalSourceRepo 必须导出').toBe('function');
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_sources'").get();
    expect(t).toBeDefined();
  });

  it('register → get roundtrip：kind/address/config/enabled 默认 1 / owner', () => {
    const { db, Repo } = open();
    const repo = new Repo!(db);
    const out = repo.register({ orgId: ORG, agentId: AGENT, kind: 'rss', address: 'news.acme@markus.global', config: { feedUrl: 'https://example.com/feed' } });
    expect(out.status).toBe('registered');
    const row = repo.get(out.source!.id)!;
    expect(row.kind).toBe('rss');
    expect(row.address).toBe('news.acme@markus.global');
    expect(row.agentId).toBe(AGENT);
    expect(row.enabled).toBe(true);
    expect(JSON.parse(row.config)).toEqual({ feedUrl: 'https://example.com/feed' });
    expect(repo.listByOrg(ORG).map(r => r.id)).toContain(row.id);
  });

  it('kind 闭集：非 webhook/rss 必拒（bounced，不静默落库）', () => {
    const { db, Repo } = open();
    const repo = new Repo!(db);
    const out = repo.register({ orgId: ORG, agentId: AGENT, kind: 'email', address: 'x.acme@markus.global' });
    expect(out.status).toBe('bounced');
    expect(repo.listByOrg(ORG)).toHaveLength(0);
  });

  it('address 经唯一解析器：非 markus 组织地址必拒（外部域/平台保留/格式坏）', () => {
    const { db, Repo } = open();
    const repo = new Repo!(db);
    for (const bad of ['someone@gmail.com', 'noreply@markus.global', 'no-dot', 'a.b.c@markus.global']) {
      expect(repo.register({ orgId: ORG, agentId: AGENT, kind: 'webhook', address: bad }).status, bad).toBe('bounced');
    }
  });

  it('kill switch 持久：setEnabled(false) → 关库重开 → 仍 false（重启保持，不是内存缓冲）', () => {
    const { db, Repo } = open();
    const repo = new Repo!(db);
    const { source } = repo.register({ orgId: ORG, agentId: AGENT, kind: 'webhook', address: 'hook.acme@markus.global' });
    expect(repo.setEnabled(source!.id, false)).toBe(true);
    expect(repo.get(source!.id)!.enabled).toBe(false);
    // 重开（= 重启）：状态来自 DB，不是内存。
    storage.closeSqlite();
    const db2 = storage.openSqlite(dbPath);
    const repo2 = new Repo!(db2);
    expect(repo2.get(source!.id)!.enabled).toBe(false);
    expect(repo2.listEnabledByKind('webhook')).toHaveLength(0);
    expect(repo2.setEnabled(source!.id, true)).toBe(true);
    expect(repo2.listEnabledByKind('webhook').map(r => r.id)).toContain(source!.id);
  });

  it('cursor / lastEventAt / lastError 可写可读（RSS 水位持久，重启不重扫全量）', () => {
    const { db, Repo } = open();
    const repo = new Repo!(db);
    const { source } = repo.register({ orgId: ORG, agentId: AGENT, kind: 'rss', address: 'feed.acme@markus.global' });
    repo.updateCursor(source!.id, JSON.stringify({ lastPublishedAt: '2026-11-22T10:00:00Z', seenIds: ['g1'] }), '2026-11-22T10:00:01Z');
    repo.recordError(source!.id, 'fetch timeout');
    const row = repo.get(source!.id)!;
    expect(JSON.parse(row.cursor!)).toEqual({ lastPublishedAt: '2026-11-22T10:00:00Z', seenIds: ['g1'] });
    expect(row.lastEventAt).toBe('2026-11-22T10:00:01Z');
    expect(row.lastError).toBe('fetch timeout');
  });

  it('fresh vs upgraded：external_sources 逻辑列形 + 索引完全一致（按名排序，不比 cid）', () => {
    const shapeOf = (db: DatabaseSync) => ({
      cols: (db.prepare('PRAGMA table_info(external_sources)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>)
        .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      indexes: (db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='external_sources' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>)
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
    // fresh
    const fresh = storage.openSqlite(dbPath);
    const freshShape = shapeOf(fresh);
    storage.closeSqlite();
    // upgraded：一个只有 organizations 的「旧库」，openSqlite 补齐全表。
    const legacyPath = join(tempDir, 'legacy.db');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, org_slug TEXT);');
    legacy.close();
    const upgraded = storage.openSqlite(legacyPath);
    expect(shapeOf(upgraded)).toEqual(freshShape);
    storage.closeSqlite();
  });
});
