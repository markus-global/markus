/**
 * 第七刀 C7-A —— 三条日常链路的**真实数据库探针**。
 *
 * 判据（计划 §5.2 / 卡面）：chat / task / a2a 各有一条
 * `mailbox_items.work_unit_ref IS NOT NULL` 的行，且 `work_units` 里能查到对应实体。
 *
 * 这里跑的是**真实 SQLite 文件 + 真实生产者代码**（`APIServer.persistChatTurn` /
 * `TaskService.createTask` / `AgentDelivery.deliver`），不是对 mock 的断言：
 * 唯一被替换的是「与 WU 无关的外围依赖」（orgService / ws / agent 运行时），
 * 因为起完整实例需要 LLM 凭据与端口；持久化这一层是零 mock 的。
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
  SqliteChatSessionRepo,
} from '../../storage/src/sqlite-storage.js';
import { WorkUnitService } from '../src/work-unit-service.js';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';
import { AgentDelivery } from '../src/agent-delivery.js';

let tempDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c7a-probe-'));
  dbPath = join(tempDir, 'data.db');
  db = openSqlite(dbPath) as unknown as DatabaseSync;
  // `chat_sessions.agent_id` 有 FK：探针需要真实的父行，否则建会话就会被
  // FOREIGN KEY 拒绝（那会把「会话建不起来」误读成「WU 没建」）。
  db.prepare('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)')
    .run('org_1', 'Probe Org', 'owner_1');
  for (const id of ['agt_a', 'agt_b', 'agt_x', 'agt_y', 'agt_p', 'agt_q']) {
    db.prepare('INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, 'org_1', 'role_worker', 'Worker');
  }
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function service(): WorkUnitService {
  return new WorkUnitService({ repo: new SqliteWorkUnitRepo(db) });
}

/**
 * 投递端口与 `APIServer.delivery` 同形：**不是**把 `WorkUnitService` 直接当端口传。
 *
 * C7-B 给端口加了一个读方法（`turnWorkUnitRef`，跨团队委派的父链来源），
 * 服务本身没有它 —— 这也是「端口只声明能力、不泄漏服务形状」的实证。
 */
function deliveryPort(units: WorkUnitService, currentRef: string | null = null) {
  return {
    ensure: (seed: Parameters<WorkUnitService['ensure']>[0]) => units.ensure(seed),
    turnWorkUnitRef: () => currentRef,
    linkMailboxItem: (itemId: string | null | undefined, ref: string | null) =>
      units.linkMailboxItem(itemId, ref),
    transition: (ref: string, to: string, opts?: unknown) =>
      units.tryTransition(ref, to as never, opts as never),
  };
}

function mailboxRowsWithWu(): Array<{ id: string; work_unit_ref: string }> {
  return db
    .prepare('SELECT id, work_unit_ref FROM mailbox_items WHERE work_unit_ref IS NOT NULL')
    .all() as Array<{ id: string; work_unit_ref: string }>;
}

