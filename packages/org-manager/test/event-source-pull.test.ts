/**
 * `POST /api/events/:prefix/batch` —— 拉取侧批量入口与位点提交（B2）。
 *
 * 用**真实** SqliteRepo + 真实 `EventIngress`（只伪造 req/res）：
 * 这里要验的不是分支逻辑，而是「位点、触发器、准入」三者在**真库**上的联动：
 *  1. 两批事件 → 第二轮只拿到新增（位点生效）；
 *  2. 消费失败（签名错）→ cursor 一动不动；
 *  3. 机器人自己的消息 → 不产生 trigger，但位点照常前进（这是「成功消费」而非失败）；
 *  4. 缺 nextCursor → 400，且不推进（防止调用方忘传把位点重置成 NULL）。
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
  SqliteTriggerRepo,
} from '@markus/storage';
import { handleEventRoutes } from '../src/event-routes.js';

const ORG = 'default';
const SECRET = 's3cret';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let repos: {
  threadRepo: SqliteThreadRepo;
  dispositionRepo: SqliteDispositionRepo;
  resourceBindingRepo: SqliteResourceBindingRepo;
  eventSourceRepo: SqliteEventSourceRepo;
  triggerRepo: SqliteTriggerRepo;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-source-pull-'));
  db = openSqlite(join(dir, 'markus.db'));
  repos = {
    threadRepo: new SqliteThreadRepo(db),
    dispositionRepo: new SqliteDispositionRepo(db),
    resourceBindingRepo: new SqliteResourceBindingRepo(db),
    eventSourceRepo: new SqliteEventSourceRepo(db),
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
  headers?: Record<string, string>;
  raw?: Buffer;
  parsed?: Record<string, unknown>;
}): IncomingMessage {
  const req: any = {
    method: opts.method,
    url: '',
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
  const handled = await handleEventRoutes({ orgId: ORG, repos: repos as any, deliver: null, now: () => 1000 }, req, res, path);
  return { handled, res };
}

const sign = (body: Buffer) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

/** 一批事件的线格式（与通用信封同构：`{events:[...], nextCursor}`） */
function batchBody(events: Array<Record<string, unknown>>, nextCursor: string | null): Buffer {
  return Buffer.from(JSON.stringify({ events, nextCursor }), 'utf8');
}

async function postBatch(prefix: string, body: Buffer, opts: { signature?: string; parsed?: Record<string, unknown> } = {}) {
  return call(
    fakeReq({
      method: 'POST',
      raw: body,
      headers: { 'x-markus-signature': opts.signature ?? sign(body) },
      parsed: opts.parsed ?? JSON.parse(body.toString('utf8')),
    }),
    `/api/events/${prefix}/batch`,
  );
}

function triggerCount(): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number }).n);
}

function registerSource(config: Record<string, unknown> = {}) {
  return repos.eventSourceRepo.upsert({ orgId: ORG, prefix: 'rss', secret: SECRET, config });
}

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ref: 'rss:competitor-a',
  kind: 'external',
  actorKind: 'human',
  actorId: 'alice',
  summary: `item ${id}`,
  body: 'x',
  ...over,
});

describe('两批事件：位点生效，第二轮只拿到新增', () => {
  it('第一批提交 p2，第二批从 p2 提交 p3；triggers 只增不重', async () => {
    const src = registerSource();

    const b1 = batchBody([ev('i1'), ev('i2')], 'p2');
    const r1 = await postBatch('rss', b1);
    expect(r1.res.status).toBe(200);
    expect(r1.res.body.status).toBe('committed');
    expect(r1.res.body.cursor).toBe('p2');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p2');
    expect(repos.eventSourceRepo.getById(src.id)!.lastPolledAt).toBe(1000);
    expect(triggerCount()).toBe(2);

    const b2 = batchBody([ev('i3')], 'p3');
    const r2 = await postBatch('rss', b2);
    expect(r2.res.status).toBe(200);
    expect(r2.res.body.status).toBe('committed');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p3');
    expect(triggerCount()).toBe(3);
  });

  it('同一事件重投：幂等命中（duplicate），不留第二行 trigger，位点仍前进', async () => {
    const src = registerSource();
    await postBatch('rss', batchBody([ev('i1')], 'p2'));
    const r = await postBatch('rss', batchBody([ev('i1')], 'p3'));
    expect(r.res.status).toBe(200);
    expect(triggerCount()).toBe(1);
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p3');
  });

  it('空批次也推进（拉取成功但这一页没有新事件）', async () => {
    const src = registerSource();
    const r = await postBatch('rss', batchBody([], 'p1'));
    expect(r.res.status).toBe(200);
    expect(r.res.body.status).toBe('committed');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p1');
    expect(triggerCount()).toBe(0);
  });
});

