/**
 * C10-B —— ExternalSourceService：唯一 ingest 点（计划 §B / 卡内契约 D2/D4/D5/D6/D7）。
 *
 * 判据：
 *   · ref 由唯一构造器 WORK_UNIT_REF.external 建，入队即带身份（refOrigin entity）；
 *   · 未验证外部信号 intent 封顶 deliver（信号级天花板，唯一消费点）；
 *   · kill switch **现读 DB**（第二个写者直接 UPDATE enabled 也立刻生效 = 无内存缓存）；
 *   · 同 messageId 重投 → duplicate_message_id 退信回声，queued 信号行不增（真库）；
 *   · 无绑定 → no_active_target 退信回声进源主 mailbox，身份保留（C10-0A）；
 *   · 路由跟绑定走（不跟源主走）；伪造 From 结构上仍是 external/unverified；
 *   · RSS 单 timer + cursor 水位入库（重启不重扫全量）。
 *
 * base（37c817aa）上必须红：模块不存在。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as storage from '../../storage/src/sqlite-storage.js';
import { AgentMailbox, EventBus } from '@markus/core';
import { WORK_UNIT_REF } from '@markus/shared';
import { WorkUnitService } from '../src/work-unit-service.js';
import { ExternalSourceService } from '../src/external-source-service.js';

const ORG = 'acme';
const OWNER = 'agt_owner';
const OTHER = 'agt_other';
const ADDR = 'hook.acme@markus.global';

const RSS_SAMPLE = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>One</title><link>https://example.com/1</link><guid>g1</guid><description>body1</description><pubDate>Sat, 22 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Two</title><link>https://example.com/2</link><guid>g2</guid><description>body2</description><pubDate>Sat, 22 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

let tempDir: string;
let db: ReturnType<typeof storage.openSqlite>;
let sources: storage.SqliteExternalSourceRepo;
let bindings: storage.SqliteAddressBindingRepo;
let mbRepo: storage.SqliteMailboxRepo;
let service: ExternalSourceService;
let boxes: Map<string, AgentMailbox>;

function persistenceFor(repo: storage.SqliteMailboxRepo) {
  const row = (item: any, status: string, messageId: string | null, dropReason: string | null) => ({
    id: item.id, agentId: item.agentId, sourceType: item.sourceType,
    priority: item.priority, status,
    payload: item.payload as Record<string, unknown>,
    metadata: (item.metadata ?? {}) as Record<string, unknown>,
    queuedAt: item.queuedAt, dedupKey: undefined,
    envelope: item.envelope ? JSON.stringify(item.envelope) : null,
    messageId,
    signalClass: item.envelope?.signalClass ?? null,
    intent: item.envelope?.intent ?? null,
    dropReason, bounceTarget: item.bounceTarget ?? null,
    workUnitRef: item.workUnitRef ?? null,
  });
  return {
    save: (item: any, dedupKey?: string) => repo.save({ ...row(item, item.status, item.envelope?.messageId ?? null, item.dropReason ?? null), dedupKey }),
    updateStatus: (id: string, status: string, extra?: Record<string, unknown>) => repo.updateStatus(id, status, extra),
    findByMessageId: (aid: string, mid: string) => repo.findByMessageId(aid, mid),
    saveBounced: (item: any, dropReason: string) => { repo.save(row(item, 'bounced', null, dropReason)); },
    getStatus: (id: string) => repo.getStatus(id),
  };
}

beforeEach(() => {
  storage.closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-extsvc-'));
  db = storage.openSqlite(join(tempDir, 'data.db'));
  db.prepare("INSERT INTO organizations (id, name, owner_id, org_slug) VALUES (?, ?, 'usr_o', ?)").run(ORG, ORG, ORG);
  for (const aid of [OWNER, OTHER]) {
    db.prepare("INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, 'role_w', 'worker')").run(aid, aid, ORG);
  }
  sources = new storage.SqliteExternalSourceRepo(db);
  bindings = new storage.SqliteAddressBindingRepo(db);
  mbRepo = new storage.SqliteMailboxRepo(db);
  const workUnits = new WorkUnitService({ repo: new storage.SqliteWorkUnitRepo(db) });
  boxes = new Map();
  const mailboxOf = (aid: string) => {
    let mb = boxes.get(aid);
    if (!mb) {
      mb = new AgentMailbox(aid, new EventBus(), persistenceFor(mbRepo) as any);
      mb.setAddressLookup({ findActive: (addr: string) => bindings.findActive(addr) });
      mb.setIdentityPort({ ensureIdentity: (seed: any) => workUnits.ensure(seed) !== null });
      boxes.set(aid, mb);
    }
    return mb;
  };
  service = new ExternalSourceService({
    sources,
    findActive: (addr: string) => bindings.findActive(addr),
    mailboxOf,
    fetchText: async () => RSS_SAMPLE,
    now: () => new Date('2026-11-22T15:00:00Z'),
  });
});

afterEach(() => {
  service.stopPolling();
  storage.closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function registerWebhook(agentId = OWNER) {
  const out = sources.register({ orgId: ORG, agentId, kind: 'webhook', address: ADDR });
  expect(out.status).toBe('registered');
  return out.source!.id;
}
const event = (over: Record<string, unknown> = {}) => ({
  messageId: 'wh-1', from: 'sender@external.example', subject: 'Hello',
  content: 'body', externalThreadRef: 'thread-9', ...over,
});
const queuedSignals = () =>
  (db.prepare("SELECT COUNT(*) c FROM mailbox_items WHERE source_type='external_signal' AND status='queued'").get() as { c: number }).c;

describe('C10-B：唯一 ingest 点', () => {
  it('webhook 真事件落库：external_signal/queued + 信封 from external/unverified + ref 唯一构造 + work_units 行', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    const out = service.ingest(srcId, event());
    expect(out.status).toBe('ingested');
    const ref = WORK_UNIT_REF.external(srcId, 'wh-1');
    expect((out as any).workUnitRef).toBe(ref);
    const row = db.prepare("SELECT * FROM mailbox_items WHERE id=?").get((out as any).itemId) as any;
    expect(row.source_type).toBe('external_signal');
    expect(row.status).toBe('queued');
    expect(row.work_unit_ref).toBe(ref);
    const env = JSON.parse(row.envelope);
    expect(env.from).toEqual({ kind: 'external', address: 'sender@external.example' });
    expect(env.fromVerified).toBe(false);
    expect(env.intent).toBe('deliver');
    expect(env.externalThreadRef).toBe('thread-9');
    expect(db.prepare('SELECT ref FROM work_units WHERE ref=?').get(ref)).toBeDefined();
  });

  it('同 messageId 重投幂等：duplicate_message_id 回声，queued 信号行与 work_units 行不增（真库）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    expect(service.ingest(srcId, event()).status).toBe('ingested');
    const second = service.ingest(srcId, event());
    expect(second.status).toBe('bounced');
    expect((second as any).dropReason).toBe('duplicate_message_id');
    expect(queuedSignals()).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM work_units').get() as { c: number }).c).toBe(1);
  });

  it('信号级天花板：trigger_execution / action_required 一律封顶 deliver（唯一消费点）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    for (const intent of ['trigger_execution', 'action_required'] as const) {
      const out = service.ingest(srcId, event({ messageId: `m-${intent}` }), { intent });
      expect(out.status).toBe('ingested');
      const row = db.prepare('SELECT envelope FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
      expect(JSON.parse(row.envelope).intent, intent).toBe('deliver');
    }
  });

  it('kill switch 现读 DB：第二写者直接 UPDATE enabled=0 立刻生效（无内存缓存），恢复后照常', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    db.prepare('UPDATE external_sources SET enabled=0 WHERE id=?').run(srcId);
    expect(service.ingest(srcId, event()).status).toBe('disabled');
    expect(queuedSignals()).toBe(0);
    db.prepare('UPDATE external_sources SET enabled=1 WHERE id=?').run(srcId);
    expect(service.ingest(srcId, event()).status).toBe('ingested');
  });

  it('地址无绑定 → no_active_target 退信回声进源主 mailbox，身份保留（C10-0A）', () => {
    const srcId = registerWebhook();
    const out = service.ingest(srcId, event());
    expect(out.status).toBe('bounced');
    expect((out as any).dropReason).toBe('no_active_target');
    const row = db.prepare('SELECT * FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
    expect(row.agent_id).toBe(OWNER);
    // FSM 终态：bounced → catch_all（归集），原因列保留 —— 断言归集态 + 原因，不只断 bounced。
    expect(row.status).toBe('catch_all');
    expect(row.drop_reason).toBe('no_active_target');
    expect(row.work_unit_ref).toBe(WORK_UNIT_REF.external(srcId, 'wh-1'));
  });

  it('路由跟绑定走：地址绑给 OTHER，信号进 OTHER 的 mailbox（不是源主）', () => {
    bindings.bind({ orgId: ORG, agentId: OTHER, address: ADDR });
    const srcId = registerWebhook(OWNER);
    const out = service.ingest(srcId, event());
    expect(out.status).toBe('ingested');
    expect((db.prepare('SELECT agent_id FROM mailbox_items WHERE id=?').get((out as any).itemId) as any).agent_id).toBe(OTHER);
  });

  it('未知源 → unknown_source（不猜、不静默）', () => {
    expect(service.ingest('src_nope', event()).status).toBe('unknown_source');
  });

  it('messageId 缺省 = 平台 id：两次投递都是新事件（无假幂等），ref 各不相同', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    const a = service.ingest(srcId, event({ messageId: null }));
    const b = service.ingest(srcId, event({ messageId: null }));
    expect(a.status).toBe('ingested');
    expect(b.status).toBe('ingested');
    expect((a as any).workUnitRef).not.toBe((b as any).workUnitRef);
    expect(queuedSignals()).toBe(2);
  });

  it('伪造 From：长得像内部地址也结构上 external/unverified（字符串相似度永不决定身份）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    const out = service.ingest(srcId, event({ from: 'cto.acme@markus.global' }));
    const row = db.prepare('SELECT envelope FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
    const env = JSON.parse(row.envelope);
    expect(env.from.kind).toBe('external');
    expect(env.fromVerified).toBe(false);
  });
});

// ─── C10-B Part G：CRUD + 唯一归属裁决点（工具面与 API 路由共用同一处判决）──────
//
// 这些用例锁的是「归属只有一个写者」：注册/开关的**唯一**裁决点在
// ExternalSourceService（org-manager）。把门去掉（见提交说明里的伪证记录），
// 这里的 forbidden 用例必须变红 —— 否则它们只是装饰。
describe('C10-B：registerSource 归属门（地址必须 active 绑给自己）', () => {
  it('地址已 active 绑给自己 ⇒ registered + source.id，且行归属本次调用者', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });

    const out = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR, config: { token: 's3cret' } });

    expect(out.status).toBe('registered');
    const row = sources.get(out.source!.id)!;
    expect(row).toMatchObject({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR, enabled: true });
    expect(JSON.parse(row.config)).toEqual({ token: 's3cret' });
  });

  it('地址 active 绑给**别的** agent ⇒ forbidden(address_not_bound_to_you)，且不落库', () => {
    bindings.bind({ orgId: ORG, agentId: OTHER, address: ADDR });

    const out = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR });

    expect(out.status).toBe('forbidden');
    expect(out.reason).toBe('address_not_bound_to_you');
    expect(out.hint).toContain('bind_address');
    expect(out.source).toBeUndefined();
    // 「被拒绝」必须是真的没写：不存在一条挂在 OWNER 名下的源。
    expect(sources.listByOrg(ORG)).toHaveLength(0);
  });

  it('地址没有任何 active 绑定 ⇒ forbidden（不允许「先注册、后绑定」的自助绕过）', () => {
    const out = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'rss', address: ADDR, config: { feedUrl: 'https://example.com/f' } });

    expect(out.status).toBe('forbidden');
    expect(out.reason).toBe('address_not_bound_to_you');
    expect(sources.listByOrg(ORG)).toHaveLength(0);
  });

  it('撤销后的绑定不算 active ⇒ forbidden（读的是结构事实，不是历史行）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    bindings.revoke({ orgId: ORG, agentId: OWNER, address: ADDR });

    expect(service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR }).status).toBe('forbidden');
  });
});

describe('C10-B：listSources 只列自己的源', () => {
  it('org + agent 双限定：别人的源、别的 org 视角都看不到', () => {
    const mine = sources.register({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR }).source!.id;
    const theirs = sources.register({ orgId: ORG, agentId: OTHER, kind: 'rss', address: 'feed.acme@markus.global', config: { feedUrl: 'https://example.com/f' } }).source!.id;

    const out = service.listSources(ORG, OWNER);

    expect(out.map(s => s.id)).toEqual([mine]);
    expect(out[0]).toEqual({ id: mine, kind: 'webhook', address: ADDR, enabled: true });
    expect(out.map(s => s.id)).not.toContain(theirs);
    // 同一 agent 在别的 org 视角下也不是「自己的」：org 段参与裁决，不做单字段推断。
    expect(service.listSources('other_org', OWNER)).toEqual([]);
  });
});

describe('C10-B：setSourceEnabled 持久 kill switch（唯一归属裁决点）', () => {
  it('自己的源 ⇒ toggled + enabled 列持久化（重启保持，不靠内存缓存）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR }).source!.id;

    const off = service.setSourceEnabled({ orgId: ORG, agentId: OWNER, sourceId: srcId, enabled: false });

    expect(off).toEqual({ status: 'toggled', enabled: false });
    // 真库：不是回执自说自话 —— 读回同一行。
    expect(sources.get(srcId)!.enabled).toBe(false);

    const on = service.setSourceEnabled({ orgId: ORG, agentId: OWNER, sourceId: srcId, enabled: true });
    expect(on).toEqual({ status: 'toggled', enabled: true });
    expect(sources.get(srcId)!.enabled).toBe(true);
  });

  it('别人的源 ⇒ forbidden(not_your_source)，且状态**不变**（拒绝不能有副作用）', () => {
    const srcId = sources.register({ orgId: ORG, agentId: OTHER, kind: 'webhook', address: ADDR }).source!.id;

    const out = service.setSourceEnabled({ orgId: ORG, agentId: OWNER, sourceId: srcId, enabled: false });

    expect(out.status).toBe('forbidden');
    expect(out.reason).toBe('not_your_source');
    expect(out.enabled).toBeUndefined();
    expect(sources.get(srcId)!.enabled).toBe(true);
  });

  it('未知 sourceId ⇒ forbidden（不静默成功、不造行）', () => {
    const out = service.setSourceEnabled({ orgId: ORG, agentId: OWNER, sourceId: 'src_ghost', enabled: false });
    expect(out.status).toBe('forbidden');
    expect(out.reason).toBe('not_your_source');
    expect(sources.get('src_ghost')).toBeUndefined();
  });
});

describe('C10-B：receiveWebhook 入口（路由层只搬运，判决全在这里）', () => {
  function registerTokenSource(token: string, agentId = OWNER) {
    bindings.bind({ orgId: ORG, agentId, address: ADDR });
    return service.registerSource({ orgId: ORG, agentId, kind: 'webhook', address: ADDR, config: { token } }).source!.id;
  }

  it('未知源 ⇒ 404 unknown_source', () => {
    const out = service.receiveWebhook('src_ghost', { content: 'hi' }, null);
    expect(out.http).toBe(404);
    expect(out.body).toEqual({ status: 'unknown_source' });
  });

  it('token 不匹配 ⇒ 401 unauthorized，且不 ingest（队列里没有残留）', () => {
    const srcId = registerTokenSource('s3cret');

    const out = service.receiveWebhook(srcId, { content: 'hi', messageId: 'wh-auth' }, 'wrong');

    expect(out.http).toBe(401);
    expect(out.body).toEqual({ status: 'unauthorized' });
    expect(queuedSignals()).toBe(0);
  });

  it('token 匹配 + 合法 body ⇒ 200 ingested（信封 from external/unverified）', () => {
    const srcId = registerTokenSource('s3cret');

    const out = service.receiveWebhook(srcId, { content: 'payload', subject: 'S', from: 'x@ext.example', messageId: 'wh-ok' }, 's3cret');

    expect(out.http).toBe(200);
    expect(out.body['status']).toBe('ingested');
    const row = db.prepare('SELECT envelope, work_unit_ref FROM mailbox_items WHERE id=?').get(out.body['itemId'] as string) as any;
    expect(row.work_unit_ref).toBe(WORK_UNIT_REF.external(srcId, 'wh-ok'));
    expect(JSON.parse(row.envelope).fromVerified).toBe(false);
  });

  it('无 content 的 body ⇒ 200 {bounced, dropReason: payload_invalid}（回声，不静默吞）', () => {
    const srcId = registerTokenSource('s3cret');

    const out = service.receiveWebhook(srcId, { subject: 'no body' }, 's3cret');

    expect(out.http).toBe(200);
    expect(out.body).toEqual({ status: 'bounced', dropReason: 'payload_invalid' });
    expect(queuedSignals()).toBe(0);
  });

  it('源不是 webhook 类型 ⇒ 400 not_a_webhook_source（按行落库的 kind 判）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'rss', address: ADDR, config: { feedUrl: 'https://example.com/f' } }).source!.id;

    const out = service.receiveWebhook(srcId, { content: 'hi' }, null);

    expect(out.http).toBe(400);
    expect(out.body).toEqual({ status: 'bounced', reason: 'not_a_webhook_source' });
  });

  it('无 token 的公开源 ⇒ 不需要 token 也收（token 是可选共享密钥）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR }).source!.id;

    const out = service.receiveWebhook(srcId, { content: 'open', messageId: 'wh-open' }, null);

    expect(out.http).toBe(200);
    expect(out.body['status']).toBe('ingested');
  });
});

describe('C10-B：RSS 单 timer + cursor 水位', () => {
  it('首轮 ingest 全部 item，cursor 入库；二轮 0 新（水位过滤）；disabled 源不扫', async () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const out = sources.register({ orgId: ORG, agentId: OWNER, kind: 'rss', address: ADDR, config: { feedUrl: 'https://example.com/feed' } });
    const srcId = out.source!.id;
    const first = await service.pollRss(srcId);
    expect(first).toEqual({ fetched: 2, ingested: 2 });
    expect(sources.get(srcId)!.cursor).not.toBeNull();
    const second = await service.pollRss(srcId);
    expect(second).toEqual({ fetched: 2, ingested: 0 });
    expect(queuedSignals()).toBe(2);
    db.prepare('UPDATE external_sources SET enabled=0 WHERE id=?').run(srcId);
    expect(await service.pollRss(srcId)).toEqual({ fetched: 0, ingested: 0 });
  });
});
