/**
 * `/api/events/*` 与 `/api/threads`、`/api/resources/bindings` 的入口契约。
 *
 * 用**真实** SqliteRepo（不是假仓库）+ 伪造的 req/res：
 * 这里要验的不是分支逻辑（core 里已覆盖），而是「HTTP 面有没有把该挡的挡住」——
 * 未登记来源 404、签名错 401、secret 永不出现在响应里、admin 冲突回 409。
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite } from '@markus/storage';
import {
  SqliteThreadRepo,
  SqliteDispositionRepo,
  SqliteResourceBindingRepo,
  SqliteEventSourceRepo,
  SqliteTaskRepo,
  SqliteApprovalRepo,
  SqliteTriggerRepo,
} from '@markus/storage';
import { handleEventRoutes } from '../src/event-routes.js';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let repos: {
  threadRepo: SqliteThreadRepo;
  dispositionRepo: SqliteDispositionRepo;
  resourceBindingRepo: SqliteResourceBindingRepo;
  eventSourceRepo: SqliteEventSourceRepo;
  taskRepo?: SqliteTaskRepo;
  approvalRepo?: SqliteApprovalRepo;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-event-routes-'));
  db = openSqlite(join(dir, 'markus.db'));
  repos = {
    threadRepo: new SqliteThreadRepo(db),
    dispositionRepo: new SqliteDispositionRepo(db),
    resourceBindingRepo: new SqliteResourceBindingRepo(db),
    eventSourceRepo: new SqliteEventSourceRepo(db),
    // 时间线不再是独立表：它从 triggerRepo 派生（见 CONCEPT-CLARITY §8）。
    // 触发器登记：`IngressDeps.triggers` 是必填（见 event-ingress.ts 的说明），
    // 夹具缺它 → 运行时 `insertOrGet` 空指针，事件根本无法入链。
    triggerRepo: new SqliteTriggerRepo(db),
  };
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

type FakeRes = ServerResponse & { status?: number; body?: any };

function fakeReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  raw?: Buffer;
  parsed?: Record<string, unknown>;
}): IncomingMessage {
  const req: any = {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    __rawBody__: opts.raw,
    __parsedBody__: opts.parsed,
  };
  return req as IncomingMessage;
}

function fakeRes(): FakeRes {
  const res: any = {
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(payload?: string) {
      res.body = payload ? JSON.parse(payload) : undefined;
    },
  };
  return res as FakeRes;
}

async function call(req: IncomingMessage, path: string) {
  const res = fakeRes();
  const handled = await handleEventRoutes(
    { orgId: 'default', repos: repos as any, deliver: null, now: () => 1000 },
    req,
    res,
    path,
  );
  return { handled, res };
}

const sign = (body: Buffer, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('/api/events/:prefix', () => {
  it('未登记的来源 → 404，不解析载荷', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'e1', ref: 'gh:o/r' }));
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/events/gh', raw: body, headers: { 'x-markus-signature': 'sha256=00' } }),
      '/api/events/gh',
    );
    expect(res.status).toBe(404);
  });

  it('签名错误 → 401，且不留处置记录', async () => {
    repos.eventSourceRepo.upsert({ orgId: 'default', prefix: 'gh', secret: 'right' });
    const body = Buffer.from(JSON.stringify({ id: 'e1', ref: 'gh:o/r' }));
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/events/gh', raw: body, headers: { 'x-markus-signature': sign(body, 'wrong') } }),
      '/api/events/gh',
    );
    expect(res.status).toBe(401);
    expect(repos.dispositionRepo.listRecent()).toHaveLength(0);
  });

  it('签名正确 → 200，并留下一条 needs-assessment 处置', async () => {
    repos.eventSourceRepo.upsert({ orgId: 'default', prefix: 'gh', secret: 's3cret' });
    const body = Buffer.from(JSON.stringify({ id: 'e1', ref: 'gh:o/r', summary: 'push' }));
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/events/gh', raw: body, headers: { 'x-markus-signature': sign(body, 's3cret') } }),
      '/api/events/gh',
    );
    expect(res.status).toBe(200);
    expect(res.body!.status).toBe('ignored');
    const rows = repos.dispositionRepo.listRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toContain('needs-assessment');
  });

  it('同一事件重投 → duplicate，只有一行审计', async () => {
    repos.eventSourceRepo.upsert({ orgId: 'default', prefix: 'gh', secret: 's3cret' });
    const body = Buffer.from(JSON.stringify({ id: 'e1', ref: 'gh:o/r' }));
    const mk = () =>
      fakeReq({ method: 'POST', url: '/api/events/gh', raw: body, headers: { 'x-markus-signature': sign(body, 's3cret') } });
    await call(mk(), '/api/events/gh');
    const second = await call(mk(), '/api/events/gh');
    expect(second.res.body!.status).toBe('duplicate');
    expect(repos.dispositionRepo.listRecent()).toHaveLength(1);
  });

  it('原始字节缺失 → 400（不许拿解析后的对象去算签名）', async () => {
    repos.eventSourceRepo.upsert({ orgId: 'default', prefix: 'gh', secret: 's3cret' });
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/events/gh', headers: { 'x-markus-signature': 'sha256=00' } }),
      '/api/events/gh',
    );
    expect(res.status).toBe(400);
  });
});

describe('/api/events/sources — secret 永不外泄', () => {
  it('POST /api/events/sources 不被 webhook 前缀分支劫持（实测踩到）', async () => {
    // bug：webhook 分支用 `path.startsWith('/api/events/')`，若排在 sources 之前命中，
    // 会把 "sources" 当成平台前缀去查 → 404「未登记的来源 sources」。
    // 结果：来源永远登记不进，整个外部事件入口不可用。
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/events/sources', parsed: { prefix: 'gh', secret: 'x' } }),
      '/api/events/sources',
    );
    expect(res.status).toBe(200);
    expect(res.body.prefix).toBe('gh');
    expect(res.body.hasSecret).toBe(true);
    // 落库且能被 webhook 分支查到（闭环：登记完就能收事件）
    expect(repos.eventSourceRepo.getByPrefix('default', 'gh')).toBeTruthy();
  });

  it('列表只回 hasSecret，不回 secret 明文', async () => {
    repos.eventSourceRepo.upsert({ orgId: 'default', prefix: 'gh', secret: 'very-secret' });
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/events/sources' }), '/api/events/sources');
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('very-secret');
    expect(res.body.sources[0].hasSecret).toBe(true);
  });
});

describe('/api/threads 与绑定', () => {
  it('GET /api/threads 返回已知流', async () => {
    repos.threadRepo.upsert('tsk_1');
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
  });

  it('第二个 admin 绑定 → 409 且带可行动提示', async () => {
    const first = await call(
      fakeReq({
        method: 'POST',
        url: '/api/resources/bindings',
        parsed: { holderKind: 'agent', holderId: 'agt_a', resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:owner' },
      }),
      '/api/resources/bindings',
    );
    expect(first.res.status).toBe(200);

    const second = await call(
      fakeReq({
        method: 'POST',
        url: '/api/resources/bindings',
        parsed: { holderKind: 'agent', holderId: 'agt_b', resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:owner' },
      }),
      '/api/resources/bindings',
    );
    expect(second.res.status).toBe(409);
    expect(second.res.body.reason).toContain('agt_a');
  });

  it('未知路径返回 false，交还给主路由链', async () => {
    const { handled } = await call(fakeReq({ method: 'GET', url: '/api/threads/x/y/z' }), '/api/threads/x/y/z');
    expect(handled).toBe(false);
  });
});

/**
 * stage 派生：**用真实 repo + 真实表**。
 *
 * 这组用例存在的唯一理由：第一版把 taskRepo 的单条读取写成 `get?.()` / `getById?.()`，
 * 两个方法都不存在，而可选调用让错误静默变成 undefined —— stage 永远按「无任务」算，
 * 不报错、测试全绿。真方法名是 `findById`。现在名字写错，这里必红。
 */
