/**
 * Eval 两段语义回归（B1，任务五）：gate（零 LLM 分流）→ 命中记 matchedRule；未命中 → assessment（可插拔）。
 *
 * 锁的是「规则命中是否可解释」「降级是否不静默放行」两件事，对应契约 §5 Gate 六条 + §7 任务五锚点。
 * 对 §5 六条逐条断言 matchedRule；对 assessment 用注入 spy 断言调用时机与降级行为。
 *
 * 用内存假实现（不是 sqlite）：这里测**分支选择**；matchedRule 落库列在
 * `packages/storage/test/thread-store.test.ts` 用真库锁死。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThreadService } from '../src/thread-service.js';
import type { AssessOutcome, DispositionStoreLike, ThreadRowLike, ThreadStoreLike, SubscriptionLike } from '../src/thread-service.js';

type Disp = { triggerId: string; threadId: string; action: string; reason: string; matchedRule?: string | null };

class FakeThreads implements ThreadStoreLike {
  rows = new Map<string, ThreadRowLike>();
  subs = new Map<string, SubscriptionLike[]>();
  private n = 0;
  upsert(ref: string, now = 1000) {
    const cur = this.rows.get(ref);
    if (cur) return { thread: cur, created: false };
    const thread: ThreadRowLike = { id: `thr_${++this.n}`, ref, lastActivity: now };
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
}

class FakeDispositions implements DispositionStoreLike {
  rows: Disp[] = [];
  record(d: {
    triggerId: string;
    threadId: string;
    action: string;
    reason: string;
    matchedRule?: string | null;
    wouldAccept?: boolean;
  }) {
    if (!d.reason?.trim()) throw new Error('DISPOSITION_REASON_REQUIRED');
    if (this.countByTrigger(d.triggerId) > 0) return false;
    this.rows.push({ ...d });
    return true;
  }
  countByTrigger(triggerId: string) {
    return this.rows.filter(r => r.triggerId === triggerId).length;
  }
}

const none = { hasOwner: false, hasSubscriptions: false, threadEnded: false };

let threads: FakeThreads;
let dispositions: FakeDispositions;

beforeEach(() => {
  threads = new FakeThreads();
  dispositions = new FakeDispositions();
});

function makeService(over: { assess?: (i: never) => AssessOutcome | undefined } = {}): ThreadService {
  return new ThreadService({ threads, dispositions, now: () => 5000, assess: over.assess as never });
}

/** 一条「未命中任何确定性规则」的入参（§5 规则 6 → assess）。 */
function assessInput() {
  return {
    triggerId: 'trg-assess',
    kind: 'external' as const,
    ref: 'gh:o/r',
    actorKind: 'bot' as const,
    addressing: 'ambient' as const,
  };
}

describe('Gate 六条逐条 —— matchedRule 可解释（验收 4）', () => {
  it('规则 1 幂等命中 → matchedRule=duplicate（且不重复落审计）', () => {
    const svc = makeService();
    const input = { triggerId: 'trg-1', kind: 'external' as const, ref: 'tsk_1', actorKind: 'human' as const, addressing: 'mention' as const, directTargetAgentId: 'agt_9' };
    svc.route(input);
    const again = svc.route(input);
    expect(again.verdict).toBe('duplicate');
    expect(again.matchedRule).toBe('duplicate');
    expect(dispositions.rows).toHaveLength(1);
  });

  it('规则 2 人已指定 → matchedRule=dispatch 且落 reason 含「不研判」', () => {
    const svc = makeService();
    const r = svc.route({ triggerId: 'trg-2', kind: 'external' as const, ref: 'tsk_1', actorKind: 'human' as const, addressing: 'mention' as const, directTargetAgentId: 'agt_9' });
    expect(r.verdict).toBe('dispatch');
    expect(r.matchedRule).toBe('dispatch');
    expect(r.decision).toMatchObject({ action: 'dispatch', agentId: 'agt_9' });
    expect(dispositions.rows[0]!.matchedRule).toBe('dispatch');
    expect(dispositions.rows[0]!.reason).toContain('不研判');
  });

  it('规则 3 命中已订阅线程 → matchedRule=direct-through（不产生 Decision）', () => {
    const svc = makeService();
    svc.subscribe('tsk_1', 'tkt_own', 'agt_1', 'own');
    const r = svc.route({ triggerId: 'trg-3', kind: 'external' as const, ref: 'tsk_1', actorKind: 'bot' as const, addressing: 'ambient' as const });
    expect(r.verdict).toBe('direct-through');
    expect(r.matchedRule).toBe('direct-through');
    expect(r.decision).toBeNull();
    expect(dispositions.rows).toHaveLength(0);
  });

  it('规则 4 明确指向实体 → matchedRule=attach 且落 reason 含实体 ref', () => {
    const svc = makeService();
    const r = svc.route({ triggerId: 'trg-4', kind: 'external' as const, ref: 'tsk_1', actorKind: 'bot' as const, addressing: 'ambient' as const, entityRef: 'tsk_1' });
    expect(r.verdict).toBe('attach');
    expect(r.matchedRule).toBe('attach');
    expect(dispositions.rows[0]!.matchedRule).toBe('attach');
    expect(dispositions.rows[0]!.reason).toContain('tsk_1');
  });

  it('规则 5 流已结束 + 非人 → matchedRule=ignore-ended 只留痕不唤醒', () => {
    const svc = makeService();
    const r = svc.route({ triggerId: 'trg-5', kind: 'external' as const, ref: 'tsk_1', actorKind: 'bot' as const, addressing: 'ambient' as const, threadEnded: true });
    expect(r.verdict).toBe('ignore-ended');
    expect(r.matchedRule).toBe('ignore-ended');
    expect(dispositions.rows[0]!.matchedRule).toBe('ignore-ended');
    expect(r.decision).toMatchObject({ action: 'ignore', wouldAccept: false });
  });

  it('规则 6 其余 → matchedRule=assess，进入 assessment（有引擎时被调用）', () => {
    const assess = vi.fn<[AssessInput], AssessOutcome | undefined>(() => ({ decided: false, reason: '无法判断' }));
    const threads2 = new FakeThreads();
    const dispositions2 = new FakeDispositions();
    const svc = new ThreadService({ threads: threads2, dispositions: dispositions2, now: () => 5000, assess });
    const r = svc.route(assessInput());
    expect(r.verdict).toBe('assess');
    expect(r.matchedRule).toBe('assess');
    expect(assess).toHaveBeenCalledTimes(1);
  });
});

