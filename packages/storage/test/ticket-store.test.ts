/**
 * Ticket 持久层的**行为**回归（真实 SQLite，不是 fake repo）。
 *
 * 这一层锁的是 docs/architecture/ticket.md 的四条不变量：
 *   T1 票可**独立存在**：不挂 task 也能建、能读、能流转
 *   T2 票与 task 是**可选关联**，不是从属：删 task 只断开关联（task_id → NULL），票还在
 *   T3 状态机唯一执行点：非法转移被拒且给出可行动提示；不存在就**不**自动建票
 *   T4 单一写入点：`INSERT INTO tickets` / `UPDATE tickets` 只允许出现在 ticket-store.ts
 *
 * 为什么用真库：夹具会撒谎。T2 靠的是 `ON DELETE SET NULL` 这条**外键行为**，
 * fake repo 里手写「把 task_id 置空」看着一样，实际根本测不到 SQLite 的 FK 引擎；
 * T4 靠的是源码扫描——它测的不是行为而是结构，因此单独成例并写明理由。
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite } from '../src/sqlite-storage.js';
import { SqliteTicketRepo } from '../src/ticket-store.js';
import { SqliteTaskRepo } from '../src/sqlite-storage.js';
import { SqliteOrgRepo, SqliteAgentRepo } from '../src/sqlite-storage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（packages/storage/test → ../../../ ） */
const REPO_ROOT = join(HERE, '..', '..', '..');

let dir: string;
let db: DatabaseSync;
let tickets: SqliteTicketRepo;
let taskRepo: SqliteTaskRepo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'markus-ticket-'));
  db = openSqlite(join(dir, 'markus.db'));
  tickets = new SqliteTicketRepo(db);
  taskRepo = new SqliteTaskRepo(db);
  // 真任务需要 org + agent（tasks 的两个 NOT NULL 外键）。生产里它们恒存在。
  new SqliteOrgRepo(db).createOrg({ id: 'default', name: 'Default', ownerId: 'u1' });
  new SqliteAgentRepo(db).create({ id: 'agt_1', name: 'Worker', orgId: 'default', roleId: 'r1', roleName: 'Dev' });
  await taskRepo.create({
    id: 'tsk_1',
    orgId: 'default',
    title: '真实任务',
    assignedAgentId: 'agt_1',
    reviewerId: 'agt_2',
  });
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

