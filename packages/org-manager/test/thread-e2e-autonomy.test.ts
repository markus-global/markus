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
  SqliteThreadRepo, SqliteTriggerRepo, SqliteDispositionRepo, SqliteResourceBindingRepo,
} from '@markus/storage';
import { ThreadService, EventIngress, SourceRegistry, admitEvent } from '@markus/core';
import type { SourceAdapter, NormalizedEvent, DispatchTarget } from '@markus/core';
import type { Autonomy } from '@markus/shared';

const REF = 'gh:acme/widgets';
const AGENT = 'agt_content_writer';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let threads: SqliteThreadRepo;
let dispositions: SqliteDispositionRepo;
let bindings: SqliteResourceBindingRepo;
let triggers: SqliteTriggerRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-e2e-'));
  db = openSqlite(join(dir, 'markus.db'));
  threads = new SqliteThreadRepo(db);
  dispositions = new SqliteDispositionRepo(db);
  bindings = new SqliteResourceBindingRepo(db);
  triggers = new SqliteTriggerRepo(db);
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

  const ingress = new EventIngress({
    registry, service, deliver: t => delivered.push(t), triggers,
    // 无策略 = 全收（自激保护见 source-admission.test.ts）
    admission: ev => admitEvent(ev, {}),
  });

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

describe('端到端 · 事实 / 执行态 / 时间线（F2.2 的机制层判据）', () => {
  it('threads / thread_dispositions 有行，且时间线能从 triggers 派生', () => {
    const { ingress } = wire('observe');

    ingress.ingest({ prefix: 'gh', headers: {}, rawBody: Buffer.from('{}'), secret: null });
    // 时间线不再是独立表（2026-11-03 删除）：追加一件事 = 登记一条 trigger。
    triggers.insertOrGet({
      kind: 'comment',
      idempotencyKey: 'evt:e2e:1',
      actorId: 'human:owner',
      summary: '有人在 issue 下评论了',
      threadRefs: [REF],
    });

    const n = (t: string) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

    expect(n('threads')).toBeGreaterThan(0);
    expect(n('thread_dispositions')).toBeGreaterThan(0);
    // 判据不是「有一张事件表」，而是「时间线读得出来」——表删了这条仍然必须绿。
    expect(triggers.listByThreadRef(REF).map(e => e.summary)).toContain('有人在 issue 下评论了');
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

/**
 * B3 的度量：一次真实路由写下的 DB 列 `would_accept` 与读出的 TS 字段 `wouldAccept`
 * 必须语义一致；且必须**三态**——「没问过」不得伪装成「不会接」。
 *
 * 为什么必须跑真库：这条断言的全部意义在「SQLite 把布尔写成 1/0/NULL」这个边界上。
 * fake repo 直接存布尔，边界根本不存在，测出来的绿是假的。
 * 把编解码任一方向写反（`WouldAccept.encode` 反过来，或 decode 用 `!== 0`），三条用例必红。
 */
describe('B3 · would-accept 三态回环（DB 列 ↔ TS 字段，术语映射表见 docs/architecture/concept-naming.md）', () => {
  const rawWouldAccept = (triggerId: string) => {
    const row = db
      .prepare('SELECT would_accept FROM thread_dispositions WHERE trigger_id = ?')
      .get(triggerId) as { would_accept: number | null } | undefined;
    expect(row, `没有写下 trigger=${triggerId} 的处置`).toBeDefined();
    return row!.would_accept;
  };

  const readWouldAccept = (triggerId: string) =>
    dispositions.listRecent(100).find(d => d.triggerId === triggerId)?.wouldAccept;

  it('record-only（observe 档）：DB 1 ↔ TS true', () => {
    const { service } = wire('observe');
    service.route({ triggerId: 'trg_b3_observe', kind: 'comment', ref: REF, actorKind: 'human', addressing: 'ambient' });

    expect(rawWouldAccept('trg_b3_observe')).toBe(1);
    expect(readWouldAccept('trg_b3_observe')).toBe(true);
  });

  it('ignore-ended（流已结束的机器人事件）：DB 0 ↔ TS false', () => {
    const { service } = wire('observe');
    service.route({
      triggerId: 'trg_b3_ended',
      kind: 'task',
      ref: 'tsk_b3_done',
      actorKind: 'agent',
      addressing: 'ambient',
      threadEnded: true,
    });

    expect(rawWouldAccept('trg_b3_ended')).toBe(0);
    expect(readWouldAccept('trg_b3_ended')).toBe(false);
  });

  it('dispatch（人已指定处理者）：DB NULL ↔ TS null —— 没问过不等于不会接', () => {
    const { service } = wire('observe');
    service.route({
      triggerId: 'trg_b3_dispatch',
      kind: 'chat',
      ref: 'cs_b3_dispatch',
      actorKind: 'human',
      addressing: 'direct',
      directTargetAgentId: AGENT,
    });

    expect(rawWouldAccept('trg_b3_dispatch')).toBeNull();
    expect(readWouldAccept('trg_b3_dispatch')).toBeNull();
  });
});
