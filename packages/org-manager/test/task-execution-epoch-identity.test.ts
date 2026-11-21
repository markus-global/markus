/**
 * C10-0B §3.1 / §4-5 —— 执行纪元的身份在**入队前**由唯一执行点回答，不再是「入队后补写 DB 列」。
 *
 * 判据（真实 SQLite，零 mock 的持久化层）：
 *   ① `TaskService.ensureExecutionEpoch(taskId, round)` 返回 `WORK_UNIT_REF.task()` 造的 ref，
 *      并把该纪元实体 ensure 到 `running`（执行开始就必须在跑，不是 idle）；
 *   ② 用这个 ref 入队 → 内存 item 带身份**且** DB 行在 INSERT 时就有身份；
 *   ③ 身份来自 INSERT，**没有**入队后的 `UPDATE ... work_unit_ref`（触发器计数为 0）——
 *      这正是被删掉的 `linkMailboxItem` 的形态。
 *
 * 基线上 ① 立刻红：base 只有 `linkExecutionEpoch(itemId, taskId, round)`，没有返回值。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  closeSqlite,
  SqliteWorkUnitRepo,
  SqliteMailboxRepo,
} from '../../storage/src/sqlite-storage.js';
import { WorkUnitService } from '../src/work-unit-service.js';
import { TaskService } from '../src/task-service.js';
import { WORK_UNIT_REF, type MailboxItem } from '@markus/shared';

let tempDir: string;
let db: DatabaseSync;
let units: WorkUnitService;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10-0b-epoch-'));
  db = openSqlite(join(tempDir, 'data.db')) as unknown as DatabaseSync;
  db.prepare('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)')
    .run('org_1', 'Epoch Org', 'owner_1');
  for (const id of ['agt_a', 'agt_b']) {
    db.prepare('INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, 'org_1', 'role_worker', 'Worker');
  }
  units = new WorkUnitService({ repo: new SqliteWorkUnitRepo(db) });
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTask(svc: TaskService) {
  return svc.createTask({
    orgId: 'org_1',
    title: 'epoch identity probe',
    description: 'probe',
    priority: 'medium',
    assignedAgentId: 'agt_a',
    reviewerId: 'agt_b',
    createdBy: 'agt_b',
    creatorRole: 'manager',
    requirementId: 'req_probe',
  } as never);
}

/** 生产代码里那个「一个执行纪元 = 一个 WorkUnit」的唯一执行点。 */
function ensureEpoch(svc: TaskService, taskId: string, round: number): string {
  return (svc as unknown as {
    ensureExecutionEpoch(taskId: string, round: number): string;
  }).ensureExecutionEpoch(taskId, round);
}

/** 与 cli/start.ts 的 wireMailboxPersistence 同形的最小持久层适配器。 */
function makePersistence(repo: SqliteMailboxRepo) {
  return {
    save: (item: MailboxItem, dedupKey?: string) => {
      const { responsePromise: _rp, ...metadata } = (item.metadata ?? {}) as Record<string, unknown>;
      return repo.save({
        id: item.id, agentId: item.agentId, sourceType: item.sourceType, priority: item.priority,
        status: item.status, payload: item.payload as unknown as Record<string, unknown>,
        metadata, queuedAt: item.queuedAt, dedupKey,
        envelope: item.envelope ? JSON.stringify(item.envelope) : null,
        messageId: item.envelope?.messageId ?? null,
        signalClass: item.envelope?.signalClass ?? null,
        intent: item.envelope?.intent ?? null,
        workUnitRef: item.workUnitRef ?? null,
      });
    },
    updateStatus: (itemId: string, status: string, extra?: Record<string, unknown>) =>
      repo.updateStatus(itemId, status as never, extra as never),
  };
}

describe('C10-0B §3.1：执行纪元身份在入队前确定', () => {
  it('ensureExecutionEpoch 返回 ref，并把该纪元实体迁到 running', () => {
    const svc = new TaskService();
    svc.setWorkUnitService(units);
    const task = makeTask(svc);

    const ref = ensureEpoch(svc, task.id, 2);
    expect(ref).toBe(WORK_UNIT_REF.task(task.id, 2));
    expect(ref).toBe(`task_${task.id}_r2`);

    const row = new SqliteWorkUnitRepo(db).getByRef(ref);
    expect(row, '返回的 ref 必须能查到实体（否则就是悬空引用）').toBeDefined();
    expect(row!.status, '执行开始 = running（不是 idle 预建态）').toBe('running');
  });

  it('入队即带身份：内存 item 与 DB 行同源，且没有「入队后补写」', () => {
    const svc = new TaskService();
    svc.setWorkUnitService(units);
    const task = makeTask(svc);

    // 探针：任何对 mailbox_items.work_unit_ref 的 UPDATE 都会被记下来。
    // 它的存在就是为了证明「身份来自 INSERT，不是后补」。
    db.exec(`
      CREATE TABLE wu_ref_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT);
      CREATE TRIGGER trg_wu_ref_update AFTER UPDATE OF work_unit_ref ON mailbox_items
      BEGIN INSERT INTO wu_ref_updates (item_id) VALUES (NEW.id); END;
    `);

    const ref = ensureEpoch(svc, task.id, 2);
    const mailRepo = new SqliteMailboxRepo(db);
    const mailbox = new AgentMailbox('agt_a', new EventBus(), makePersistence(mailRepo) as never);

    const item = mailbox.enqueue(
      'task_status_update',
      { summary: 'Task: epoch', content: 'go', taskId: task.id, extra: { executionRound: 2 } } as never,
      {
        intent: 'trigger_execution',
        round: 2,
        workUnitRef: ref,
        refOrigin: 'entity',
        metadata: { taskId: task.id },
      },
    );

    // ① 内存（台账读的那一份）
    expect(item.workUnitRef).toBe(ref);
    // ② DB 行：入队那一刻就有
    expect(mailRepo.getById(item.id)!.workUnitRef).toBe(ref);
    // ③ 没有第二个写者补写这一列
    const updates = db.prepare('SELECT COUNT(*) AS n FROM wu_ref_updates').get() as { n: number };
    expect(updates.n, '身份必须来自 INSERT —— 入队后再 UPDATE 这一列就是第二个建造点').toBe(0);
  });
});

// `require` 在 ESM 下不可用，这里用惰性 import 的同步替代：直接从 core 源码导入。
import { AgentMailbox } from '../../core/src/mailbox.js';
import { EventBus } from '../../core/src/events.js';

function requireCoreMailbox(): typeof AgentMailbox {
  return AgentMailbox;
}

function newMailboxEventBus(): EventBus {
  return new EventBus();
}