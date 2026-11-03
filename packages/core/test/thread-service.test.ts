/**
 * 流服务回归：六个路由分支 + 直通不落处置 + 幂等。
 *
 * 用内存假实现（不是 sqlite）：这里测的是**分支选择**，存储级不变量 I1/I3/I4/I8
 * 已在 packages/storage/test/thread-store.test.ts 用真库锁死。分工明确，
 * 免得「夹具撒谎」和「断言漂移」互相掩护。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadService } from '../src/thread-service.js';
import type { DispositionStoreLike, ThreadRowLike, ThreadStoreLike, SubscriptionLike } from '../src/thread-service.js';

class FakeThreads implements ThreadStoreLike {
  rows = new Map<string, ThreadRowLike>();
  subs: SubscriptionLike[] = [];
  private n = 0;

  upsert(ref: string, now = 1000) {
    const existing = this.rows.get(ref);
    if (existing) return { thread: existing, created: false };
    const thread: ThreadRowLike = { id: `thr_${++this.n}`, ref, ownerAgent: null, ownerSession: null, lastActivity: now };
    this.rows.set(ref, thread);
    return { thread, created: true };
  }
  getByRef(ref: string) {
    return this.rows.get(ref) ?? null;
  }
  setOwner(id: string, agentId: string, sessionId: string) {
    const t = [...this.rows.values()].find(x => x.id === id)!;
    t.ownerAgent = agentId;
    t.ownerSession = sessionId;
  }
  clearOwner(id: string) {
    const t = [...this.rows.values()].find(x => x.id === id)!;
    t.ownerAgent = null;
    t.ownerSession = null;
  }
  touch(id: string) {
    const t = [...this.rows.values()].find(x => x.id === id)!;
    t.lastActivity = 2000;
  }
  subscribe(threadId: string, ticketId: string, agentId: string, purpose: 'own' | 'context') {
    this.subs = this.subs.filter(s => !(s.ticketId === ticketId && this.threadIdOf(ticketId) === threadId));
    this.subs.push({ ticketId, agentId, purpose });
    this.ticketThread.set(ticketId, threadId);
  }
  ticketThread = new Map<string, string>();
  private threadIdOf(ticketId: string) {
    return this.ticketThread.get(ticketId);
  }
  listSubscriptions(threadId: string) {
    return this.subs.filter(s => this.ticketThread.get(s.ticketId) === threadId);
  }
}

class FakeDispositions implements DispositionStoreLike {
  rows: Array<{ triggerId: string; threadId: string; action: string; reason: string; wouldAccept?: boolean }> = [];
  record(d: { triggerId: string; threadId: string; action: string; reason: string; wouldAccept?: boolean }) {
    if (!d.reason?.trim()) throw new Error('DISPOSITION_REASON_REQUIRED');
    if (this.countByTrigger(d.triggerId) > 0) return false;
    this.rows.push({ ...d });
    return true;
  }
  countByTrigger(triggerId: string) {
    return this.rows.filter(r => r.triggerId === triggerId).length;
  }
}

let threads: FakeThreads;
let dispositions: FakeDispositions;
let svc: ThreadService;

beforeEach(() => {
  threads = new FakeThreads();
  dispositions = new FakeDispositions();
  svc = new ThreadService({ threads, dispositions, now: () => 5000 });
});

describe('ensure / claim / release / subscribe', () => {
  it('ensure 幂等；own 订阅即“有主”，且可以有多个（P2-⑦ 的结构保证）', () => {
    const a = svc.ensure('tsk_1');
    const b = svc.ensure('tsk_1');
    expect(b.thread.id).toBe(a.thread.id);
    expect(svc.directThrough('tsk_1')).toBeNull();

    svc.subscribe('tsk_1', 'tkt_1', 'agt_1', 'own');
    expect(svc.directThrough('tsk_1')?.owners).toEqual(['agt_1']);

    // 第二个负责人并存：同一个 ref 可以有多个 own ——
    // 这就是「一 ref 多流」不需要拆表、也不需要放宽 UNIQUE(ref) 的原因。
    svc.subscribe('tsk_1', 'tkt_2', 'agt_2', 'own');
    expect([...(svc.directThrough('tsk_1')?.owners ?? [])].sort()).toEqual(['agt_1', 'agt_2']);
  });

  it('context 订阅也算直通依据，但不计入 owners', () => {
    svc.subscribe('tsk_1', 'tkt_1', 'agt_2', 'context');
    const d = svc.directThrough('tsk_1');
    expect(d?.owners).toEqual([]); // context ≠ 负责
    expect(d?.subscriptions.map(s => s.agentId)).toEqual(['agt_2']);
  });
});

describe('route — 六个分支', () => {
  it('人 @ 了谁就投给谁：dispatch 且落一条处置', () => {
    const r = svc.route({
      triggerId: 'trg_1',
      kind: 'external',
      ref: 'tsk_1',
      actorKind: 'human',
      addressing: 'mention',
      directTargetAgentId: 'agt_9',
    });
    expect(r.verdict).toBe('dispatch');
    expect(r.decision).toMatchObject({ action: 'dispatch', agentId: 'agt_9' });
    expect(dispositions.rows).toHaveLength(1);
    expect(dispositions.rows[0]!.reason).toContain('不研判');
  });

  it('同一事件重投 → duplicate，不产生第二行审计', () => {
    const input = {
      triggerId: 'trg_1',
      kind: 'external' as const,
      ref: 'tsk_1',
      actorKind: 'human' as const,
      addressing: 'mention' as const,
      directTargetAgentId: 'agt_9',
    };
    svc.route(input);
    const again = svc.route(input);
    expect(again.verdict).toBe('duplicate');
    expect(dispositions.rows).toHaveLength(1);
  });

  it('流已有主（own 订阅）→ 直通：不产生处置（流本身就是证据）', () => {
    svc.subscribe('tsk_1', 'tkt_own', 'agt_1', 'own');
    const r = svc.route({ triggerId: 'trg_2', kind: 'external', ref: 'tsk_1', actorKind: 'bot', addressing: 'ambient' });
    expect(r.verdict).toBe('direct-through');
    expect(r.decision).toBeNull();
    expect(r.ticketId).toBeTruthy();
    expect(dispositions.rows).toHaveLength(0);
  });

  it('卡已结束 + bot 事件 → 只留痕不唤醒', () => {
    const r = svc.route({
      triggerId: 'trg_3',
      kind: 'external',
      ref: 'tsk_1',
      actorKind: 'bot',
      addressing: 'ambient',
      threadEnded: true,
    });
    expect(r.verdict).toBe('ignore-ended');
    expect(r.decision).toMatchObject({ action: 'ignore', wouldAccept: false });
    expect(dispositions.rows).toHaveLength(1);
  });

  it('指向既有实体 → attach 到该流', () => {
    const r = svc.route({
      triggerId: 'trg_4',
      kind: 'external',
      ref: 'tsk_1',
      actorKind: 'bot',
      addressing: 'ambient',
      entityRef: 'tsk_1',
    });
    expect(r.verdict).toBe('attach');
    expect(r.decision).toMatchObject({ action: 'attach', threadRef: 'tsk_1' });
  });

  it('判不了 → assess：记录并延后，wouldAccept=true 便于回放', () => {
    const r = svc.route({ triggerId: 'trg_5', kind: 'external', ref: 'gh:o/r', actorKind: 'bot', addressing: 'ambient' });
    expect(r.verdict).toBe('assess');
    expect(r.decision).toMatchObject({ action: 'ignore', wouldAccept: true });
    expect(dispositions.rows[0]!.reason).toContain('needs-assessment');
  });
});

describe('record', () => {
  it('理由为空直接拒绝（不写半条审计）', () => {
    expect(() => svc.record('trg_x', 'thr_1', { action: 'ignore', threadRef: 'r', reason: '' })).toThrow(
      /DISPOSITION_REASON_REQUIRED/,
    );
  });
});
