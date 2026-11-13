/**
 * 第六刀 C1 —— 邮箱地址绑定的数据模型、唯一性裁决与写入侧隔离守卫。
 *
 * 这里的断言都是**行为**断言：跑真实 SQLite 文件、读真实视图、看真实返回体。
 * 不用 `readFileSync + toContain` 那种「重命名即失效」的文本栅栏——唯一例外是
 * 索引键的架构守卫（`org_id` 不得进唯一键），那条本身就是在断言 DDL 的形状。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  closeSqlite,
  SqliteAddressBindingRepo,
  SqliteUserRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-addr-c1-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function open() {
  const db = openSqlite(dbPath);
  for (const orgId of [ORG1, ORG2]) {
    db.prepare("INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, 'usr_owner')").run(orgId, orgId);
  }
  return { db, repo: new SqliteAddressBindingRepo(db), users: new SqliteUserRepo(db) };
}

const A1 = 'agt_alice';
const A2 = 'agt_bob';
const ORG1 = 'acme';
const ORG2 = 'globex';

describe('C1 数据模型：可空列 / 全局部分唯一索引 / 视图（存量库按形状升级）', () => {
  it('既有库（无 address 列）打开后自动补列，旧行保持 NULL，且不丢数据', () => {
    // 1) 先造一个「升级前」的库：channel_bindings 没有 address / revoked_at。
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE channel_bindings (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        instance_id TEXT,
        native_id TEXT,
        kind TEXT,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(org_id, scope, instance_id, native_id)
      );
      INSERT INTO channel_bindings (id, org_id, scope, instance_id, native_id, kind, agent_id)
        VALUES ('cb_legacy', '${ORG1}', 'global', NULL, NULL, NULL, '${A1}');
    `);
    legacy.close();

    const { db } = open();
    const cols = (db.prepare('PRAGMA table_info(channel_bindings)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('address');
    expect(cols).toContain('revoked_at');

    const legacyRow = db
      .prepare("SELECT address, revoked_at, agent_id FROM channel_bindings WHERE id = 'cb_legacy'")
      .get() as { address: string | null; revoked_at: string | null; agent_id: string };
    // 不回填：旧行新列必须是 NULL，且原数据仍在。
    expect(legacyRow.address).toBeNull();
    expect(legacyRow.revoked_at).toBeNull();
    expect(legacyRow.agent_id).toBe(A1);
  });

  it('全局唯一索引的键里不含 org_id（架构守卫）', () => {
    const { db } = open();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_channel_bindings_address_active'")
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toContain('UNIQUE INDEX');
    expect(row!.sql).toContain('(address)');
    expect(row!.sql).toContain('WHERE revoked_at IS NULL');
    // 关键：地址是全局身份，键里一旦出现 org_id，跨组织就能重复占用同一地址。
    expect(row!.sql).not.toContain('org_id');
  });

  it('address_bindings 视图只暴露带地址的行，target_ref 由 agent_id 派生', () => {
    const { db, repo } = open();
    db.prepare(
      "INSERT INTO channel_bindings (id, org_id, scope, agent_id) VALUES ('cb_route', ?, 'global', ?)",
    ).run(ORG1, A1);

    expect(repo.bind({ orgId: ORG1, agentId: A1, address: `alice.${ORG1}@markus.global` })).toMatchObject({
      status: 'bound',
      targetRef: `agent:${A1}`,
    });

    const rows = db.prepare('SELECT address, target_ref FROM address_bindings').all() as Array<{
      address: string;
      target_ref: string;
    }>;
    expect(rows).toEqual([{ address: `alice.${ORG1}@markus.global`, target_ref: `agent:${A1}` }]);
  });
});

describe('C1 I1：一个 active 地址至多一个 target_ref', () => {
  it('两个 Agent 抢同一地址：恰一成功一冲突（第二次读不到别人的身份）', () => {
    const { repo } = open();
    const address = `shared.${ORG1}@markus.global`;

    const first = repo.bind({ orgId: ORG1, agentId: A1, address });
    const second = repo.bind({ orgId: ORG1, agentId: A2, address });

    expect(first.status).toBe('bound');
    expect(second.status).toBe('conflict');
    // 冲突不泄露对方的绑定细节，只给下一步动作
    expect(JSON.stringify(second)).not.toContain(A1);
  });

  it('并发两次 bind 同一地址 → 恰一成功（裁决权在部分唯一索引，不在读-再-写）', async () => {
    const { repo } = open();
    const address = `race.${ORG1}@markus.global`;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => repo.bind({ orgId: ORG1, agentId: A1, address })),
      Promise.resolve().then(() => repo.bind({ orgId: ORG1, agentId: A2, address })),
    ]);

    expect(outcomes.filter((o) => o.status === 'bound')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'conflict')).toHaveLength(1);
  });

  it('同一 Agent 再绑自己的地址是 no-op（幂等），不是冲突', () => {
    const { repo } = open();
    const address = `alice.${ORG1}@markus.global`;
    expect(repo.bind({ orgId: ORG1, agentId: A1, address }).status).toBe('bound');
    const again = repo.bind({ orgId: ORG1, agentId: A1, address });
    expect(again).toMatchObject({ status: 'bound', unchanged: true });
  });
});

describe('C1 A3：跨组织不撞（同名 local 可共存，同一完整地址不可重复）', () => {
  it('两个组织下同 local 不同 org 的地址可以共存', () => {
    const { repo } = open();
    expect(repo.bind({ orgId: ORG1, agentId: A1, address: `alice.${ORG1}@markus.global` }).status).toBe(
      'bound',
    );
    expect(repo.bind({ orgId: ORG2, agentId: A2, address: `alice.${ORG2}@markus.global` }).status).toBe(
      'bound',
    );
  });

  it('同一完整地址在两个组织下也只能绑一次（跨组织唯一）', () => {
    const { repo } = open();
    const address = `alice.${ORG1}@markus.global`;
    expect(repo.bind({ orgId: ORG1, agentId: A1, address }).status).toBe('bound');
    // 换个 org_id 写同一地址：唯一键里没有 org_id，所以必须冲突。
    expect(repo.bind({ orgId: ORG2, agentId: A2, address }).status).toBe('conflict');
  });
});

describe('C1 A2/H12：平台保留地址与非法格式一律拒绝，且返回可行动提示', () => {
  it.each([
    ['conduct@markus.global', 'platform_reserved'],
    ['postmaster@markus.global', 'platform_reserved'],
    ['Alice.acme@markus.global', 'invalid_label'],
    ['alice..acme@markus.global', 'team_level_reserved'],
    ['alice.org@sub.markus.global', 'external_domain'],
    ['someone@example.com', 'external_domain'],
    ['alice.acme@MARKUS.GLOBAL', 'invalid_label'],
    ['alice@markus.global', 'unknown_platform_address'],
    ['a.team.squad@markus.global', 'team_level_reserved'],
    ['alice.acme', 'malformed'],
  ])('bind(%s) → bounced/%s，并给出下一步提示', (address, detail) => {
    const { repo } = open();
    const outcome = repo.bind({ orgId: ORG1, agentId: A1, address });
    expect(outcome.status).toBe('bounced');
    if (outcome.status !== 'bounced') throw new Error('unreachable');
    expect(outcome.detail).toBe(detail);
    expect(outcome.reason).toBe('unresolved_address');
    expect(outcome.hint.length).toBeGreaterThan(20);
    // C1 不产生 catch-all 记录：字段占位为 null，C3 上线时返回形状不变。
    expect(outcome.catchAllId).toBeNull();
  });

  it('平台保留地址被拒后，没有任何行落库', () => {
    const { db, repo } = open();
    repo.bind({ orgId: ORG1, agentId: A1, address: 'conduct@markus.global' });
    const row = db.prepare('SELECT COUNT(*) AS n FROM address_bindings').get() as { n: number };
    expect(row.n).toBe(0);
  });
});

describe('C1 I5：改他人绑定禁止；撤销后可重新认领', () => {
  it('撤销别人的地址 → forbidden（且原绑定仍然 active）', () => {
    const { repo } = open();
    const address = `alice.${ORG1}@markus.global`;
    repo.bind({ orgId: ORG1, agentId: A1, address });

    const attempt = repo.revoke({ orgId: ORG1, agentId: A2, address });
    expect(attempt.status).toBe('forbidden');
    expect(repo.resolve(address)).toMatchObject({ matched: true, agentId: A1 });
  });

  it('撤销自己的 → revoked；地址随后可被他人认领', () => {
    const { repo } = open();
    const address = `alice.${ORG1}@markus.global`;
    repo.bind({ orgId: ORG1, agentId: A1, address });

    expect(repo.revoke({ orgId: ORG1, agentId: A1, address }).status).toBe('revoked');
    expect(repo.resolve(address)).toEqual({ matched: false, address, reason: 'no_active_target' });
    expect(repo.bind({ orgId: ORG1, agentId: A2, address }).status).toBe('bound');
  });

  it('撤销不存在的绑定 → not_bound；撤销非法地址 → bounced', () => {
    const { repo } = open();
    expect(repo.revoke({ orgId: ORG1, agentId: A1, address: `ghost.${ORG1}@markus.global` }).status).toBe(
      'not_bound',
    );
    expect(repo.revoke({ orgId: ORG1, agentId: A1, address: 'not-an-address' }).status).toBe('bounced');
  });
});

describe('C1 resolve()：唯一解析入口，没有第三种「悄悄丢掉」', () => {
  it('active → 命中唯一目标；撤销 → no_active_target；外部域 → unresolved_address', () => {
    const { repo } = open();
    const address = `alice.${ORG1}@markus.global`;
    expect(repo.resolve(address)).toEqual({ matched: false, address, reason: 'no_active_target' });

    repo.bind({ orgId: ORG1, agentId: A1, address });
    expect(repo.resolve(address)).toEqual({
      matched: true,
      address,
      targetRef: `agent:${A1}`,
      agentId: A1,
    });

    repo.revoke({ orgId: ORG1, agentId: A1, address });
    expect(repo.resolve(address)).toMatchObject({ matched: false, reason: 'no_active_target' });

    expect(repo.resolve('stranger@example.com')).toMatchObject({
      matched: false,
      reason: 'unresolved_address',
    });
  });
});

describe('C1 address_list：可见范围是展示语义，含状态', () => {
  it('默认只列自己的（active + revoked）；include_org 追加本组织他人的 active', () => {
    const { repo } = open();
    repo.bind({ orgId: ORG1, agentId: A1, address: `alice.${ORG1}@markus.global` });
    repo.bind({ orgId: ORG1, agentId: A1, address: `alice2.${ORG1}@markus.global` });
    repo.bind({ orgId: ORG1, agentId: A2, address: `bob.${ORG1}@markus.global` });
    repo.revoke({ orgId: ORG1, agentId: A1, address: `alice2.${ORG1}@markus.global` });

    const own = repo.listVisible({ orgId: ORG1, agentId: A1 });
    expect(own.map((r) => r.address).sort()).toEqual([
      `alice.${ORG1}@markus.global`,
      `alice2.${ORG1}@markus.global`,
    ]);
    expect(own.filter((r) => r.revokedAt !== null)).toHaveLength(1);

    const withOrg = repo.listVisible({ orgId: ORG1, agentId: A1, includeOrg: true });
    expect(withOrg.map((r) => r.address)).toContain(`bob.${ORG1}@markus.global`);
  });
});

describe('C1 A4：users.email 写入侧隔离（组织邮箱格式一律拒绝）', () => {
  it('create/upsert/updateProfile 三条写路径都拒绝 <local>.<org>@markus.global', async () => {
    const { users } = open();
    const base = { id: 'usr_1', orgId: ORG1, name: 'Alice' };

    expect(() => users.create({ ...base, email: `alice.${ORG1}@markus.global` })).toThrow(
      /organisation address/i,
    );
    await expect(users.upsert({ ...base, email: `alice.${ORG1}@markus.global` })).rejects.toThrow(
      /organisation address/i,
    );
    users.create({ ...base, email: 'alice@example.com' });
    expect(() => users.updateProfile('usr_1', { email: `alice.${ORG1}@markus.global` })).toThrow(
      /organisation address/i,
    );
    // 被拒后原值不变（拒绝 ≠ 静默清空）
    expect(users.findById('usr_1')?.email).toBe('alice@example.com');
  });

  it('普通个人邮箱、外部域、平台保留地址照常可写（不误伤既有数据）', () => {
    const { users } = open();
    users.create({ id: 'usr_2', orgId: ORG1, name: 'Bob', email: 'bob@corp.example' });
    users.create({ id: 'usr_3', orgId: ORG1, name: 'NoMail' });
    expect(users.findById('usr_2')?.email).toBe('bob@corp.example');
    expect(users.findById('usr_3')?.email).toBeNull();
    expect(() => users.updateProfile('usr_2', { email: 'bob@corp.example' })).not.toThrow();
  });
});
