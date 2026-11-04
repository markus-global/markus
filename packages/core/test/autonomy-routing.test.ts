import { describe, it, expect } from 'vitest';
import { ThreadService } from '../src/thread-service.js';
import type {
  DispositionStoreLike, ThreadRowLike, ThreadStoreLike, SubscriptionLike,
} from '../src/thread-service.js';
import type { Autonomy } from '@markus/shared';
import { deliveryFor, auditsEveryAction } from '@markus/shared';

// ── 四档语义：路由级行为测试 ──────────────────────────────────────────────────
// 这组测试守的是 B3.1–B3.4。此前的死法是：autonomy 存在绑定表里，但
// `gateVerdict()` 根本不读它 —— observe 档的 agent 照样被叫醒，而
// resource_bind 的工具描述却写着「observe：不会自动动手」。
//
// 断言方式刻意选成**行为**而不是文本：
//   · off      → 没叫醒（wake 未调用）+ 没写判断（disposition 为空）
//   · observe  → 没叫醒 + 写了一条 wouldAccept=true 的判断
//   · auto/trusted → 叫醒 + 不写判断（直通本身就是证据）
// 如果谁把四档改回「只存在不消费」，这里立刻红。

class FakeThreads implements ThreadStoreLike {
  rows = new Map<string, ThreadRowLike>();
  subs: Array<SubscriptionLike & { threadId: string }> = [];
  private n = 0;

  upsert(ref: string) {
    const existing = this.rows.get(ref);
    if (existing) return { thread: existing, created: false };
    const thread: ThreadRowLike = { id: `thr_${++this.n}`, ref, lastActivity: 1000 };
    this.rows.set(ref, thread);
    return { thread, created: true };
  }
  getByRef(ref: string) {
    return this.rows.get(ref) ?? null;
  }
  touch() {}
  subscribe(threadId: string, _ticketId: string, agentId: string, purpose: 'own' | 'context') {
    this.subs.push({ threadId, ticketId: _ticketId, agentId, purpose });
  }
  listSubscriptions(threadId: string) {
    return this.subs.filter(s => s.threadId === threadId);
  }
}

class FakeDispositions implements DispositionStoreLike {
  rows: Array<{ triggerId: string; threadId: string; action: string; reason: string; wouldAccept?: boolean; actor?: string }> = [];
  record(d: { triggerId: string; threadId: string; action: string; reason: string; wouldAccept?: boolean; actor?: string }) {
    if (!d.reason?.trim()) throw new Error('DISPOSITION_REASON_REQUIRED');
    if (this.countByTrigger(d.triggerId) > 0) return false;
    this.rows.push({ ...d });
    return true;
  }
  countByTrigger(triggerId: string) {
    return this.rows.filter(r => r.triggerId === triggerId).length;
  }
}

const REF = 'gh:acme/repo';
const AGENT = 'agt_writer';

function setup(autonomy: Autonomy | null) {
  const threads = new FakeThreads();
  const dispositions = new FakeDispositions();
  const wakes: string[] = [];
  const { thread } = threads.upsert(REF);
  threads.subscribe(thread.id, thread.id, AGENT, 'own');

  const service = new ThreadService({
    threads,
    dispositions,
    now: () => 2000,
    onWake: (e) => wakes.push(e.threadRef),
    ...(autonomy === null ? {} : { autonomyFor: () => autonomy }),
  });

  const result = service.route({
    triggerId: 'trig_1',
    kind: 'comment',
    ref: REF,
    actorKind: 'human',
    addressing: 'broadcast',
  });

  return { threads, dispositions, wakes, result, service };
}

describe('四档语义 · off', () => {
  it('不叫醒、不写判断（没做的决定没有可记的内容）', () => {
    const { wakes, dispositions, result } = setup('off');
    expect(result.delivery).toBe('drop');
    expect(wakes).toHaveLength(0);       // 没被打扰
    expect(dispositions.rows).toHaveLength(0); // 也没有伪造一条「我判断过」
  });
});

describe('四档语义 · observe', () => {
  it('不叫醒，但记下「本会接」—— wouldAccept=true', () => {
    const { wakes, dispositions, result } = setup('observe');
    expect(result.delivery).toBe('record-only');
    expect(wakes).toHaveLength(0);              // 关键：observe 不动手
    expect(dispositions.rows).toHaveLength(1);  // 但留下判断
    expect(dispositions.rows[0]!.wouldAccept).toBe(true); // 信息量就在这
    expect(dispositions.rows[0]!.reason).toContain('observe');
  });

  it('记录里带着可回看的信息：人能看到「若为 auto 他会接」', () => {
    const { dispositions } = setup('observe');
    expect(dispositions.rows[0]!.reason).toMatch(/auto/);
  });
});

describe('四档语义 · auto / trusted', () => {
  it('auto：叫醒，不额外写判断（直通本身就是证据）', () => {
    const { wakes, dispositions, result } = setup('auto');
    expect(result.delivery).toBe('deliver');
    expect(wakes).toEqual([REF]);
    expect(dispositions.rows).toHaveLength(0);
  });

  it('trusted：同样叫醒', () => {
    const { wakes, result } = setup('trusted');
    expect(result.delivery).toBe('deliver');
    expect(wakes).toEqual([REF]);
  });

  it('auto 与 trusted 的差别不在「能不能做」，而在要不要逐次登记', () => {
    // 这是设计原文的说法。若有人把这条差别塞进 gateAction，
    // 就等于凭空多出第三根轴 —— 这条测试锁住「它是一根独立的判断」。
    expect(auditsEveryAction('auto')).toBe(true);
    expect(auditsEveryAction('trusted')).toBe(false);
  });
});

describe('四档语义 · 兜底：无法判定档位时保持旧行为', () => {
  it('没注入 autonomyFor（或这条流上没有绑定）→ 直通即唤醒，不擅自降级', () => {
    // 为什么不默认 observe：直通也可能来自 context 订阅，那些场景没有绑定记录。
    // 把它们一并降级会让现存 agent 集体失聪 —— 那不是收紧，是事故。
    const { wakes, dispositions, result } = setup(null);
    expect(result.delivery).toBeUndefined();
    expect(wakes).toEqual([REF]);
    expect(dispositions.rows).toHaveLength(0);
  });
});

describe('四档投影 · 纯函数', () => {
  it('四个档位映射到三种结局，且没有遗漏', () => {
    expect(deliveryFor('off')).toBe('drop');
    expect(deliveryFor('observe')).toBe('record-only');
    expect(deliveryFor('auto')).toBe('deliver');
    expect(deliveryFor('trusted')).toBe('deliver');
  });

  it('幂等：同一 trigger 不会被记录两次', () => {
    const { dispositions, service, threads } = setup('observe');
    const { thread } = threads.upsert(REF);
    service.route({
      triggerId: 'trig_1', kind: 'comment', ref: REF,
      actorKind: 'human', addressing: 'broadcast',
    });
    // 同一个 triggerId 再走一遍 → UNIQUE 语义下仍是 1 条
    expect(dispositions.rows.filter(r => r.threadId === thread.id)).toHaveLength(1);
  });
});
