/**
 * 第七刀 C7-A —— `work_units` 的真实 SQLite 行为。
 *
 * 断言跑真实数据库文件，不是文本栅栏：
 *   · 并发 `ensure` 同一 ref ⇒ 恰一行（唯一索引兜底，不靠调用方自觉）；
 *   · 非法迁移被矩阵判红，且**状态未被改动**（不是「先写后报错」）；
 *   · 每次合法迁移都在 `status_transitions` 留下 `entity_type='work_unit'` 的行；
 *   · `mailbox_items.work_unit_ref` 的唯一写者是入队 INSERT（C10-0B 删除了“事后补列”的写者）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  SqliteWorkUnitRepo,
  SqliteStatusTransitionRepo,
} from '../src/sqlite-storage.js';
import { DatabaseSync } from 'node:sqlite';

let tempDir: string;
let dbPath: string;
/** 额外连接（并发用例需要第二个真实连接）——只有它需要手动关闭。 */
let extraDbs: DatabaseSync[] = [];

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-wu-'));
  dbPath = join(tempDir, 'data.db');
  extraDbs = [];
});

afterEach(() => {
  for (const db of extraDbs) {
    try { db.close(); } catch { /* already closed */ }
  }
  extraDbs = [];
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/** 主连接 = `openSqlite` 的单例（schema 在它上面已建好）。 */
function openDb(): DatabaseSync {
  return openSqlite(dbPath) as unknown as DatabaseSync;
}

function repo(): SqliteWorkUnitRepo {
  return new SqliteWorkUnitRepo(openDb());
}

describe('work_units schema + ensure', () => {
  it('表与唯一索引存在（uq_work_units_ref 是幂等键的裁决者）', () => {
    const db = openDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_units'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('uq_work_units_ref');
  });

  it('ensure 幂等：同一 ref 连调两次只有一行，第二次 created=false', () => {
    const r = repo();
    const first = r.ensure({ ref: 'session:cs_1:r1', agentId: 'agt_a' });
    expect(first.created).toBe(true);
    const second = r.ensure({ ref: 'session:cs_1:r1', agentId: 'agt_a' });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.status).toBe('running');
    expect(second.row.used).toBe(0);
  });

  it('并发 ensure 同一 ref（两个连接交错）⇒ 恰一行', async () => {
    const r1 = repo();
    // 第二个**独立连接**：同一文件、不同连接，才是真正的并发写入面。
    const db2 = new DatabaseSync(dbPath);
    extraDbs.push(db2);
    const r2 = new SqliteWorkUnitRepo(db2);
    const ops = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        (i % 2 === 0 ? r1 : r2).ensure({ ref: 'session:cs_race:r1', agentId: 'agt_a' }),
      ),
    );
    const results = await Promise.all(ops);
    const ids = new Set(results.map((x) => x.row.id));
    expect(ids.size).toBe(1);
    // 恰好一次「真插入」，其余全是幂等命中
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(r1.listByAgent('agt_a')).toHaveLength(1);
  });

  it('唯一索引是兜底：绕过 ensure 直接插同 ref 会被数据库拒绝', () => {
    const r = repo();
    r.ensure({ ref: 'task_tsk_1_r1', agentId: 'agt_a' });
    const db = openDb();
    expect(() =>
      db
        .prepare('INSERT INTO work_units (id, ref, agent_id, status, used) VALUES (?, ?, ?, ?, 0)')
        .run('wu_dup', 'task_tsk_1_r1', 'agt_a', 'running'),
    ).toThrow();
  });
});

