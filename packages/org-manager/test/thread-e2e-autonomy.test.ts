/**
 * 端到端：一条真实事件从入口进来，走完 「路由 → 四档判定 → 处置留痕 → 时间线」。
 *
 * 为什么这组测试必须用**真 SQLite**而不是 fake repo：
 *   F2.2 要回答的问题是「这三张表真的会有行吗」。fake repo 的 `record()` 是手写的
 *   数组 push，它永远成功 —— 于是「表会不会有行」这个问题在夹具上根本不存在，
 *   测出来的绿是假的。真库才会暴露 UNIQUE / NOT NULL / 外键这些真实的写入门槛。
 *
 * 为什么这组测试现在才存在：生产库里 event_sources / bindings / subscriptions /
 *   triggers / dispositions **全是 0 行** —— 这条链路从未被真实走过。
 *   所以 F2.2 的「处置表为空」不是丢了记录，是功能还没被使用。
 *   本文件证明的是**机制能通**；生产是否已有真实流量，是另一个事实，不该混为一谈。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite, closeSqlite,
  SqliteThreadRepo, SqliteThreadEventRepo, SqliteDispositionRepo, SqliteResourceBindingRepo,
} from '@markus/storage';
import { ThreadService, EventIngress, SourceRegistry } from '@markus/core';
import type { SourceAdapter, NormalizedEvent, DispatchTarget } from '@markus/core';
import type { Autonomy } from '@markus/shared';

const REF = 'gh:acme/widgets';
const AGENT = 'agt_content_writer';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let threads: SqliteThreadRepo;
let dispositions: SqliteDispositionRepo;
let bindings: SqliteResourceBindingRepo;
let events: SqliteThreadEventRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-e2e-'));
  db = openSqlite(join(dir, 'markus.db'));
  threads = new SqliteThreadRepo(db);
  dispositions = new SqliteDispositionRepo(db);
  bindings = new SqliteResourceBindingRepo(db);
  events = new SqliteThreadEventRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

/** 一个无签名的测试适配器：只做「归一化出一条事件」这件事。 */
function makeAdapter(): SourceAdapter {
  return {
    prefix: 'gh',
    verify: () => true,
    normalize: (): NormalizedEvent[] => [{
      kind: 'comment',
      idempotencyKey: 'gh:comment:1',
      ref: REF,
      actorKind: 'human',
      actorId: 'human:owner',
      addressing: 'broadcast',
      summary: '有人在 issue 下评论了',
      body: '这条评论需要跟进',
      receivedAt: Date.now(),
    }],
  };
}

/** 装配真实链路：绑定 → 订阅 → 路由 → ingress。 */
function wire(autonomy: Autonomy) {
  const bound = bindings.bind({
    holder: { kind: 'agent', id: AGENT },
    resource: REF,
    scope: 'draft',
    autonomy,
    grantedBy: 'human:owner',
  });
  expect(bound.ok).toBe(true);

  const { thread } = threads.upsert(REF);
  threads.subscribe(thread.id, thread.id, AGENT, 'own');

  const delivered: DispatchTarget[] = [];
  const service = new ThreadService({
    threads,
    dispositions,
    onWake: () => {},
    // 与生产同一份接线（org-manager/event-routes.ts 的 serviceOf）
    autonomyFor: (ref, agentId) => bindings.findByHolder('agent', agentId, ref)?.autonomy ?? null,
  });

  const registry = new SourceRegistry();
  registry.register(makeAdapter());

  // 触发器登记的假实现：验「事件进来时有没有登记」与幂等（与生产同一条路径）
  const triggers = {
    rows: [] as Array<Record<string, unknown>>,
    insertOrGet(t: Record<string, unknown>) {
      const key = String(t['idempotencyKey']);
      const found = triggers.rows.find(r => r['idempotencyKey'] === key);
      if (found) return { trigger: found, created: false };
      const rec = { id: `trg_${triggers.rows.length + 1}`, ...t };
      triggers.rows.push(rec);
      return { trigger: rec, created: true };
    },
  };

  const ingress = new EventIngress({ registry, service, deliver: t => delivered.push(t), triggers });

  return { service, ingress, delivered, thread, triggers };
}

const countDispositions = () =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM thread_dispositions').get() as { n: number }).n);

describe('端到端 · observe 档：不叫醒，但留下可回看的判断', () => {
  it('事件进来后：没有投递，处置表有 1 行且 would_accept=1', () => {
    const { ingress, delivered } = wire('observe');

    const result = ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });

    expect(result.status).toBe('ignored');       // 没投递 → 状态必须诚实地说「没投」
    expect(delivered).toHaveLength(0);          // 关键：observe 不动手

    expect(countDispositions()).toBe(1);        // 但判断留下了
    const row = db.prepare('SELECT * FROM thread_dispositions').get() as Record<string, unknown>;
    expect(row['would_accept']).toBe(1);        // 信息量：若为 auto 他会接
    expect(String(row['reason'])).toContain('observe');
  });
});

describe('端到端 · auto 档：叫醒，不逐次登记', () => {
  it('事件进来后：投递给负责人，处置表不新增（直通本身是证据）', () => {
    const { ingress, delivered } = wire('auto');

    const result = ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });

    expect(result.status).toBe('direct-through');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.agentId).toBe(AGENT);
    expect(countDispositions()).toBe(0);
  });
});

describe('端到端 · off 档：既不叫醒，也不留判断', () => {
  it('没做的决定没有可记的内容', () => {
    const { ingress, delivered } = wire('off');

    const result = ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });

    expect(result.status).toBe('ignored');
    expect(delivered).toHaveLength(0);
    expect(countDispositions()).toBe(0);
  });
});

describe('端到端 · 三张表都留痕（F2.2 的机制层判据）', () => {
  it('threads / thread_dispositions / thread_events 在同一轮里都有行', () => {
    const { ingress, thread } = wire('observe');

    ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });
    // 时间线是独立的读模型：路由完之后追加一条「发生了什么」
    events.append({ threadId: thread.id, kind: 'comment', actor: 'human:owner', summary: '有人在 issue 下评论了' });

    const n = (t: string) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

    expect(n('threads')).toBeGreaterThan(0);
    expect(n('thread_dispositions')).toBeGreaterThan(0);
    expect(n('thread_events')).toBeGreaterThan(0);
  });

  it('幂等：同一个 trigger 重投 3 次，处置仍然只有 1 行', () => {
    // 真库的 UNIQUE(trigger_id, thread_id) 才测得到这件事；fake repo 测不到。
    const { ingress } = wire('observe');
    for (let i = 0; i < 3; i++) {
      ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });
    }
    expect(countDispositions()).toBe(1);
  });
});
