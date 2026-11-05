/**
 * 事件入口回归：单一顺序 verify → normalize → 幂等 → gate → record → dispatch。
 *
 * 重点锁三件会出安全/一致性事故的事：
 *  1. 签名必须对**原始字节**算 —— 重新序列化 JSON 会让攻击者构造等价载荷；
 *  2. 未注册前缀必须拒绝（不能「先收下再说」）；
 *  3. 同一事件重投只处理一次，且**不产生第二行审计**。
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { EventIngress } from '../src/event-ingress.js';
import { SourceRegistry, sourceIdempotencyKey, verifyHmac } from '../src/event-source.js';
import type { NormalizedEvent, RawEvent, SourceAdapter } from '../src/event-source.js';
import { ThreadService } from '../src/thread-service.js';
import type { DispositionStoreLike, ThreadRowLike, ThreadStoreLike, SubscriptionLike } from '../src/thread-service.js';
import type { DispatchTarget } from '../src/event-ingress.js';

const SECRET = 'top-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeAdapter(over: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    prefix: 'gh',
    verify: raw => verifyHmac(raw, 'x-hub-signature-256'),
    normalize: raw => {
      const payload = JSON.parse(raw.rawBody.toString('utf8')) as { id: string; repo: string; actor?: string };
      const ev: NormalizedEvent = {
        kind: 'external',
        idempotencyKey: sourceIdempotencyKey('gh', payload.id),
        ref: `gh:${payload.repo}`,
        actorKind: payload.actor === 'bot' ? 'bot' : 'human',
        actorId: payload.actor ?? 'unknown',
        addressing: 'ambient',
        summary: `push ${payload.id}`,
        body: 'x',
        receivedAt: 1000,
      };
      return [ev];
    },
    ...over,
  };
}

class FakeThreads implements ThreadStoreLike {
  rows = new Map<string, ThreadRowLike>();
  subs = new Map<string, SubscriptionLike[]>();
  private n = 0;
  upsert(ref: string) {
    const cur = this.rows.get(ref);
    if (cur) return { thread: cur, created: false };
    const thread: ThreadRowLike = { id: `thr_${++this.n}`, ref, ownerAgent: null, ownerSession: null, lastActivity: 0 };
    this.rows.set(ref, thread);
    this.subs.set(thread.id, []);
    return { thread, created: true };
  }
  getByRef(ref: string) {
    return this.rows.get(ref) ?? null;
  }
  touch() {}
  subscribe(id: string, ticketId: string, agentId: string, purpose: 'own' | 'context') {
    this.subs.get(id)!.push({ ticketId, agentId, purpose });
  }
  listSubscriptions(id: string) {
    return this.subs.get(id) ?? [];
  }
  private byId(id: string) {
    return [...this.rows.values()].find(t => t.id === id)!;
  }
}

class FakeDispositions implements DispositionStoreLike {
  rows: Array<{ triggerId: string; threadId: string; action: string; reason: string }> = [];
  record(d: { triggerId: string; threadId: string; action: string; reason: string }) {
    if (!d.reason?.trim()) throw new Error('DISPOSITION_REASON_REQUIRED');
    if (this.countByTrigger(d.triggerId) > 0) return false;
    this.rows.push({ triggerId: d.triggerId, threadId: d.threadId, action: d.action, reason: d.reason });
    return true;
  }
  countByTrigger(triggerId: string) {
    return this.rows.filter(r => r.triggerId === triggerId).length;
  }
}

/** 触发器登记的假实现：验「事件进来时有没有登记」与幂等。 */
function fakeTriggers() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    insertOrGet(t: Record<string, unknown>) {
      const key = String(t['idempotencyKey']);
      const existing = rows.find(r => r['idempotencyKey'] === key);
      if (existing) return { trigger: existing, created: false };
      const rec = { id: `trg_${rows.length + 1}`, ...t };
      rows.push(rec);
      return { trigger: rec, created: true };
    },
  };
}

let registry: SourceRegistry;
let threads: FakeThreads;
let dispositions: FakeDispositions;
let service: ThreadService;
let delivered: DispatchTarget[];
let ingress: EventIngress;

beforeEach(() => {
  registry = new SourceRegistry();
  registry.register(makeAdapter());
  threads = new FakeThreads();
  dispositions = new FakeDispositions();
  service = new ThreadService({ threads, dispositions, now: () => 5000 });
  delivered = [];
  ingress = new EventIngress({ registry, service, deliver: t => delivered.push(t), triggers: fakeTriggers() });
});

const raw = (payload: object, headers: Record<string, string> = {}): RawEvent => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return { prefix: 'gh', headers: { 'x-hub-signature-256': sign(body), ...headers }, rawBody: body, secret: SECRET };
};