describe('规则命中 → assessment 零调用（验收 1）', () => {
  it.each([
    ['dispatch', { triggerId: 't1', kind: 'external' as const, ref: 'tsk_1', actorKind: 'human' as const, addressing: 'mention' as const, directTargetAgentId: 'agt_9' }],
    ['ignore-ended', { triggerId: 't2', kind: 'external' as const, ref: 'tsk_1', actorKind: 'bot' as const, addressing: 'ambient' as const, threadEnded: true }],
    ['attach', { triggerId: 't3', kind: 'external' as const, ref: 'tsk_1', actorKind: 'bot' as const, addressing: 'ambient' as const, entityRef: 'tsk_1' }],
  ])('verdict=%s：匹配规则时绝不调 assessment（spy 零调用）', (_label, input) => {
    const assess = vi.fn<[AssessInput], AssessOutcome | undefined>();
    const threads2 = new FakeThreads();
    const dispositions2 = new FakeDispositions();
    const svc = new ThreadService({ threads: threads2, dispositions: dispositions2, now: () => 5000, assess });
    const r = svc.route(input);
    expect(r.verdict).not.toBe('assess');
    expect(r.matchedRule).toBeTruthy();
    expect(assess).not.toHaveBeenCalled();
  });
});

describe('未命中 → assessment；无引擎降级 needs-assessment（验收 2）', () => {
  it('无引擎（assess 未注入）→ 结局 needs-assessment，不抛异常', () => {
    const svc = makeService();
    expect(() => {
      const r = svc.route(assessInput());
      expect(r.verdict).toBe('assess');
      expect(r.matchedRule).toBe('assess');
      expect(r.decision).toMatchObject({ action: 'ignore', wouldAccept: true });
      expect(dispositions.rows[0]!.reason).toContain('needs-assessment');
    }).not.toThrow();
  });

  it('引擎存在但判不了（decided:false）→ 同样降级 needs-assessment，reason 带上引擎原因', () => {
    const assess = vi.fn<[AssessInput], AssessOutcome | undefined>(() => ({ decided: false, reason: '置信度不足' }));
    const threads2 = new FakeThreads();
    const dispositions2 = new FakeDispositions();
    const svc = new ThreadService({ threads: threads2, dispositions: dispositions2, now: () => 5000, assess });
    const r = svc.route(assessInput());
    expect(r.verdict).toBe('assess');
    expect(r.matchedRule).toBe('assess');
    expect(dispositions2.rows[0]!.reason).toContain('needs-assessment');
    expect(dispositions2.rows[0]!.reason).toContain('置信度不足');
  });

  it('引擎给定 decided:true → 采用引擎的 disposition', () => {
    const assess = vi.fn<[AssessInput], AssessOutcome | undefined>(() => ({
      decided: true,
      disposition: { action: 'accept', threadRef: 'gh:o/r', reason: '研判引擎判定应转工作' },
    }));
    const threads2 = new FakeThreads();
    const dispositions2 = new FakeDispositions();
    const svc = new ThreadService({ threads: threads2, dispositions: dispositions2, now: () => 5000, assess });
    const r = svc.route(assessInput());
    expect(r.verdict).toBe('assess');
    expect(r.matchedRule).toBe('assess');
    expect(r.decision).toMatchObject({ action: 'accept', reason: '研判引擎判定应转工作' });
  });
});

describe('「两者都缺」显式状态，非默认放行（验收 3）', () => {
  it('无确定性规则命中 + 无研判结论 → 显式 needs-assessment，reason 非空指明原因', () => {
    const svc = makeService();
    const r = svc.route(assessInput());
    // 显式状态：不是 accept、不是 dispatch —— 是 needs-assessment 的 ignore + 原因
    expect(r.decision?.action).not.toBe('accept');
    expect(r.decision?.action).not.toBe('dispatch');
    expect((r.decision as { action: string }).action).toBe('ignore');
    expect(r.decision?.reason).toBeTruthy();
    expect(dispositions.rows[0]!.reason).toContain('needs-assessment');
    expect(dispositions.rows[0]!.matchedRule).toBe('assess');
  });

  it('I4：降级路径 reason 必须非空（若有引擎 reason 缺失 → repo 仍拦）', () => {
    // 构造一个不满足 I4 的处置直接 record -> 必须抛错（repo 单写点守 I4）
    const svc = makeService();
    expect(() =>
      svc.record('trg-x', 'thr_1', { action: 'ignore', threadRef: 'r', reason: '', wouldAccept: true }, 'assess'),
    ).toThrow(/DISPOSITION_REASON_REQUIRED/);
  });
});