describe('C7-A 三条链路：mailbox_items.work_unit_ref 首次有值', () => {
  it('chat：persistChatTurn 一轮 ⇒ 1 个 WU + 该 mailbox 行挂上 ref', async () => {
    const units = service();
    const mailbox = new SqliteMailboxRepo(db);
    const chatRepo = new SqliteChatSessionRepo(db);

    // 人类消息这一行是入口入队产生的（这里用真 repo 落一行，模拟入口）
    mailbox.save({
      id: 'mbx_chat_1',
      agentId: 'agt_a',
      sourceType: 'human_chat',
      priority: 0,
      status: 'completed',
      payload: { summary: 'hi', content: 'hi' },
      metadata: {},
      queuedAt: '2026-11-13T00:00:00.000Z',
    } as never);

    const server = Object.create(APIServer.prototype) as APIServer;
    (server as unknown as Record<string, unknown>)['storage'] = {
      chatSessionRepo: chatRepo,
      workUnitRepo: new SqliteWorkUnitRepo(db),
    };
    (server as unknown as Record<string, unknown>)['_workUnits'] = units;

    await (server as unknown as {
      persistChatTurn: (
        agentId: string, user: string, reply: string, senderId?: string,
        tokens?: number, meta?: unknown, itemId?: string,
      ) => Promise<void>;
    }).persistChatTurn('agt_a', 'hi', 'hello', undefined, 3, undefined, 'mbx_chat_1');

    const rows = mailboxRowsWithWu();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.work_unit_ref.startsWith('session:')).toBe(true);

    const wu = new SqliteWorkUnitRepo(db).getByRef(rows[0]!.work_unit_ref)!;
    expect(wu.agentId).toBe('agt_a');
    // 回合已收口（回复已落库）= 这条活不再在跑 → `running → idle`。
    // 新建时默认 `running`，`persistChatTurn` 在落库后立刻收口，所以这里读到 `idle`。
    expect(wu.status).toBe('idle');
    expect(wu.contextRef).toBeTruthy();
    // 收口必须**留痕**：不留痕的话「这一轮什么时候结束的」只能从消息时间戳猜。
    // `status_transitions.entity_id` 记的是 WU 行的数字 id，不是 ref（见
    // SqliteWorkUnitRepo.transition 里的 `entityId: current.id`）。
    const transitions = db.prepare(
      "SELECT reason FROM status_transitions WHERE entity_type='work_unit' AND entity_id=? ORDER BY id DESC LIMIT 1",
    ).all(String(wu.id)) as Array<{ reason: string | null }>;
    expect(transitions[0]?.reason).toBe('chat_turn_settled');
    // 一轮 = 一个 WU：第二轮必须产生新 ref，不能复用
    await (server as unknown as {
      persistChatTurn: (agentId: string, u: string, r: string) => Promise<void>;
    }).persistChatTurn('agt_a', 'again', 'reply');
    expect(new SqliteWorkUnitRepo(db).listByAgent('agt_a')).toHaveLength(2);
  });

  it('task：createTask ⇒ 1 个 WU，ref 复用 task_<id>_r<round> 既有格式', () => {
    const units = service();
    const taskService = new TaskService();
    taskService.setWorkUnitService(units);

    const task = taskService.createTask({
      orgId: 'org_1',
      title: 'C7-A probe task',
      description: 'probe',
      priority: 'medium',
      assignedAgentId: 'agt_a',
      reviewerId: 'agt_b',
      createdBy: 'agt_b',
      creatorRole: 'manager',
      requirementId: 'req_probe',
    } as never);

    const rows = new SqliteWorkUnitRepo(db).listByAgent('agt_a');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(`task_${task.id}_r${task.executionRound}`);
    expect(rows[0]!.taskId).toBe(task.id);
  });

  it('a2a：deliver ⇒ 1 个 WU（接收方），mailbox 行挂上 ref', () => {
    const units = service();
    const mailbox = new SqliteMailboxRepo(db);
    let seq = 0;
    const delivery = new AgentDelivery({
      getAgent: (agentId: string) => ({
        config: { name: agentId },
        enqueueToMailbox: (sourceType: string, payload: unknown, options: unknown) => {
          const item = {
            id: `mbx_a2a_${++seq}`,
            agentId,
            sourceType,
            priority: 2,
            status: 'queued',
            payload,
            metadata: {},
            queuedAt: '2026-11-13T00:00:00.000Z',
            workUnitRef: (options as { workUnitRef?: string } | undefined)?.workUnitRef ?? null,
          };
          mailbox.save(item as never);
          return item;
        },
      }),
      workUnits: deliveryPort(units),
    } as never);

    const outcome = delivery.deliver({
      orgId: 'org_1',
      channelKey: 'dm:a2a:x:y',
      fromAgentId: 'agt_x',
      fromAgentName: 'X',
      content: 'hello',
      targetAgentIds: ['agt_y'],
      chainId: 'chain_1',
      depth: 0,
    });

    expect(outcome.state).toBe('queued');
    const rows = mailboxRowsWithWu();
    expect(rows).toHaveLength(1);
    // C8-A：身份是「这件事」，不是「这次投递」——`deliveryId` 不再进 ref。
    // 发送方没有回合 WU 时，实体的正确回答是一次对话本身（`channel:`），
    // 所以 ref 是 `a2a:channel:<channelKey>`；同一对话的多次投递共享它。
    expect(rows[0]!.work_unit_ref).toBe('a2a:channel:dm:a2a:x:y');
    // `work_units.agent_id` 记的是**发送方**（干活的那个），不是接收方。
    // 一次投递给 N 个接收方 → N 个 item 共享同一个 ref，这是定义不是缺陷。
    expect(new SqliteWorkUnitRepo(db).getByRef(rows[0]!.work_unit_ref)!.agentId).toBe('agt_x');
  });

  it('a2a：发送方有本轮 WU 时，投递产生的子 WU 落 parent_id（跨团队委派的父子链）', () => {
    const units = service();
    const parent = units.ensure({
      ref: 'task_tsk_parent_r1',
      agentId: 'agt_x',
      status: 'running',
      contextRef: 'sess_parent_x',
    })!;
    const delivery = new AgentDelivery({
      getAgent: (agentId: string) => ({
        config: { name: agentId },
        enqueueToMailbox: (_sourceType: string, _payload: unknown) => ({
          id: `mbx_a2a_parent_${agentId}`,
          agentId,
          workUnitRef: null,
        }),
      }),
      workUnits: deliveryPort(units, 'task_tsk_parent_r1'),
    } as never);

    const outcome = delivery.deliver({
      orgId: 'org_1',
      channelKey: 'dm:a2a:x:y',
      fromAgentId: 'agt_x',
      fromAgentName: 'X',
      content: 'delegated work',
      targetAgentIds: ['agt_y'],
      chainId: 'chain_2',
      depth: 0,
    });

    const repo = new SqliteWorkUnitRepo(db);
    // C8-A：发送方本轮 WU 属于 `tsk_parent` → 实体是那个任务，ref 不带投递 id。
    const child = repo.getByRef('a2a:task:tsk_parent')!;
    // 父链是结构字段，不是从 chainId / 文本推断出来的。
    expect(child.parentId).toBe(parent.id);
  });

  it('三条链路合起来：三种 ref 前缀各自出现，实体全部可查（终极读数）', async () => {
    const units = service();
    const mailbox = new SqliteMailboxRepo(db);
    const chatRepo = new SqliteChatSessionRepo(db);

    mailbox.save({
      id: 'mbx_chat_x', agentId: 'agt_a', sourceType: 'human_chat', priority: 0,
      status: 'completed', payload: { summary: 's', content: 'c' }, metadata: {},
      queuedAt: '2026-11-13T00:00:00.000Z',
    } as never);
    const server = Object.create(APIServer.prototype) as APIServer;
    (server as unknown as Record<string, unknown>)['storage'] = {
      chatSessionRepo: chatRepo, workUnitRepo: new SqliteWorkUnitRepo(db),
    };
    (server as unknown as Record<string, unknown>)['_workUnits'] = units;
    await (server as unknown as {
      persistChatTurn: (a: string, u: string, r: string, s?: string, t?: number, m?: unknown, i?: string) => Promise<void>;
    }).persistChatTurn('agt_a', 'hi', 'yo', undefined, 0, undefined, 'mbx_chat_x');

    const taskService = new TaskService();
    taskService.setWorkUnitService(units);
    taskService.createTask({
      orgId: 'org_1', title: 't', description: 'd', priority: 'medium',
      assignedAgentId: 'agt_a', reviewerId: 'agt_b', createdBy: 'agt_b', creatorRole: 'manager',
      requirementId: 'req_probe',
    } as never);

    let seq = 100;
    const delivery = new AgentDelivery({
      getAgent: (agentId: string) => ({
        config: { name: agentId },
        enqueueToMailbox: (sourceType: string, payload: unknown) => {
          const item = {
            id: `mbx_a2a_${++seq}`, agentId, sourceType, priority: 2, status: 'queued',
            payload, metadata: {}, queuedAt: '2026-11-13T00:00:00.000Z', workUnitRef: null,
          };
          mailbox.save(item as never);
          return item;
        },
      }),
      workUnits: deliveryPort(units),
    } as never);
    delivery.deliver({
      orgId: 'org_1', channelKey: 'dm:a2a:p:q', fromAgentId: 'agt_p', fromAgentName: 'P',
      content: 'm', targetAgentIds: ['agt_q'], chainId: 'c1', depth: 0,
    });

    const refs = mailboxRowsWithWu().map((r) => r.work_unit_ref);
    expect(refs.some((r) => r.startsWith('session:'))).toBe(true);
    expect(refs.some((r) => r.startsWith('a2a:'))).toBe(true);
    // task 链路的 mailbox 行由任务分发入队产生（不在本探针范围），但实体必须存在
    expect(new SqliteWorkUnitRepo(db).listByAgent('agt_a').some((r) => r.ref.startsWith('task_'))).toBe(true);
  });

  it('C8-A 验收判据（真实 DB）：同一实体两次投递 ⇒ 2 行、1 个 ref，且 ref 里没有投递 id', () => {
    // 这是卡面上写死的验收读数，在**真实 SQLite** 上执行，而不是靠 mock 数调用次数：
    //   `COUNT(DISTINCT work_unit_ref)` 必须明显小于消息数，且 ref 不含 `dlv_`。
    const units = service();
    const parent = units.ensure({
      ref: 'task_tsk_accept_r1',
      agentId: 'agt_x',
      status: 'running',
      contextRef: 'sess_accept_x',
    })!;
    const mailbox = new SqliteMailboxRepo(db);

    let seq = 900;
    const delivery = new AgentDelivery({
      getAgent: (agentId: string) => ({
        config: { name: agentId },
        enqueueToMailbox: (
          sourceType: string,
          payload: unknown,
          options?: { workUnitRef?: string | null },
        ) => {
          const item = {
            id: `mbx_acc_${++seq}`,
            agentId,
            sourceType,
            priority: 2,
            status: 'queued',
            payload,
            metadata: {},
            queuedAt: '2026-11-14T00:00:00.000Z',
            // 真实链路的 enqueue 会把 WorkUnit 身份带在 item 上（C8-A）
            workUnitRef: options?.workUnitRef ?? null,
          };
          mailbox.save(item as never);
          return item;
        },
      }),
      workUnits: deliveryPort(units, 'task_tsk_accept_r1'),
    } as never);

    for (const content of ['m1', 'm2']) {
      delivery.deliver({
        orgId: 'org_1', channelKey: 'dm:a2a:x:y', fromAgentId: 'agt_x', fromAgentName: 'X',
        content, targetAgentIds: ['agt_y'], chainId: 'chain_acc', depth: 0,
      });
    }

    const rows = db
      .prepare("SELECT work_unit_ref FROM mailbox_items WHERE id LIKE 'mbx_acc_%'")
      .all() as Array<{ work_unit_ref: string }>;
    expect(rows).toHaveLength(2);
    // 判据 1：行数 2，ref 数 1（旧实现这里是 2，因为 deliveryId 编进了身份）
    expect(new Set(rows.map((r) => r.work_unit_ref)).size).toBe(1);
    // 判据 2：ref 是实体，不含投递 id
    expect(rows[0]!.work_unit_ref).toBe('a2a:task:tsk_accept');
    expect(rows[0]!.work_unit_ref.includes('dlv_')).toBe(false);
    // 父子链仍是结构字段（C7-B 语义未回退）
    const entity = new SqliteWorkUnitRepo(db).getByRef('a2a:task:tsk_accept')!;
    expect(entity.parentId).toBe(parent.id);
    expect(entity.agentId).toBe('agt_x');
  });
});