describe('verifyHmac — 原始字节', () => {
  it('正确签名通过，篡改一字节即失败', () => {
    const good = raw({ id: 'e1', repo: 'o/r' });
    expect(verifyHmac(good, 'x-hub-signature-256')).toBe(true);

    const tampered: RawEvent = { ...good, rawBody: Buffer.from(good.rawBody.toString('utf8').replace('e1', 'e2')) };
    expect(verifyHmac(tampered, 'x-hub-signature-256')).toBe(false);
  });

  it('对「解析后重新序列化」的等价载荷签名 → 验证失败（这是刻意的）', () => {
    // 原始字节带空格 → 重新序列化会去掉空格，二者语义等价但字节不同。
    const body = Buffer.from('{"id": "e1", "repo": "o/r"}', 'utf8');
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    expect(reserialized.equals(body)).toBe(false); // 前提：两者确实不同字节

    const sig = sign(body).slice('sha256='.length);
    const header = { 'x-hub-signature-256': `sha256=${sig}` };
    // 用原始字节验：通过
    expect(verifyHmac({ prefix: 'gh', headers: header, rawBody: body, secret: SECRET }, 'x-hub-signature-256')).toBe(true);
    // 用重新序列化的字节验：不通过 —— 这就是「必须对原始字节签名」的原因
    expect(
      verifyHmac({ prefix: 'gh', headers: header, rawBody: reserialized, secret: SECRET }, 'x-hub-signature-256'),
    ).toBe(false);
  });

  it('无密钥 / 无签名头 / 长度不等 → 一律 false，不抛异常', () => {
    const r = raw({ id: 'e1', repo: 'o/r' });
    expect(verifyHmac({ ...r, secret: null }, 'x-hub-signature-256')).toBe(false);
    expect(verifyHmac({ ...r, headers: {} }, 'x-hub-signature-256')).toBe(false);
    expect(verifyHmac({ ...r, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }, 'x-hub-signature-256')).toBe(false);
  });
});

describe('SourceRegistry', () => {
  it('同前缀重复注册直接拒（一个前缀只能有一个适配器）', () => {
    expect(() => registry.register(makeAdapter())).toThrow(/SOURCE_PREFIX_DUPLICATE/);
  });

  it('空前缀拒绝', () => {
    expect(() => registry.register(makeAdapter({ prefix: '  ' }))).toThrow(/SOURCE_PREFIX_EMPTY/);
  });
});

describe('EventIngress — 单一顺序', () => {
  it('未注册前缀 → unknown-source，不解析载荷', () => {
    const r = ingress.ingest({ ...raw({ id: 'e1', repo: 'o/r' }), prefix: 'evil' });
    expect(r.status).toBe('unknown-source');
    expect(dispositions.rows).toHaveLength(0);
  });

  it('签名错 → unauthorized，且不留下任何处置记录', () => {
    const r = ingress.ingest({ ...raw({ id: 'e1', repo: 'o/r' }), secret: 'wrong-secret' });
    expect(r.status).toBe('unauthorized');
    expect(dispositions.rows).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it('合法但无主的流 → needs-assessment：留痕 + 不投递', () => {
    const r = ingress.ingest(raw({ id: 'e1', repo: 'o/r' }));
    expect(r.status).toBe('ignored');
    expect(dispositions.rows).toHaveLength(1);
    expect(dispositions.rows[0]!.reason).toContain('needs-assessment');
    expect(delivered).toHaveLength(0);
  });

  it('同一事件重投 → duplicate，只有一行审计', () => {
    ingress.ingest(raw({ id: 'e1', repo: 'o/r' }));
    const r = ingress.ingest(raw({ id: 'e1', repo: 'o/r' }));
    expect(r.status).toBe('duplicate');
    expect(dispositions.rows).toHaveLength(1);
  });

  it('流已有主（own 订阅）→ 直通并投给持有者（不产生处置）', () => {
    const { thread } = threads.upsert('gh:o/r');
    threads.subscribe(thread.id, 'tkt_owner', 'agt_owner', 'own');

    const r = ingress.ingest(raw({ id: 'e9', repo: 'o/r' }));
    expect(r.status).toBe('direct-through');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.agentId).toBe('agt_owner');
    expect(dispositions.rows).toHaveLength(0);
  });

  it('只订阅未接管 → 直通给订阅者（own 优先于 context）', () => {
    const { thread } = threads.upsert('gh:o/r');
    threads.subscribe(thread.id, 'tkt_ctx', 'agt_ctx', 'context');
    threads.subscribe(thread.id, 'tkt_own', 'agt_own', 'own');

    ingress.ingest(raw({ id: 'e10', repo: 'o/r' }));
    expect(delivered[0]!.agentId).toBe('agt_own');
  });

  it('归一化抛错 → 记 ignored 而不是让异常穿透到 HTTP 层', () => {
    registry = new SourceRegistry();
    registry.register(
      makeAdapter({
        normalize: () => {
          throw new Error('bad payload');
        },
      }),
    );
    ingress = new EventIngress({ registry, service, deliver: t => delivered.push(t), triggers: fakeTriggers() });
    const r = ingress.ingest(raw({ id: 'e1', repo: 'o/r' }));
    expect(r.status).toBe('ignored');
    expect(r.reason).toContain('归一化失败');
  });

  it('批量载荷逐个走同一条链（2 个事件 → 2 行审计）', () => {
    registry = new SourceRegistry();
    registry.register(
      makeAdapter({
        normalize: raw => {
          const p = JSON.parse(raw.rawBody.toString('utf8')) as { ids: string[]; repo: string };
          return p.ids.map(id => ({
            kind: 'external' as const,
            idempotencyKey: sourceIdempotencyKey('gh', id),
            ref: `gh:${p.repo}`,
            actorKind: 'bot' as const,
            actorId: 'ci',
            addressing: 'ambient' as const,
            summary: id,
            body: 'x',
            receivedAt: 1000,
          }));
        },
      }),
    );
    ingress = new EventIngress({ registry, service, deliver: t => delivered.push(t), triggers: fakeTriggers() });
    const r = ingress.ingest(raw({ ids: ['a', 'b'], repo: 'o/r' }));
    expect(r.events).toBe(2);
    expect(dispositions.rows).toHaveLength(2);
  });
});
