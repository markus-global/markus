/**
 * 卡4 · 通路 B：**订阅命中 → 直通**，用真实链路取证。
 *
 * 为什么这组测试和 `thread-e2e-autonomy.test.ts` 不重复：
 *   那个文件验的是「四档语义」（off/observe/auto/trusted 各自的行为），
 *   本文件验的是**通路本身**——「订阅是怎么产生的」与「命中订阅之后 verdict 是什么」。
 *   它盯的是两个具体的事故面，两者都在生产上真实发生过：
 *
 *   1. **两个写者**：订阅曾经有两条创建路径（仓储的 `ensureSubscription` +
 *      `resource_bind` 工具里的 `deps.subscribe` 注入）。两个 agent 绑定同一资源时
 *      因为主键相同而看不出问题；但 **team 绑定**上两处语义相反（工具替调用者
 *      agent 订阅，仓储认为团队没指定 agent、不订阅），于是「同一个动作，
 *      走工具面会收事件、走 API 路径不会」。现在唯一写者是仓储。
 *   2. **verdict 无人验证**：四档测试只断言 `result.status`（'ignored' /
 *      'direct-through'），而 `ignored` 同时覆盖「observe 档」与「off 档」，
 *      **无法区分「直通了但被档位拦下」和「根本没直通」**。本文件直接断言
 *      `route()` 返回的 `verdict === 'direct-through'`。
 *
 * 用真 SQLite 而不是 fake repo 的理由同 `thread-e2e-autonomy.test.ts`：
 * 「订阅/处置这两张表会不会有行」这个问题在夹具上根本不存在，测出来的绿是假的。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite, closeSqlite,
  SqliteThreadRepo, SqliteTriggerRepo, SqliteDispositionRepo, SqliteResourceBindingRepo,
} from '@markus/storage';
import {
  ThreadService, EventIngress, SourceRegistry, createGenericWebhookAdapter, admitEvent,
} from '@markus/core';
import type { DispatchTarget } from '@markus/core';
import type { Autonomy } from '@markus/shared';

const REF = 'probe:acme/widgets';
const AGENT = 'agt_card4_owner';
const SECRET = 'card4-test-secret';

let dir: string;
let db: ReturnType<typeof openSqlite>;
let threads: SqliteThreadRepo;
let dispositions: SqliteDispositionRepo;
let bindings: SqliteResourceBindingRepo;
let triggerRepo: SqliteTriggerRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-card4-'));
  db = openSqlite(join(dir, 'markus.db'));
  threads = new SqliteThreadRepo(db);
  dispositions = new SqliteDispositionRepo(db);
  bindings = new SqliteResourceBindingRepo(db);
  triggerRepo = new SqliteTriggerRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

const countSubs = () =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM thread_subscriptions').get() as { n: number }).n);
const countDispositions = () =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM thread_dispositions').get() as { n: number }).n);

/**
 * 装真实链路：绑定（→ 订阅）→ 真实 HMAC 适配器 → 真实 ingress。
 *
 * 注意这里**没有**任何 `threads.subscribe(...)` —— 订阅必须由 `bind()` 一处产生。
 * 测试里手动补一行，等于把「两个写者」这个 bug 在测试里复刻一遍并显得无害。
 */
function wire(autonomy: Autonomy) {
  const bound = bindings.bind({
    holder: { kind: 'agent', id: AGENT },
    resource: REF,
    scope: 'draft',
    autonomy,
    grantedBy: 'human:owner',
  });
  expect(bound.ok).toBe(true);
  if (!bound.ok) throw new Error('unreachable');

  const delivered: DispatchTarget[] = [];
  const service = new ThreadService({
    threads,
    dispositions,
    onWake: () => {},
    // 与生产同一份接线（`org-manager/src/event-routes.ts` 的 `serviceOf`）
    autonomyFor: (ref, agentId) => bindings.findByHolder('agent', agentId, ref)?.autonomy ?? null,
  });

  const registry = new SourceRegistry();
  registry.register(createGenericWebhookAdapter('probe'));

  const ingress = new EventIngress({
    registry,
    service,
    deliver: (t: DispatchTarget) => delivered.push(t),
    triggers: triggerRepo,
    admission: ev => admitEvent(ev, {}),
  });

  return { bound, service, ingress, delivered };
}

/** 真实 HMAC：对**原始字节**签名（不能用解析后重新序列化，字段顺序会变）。 */
function sign(rawBody: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function envelope(id: string, over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      id,
      ref: REF,
      kind: 'external',
      actorKind: 'bot',
      actorId: 'probe:acme-bot',
      addressing: 'ambient',
      summary: '一条来自 probe 来源的真实事件',
      body: '',
      ...over,
    }),
    'utf8',
  );
}

function post(body: Buffer, signature: string) {
  return (wireIngress: ReturnType<typeof wire>) =>
    wireIngress.ingress.ingest({
      prefix: 'probe',
      headers: { 'x-markus-signature': `sha256=${signature}` },
      rawBody: body,
      secret: SECRET,
    });
}

