/**
 * C10-B —— ExternalSourceService：唯一 ingest 点（计划 §B / 卡内契约 D2/D4/D5/D6/D7）。
 *
 * 判据：
 *   · ref 由唯一构造器 WORK_UNIT_REF.external 建，入队即带身份（refOrigin entity）；
 *   · A（Owner 2026-11-25）：外部事件一律欠一个回合（action_required）—— 欠回合由平台判定；
 *     发送者只能升权（trigger_execution 须已验证），权威侧执行点在 agent 级天花板；
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
/**
 * 入队时**原始**载荷（外置存储之前的形态）。
 *
 * 为什么要记：mailbox payload > 8 KB 会由 `projectJsonForStorage` 外置成 blob 引用，
 * 直接读列拿到的是 `$blob` 引用而不是正文。断言「截断后的正文」必须看入口这一层，
 * 而不是去看一个被外置过的列。
 */
let recordedPayloads: Array<Record<string, unknown>> = [];

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
    save: (item: any, dedupKey?: string) => { recordedPayloads.push(item.payload as Record<string, unknown>); return repo.save({ ...row(item, item.status, item.envelope?.messageId ?? null, item.dropReason ?? null), dedupKey }); },
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
    // C10-F: this suite describes ingest MECHANICS, so it declares the most
    // permissive org policy explicitly ('accept' = pre-policy behaviour). The
    // missing-port default is 'off', and every assertion below would then stop at
    // the policy gate instead of reaching the ingest path it is about.
    // The gate itself has its own suite: external-ingress-policy.test.ts.
    ingressPolicy: () => 'accept' as const,
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
    // A：未验证不等于「不值得一个回合」。平台判定外部事件欠回合 → action_required，
    // routeMailboxItem 据此 invokesLLM=true。旧值是 deliver（事件被静默存档）。
    expect(env.intent).toBe('action_required');
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

  it('A 天花板：未验证发送者只能升权不能夺权 —— trigger_execution 降为 action_required，deliver 抬为 action_required', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    // 三个方向各咬一件事：
    //  · trigger_execution → action_required：未验证来源拿不到权威 FSM 待遇（判据 14 守）。
    //  · action_required → action_required：平台判定本就欠回合，原样保留。
    //  · deliver → action_required：**发送者无权让事件消失**。旧实现把这里当「封顶」，
    //    实际是让外部事件静默存档、agent 永不决策 —— A 要修的就是这一条。
    const expected: Record<string, string> = {
      trigger_execution: 'action_required',
      action_required: 'action_required',
      deliver: 'action_required',
    };
    for (const [requested, want] of Object.entries(expected)) {
      const out = service.ingest(srcId, event({ messageId: `m-${requested}` }), {
        intent: requested as never,
      });
      expect(out.status).toBe('ingested');
      const row = db.prepare('SELECT envelope FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
      const env = JSON.parse(row.envelope);
      expect(env.intent, `requested=${requested}`).toBe(want);
      expect(env.fromVerified, 'B 不做认证，恒 false').toBe(false);
    }
  });

  // ── B（Owner 2026-11-25 裁决）：鉴权运营投递入口 ──────────────────────────
  // 注册闸门原样不动（防「先注册后绑定」自助绕过）。运营者用**自己已注册的源**当出处，
  // 只额外指定目标地址 ⇒ ref 仍是真实体 external:<真源id>:<msgId>，不造伪源 id。
  const UNCLAIMED = 'nobody.acme@markus.global';

  it('B 运营投递：自己的源 + 无人认领地址 ⇒ 信号落源主 mailbox（当前为退信归集态，M2 才把它变决策）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    const out = service.deliverAsOperator({
      orgId: ORG, agentId: OWNER, sourceId: srcId, address: UNCLAIMED,
      body: { messageId: 'op-1', content: 'unclaimed address signal', subject: 'S' },
    });
    // 诚实断言当前行为：唯一解析器对无 active 绑定的地址判 no_active_target，
    // 信号以 catch_all 归集态落源主 mailbox。**入站口已存在**（这就是 B 的交付）；
    // 把「回声」变成「一次决策」是 M2 的活，不在本入口里偷偷改路由语义。
    expect(out.status).toBe('bounced');
    expect((out as any).dropReason).toBe('no_active_target');
    const row = db.prepare('SELECT * FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
    expect(row.agent_id).toBe(OWNER);
    expect(row.source_type).toBe('external_signal');
    expect(row.status).toBe('catch_all');
    const env = JSON.parse(row.envelope);
    // markus ref 的真实形状是四字段（local/orgSlug 由解析器给出，不自己拼）。
    expect(env.to).toEqual({ kind: 'markus', address: UNCLAIMED, local: 'nobody', orgSlug: 'acme' });
    expect(env.fromVerified).toBe(false);
    // A：intent 仍是 action_required（平台判定欠回合）—— 退信是路由结果，不是把 intent 擦掉。
    expect(env.intent).toBe('action_required');
    // ref 用真实源 id，不是伪 id（判据 15 + 唯一构造器都不动）。
    expect(row.work_unit_ref).toBe(WORK_UNIT_REF.external(srcId, 'op-1'));
  });

  it('B 归属门：别人的源 ⇒ forbidden(not_your_source)，且不落库（拒绝无副作用）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook();
    const before = queuedSignals();
    const out = service.deliverAsOperator({
      orgId: ORG, agentId: OTHER, sourceId: srcId, address: UNCLAIMED,
      body: { messageId: 'op-x', content: 'steal' },
    });
    expect(out.status).toBe('forbidden');
    expect((out as any).reason).toBe('not_your_source');
    expect(queuedSignals()).toBe(before);
  });

  it('B 路由跟绑定走：目标地址已绑给 OTHER ⇒ 进 OTHER 的 mailbox（不是源主）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    bindings.bind({ orgId: ORG, agentId: OTHER, address: UNCLAIMED });
    const srcId = registerWebhook();
    const out = service.deliverAsOperator({
      orgId: ORG, agentId: OWNER, sourceId: srcId, address: UNCLAIMED,
      body: { messageId: 'op-2', content: 'bound elsewhere' },
    });
    expect(out.status).toBe('ingested');
    const row = db.prepare('SELECT agent_id FROM mailbox_items WHERE id=?').get((out as any).itemId) as any;
    expect(row.agent_id).toBe(OTHER);
  });

  it('B 安全边界：公开 webhook 入口不得接受目标地址覆写（外部方不能重定向）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    bindings.bind({ orgId: ORG, agentId: OTHER, address: UNCLAIMED });
    // C10 开源默认值后：源必须带密钥才能入站，这里显式给一个。
    const srcId = service.registerSource({
      orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR, config: { token: 's3cret' },
    }).source!.id;
    // 外部方在 payload 里塞 targetAddress —— 必须被忽略，仍按源自己的地址路由。
    const out = service.receiveWebhook(srcId, {
      messageId: 'wh-redirect', content: 'redirect attempt', targetAddress: UNCLAIMED,
    }, 's3cret');
    expect(out.http).toBe(200);
    const row = db.prepare('SELECT agent_id, envelope FROM mailbox_items WHERE id=?')
      .get((out.body as any).itemId) as any;
    expect(row.agent_id).toBe(OWNER);
    expect(JSON.parse(row.envelope).to).toEqual({
      kind: 'markus', address: ADDR, local: 'hook', orgSlug: 'acme',
    });
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
    // C10-F: the list receipt gained the inbound path + secret status + last-event
    // fields (the settings screen must be able to show what it manages). Deep
    // equality is kept on purpose — a subset match would let a future writer drop
    // a field silently and still pass.
    expect(out[0]).toEqual({
      id: mine, kind: 'webhook', address: ADDR, enabled: true,
      urlPath: `/api/webhooks/${mine}`,
      hasSecret: false, secretPreview: null, feedUrl: null,
      lastEventAt: null, lastError: null,
    });
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

  it('旧契约已废止：不给密钥的调用 ⇒ 401（用现铸密钥才能入站）', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const reg = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR });
    const srcId = reg.source!.id;

    // 不给密钥：即使源是本次注册刚铸的密钥，也不能免验入站
    const denied = service.receiveWebhook(srcId, { content: 'open', messageId: 'wh-open' }, null);
    expect(denied.http).toBe(401);
    expect(denied.body['status']).toBe('unauthorized');

    // 拿注册时回显的密钥 ⇒ 照常收
    const ok = service.receiveWebhook(srcId, { content: 'open', messageId: 'wh-open' }, reg.secret);
    expect(ok.http).toBe(200);
    expect(ok.body['status']).toBe('ingested');
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

