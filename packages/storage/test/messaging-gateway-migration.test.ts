/**
 * G1 — messaging-gateway data model migration.
 *
 * Locks the migration contract from `docs/design/messaging-gateway.md` §5.2/§5.3:
 * an existing `integrations` row (the `(org, platform)`-keyed legacy table) is
 * copied into the new `platform_instances` / `channel_bindings` tables such that
 * an upgrade is **incremental, idempotent, non-destructive, fail-safe** and
 * existing Feishu credentials survive byte-for-byte.
 *
 * These tests run against a real SQLite file seeded with a pre-upgrade schema —
 * no DB mock. Behaviour must be observable from outside (raw SELECTs), the same
 * way the router will consume it in later slices.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, migrateMessagingGateway, resolveInstanceConfig } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-gw-g1-'));
  dbPath = join(tempDir, 'legacy.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * The pre-upgrade shape: only the two tables the migration reads (`integrations`
 * + `agents`). Everything else `openSqlite` creates for itself via SCHEMA_SQL.
 * `agents` carries its base columns so the untouched v1 heartbeat step still runs.
 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, platform TEXT NOT NULL, display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', forward_rules TEXT DEFAULT '[]',
  last_verified_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations(org_id, platform);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, org_id TEXT NOT NULL, team_id TEXT,
  role_id TEXT NOT NULL DEFAULT '', role_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'offline',
  skills TEXT DEFAULT '[]', llm_config TEXT DEFAULT '{}', compute_config TEXT DEFAULT '{}', channels TEXT DEFAULT '[]',
  agent_role TEXT NOT NULL DEFAULT 'worker', heartbeat_interval_ms INTEGER NOT NULL DEFAULT 1800000,
  container_id TEXT, tokens_used_today INTEGER NOT NULL DEFAULT 0, active_task_ids TEXT DEFAULT '[]',
  profile TEXT, last_heartbeat TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function seedLegacy(userVersion = 3): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  for (const stmt of LEGACY_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
  // Default 3 = "tail of the pre-G1 schema": openSqlite then SKIPS its one-shot
  // migration, so the *direct* migrateMessagingGateway() call under test is the
  // one that does the work (and reports honest stats). Pass 0 to exercise the
  // openSqlite startup path itself (auto-migrate / fail-safe).
  db.exec(`PRAGMA user_version = ${userVersion}`);
  return db;
}

function addIntegration(
  db: DatabaseSync,
  o: { id: string; orgId: string; platform: string; config: string; enabled?: number },
): void {
  db.prepare(
    `INSERT INTO integrations (id, org_id, platform, display_name, enabled, config) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.orgId, o.platform, o.platform, o.enabled ?? 1, o.config);
}

function addAgent(
  db: DatabaseSync,
  o: { id: string; name: string; orgId: string; agentRole?: string; roleName?: string; teamId?: string | null },
): void {
  db.prepare(
    `INSERT INTO agents (id, name, org_id, team_id, role_id, role_name, agent_role) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.name, o.orgId, o.teamId ?? null, '', o.roleName ?? 'Worker', o.agentRole ?? 'worker');
}

function q<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

describe('migrateMessagingGateway — 增量迁移契约', () => {
  it('空库：不抛错、不新增任何行', () => {
    const db = openSqlite(dbPath);
    const stats = migrateMessagingGateway(db);
    expect(stats.instancesCreated).toBe(0);
    expect(stats.bindingsCreated).toBe(0);
    expect(q(db, 'SELECT id FROM platform_instances')).toHaveLength(0);
    expect(q(db, 'SELECT id FROM channel_bindings')).toHaveLength(0);
  });

  it('无 agentId：生成 instance 行 + global→Secretary', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'int_feishu', orgId: 'org_a', platform: 'feishu', config: '{"appId":"cli_x"}' });
    addAgent(legacy, { id: 'agt_sec', name: 'Secretary', orgId: 'org_a', agentRole: 'manager', roleName: 'Secretary' });
    legacy.close();

    const db = openSqlite(dbPath);
    const stats = migrateMessagingGateway(db);

    expect(stats.instancesCreated).toBe(1);
    const instances = q<{ id: string; org_id: string; platform: string; label: string; enabled: number }>(
      db, 'SELECT id, org_id, platform, label, enabled FROM platform_instances',
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ org_id: 'org_a', platform: 'feishu', label: 'default', enabled: 1 });

    const bindings = q<{ scope: string; instance_id: string | null; agent_id: string; kind: string | null }>(
      db, 'SELECT scope, instance_id, agent_id, kind FROM channel_bindings',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ scope: 'global', instance_id: null, agent_id: 'agt_sec', kind: null });
  });

  it('Secretary 选择沿用单一事实源（无 team 者优先）', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'int_1', orgId: 'org_a', platform: 'feishu', config: '{}' });
    addAgent(legacy, { id: 'agt_team_sec', name: '协调秘书', orgId: 'org_a', roleName: 'Secretary', teamId: 'team_1' });
    addAgent(legacy, { id: 'agt_org_sec', name: 'Secretary', orgId: 'org_a', roleName: 'Secretary', teamId: null });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);
    const globals = q<{ agent_id: string }>(db, "SELECT agent_id FROM channel_bindings WHERE scope='global'");
    expect(globals).toHaveLength(1);
    expect(globals[0].agent_id).toBe('agt_org_sec');
  });

  it('config 字节级一致 —— 绝不重新序列化', () => {
    // Deliberately unusual whitespace + key order: a JSON.parse→stringify path
    // would normalise both, so byte equality is the proof it was not re-encoded.
    const raw = '{ "appSecret" : "s3cr3t-飞书",\n  "agentId":"agt_sales",  "appId":"cli_x" }';
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'int_feishu', orgId: 'org_a', platform: 'feishu', config: raw, enabled: 0 });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);
    const row = q<{ config: string }>(db, 'SELECT config FROM platform_instances')[0];
    expect(row.config).toBe(raw);
    expect(q<{ enabled: number }>(db, 'SELECT enabled FROM platform_instances')[0].enabled).toBe(0);
  });

  it('有 agentId：插 instance-scope binding，且不再补 global', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, {
      id: 'int_feishu', orgId: 'org_a', platform: 'feishu',
      config: '{"appId":"cli_x","agentId":"agt_sales"}',
    });
    addAgent(legacy, { id: 'agt_sec', name: 'Secretary', orgId: 'org_a', roleName: 'Secretary' });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);

    const inst = q<{ id: string }>(db, 'SELECT id FROM platform_instances')[0];
    const bindings = q<{ scope: string; instance_id: string; agent_id: string }>(
      db, 'SELECT scope, instance_id, agent_id FROM channel_bindings',
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ scope: 'instance', instance_id: inst.id, agent_id: 'agt_sales' });
  });

  it('多平台 / 多 org：各自独立迁移', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"agentId":"agt_1"}' });
    addIntegration(legacy, { id: 'i2', orgId: 'org_a', platform: 'telegram', config: '{"botToken":"t"}' });
    addIntegration(legacy, { id: 'i3', orgId: 'org_b', platform: 'slack', config: '{"botToken":"s"}' });
    addAgent(legacy, { id: 'agt_sec_a', name: 'Secretary', orgId: 'org_a', roleName: 'Secretary' });
    addAgent(legacy, { id: 'agt_sec_b', name: 'Secretary', orgId: 'org_b', roleName: 'Secretary' });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);

    expect(q(db, 'SELECT id FROM platform_instances')).toHaveLength(3);
    // org_a already has an instance binding (feishu→agt_1) → no global seed;
    // telegram carried no agentId. org_b has no binding at all → global→Secretary.
    const bindings = q<{ org_id: string; scope: string; agent_id: string }>(
      db, 'SELECT org_id, scope, agent_id FROM channel_bindings ORDER BY org_id, scope',
    );
    expect(bindings).toHaveLength(2);
    expect(bindings.filter((b) => b.org_id === 'org_a').map((b) => b.scope)).toEqual(['instance']);
    expect(bindings.find((b) => b.org_id === 'org_b')).toMatchObject({ scope: 'global', agent_id: 'agt_sec_b' });
  });

  it('幂等：重复调用不新增、不覆盖用户改动', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"appId":"cli_x"}' });
    addAgent(legacy, { id: 'agt_sec', name: 'Secretary', orgId: 'org_a', roleName: 'Secretary' });
    legacy.close();

    const db = openSqlite(dbPath);
    const first = migrateMessagingGateway(db);
    expect(first.instancesCreated).toBe(1);
    expect(first.bindingsCreated).toBe(1);

    // A user (or a later slice) edits the migrated row.
    db.prepare("UPDATE platform_instances SET label='renamed-by-user', enabled=0").run();

    const second = migrateMessagingGateway(db);
    expect(second.instancesCreated).toBe(0);
    expect(second.bindingsCreated).toBe(0);
    const inst = q<{ label: string; enabled: number; config: string }>(
      db, 'SELECT label, enabled, config FROM platform_instances',
    );
    expect(inst).toHaveLength(1);
    expect(inst[0].label).toBe('renamed-by-user');   // never overwritten
    expect(inst[0].enabled).toBe(0);
    expect(q(db, 'SELECT id FROM channel_bindings')).toHaveLength(1); // never duplicated
  });

  it('生成确定性 id，重启稳定', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{}' });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);
    const id1 = q<{ id: string }>(db, 'SELECT id FROM platform_instances')[0].id;
    migrateMessagingGateway(db);
    const id2 = q<{ id: string }>(db, 'SELECT id FROM platform_instances')[0].id;
    expect(id1).toBe(id2);
    expect(id1).toContain('feishu');
  });

  it('没有 Secretary agent 时：插 instance 行但不崩、不插 binding', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{}' });
    legacy.close();

    const db = openSqlite(dbPath);
    expect(() => migrateMessagingGateway(db)).not.toThrow();
    expect(q(db, 'SELECT id FROM platform_instances')).toHaveLength(1);
    expect(q(db, 'SELECT id FROM channel_bindings')).toHaveLength(0);
  });

  it('非法 config：不抛错、字节照抄、无 binding', () => {
    const bad = 'not-json :: 原始字节';
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: bad });
    legacy.close();

    const db = openSqlite(dbPath);
    expect(() => migrateMessagingGateway(db)).not.toThrow();
    expect(q<{ config: string }>(db, 'SELECT config FROM platform_instances')[0].config).toBe(bad);
    expect(q(db, 'SELECT id FROM channel_bindings')).toHaveLength(0);
  });

  it('非破坏：legacy integrations 行迁移前后字节不变', () => {
    const raw = '{"appId":"cli_x","secret":"保留"}';
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: raw, enabled: 1 });
    legacy.close();

    const db = openSqlite(dbPath);
    const before = q<{ config: string; enabled: number }>(db, 'SELECT config, enabled FROM integrations');
    migrateMessagingGateway(db);
    const after = q<{ config: string; enabled: number }>(db, 'SELECT config, enabled FROM integrations');
    expect(after).toEqual(before);
  });
});

describe('resolveInstanceConfig — 双读窗口原语', () => {
  it('优先新表（用户改动后仍以新表为准）', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"appId":"legacy"}' });
    legacy.close();

    const db = openSqlite(dbPath);
    migrateMessagingGateway(db);
    db.prepare(`UPDATE platform_instances SET config = '{"appId":"new"}'`).run();

    const resolved = resolveInstanceConfig(db, 'org_a', 'feishu');
    expect(resolved?.source).toBe('instance');
    expect(resolved?.config['appId']).toBe('new');
  });

  it('某平台尚无 instance 行 → 回落 legacy', () => {
    const legacy = seedLegacy();
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"appId":"legacy"}' });
    legacy.close();

    const db = openSqlite(dbPath); // version 3 ⇒ no auto-migration, table stays empty
    const resolved = resolveInstanceConfig(db, 'org_a', 'feishu');
    expect(resolved?.source).toBe('legacy');
    expect(resolved?.config['appId']).toBe('legacy');
  });

  it('两处都无 → undefined', () => {
    const db = openSqlite(dbPath);
    expect(resolveInstanceConfig(db, 'org_a', 'feishu')).toBeUndefined();
  });
});

describe('openSqlite 接线 + fail-safe', () => {
  it('openSqlite 自动迁移：新表存在、版本推进到 3', () => {
    const legacy = seedLegacy(0);
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"appId":"cli_x"}' });
    addAgent(legacy, { id: 'agt_sec', name: 'Secretary', orgId: 'org_a', roleName: 'Secretary' });
    legacy.close();

    const db = openSqlite(dbPath);
    expect(q(db, 'SELECT id FROM platform_instances')).toHaveLength(1);
    expect(q(db, 'SELECT id FROM channel_bindings')).toHaveLength(1);
    const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(ver.user_version).toBe(3);

    // Reopen: the one-shot gate means no second pass — rows stay as they are.
    closeSqlite();
    const db2 = openSqlite(dbPath);
    expect(q(db2, 'SELECT id FROM platform_instances')).toHaveLength(1);
    expect(q(db2, 'SELECT id FROM channel_bindings')).toHaveLength(1);
  });

  it('迁移抛错时 app 仍启动、旧读路径仍服务、版本不推进（可重试）', () => {
    const legacy = seedLegacy(0);
    addIntegration(legacy, { id: 'i1', orgId: 'org_a', platform: 'feishu', config: '{"agentId":"agt_sales"}' });
    // Poison the binding insert with a correct-schema table + abort trigger, so
    // the migration throws while SCHEMA_SQL's index creation still succeeds.
    legacy.exec(`CREATE TABLE channel_bindings (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL, instance_id TEXT,
      native_id TEXT, kind TEXT, agent_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, scope, instance_id, native_id)
    )`);
    legacy.exec(`CREATE TRIGGER poison_binding BEFORE INSERT ON channel_bindings
      BEGIN SELECT RAISE(ABORT, 'poisoned for fail-safe test'); END`);
    legacy.close();

    let db: ReturnType<typeof openSqlite>;
    expect(() => { db = openSqlite(dbPath); }).not.toThrow();
    // Legacy read path still serves the old row untouched.
    const legacyRows = q<{ config: string }>(db!, 'SELECT config FROM integrations');
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0].config).toBe('{"agentId":"agt_sales"}');
    // Version gate is NOT advanced, so a fixed build retries on the next start.
    const ver = db!.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(ver.user_version).toBeLessThan(3);
  });
});