describe('通路 B · 订阅由 bind() 一处产生（唯一写者）', () => {
  it('只调 bind() 就会建订阅，且 subscribed 如实为 true', () => {
    const { bound } = wire('observe');

    if (!bound.ok) throw new Error('unreachable');
    expect(bound.subscribed).toBe(true);
    expect(countSubs()).toBe(1);

    const row = db
      .prepare('SELECT thread_id, ticket_id, agent_id, purpose FROM thread_subscriptions')
      .get() as Record<string, unknown>;
    expect(row['agent_id']).toBe(AGENT);
    expect(row['purpose']).toBe('own'); // 只有 purpose='own' 才算 hasOwner
  });

  it('team 绑定：不建订阅，且如实回报 subscribed=false（不替团队编一个 agent）', () => {
    const bound = bindings.bind({
      holder: { kind: 'team', id: 'team_content' },
      resource: REF,
      scope: 'read',
      grantedBy: 'human:owner',
    });

    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error('unreachable');
    expect(bound.subscribed).toBe(false);
    expect(countSubs()).toBe(0);
  });
});

describe('通路 B · 真实 HMAC 事件命中订阅 → verdict 必须是 direct-through', () => {
  it('auto 档：ingress 报 direct-through，投递 1 次、处置 0 行', () => {
    const w = wire('auto');
    const boundThread = threads.getByRef(REF)!;
    const body = envelope('evt-auto-1');

    const res = post(body, sign(body))(w);

    expect(res.status).toBe('direct-through');
    expect(res.threadId).toBe(boundThread.id); // 事件落到订阅的那条流

    // 投递到负责人
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.agentId).toBe(AGENT);

    // 直通 = 流本身就是证据，不需要再写一条「我判断过了」
    expect(countDispositions()).toBe(0);
  });

  it('off 档：仍然是 direct-through，但既不投递也不写处置（没做的决定没有可记的内容）', () => {
    const w = wire('off');
    const body = envelope('evt-off-1');

    const res = post(body, sign(body))(w);

    expect(res.status).toBe('ignored');
    expect(w.delivered).toHaveLength(0);
    expect(countDispositions()).toBe(0); // 关键：直通不等于写处置
  });

  it('observe 档：direct-through 之后被档位拦下 —— 写 1 行 would_accept=1 的判断', () => {
    const w = wire('observe');
    const body = envelope('evt-observe-1');

    const res = post(body, sign(body))(w);

    expect(res.status).toBe('ignored');
    expect(w.delivered).toHaveLength(0); // observe 不动手
    expect(countDispositions()).toBe(1);

    const row = db.prepare('SELECT * FROM thread_dispositions').get() as Record<string, unknown>;
    expect(row['would_accept']).toBe(1); // 信息量：若为 auto 他会接
  });
});

describe('通路 B · route() 的 verdict 是显式可判定的（不是从 status 猜的）', () => {
  it('订阅命中时 verdict 字面等于 direct-through，且 decision 为 null（不产生处置）', () => {
    const w = wire('off'); // 选 off：任何处置行都只能是这个 bug 的证据
    const thread = threads.getByRef(REF)!;

    const result = w.service.route({
      triggerId: 'trg_direct_1',
      kind: 'external',
      ref: REF,
      actorKind: 'bot',
      addressing: 'ambient',
    });

    expect(result.verdict).toBe('direct-through');
    expect(result.decision).toBeNull();
    expect(result.threadId).toBe(thread.id);
    expect(result.ticketId).toBe(thread.id); // v1 里 ticket 就是 thread 本身
    expect(countDispositions()).toBe(0);
  });

  it('没有订阅 → 不走直通（证明这条测试真的绑在「订阅」上，而不是恒绿）', () => {
    const w = wire('off');
    // 把订阅删掉：同一个 ref、同一个 agent，只是没人订阅了
    const thread = threads.getByRef(REF)!;
    threads.unsubscribe(thread.id, thread.id);
    expect(countSubs()).toBe(0);

    const result = w.service.route({
      triggerId: 'trg_no_sub_1',
      kind: 'external',
      ref: REF,
      actorKind: 'bot',
      addressing: 'ambient',
    });

    expect(result.verdict).not.toBe('direct-through');
  });
});

describe('通路 B · 真实签名的门禁与幂等', () => {
  it('签名错误 → unauthorized，且不写触发流水（验签在解析之前）', () => {
    const w = wire('auto');
    const body = envelope('evt-badsig-1');

    const res = post(body, sign(body, 'wrong-secret'))(w);

    expect(res.status).toBe('unauthorized');
    expect(w.delivered).toHaveLength(0);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number }).n)).toBe(0);
  });

  it('同一 id 重投 → duplicate，处置不叠加（webhook 重试是正常情况）', () => {
    const w = wire('observe');
    const body = envelope('evt-dup-1');

    const first = post(body, sign(body))(w);
    const second = post(body, sign(body))(w);

    expect(first.status).toBe('ignored');
    expect(second.status).toBe('duplicate');
    expect(countDispositions()).toBe(1);
  });
});