/**
 * C10 开源默认值（Owner 2026-11-26）：markus 要给大量开源用户部署，默认值即实际配置。
 *
 * 三条判据都必须**结构性**成立，不能靠用户记得配：
 *   ① webhook 源必然带共享密钥（不传就现铸）→ 「无鉴权入站口」不可表达；
 *   ② 没有密钥的源拒绝入站（fail-closed），而不是「等于放行」；
 *   ③ content 有硬上限 → 一条外部请求不能烧掉一天上下文。
 */
describe('C10 开源默认值：密钥必铸 / 入站 fail-closed / 内容必有界', () => {
  const TOKEN = 's3cret';

  function tokenSource(): string {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    return service.registerSource({
      orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR, config: { token: TOKEN },
    }).source!.id;
  }

  const lastPayload = () => recordedPayloads[recordedPayloads.length - 1]!;

  it('超长 content ⇒ 落库截断到 32KB + contentTruncated 标记', () => {
    const srcId = tokenSource();
    recordedPayloads = [];

    const out = service.receiveWebhook(srcId, { content: 'x'.repeat(200_000), messageId: 'big-1' }, TOKEN);

    expect(out.http).toBe(200);
    const payload = lastPayload();
    expect(payload['contentTruncated']).toBe(true);
    expect(String(payload['content']).length).toBeLessThan(33_000);
    expect(payload['content']).toContain('[truncated: original 200000 chars]');
    // 截断只砍尾巴，不重排内容
    expect(String(payload['content']).startsWith('xxxx')).toBe(true);
  });

  it('恰好等于上限的内容不截断（边界不多也不少）', () => {
    const srcId = tokenSource();
    recordedPayloads = [];

    service.receiveWebhook(srcId, { content: 'y'.repeat(32 * 1024), messageId: 'edge-1' }, TOKEN);

    const payload = lastPayload();
    expect(String(payload['content']).length).toBe(32 * 1024);
    expect(payload['contentTruncated']).toBeUndefined();
  });
  it('注册 webhook 源不给 token ⇒ 现铸密钥、只回显一次、落库一致，列表面不回显', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });

    const out = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR });

    expect(out.status).toBe('registered');
    expect(typeof out.secret).toBe('string');
    const secret = out.secret!;
    // 真随机、足够长（16 字节 base64url ≥ 22 字符），且给的是可放进 header 的字符集
    expect(secret.length).toBeGreaterThanOrEqual(22);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);

    // 落库的就是回显的那个 —— 否则用户拿着密钥永远打不通（回显与存储两个口径 = 缺陷）
    // 注：`ExternalSourceRecord.config` 是 JSON **字符串**，不是对象。
    expect(JSON.parse(sources.get(out.source!.id)!.config)['token']).toBe(secret);

    // 显式传了 token 就不得被覆盖，也不该再回显一个「新密钥」误导用户
    bindings.bind({ orgId: ORG, agentId: OTHER, address: 'hook2.acme@markus.global' });
    const explicit = service.registerSource({
      orgId: ORG, agentId: OTHER, kind: 'webhook',
      address: 'hook2.acme@markus.global', config: { token: TOKEN },
    });
    expect(explicit.secret).toBeUndefined();

    // 列表面不回显密钥（避免二次扩散到日志/UI）
    expect(JSON.stringify(service.listSources(ORG, OWNER))).not.toContain(secret);

    // 闭环：用铸出来的密钥真的能入站
    const wh = service.receiveWebhook(out.source!.id, { content: 'hi', messageId: 'mint-1' }, secret);
    expect(wh.http).toBe(200);
    expect(wh.body['status']).toBe('ingested');
  });

  it('历史源（config 无 token）⇒ 401 secret_required + 可行动提示，且零入队', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = registerWebhook(); // 直落库、无 token —— 旧库里的历史行形态

    const out = service.receiveWebhook(srcId, { content: 'hi', messageId: 'legacy-1' }, null);

    expect(out.http).toBe(401);
    expect(out.body['status']).toBe('secret_required');
    // 拒绝必须可行动：告诉调用者怎么修，而不是一个空洞的 401
    expect(String(out.body['hint'])).toContain('external_source_register');
    expect(queuedSignals()).toBe(0);
  });

  it('等长但错误的 token ⇒ 401 unauthorized（恒定时间比较，不走长度捷径）', () => {
    const srcId = tokenSource();

    const out = service.receiveWebhook(srcId, { content: 'hi', messageId: 'eqlen-1' }, 'x'.repeat(TOKEN.length));

    expect(out.http).toBe(401);
    expect(out.body).toEqual({ status: 'unauthorized' });
    expect(queuedSignals()).toBe(0);
  });

});

// ─── C10-F：密钥的展示投影 ─────────────────────────────────────────────────
describe('C10-F：轮换后的显示内容就地刷新（一个事实一个投影函数）', () => {
  it('rotate 回执自带 secretPreview，并与 listSources 的投影逐字一致', () => {
    bindings.bind({ orgId: ORG, agentId: OWNER, address: ADDR });
    const srcId = service.registerSource({ orgId: ORG, agentId: OWNER, kind: 'webhook', address: ADDR }).source!.id;

    const rot = service.rotateSecret({ orgId: ORG, agentId: OWNER, sourceId: srcId });

    expect(rot.status).toBe('rotated');
    // 已轮换的尾四位必须能从回执里拿到 —— 这就是界面「不及时刷新」的根因：
    // 旧实现只回 secret，界面只能把 hasSecret 置 true、尾号停在旧值直到整页刷新。
    expect(rot.secretPreview).toBe(`••••${rot.secret!.slice(-4)}`);
    const listed = service.listSources(ORG, OWNER).find(s => s.id === srcId)!;
    expect(listed.secretPreview).toBe(rot.secretPreview);
  });
});
