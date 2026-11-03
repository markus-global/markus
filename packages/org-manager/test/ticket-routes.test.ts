/**
 * Ticket 的 HTTP 面契约：`POST /api/tickets`、`GET /api/tickets/:id`、
 * `GET /api/tasks/:id/tickets`（外加 transition / linkTask 两个入口）。
 *
 * 用**真实** SqliteRepo（不是假仓库）+ 伪造的 req/res：
 * 这里要验的不是仓储逻辑（storage 已覆盖），而是「HTTP 面有没有把该挡的挡住」——
 * 缺字段 400、票不存在 404、任务不存在 404（**不是**空数组冒充「这任务没票」）、
 * 票能脱离任务独立存在。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite } from '@markus/storage';
import {
  SqliteTicketRepo,
  SqliteThreadRepo,
  SqliteDispositionRepo,
  SqliteResourceBindingRepo,
  SqliteEventSourceRepo,
  SqliteTaskRepo,
  SqliteTriggerRepo,
  SqliteOrgRepo,
  SqliteAgentRepo,
} from '@markus/storage';
import { handleEventRoutes } from '../src/event-routes.js';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let repos: Record<string, unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'markus-ticket-routes-'));
  db = openSqlite(join(dir, 'markus.db'));
  const orgRepo = new SqliteOrgRepo(db);
  orgRepo.createOrg({ id: 'default', name: 'Default', ownerId: 'u1' });
  new SqliteAgentRepo(db).create({ id: 'agt_1', name: 'W', orgId: 'default', roleId: 'r1', roleName: 'Dev' });
  const taskRepo = new SqliteTaskRepo(db);
  await taskRepo.create({ id: 'tsk_1', orgId: 'default', title: 'T', assignedAgentId: 'agt_1', reviewerId: 'agt_2' });
  repos = {
    threadRepo: new SqliteThreadRepo(db),
    dispositionRepo: new SqliteDispositionRepo(db),
    resourceBindingRepo: new SqliteResourceBindingRepo(db),
    eventSourceRepo: new SqliteEventSourceRepo(db),
    triggerRepo: new SqliteTriggerRepo(db),
    taskRepo,
    ticketRepo: new SqliteTicketRepo(db),
  };
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

type FakeRes = ServerResponse & { status?: number; body?: any };

function fakeReq(opts: { method: string; url: string; parsed?: Record<string, unknown> }): IncomingMessage {
  return {
    method: opts.method,
    url: opts.url,
    headers: {},
    __parsedBody__: opts.parsed,
  } as unknown as IncomingMessage;
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

describe('POST /api/tickets', () => {
  it('只带 kind + subject 就能建票（**无需**任何 task）→ 201', async () => {
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/tickets', parsed: { kind: 'message', subject: '客户问发货', sourceRef: 'msg_1' } }),
      '/api/tickets',
    );
    expect(res.status).toBe(201);
    expect(res.body.ticket.taskId).toBeNull();
    expect(res.body.ticket.status).toBe('open');
    expect(res.body.ticket.orgId).toBe('default');
  });

  it('挂 task 建票 → 201 且 taskId 回读一致', async () => {
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/tickets', parsed: { kind: 'comment', subject: '验收意见', taskId: 'tsk_1' } }),
      '/api/tickets',
    );
    expect(res.status).toBe(201);
    expect(res.body.ticket.taskId).toBe('tsk_1');
  });

  it('缺 subject → 400 + 可行动提示（不是 500，也不是建一张无名票）', async () => {
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/tickets', parsed: { kind: 'message' } }),
      '/api/tickets',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('TICKET_SUBJECT_REQUIRED');
  });

  it('挂不存在的任务 → 400 + 提示票可独立存在', async () => {
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/tickets', parsed: { kind: 'comment', subject: 'x', taskId: 'tsk_ghost' } }),
      '/api/tickets',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('票不需要任务也能独立存在');
  });
});

describe('GET /api/tickets/:id', () => {
  it('存在 → 200 + 完整票', async () => {
    const created = (repos['ticketRepo'] as SqliteTicketRepo).create({
      orgId: 'default',
      kind: 'webhook',
      sourceRef: 'gh:o/r#7',
      subject: 'CI 失败',
    });
    const { res } = await call(fakeReq({ method: 'GET', url: `/api/tickets/${created.id}` }), `/api/tickets/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ticket.id).toBe(created.id);
    expect(res.body.ticket.sourceRef).toBe('gh:o/r#7');
  });

  it('不存在 → 404 + 告诉去哪找正确 id（不返回空对象）', async () => {
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/tickets/tkt_ghost' }), '/api/tickets/tkt_ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('不存在');
  });
});

describe('GET /api/tasks/:id/tickets', () => {
  it('任务存在 → 200 + 该任务的票（不含别人的票）', async () => {
    const ticketRepo = repos['ticketRepo'] as SqliteTicketRepo;
    ticketRepo.create({ orgId: 'default', kind: 'comment', subject: '挂这张任务', taskId: 'tsk_1' });
    ticketRepo.create({ orgId: 'default', kind: 'message', subject: '无任务的票' });

    const { res } = await call(fakeReq({ method: 'GET', url: '/api/tasks/tsk_1/tickets' }), '/api/tasks/tsk_1/tickets');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].subject).toBe('挂这张任务');
  });

  it('任务不存在 → 404（而不是空数组冒充「这任务没票」）', async () => {
    const { res } = await call(fakeReq({ method: 'GET', url: '/api/tasks/tsk_ghost/tickets' }), '/api/tasks/tsk_ghost/tickets');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('tsk_ghost');
  });
});

describe('流转与关联（状态机 / linkTask 的 HTTP 翻译）', () => {
  it('open → ended → 非法转移 400 且状态不变', async () => {
    const t = (repos['ticketRepo'] as SqliteTicketRepo).create({ orgId: 'default', kind: 'manual', subject: '生命周期' });

    const ended = await call(
      fakeReq({ method: 'POST', url: `/api/tickets/${t.id}/transition`, parsed: { status: 'ended' } }),
      `/api/tickets/${t.id}/transition`,
    );
    expect(ended.res.status).toBe(200);
    expect(ended.res.body.ticket.status).toBe('ended');

    (repos['ticketRepo'] as SqliteTicketRepo).transition(t.id, 'cancelled');
    const rejected = await call(
      fakeReq({ method: 'POST', url: `/api/tickets/${t.id}/transition`, parsed: { status: 'open' } }),
      `/api/tickets/${t.id}/transition`,
    );
    expect(rejected.res.status).toBe(400);
    expect(rejected.res.body.error).toContain('TICKET_TRANSITION_INVALID');
    expect((repos['ticketRepo'] as SqliteTicketRepo).getById(t.id)?.status).toBe('cancelled');
  });

  it('流转不存在的票 → 404（不自动建票）', async () => {
    const { res } = await call(
      fakeReq({ method: 'POST', url: '/api/tickets/tkt_ghost/transition', parsed: { status: 'ended' } }),
      '/api/tickets/tkt_ghost/transition',
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('TICKET_NOT_FOUND');
  });

  it('PATCH 只接受 taskId；挂任务后 listByTask 能查到', async () => {
    const t = (repos['ticketRepo'] as SqliteTicketRepo).create({ orgId: 'default', kind: 'message', subject: '后挂任务' });
    const patched = await call(
      fakeReq({ method: 'PATCH', url: `/api/tickets/${t.id}`, parsed: { taskId: 'tsk_1' } }),
      `/api/tickets/${t.id}`,
    );
    expect(patched.res.status).toBe(200);
    expect(patched.res.body.ticket.taskId).toBe('tsk_1');

    const listed = await call(fakeReq({ method: 'GET', url: '/api/tasks/tsk_1/tickets' }), '/api/tasks/tsk_1/tickets');
    expect(listed.res.body.tickets).toHaveLength(1);

    const bad = await call(fakeReq({ method: 'PATCH', url: `/api/tickets/${t.id}`, parsed: { status: 'ended' } }), `/api/tickets/${t.id}`);
    expect(bad.res.status).toBe(400);
    expect(bad.res.body.error).toContain('transition');
  });
});