describe('/api/threads — stage 派生（真实 repo）', () => {
  const insertTask = (id: string, status: string) =>
    // tasks 有 NOT NULL 的 assigned_agent_id / reviewer_agent_id，且对 agents 有外键；
    // 这组用例验的是 stage 派生，不是外键约束，所以关掉 FK 后插入最小行。
    db
      .prepare(
        `INSERT INTO tasks (id, org_id, title, description, status, priority, assigned_agent_id, reviewer_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'default', 't', 'd', status, 'medium', 'agt_test', 'agt_test');

  beforeEach(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    repos.taskRepo = new SqliteTaskRepo(db);
    repos.approvalRepo = new SqliteApprovalRepo(db);
  });

  it('任务在 review → person:review（方法名写错会退化，此处必红）', async () => {
    repos.threadRepo.upsert('tsk_t1');
    insertTask('tsk_t1', 'review');
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads[0];
    expect(t.taskStatus).toBe('review');
    expect(t.stage).toBe('person:review');
    expect(t.stageBasis).toBe('partial');
    expect(t.missingFacts).toEqual(['openQuestion']);
  });

  it('任务 blocked → person:blocked；completed → idle', async () => {
    repos.threadRepo.upsert('tsk_t2');
    insertTask('tsk_t2', 'blocked');
    repos.threadRepo.upsert('tsk_t3');
    insertTask('tsk_t3', 'completed');
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const byRef = Object.fromEntries(res.body.threads.map((t: any) => [t.ref, t]));
    expect(byRef['tsk_t2'].stage).toBe('person:blocked');
    expect(byRef['tsk_t3'].stage).toBe('idle');
  });

  it('能精确归属到这条流的待批 → person:approval', async () => {
    repos.threadRepo.upsert('tsk_t4');
    insertTask('tsk_t4', 'in_progress');
    db.prepare(
      `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('apr_1', 'agt_x', 'X', 'action', 'sig', 'd', JSON.stringify({ taskId: 'tsk_t4' }), 'pending', new Date().toISOString());

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads.find((x: any) => x.ref === 'tsk_t4');
    expect(t.stage).toBe('person:approval');
  });

  it('无法归属到这条流的待批只给提示，不改 stage（误报会训练人忽略信号）', async () => {
    repos.threadRepo.upsert('tsk_t5');
    insertTask('tsk_t5', 'in_progress');
    repos.threadRepo.upsert('tsk_t6');
    // 用 blocked（会进概览）而不是 in_progress：聚合模型下“在跑的任务”根本不该出现在概览里，
    // 用 in_progress 验的是旧模型（thread 自己带 owner）的行为。
    insertTask('tsk_t6', 'blocked');
    // 「这条流归谁」现由 task.assignedAgentId 承载（threads.owner_* 三列已删，不再是事实源）
    db.prepare('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?').run('agt_y', 'tsk_t6');
    // 审批属于别的任务，但 agent 是 agt_y
    db.prepare(
      `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('apr_2', 'agt_y', 'Y', 'action', 'sig2', 'd', JSON.stringify({ taskId: 'tsk_other' }), 'pending', new Date().toISOString());

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads.find((x: any) => x.ref === 'tsk_t6');
    expect(t.stage).toBe('person:blocked'); // 不被不相干待批篡改成 person:approval
    expect(t.approvalHint).toContain('无法确认属于这条流');
  });

  it('没有 approvalRepo 时 pendingApproval 必须列进 missingFacts', async () => {
    repos.approvalRepo = undefined;
    repos.threadRepo.upsert('tsk_t7');
    insertTask('tsk_t7', 'in_progress');
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads.find((x: any) => x.ref === 'tsk_t7');
    expect(t.missingFacts).toContain('pendingApproval');
  });
});

/**
 * 存量视角：**不预置任何 thread**。
 *
 * 上面的用例每条都先 `threadRepo.upsert(...)`，于是"生产库里 threads 表是空的"
 * 这个真实条件从未被表达过 —— 8 阶段全绿、概览永远空，正是这样发生的
 * （复审文档 §9.2/§9.3）。
 *
 * 这一组把那个盲点钉住：只写业务表（tasks / approvals），threads 表保持空，
 * 概览仍必须回答"谁卡在谁那儿"。改回读空表，这里必红。
 */
describe('/api/threads — 存量视角（threads 表为空）', () => {
  const insertTask = (id: string, status: string, assigned = 'agt_test') =>
    db
      .prepare(
        `INSERT INTO tasks (id, org_id, title, description, status, priority, assigned_agent_id, reviewer_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'default', `任务 ${id}`, 'd', status, 'medium', assigned, assigned);

  const insertApproval = (id: string, details: Record<string, unknown>, agentId = 'agt_x') =>
    db
      .prepare(
        `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agentId, 'X', 'action', `审批 ${id}`, 'd', JSON.stringify(details), 'pending', new Date().toISOString());

  beforeEach(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    repos.taskRepo = new SqliteTaskRepo(db);
    repos.approvalRepo = new SqliteApprovalRepo(db);
  });

  it('threads 表为空 + 一条 review 任务 → 概览仍能看到它（H1 证伪点）', async () => {
    expect(repos.threadRepo.list(10)).toHaveLength(0);
    insertTask('tsk_live1', 'review');

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads.find((x: any) => x.ref === 'tsk_live1');
    expect(t).toBeDefined();
    expect(t.stage).toBe('person:review');
    expect(t.taskStatus).toBe('review');
    expect(t.title).toBe('任务 tsk_live1');
  });

  it('blocked / failed 也进概览（等人解），completed 不进', async () => {
    insertTask('tsk_live2', 'blocked');
    insertTask('tsk_live3', 'failed');
    insertTask('tsk_live4', 'completed');

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const refs = res.body.threads.map((x: any) => x.ref);
    expect(refs).toContain('tsk_live2');
    expect(refs).toContain('tsk_live3');
    expect(refs).not.toContain('tsk_live4');
  });

  it('同一个对象恰好出现一次（任务 + 归属到它的待批 → 不重复计）', async () => {
    insertTask('tsk_live5', 'in_progress');
    insertApproval('apr_live1', { taskId: 'tsk_live5' });

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const hits = res.body.threads.filter((x: any) => x.ref === 'tsk_live5');
    expect(hits).toHaveLength(1);
    expect(hits[0].stage).toBe('person:approval');
  });

  it('孤儿审批（无归属任务）自成一行，且 stage = person:approval', async () => {
    insertApproval('apr_live2', {}, 'agt_z');

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads' }), '/api/threads');
    const t = res.body.threads.find((x: any) => x.ref === 'apr_apr_live2');
    expect(t).toBeDefined();
    expect(t.stage).toBe('person:approval');
    expect(t.ownerAgent).toBe('agt_z');
  });
});

/**
 * S6 时间线：**两种身份都能取到同一条流的事件**。
 *
 * 这组用例存在的理由（实测踩到，2026-11-02）：
 * `thread_events.thread_id` 存的是内部 id（`thr_xxx`），但 `/api/threads` 给业务行
 * 返回的 `id` 是业务 ref（`tsk_xxx` / `a2a_xxx`）。Thread 视图直接拿 `row.id` 去
 * 查 `WHERE thread_id = ?` → **任务流永远 0 条**，时间线一片空白，且不报错。
 *
 * 真实数据佐证：同一个流按 `thr_` 查到 19 条，按 `tsk_` 查到 0 条。
 * 所以读取端必须做一次身份解析（id 或 ref 都能落到同一条流），
 * 而不是让前端猜该用哪个。
 */
describe('/api/threads/:key/events — 身份解析（id 或 ref 等价）', () => {
  it('按 ref 查能取到事件（这是 Thread 视图的真实调用形态）', async () => {
    (repos.threadRepo.upsert('tsk_evt1') as any).thread;
    new SqliteTriggerRepo(db).insertOrGet({
      kind: 'comment',
      idempotencyKey: 'evt:tsk_evt1:1',
      summary: '有人在任务上评论了',
      threadRefs: ['tsk_evt1'],
    });

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/threads/tsk_evt1/events' }), '/api/threads/tsk_evt1/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].summary).toContain('评论');
    // 对外形状是前端 `ThreadEventAPI`，不是仓储的 TriggerRow：
    // 时间线换数据源（表 → 派生）时，这条断言是前端的保险。
    expect(res.body.events[0]).toMatchObject({
      kind: 'comment',
      threadId: 'tsk_evt1',
      summary: '有人在任务上评论了',
    });
    expect(typeof res.body.events[0].createdAt).toBe('number');
  });

  it('按内部 id 查同样取得到（两种身份等价，不能只认一种）', async () => {
    const thread = (repos.threadRepo.upsert('tsk_evt2') as any).thread;
    new SqliteTriggerRepo(db).insertOrGet({
      kind: 'chat',
      idempotencyKey: 'evt:tsk_evt2:1',
      summary: '聊了两句',
      threadRefs: ['tsk_evt2'],
    });

    const { res } = await call(
      fakeReq({ method: 'GET', url: `/api/threads/${thread.id}/events` }),
      `/api/threads/${thread.id}/events`,
    );
    expect(res.body.events).toHaveLength(1);
  });

  it('不存在的键 → 空数组而不是 404（「没有事件」是正常状态）', async () => {
    const { res } = await call(
      fakeReq({ method: 'GET', url: '/api/threads/tsk_ghost/events' }),
      '/api/threads/tsk_ghost/events',
    );
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});
