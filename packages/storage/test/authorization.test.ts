/**
 * 授权边界（A4）的持久层回归 —— 真实 SQLite，不是 fake repo。
 *
 * 这一层锁两件事：
 *   I8  同一资源同一时刻只能有一个 L3（admin）责任人 —— **由数据库部分唯一索引守**，
 *       不是由 `bind()` 里的「先查再插」守。判据：绕过 `bind()` 直接 INSERT 也必须被拒。
 *   Mandate  「这件事批了没有」只有**一个读取点**（`SqliteApprovalRepo.findMandate`），
 *       且它的口径保守：查不到 = none，不看 type/details 的旧单不算数。
 *
 * 为什么用真库：这条不变量以前写在 JS 里（check-then-insert），fake repo 会忠实地
 * 复现那个 bug 而不是暴露它。夹具会撒谎 —— 只有索引不会。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteApprovalRepo, type ApprovalRow } from '../src/sqlite-storage.js';
import { SqliteResourceBindingRepo } from '../src/thread-store.js';

let dir: string;
let db: DatabaseSync;
let bindings: SqliteResourceBindingRepo;
let approvals: SqliteApprovalRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-authz-'));
  db = openSqlite(join(dir, 'markus.db'));
  bindings = new SqliteResourceBindingRepo(db);
  approvals = new SqliteApprovalRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

describe('I8 — 同一资源只能有一个 L3 责任人（DB 守，不是应用层守）', () => {
  it('绕过 bind() 直接插两条 admin 也必须被数据库拒绝（证明约束不在 JS 里）', () => {
    const insert = (id: string, holder: string) =>
      db
        .prepare(
          `INSERT INTO resource_bindings (id, holder_kind, holder_id, resource, scope, autonomy, granted_by, since)
           VALUES (?, 'agent', ?, 'gh:o/r', 'admin', 'observe', 'human:o', 1)`,
        )
        .run(id, holder);

    insert('rbd_1', 'agt_a');
    // 第二次直接写 SQL —— 没有任何应用层代码参与
    expect(() => insert('rbd_2', 'agt_b')).toThrow(/UNIQUE|uniq_rbd_l3/i);

    const admins = bindings.listByResource('gh:o/r').filter(b => b.scope === 'admin');
    expect(admins).toHaveLength(1);
    expect(admins[0]!.holder.id).toBe('agt_a');
  });

  it('UPDATE 路径同样被约束守住（把已有绑定升成第二个 admin 也不行）', () => {
    const a = bindings.bind({ holder: { kind: 'agent', id: 'agt_a' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    expect(a.ok).toBe(true);
    const b = bindings.bind({ holder: { kind: 'agent', id: 'agt_b' }, resource: 'gh:o/r', scope: 'read', grantedBy: 'human:o' });
    expect(b.ok).toBe(true);

    const promoted = bindings.bind({ holder: { kind: 'agent', id: 'agt_b' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    expect(promoted.ok).toBe(false);
    if (promoted.ok) throw new Error('unreachable');
    // 可行动提示：谁占着 + 怎么接管（平台规则第 5 条：拒绝必须给可行动提示）
    expect(promoted.reason).toContain('agent:agt_a');
    expect(promoted.reason).toContain('I8');
    expect(promoted.reason).toContain('transfer');
  });

  it('第二个 admin 被拒时，提示里的持有者来自真实数据（不是猜的 "另一个持有者"）', () => {
    bindings.bind({ holder: { kind: 'team', id: 'team_x' }, resource: 'xhs:brand_01', scope: 'admin', grantedBy: 'human:o' });
    const r = bindings.bind({ holder: { kind: 'agent', id: 'agt_c' }, resource: 'xhs:brand_01', scope: 'admin', grantedBy: 'human:o' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('team:team_x');
  });

  it('存量重复 admin 在升级时被降级（否则索引根本建不起来）', () => {
    const file = join(dir, 'legacy.db');
    closeSqlite();
    db = openSqlite(file);
    // 模拟旧库：先拆掉索引，再制造两条 admin（旧代码允许）
    db.exec('DROP INDEX IF EXISTS uniq_rbd_l3');
    const raw = db.prepare(
      `INSERT INTO resource_bindings (id, holder_kind, holder_id, resource, scope, autonomy, granted_by, since)
       VALUES (?, 'agent', ?, 'gh:o/r', 'admin', 'observe', 'human:o', ?)`,
    );
    raw.run('rbd_old1', 'agt_a', 10);
    raw.run('rbd_old2', 'agt_b', 20);
    closeSqlite();

    // 重新打开 → 迁移段去重 + 建索引
    db = openSqlite(file);
    bindings = new SqliteResourceBindingRepo(db);
    const admins = bindings.listByResource('gh:o/r').filter(b => b.scope === 'admin');
    expect(admins).toHaveLength(1);
    expect(admins[0]!.holder.id).toBe('agt_a'); // 最早那条保留
    // 另一条降级而不是删除：绑定事实还在，只是不再声称 L3
    expect(bindings.findByHolder('agent', 'agt_b', 'gh:o/r')?.scope).toBe('publish');
  });
});

describe('findMandate — 逐件事审批的唯一读取点', () => {
  const approval = (over: Partial<ApprovalRow>): ApprovalRow => ({
    id: 'apr_1',
    agentId: 'agt_a',
    agentName: 'A',
    // 判据是 details 里的两个字段，不是 approvals.type（见 findMandate 注释）
    type: 'action',
    title: 'delete data',
    description: '',
    details: { resource: 'gh:o/r', actionScope: 'admin' },
    status: 'approved',
    requestedAt: '2026-11-03T00:00:00.000Z',
    ...over,
  });

  it('没有单 → none（不是"可能批了"）', () => {
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' }).state).toBe('none');
  });

  it('三种状态映射：approved / pending / rejected+expired→denied', () => {
    const cases: Array<[string, string]> = [
      ['approved', 'approved'],
      ['pending', 'pending'],
      ['rejected', 'denied'],
      ['expired', 'denied'],
    ];
    for (const [status, expected] of cases) {
      // 每个用例用**独立资源**：否则多条单会互相遮挡，测到的是"最近一条"而不是状态映射
      const resource = `gh:o/${status}`;
      approvals.upsert(approval({ id: `apr_${status}`, status, details: { resource, actionScope: 'admin' } }));
      expect(
        approvals.findMandate({ agentId: 'agt_a', resource, actionScope: 'admin' }).state,
        status,
      ).toBe(expected);
    }
  });

  it('同一件事有多条单时以最近一条为准（重新申请能覆盖旧结论）', () => {
    approvals.upsert(approval({ id: 'apr_old', status: 'rejected', requestedAt: '2026-11-01T00:00:00.000Z' }));
    approvals.upsert(approval({ id: 'apr_new', status: 'pending', requestedAt: '2026-11-03T00:00:00.000Z' }));
    const r = approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' });
    expect(r.state).toBe('pending');
    expect(r.approvalId).toBe('apr_new');
  });

  it('资源或动作档位不匹配的单不算数（审批不能被挪用到别的地/别的档）', () => {
    approvals.upsert(approval({ details: { resource: 'gh:other/repo', actionScope: 'admin' } }));
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' }).state).toBe('none');

    approvals.upsert(approval({ id: 'apr_2', details: { resource: 'gh:o/r', actionScope: 'publish' } }));
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' }).state).toBe('none');
  });

  it('别人的单不算数；没有 resource/actionScope 的普通工具确认也不算数', () => {
    approvals.upsert(approval({ id: 'apr_other_agent', agentId: 'agt_z' }));
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' }).state).toBe('none');

    // 普通工具确认（如「同意跑一次 shell」）details 里没有这两项 → 绝不能被当作 mandate
    approvals.upsert(approval({ id: 'apr_plain', details: { toolName: 'shell_execute' } }));
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin' }).state).toBe('none');
  });

  it('eventKey：给了 eventKey 时只认同一件事（或没有绑定具体事件的通用单）', () => {
    approvals.upsert(approval({ id: 'apr_e1', details: { resource: 'gh:o/r', actionScope: 'admin', eventKey: 'trg_1' } }));
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin', eventKey: 'trg_1' }).state).toBe('approved');
    expect(approvals.findMandate({ agentId: 'agt_a', resource: 'gh:o/r', actionScope: 'admin', eventKey: 'trg_2' }).state).toBe('none');
  });
});