describe('消费失败：位点一动不动', () => {
  it('签名错 → 401，cursor 保持原值', async () => {
    const src = registerSource();
    await postBatch('rss', batchBody([ev('i1')], 'p2'));
    const before = repos.eventSourceRepo.getById(src.id)!.cursor;

    const body = batchBody([ev('i2')], 'p3');
    const r = await postBatch('rss', body, { signature: 'sha256=deadbeef' });
    expect(r.res.status).toBe(401); // 权限问题不是「稍后重试」
    expect(r.res.body.status).toBe('not-committed');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe(before);
    expect(triggerCount()).toBe(1);
  });

  it('归一化失败（缺 ref）→ 整批不提交：宁可重拉，不可漏', async () => {
    const src = registerSource();
    const body = Buffer.from(JSON.stringify({ events: [{ id: 'bad' }], nextCursor: 'p2' }), 'utf8');
    const r = await postBatch('rss', body);
    expect(r.res.status).toBe(409);
    expect(r.res.body.status).toBe('not-committed');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBeNull();
  });

  it('缺 nextCursor → 400，且不推进（防「忘传一次就把位点重置成 NULL」）', async () => {
    const src = registerSource();
    await postBatch('rss', batchBody([ev('i1')], 'p2'));
    const body = Buffer.from(JSON.stringify({ events: [ev('i2')] }), 'utf8');
    const r = await postBatch('rss', body);
    expect(r.res.status).toBe(400);
    expect(r.res.body.error).toContain('nextCursor');
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p2');
  });

  it('未登记的来源 → 404', async () => {
    const body = batchBody([ev('i1')], 'p2');
    const r = await postBatch('nope', body);
    expect(r.res.status).toBe(404);
  });
});

describe('准入：机器人自己的消息不产生 trigger（真实载荷 + 真实库）', () => {
  it('actorId 命中 selfActorIds → filtered，不产生 trigger；但这是「消费成功」，位点照常前进', async () => {
    const src = registerSource({ policy: { selfActorIds: ['markus-bot'] } });
    const body = batchBody([ev('self-1', { actorKind: 'bot', actorId: 'markus-bot' })], 'p2');
    const r = await postBatch('rss', body);

    expect(r.res.status).toBe(200);
    expect(r.res.body.status).toBe('committed');
    expect(r.res.body.results[0].status).toBe('filtered');
    expect(r.res.body.results[0].filteredBy).toBe('self');
    expect(triggerCount()).toBe(0); // 进领域之前就丢了
    expect(repos.eventSourceRepo.getById(src.id)!.cursor).toBe('p2');

    // 丢弃原因必须可查（不是静默）
    const health = repos.eventSourceRepo.getById(src.id)!.health as Record<string, unknown>;
    expect(health['lastFiltered']).toBe('self');
  });

  it('同一个来源里普通人的消息照常进入（规则不是「整源静音」）', async () => {
    registerSource({ policy: { selfActorIds: ['markus-bot'] } });
    await postBatch('rss', batchBody([ev('h1', { actorId: 'alice' })], 'p2'));
    expect(triggerCount()).toBe(1);
  });

  it('监听范围外的事件被丢弃，且 reason 说清范围', async () => {
    registerSource({ policy: { refPrefixes: ['rss:competitor-b'] } });
    const body = batchBody([ev('i1')], 'p2');
    const r = await postBatch('rss', body);
    expect(r.res.body.results[0].filteredBy).toBe('scope');
    expect(r.res.body.results[0].reason).toContain('rss:competitor-b');
    expect(triggerCount()).toBe(0);
  });

  it('webhook 单条路径同样走准入（同一套规则，不是每个入口各写一份）', async () => {
    registerSource({ policy: { selfActorIds: ['markus-bot'] } });
    const body = Buffer.from(JSON.stringify(ev('self-1', { actorKind: 'bot', actorId: 'markus-bot' })), 'utf8');
    const r = await call(
      fakeReq({ method: 'POST', raw: body, headers: { 'x-markus-signature': sign(body) } }),
      '/api/events/rss',
    );
    expect(r.res.status).toBe(200);
    expect(r.res.body.status).toBe('filtered');
    expect(triggerCount()).toBe(0);
  });
});

describe('HTTP 面：位点可观测、配置写入时校验', () => {
  it('GET /api/events/sources 暴露 cursor 与 lastPolledAt', async () => {
    registerSource();
    await postBatch('rss', batchBody([ev('i1')], 'p2'));
    const r = await call(fakeReq({ method: 'GET' }), '/api/events/sources');
    expect(r.res.status).toBe(200);
    const s = r.res.body.sources[0];
    expect(s.cursor).toBe('p2');
    expect(s.lastPolledAt).toBe(1000);
    expect(s).not.toHaveProperty('secret'); // secret 永不进响应
  });

  it('policy 写错 → 400 带 problems（不能让规则静默不生效）', async () => {
    const r = await call(
      fakeReq({ method: 'POST', parsed: { prefix: 'rss', config: { policy: { selfActorIds: 'markus-bot' } } } }),
      '/api/events/sources',
    );
    expect(r.res.status).toBe(400);
    expect(r.res.body.problems[0]).toContain('selfActorIds');
  });

  it('新建来源 cursor 为 null（推送式来源没有位点）', async () => {
    const r = await call(fakeReq({ method: 'POST', parsed: { prefix: 'gh', secret: 'x' } }), '/api/events/sources');
    expect(r.res.status).toBe(200);
    expect(r.res.body.cursor).toBeNull();
  });
});