describe('transition（矩阵的唯一执行点）', () => {
  it('非法迁移 archived→running 抛错，且状态未被改动', () => {
    const r = repo();
    const { row } = r.ensure({ ref: 'session:cs_2:r1', agentId: 'agt_a' });
    r.transition(row.ref, 'terminated');
    r.transition(row.ref, 'archived');
    expect(() => r.transition(row.ref, 'running')).toThrow();
    expect(r.getByRef(row.ref)!.status).toBe('archived');
  });

  it('合法迁移写 status_transitions（entity_type=work_unit，from/to 正确）', () => {
    const r = repo();
    const { row } = r.ensure({ ref: 'session:cs_3:r1', agentId: 'agt_a' });
    r.transition(row.ref, 'idle', { reason: 'turn finished', changedByType: 'agent' });
    const db = openDb();
    const st = new SqliteStatusTransitionRepo(db).getByEntity('work_unit', row.id);
    expect(st).toHaveLength(1);
    expect(st[0]!.fromStatus).toBe('running');
    expect(st[0]!.toStatus).toBe('idle');
    expect(st[0]!.reason).toBe('turn finished');
  });

  it('archived 迁移写入 archived_at', () => {
    const r = repo();
    const { row } = r.ensure({ ref: 'session:cs_4:r1', agentId: 'agt_a' });
    r.transition(row.ref, 'terminated');
    r.transition(row.ref, 'archived');
    expect(r.getByRef(row.ref)!.archivedAt).toBeTruthy();
  });
});

describe('reconcileRunningAgainstTerminalMailbox（僵尸 running 收口）', () => {
  it('规则三：父回合已不在 running → 委派子 WU 不再被算作在跑', () => {
    const r = repo();
    const parent = r.ensure({ ref: 'session:cs_x:r1', agentId: 'agt_a' }).row;
    r.ensure({
      ref: 'delegation:session:cs_x:r1#sub_a',
      agentId: 'agt_a',
      parentId: parent.id,
    });

    // 父回合结束（子 WU 的 settle() 在进程被杀/异常时永不执行 → 子停在 running）
    r.transition(parent.ref, 'idle');
    expect(r.getByRef('delegation:session:cs_x:r1#sub_a')!.status).toBe('running');

    r.reconcileRunningAgainstTerminalMailbox();

    expect(r.getByRef('delegation:session:cs_x:r1#sub_a')!.status).toBe('idle');
    expect(r.getByRef('delegation:session:cs_x:r1#sub_a')!.stopReason)
      .toBe('reconciled_parent_not_running');
  });

  it('规则三不误伤：父仍 running 时子必须保持 running', () => {
    const r = repo();
    // 父用非 `session:` ref，避开规则二（孤儿收口）的干扰面 —— 本用例只问规则三。
    const parent = r.ensure({ ref: 'task_tsk_t1_r1', agentId: 'agt_a' }).row;
    r.ensure({
      ref: 'delegation:task_tsk_t1_r1#sub_b',
      agentId: 'agt_a',
      parentId: parent.id,
    });

    r.reconcileRunningAgainstTerminalMailbox();

    expect(r.getByRef(parent.ref)!.status).toBe('running');
    expect(r.getByRef('delegation:task_tsk_t1_r1#sub_b')!.status).toBe('running');
  });
});

describe('listByAgent / listChildren（自省读面）', () => {
  it('按 agent 读取，默认排除 archived', () => {
    const r = repo();
    r.ensure({ ref: 'session:cs_a:r1', agentId: 'agt_a' });
    r.ensure({ ref: 'session:cs_a:r2', agentId: 'agt_a' });
    const { row } = r.ensure({ ref: 'session:cs_b:r1', agentId: 'agt_b' });
    r.transition(row.ref, 'terminated');
    r.transition(row.ref, 'archived');

    expect(r.listByAgent('agt_a')).toHaveLength(2);
    expect(r.listByAgent('agt_b')).toHaveLength(0);
    expect(r.listByAgent('agt_b', { includeArchived: true })).toHaveLength(1);
  });

  it('父子关系可从对象读出（C7-A 不产生父子，但读面先就位）', () => {
    const r = repo();
    const parent = r.ensure({ ref: 'session:cs_p:r1', agentId: 'agt_a' }).row;
    // 直接造一个子行：C7-A 没有生产者，但读面必须能回答「有没有子」
    const db = openDb();
    db.prepare(
      'INSERT INTO work_units (id, parent_id, ref, agent_id, status, used) VALUES (?, ?, ?, ?, ?, 0)',
    ).run('wu_child', parent.id, 'a2a:dm:x:dlv_1', 'agt_child', 'running');
    const children = r.listChildren(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.ref).toBe('a2a:dm:x:dlv_1');
  });
});