/**
 * C7 尾巴（2026-11-14）—— task 链路「一个执行纪元 = 一个 WorkUnit」的实体必须真的存在。
 *
 * 缺陷：`createTask()` 只给 round 1 建实体，而 `linkMailboxItem()` 在两个执行入口
 * **无条件**写 `task_<id>_r<round>`。`mailbox_items.work_unit_ref` 是纯 TEXT 列（无 FK），
 * 所以 round ≥2 的引用指向不存在的实体也不会有任何报错 —— resolve(ref) 返 null →
 * 锁键退化、该回合发起的委派 `parent_id` 落 NULL。不崩，但结构事实是假的。
 *
 * 判据只认事实：引用写进 mailbox 行**且** `getByRef()` 查得到实体。
 */
describe('C7 尾巴：task 链路每个执行纪元都必须有实体（round ≥2 不再悬空）', () => {
  function seedMailboxItem(id: string, agentId: string): void {
    new SqliteMailboxRepo(db).save({
      id,
      agentId,
      sourceType: 'task_status_update',
      priority: 2,
      status: 'queued',
      payload: { taskId: 'tsk_probe' },
      metadata: {},
      queuedAt: '2026-11-14T00:00:00.000Z',
      workUnitRef: null,
    } as never);
  }

  function refOfMailboxRow(id: string): string | null {
    const row = db.prepare('SELECT work_unit_ref FROM mailbox_items WHERE id = ?').get(id) as
      | { work_unit_ref: string | null }
      | undefined;
    return row?.work_unit_ref ?? null;
  }

  /** 直接驱动生产代码里那个「先实体、后引用」的唯一执行点。 */
  function linkEpoch(svc: TaskService, itemId: string, taskId: string, round: number): void {
    (svc as unknown as { linkExecutionEpoch: (i: string, t: string, r: number) => void })
      .linkExecutionEpoch(itemId, taskId, round);
  }

  function makeTask(svc: TaskService) {
    return svc.createTask({
      orgId: 'org_1',
      title: 'epoch probe',
      description: 'probe',
      priority: 'medium',
      assignedAgentId: 'agt_a',
      reviewerId: 'agt_b',
      createdBy: 'agt_b',
      creatorRole: 'manager',
      requirementId: 'req_probe',
    } as never);
  }

  it('round 1：引用与实体同时成立', () => {
    const units = service();
    const svc = new TaskService();
    svc.setWorkUnitService(units);
    const task = makeTask(svc);

    seedMailboxItem('mbx_epoch_r1', 'agt_a');
    linkEpoch(svc, 'mbx_epoch_r1', task.id, 1);

    const ref = refOfMailboxRow('mbx_epoch_r1');
    expect(ref).toBe(`task_${task.id}_r1`);
    expect(new SqliteWorkUnitRepo(db).getByRef(ref!)).not.toBeNull();
  });

  it('round ≥2（打回返工）：引用必须落到真实存在的实体上', () => {
    const units = service();
    const svc = new TaskService();
    svc.setWorkUnitService(units);
    const task = makeTask(svc); // createTask 建的是 round 1 的实体

    seedMailboxItem('mbx_epoch_r2', 'agt_a');
    linkEpoch(svc, 'mbx_epoch_r2', task.id, 2);

    const ref = refOfMailboxRow('mbx_epoch_r2');
    expect(ref).toBe(`task_${task.id}_r2`);
    // 这条断言就是缺陷的判据：旧实现只写引用，实体查不到 → 红。
    expect(new SqliteWorkUnitRepo(db).getByRef(ref!)).not.toBeNull();
    // 两个执行纪元 = 两个实体，不复用同一行。
    expect(new SqliteWorkUnitRepo(db).listByAgent('agt_a')).toHaveLength(2);
  });

  it('零悬空：mailbox 侧所有 work_unit_ref 都能 JOIN 到实体', () => {
    const units = service();
    const svc = new TaskService();
    svc.setWorkUnitService(units);
    const task = makeTask(svc);

    for (const [id, round] of [['mbx_zero_r1', 1], ['mbx_zero_r2', 2], ['mbx_zero_r3', 3]] as const) {
      seedMailboxItem(id, 'agt_a');
      linkEpoch(svc, id, task.id, round);
    }

    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mailbox_items m
         LEFT JOIN work_units w ON w.ref = m.work_unit_ref
         WHERE m.work_unit_ref IS NOT NULL AND w.id IS NULL`,
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);
  });
});