describe('三向关联（验收判据 1）', () => {
  it('① 票可以不依赖 task 存在：建 → 读 → 流转全部可用', () => {
    const created = tickets.create({
      orgId: 'default',
      kind: 'message',
      sourceRef: 'msg_abc',
      subject: '客户在问发货时间',
      assignee: 'agt_1',
    });
    expect(created.taskId).toBeNull();
    expect(created.status).toBe('open');

    const read = tickets.getById(created.id);
    expect(read?.subject).toBe('客户在问发货时间');
    expect(read?.sourceRef).toBe('msg_abc');
    expect(read?.taskId).toBeNull();

    expect(tickets.transition(created.id, 'ended').status).toBe('ended');
  });

  it('② 票可以挂 task：双向都查得到（byId 带 taskId / byTask 列出）', () => {
    const created = tickets.create({
      orgId: 'default',
      kind: 'comment',
      sourceRef: 'cmt_9',
      subject: '验收意见：这里要补测试',
      taskId: 'tsk_1',
    });
    expect(created.taskId).toBe('tsk_1');
    expect(tickets.getById(created.id)?.taskId).toBe('tsk_1');
    expect(tickets.listByTask('tsk_1').map(t => t.id)).toEqual([created.id]);
    // 没挂票的任务返回空数组（不是 undefined —— 调用方不必做空值分支）
    expect(tickets.listByTask('tsk_不存在')).toEqual([]);
  });

  it('③ task 被取消 → 票仍在且可读，票的状态**不跟随** task', () => {
    const created = tickets.create({
      orgId: 'default',
      kind: 'comment',
      subject: '跟着任务走的票',
      taskId: 'tsk_1',
    });
    // 取消任务（治理态迁移，票不该有任何反应）
    db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run('tsk_1');

    const after = tickets.getById(created.id);
    expect(after).not.toBeNull();
    expect(after?.status).toBe('open');
    expect(after?.taskId).toBe('tsk_1');
    // 票自己能独立收尾
    expect(tickets.transition(created.id, 'ended').status).toBe('ended');
  });

  it('③b task 被删除 → 票仍在，task_id 置空（ON DELETE SET NULL，不是级联删）', () => {
    const created = tickets.create({ orgId: 'default', kind: 'task', subject: '挂任务的票', taskId: 'tsk_1' });
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run('tsk_1');

    const after = tickets.getById(created.id);
    expect(after).not.toBeNull(); // 票没被级联删除
    expect(after?.taskId).toBeNull(); // 只是断开关联
    expect(after?.subject).toBe('挂任务的票');
  });

  it('④ 三种场景之后 PRAGMA foreign_key_check 无违规行（验收判据 3）', () => {
    const a = tickets.create({ orgId: 'default', kind: 'message', subject: '无任务' });
    const b = tickets.create({ orgId: 'default', kind: 'comment', subject: '挂任务', taskId: 'tsk_1' });
    db.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run('tsk_1');
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run('tsk_1');
    tickets.linkTask(b.id, null);
    tickets.transition(a.id, 'ended');

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('状态机 — 唯一执行点（验收判据 2 的拒绝路径）', () => {
  it('open → ended；ended → open（人再发消息可恢复）；cancelled 是终态', () => {
    const t = tickets.create({ orgId: 'default', kind: 'message', subject: '有生命周期' });
    expect(tickets.transition(t.id, 'ended').status).toBe('ended');
    expect(tickets.transition(t.id, 'open').status).toBe('open');
    expect(tickets.transition(t.id, 'cancelled').status).toBe('cancelled');
  });

  it('cancelled 之后任何转移都被拒，且提示里列出「终态」', () => {
    const t = tickets.create({ orgId: 'default', kind: 'message', subject: '人喊停' });
    tickets.transition(t.id, 'cancelled');
    expect(() => tickets.transition(t.id, 'open')).toThrow(/TICKET_TRANSITION_INVALID/);
    expect(() => tickets.transition(t.id, 'open')).toThrow(/cancelled 只能转到 \[∅（终态）\]/);
    expect(tickets.getById(t.id)?.status).toBe('cancelled');
  });

  it('非法状态字面量被拒（不是静默落库）', () => {
    const t = tickets.create({ orgId: 'default', kind: 'message', subject: 'x' });
    expect(() => tickets.transition(t.id, 'pending' as any)).toThrow(/TICKET_STATUS_INVALID/);
    expect(tickets.getById(t.id)?.status).toBe('open');
  });

  it('流转一个不存在的票 → 拒绝 + 可行动提示，且**不会**自动建票', () => {
    expect(() => tickets.transition('tkt_ghost', 'ended')).toThrow(/TICKET_NOT_FOUND/);
    expect(() => tickets.transition('tkt_ghost', 'ended')).toThrow(/流转不会自动建票/);
    expect(tickets.getById('tkt_ghost')).toBeNull();
  });
});

describe('写入侧校验 — 拒绝时给可行动提示', () => {
  it('空标题 / 空 kind / 无 org 都拒绝（不留半条脏数据）', () => {
    expect(() => tickets.create({ orgId: 'default', kind: 'message', subject: '   ' })).toThrow(/TICKET_SUBJECT_REQUIRED/);
    expect(() => tickets.create({ orgId: 'default', kind: '', subject: 'x' })).toThrow(/TICKET_KIND_REQUIRED/);
    expect(() => tickets.create({ orgId: '', kind: 'message', subject: 'x' })).toThrow(/TICKET_ORG_REQUIRED/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
  });

  it('挂到不存在的任务 → FK 拒绝并翻译成人话（不是 FOREIGN KEY constraint failed）', () => {
    expect(() =>
      tickets.create({ orgId: 'default', kind: 'comment', subject: 'x', taskId: 'tsk_ghost' }),
    ).toThrow(/TICKET_TASK_NOT_FOUND/);
    expect(() =>
      tickets.create({ orgId: 'default', kind: 'comment', subject: 'x', taskId: 'tsk_ghost' }),
    ).toThrow(/票不需要任务也能独立存在/);
  });

  it('linkTask 可挂可断（断开 ≠ 删票）', () => {
    const t = tickets.create({ orgId: 'default', kind: 'message', subject: '后续挂任务' });
    expect(tickets.linkTask(t.id, 'tsk_1').taskId).toBe('tsk_1');
    expect(tickets.listByTask('tsk_1')).toHaveLength(1);
    const detached = tickets.linkTask(t.id, null);
    expect(detached.taskId).toBeNull();
    expect(tickets.listByTask('tsk_1')).toHaveLength(0);
    expect(tickets.getById(t.id)).not.toBeNull();
  });
});

describe('结构断言 — 单一写入点 + 外键形态', () => {
  it('tickets.task_id 的外键是 ON DELETE SET NULL（删 task 不得级联删票的结构依据）', () => {
    const fks = db.prepare('PRAGMA foreign_key_list(tickets)').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const fk = fks.find(f => f.from === 'task_id');
    expect(fk).toBeDefined();
    expect(fk?.table).toBe('tasks');
    expect(fk?.to).toBe('id');
    expect(fk?.on_delete).toBe('SET NULL');
  });

  it('全仓只有一个票写入者：INSERT/UPDATE tickets 只出现在 ticket-store.ts', () => {
    // 为什么是源码扫描而不是行为测试：SQLite 同进程只有一个连接、没有 per-table ACL，
    // 物理上挡不住别的模块直接拼 SQL。所以把「单一写者」做成一条**会红的检查**，
    // 而不是一句注释。加第二个写者 → 本用例红。
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|mts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const text = readFileSync(p, 'utf8');
          if (/INSERT\s+INTO\s+tickets|UPDATE\s+tickets\s+SET/i.test(text)) {
            offenders.push(p.slice(REPO_ROOT.length + 1));
          }
        }
      }
    };
    walk(join(REPO_ROOT, 'packages'));
    expect(offenders).toEqual(['packages/storage/src/ticket-store.ts']);
  });
});
