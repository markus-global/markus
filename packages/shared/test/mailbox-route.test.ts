/**
 * Cut-1 golden contract: `routeMailboxItem()` is the single decision point for
 * 「how is this item routed」. These assertions ARE the behaviour contract —
 * they lock today's routing facts so the refactor proves itself behaviour-neutral,
 * and they bite the moment anyone re-scatters a rule outside `route()`.
 */
import { describe, it, expect } from 'vitest';
import {
  routeMailboxItem,
  MAILBOX_TYPE_REGISTRY,
  isStrictStateItem,
  resolveEntityKeys,
  resolveMailboxDestination,
  type MailboxItemType,
  type MailboxPayload,
} from '../src/types/mailbox.js';

function lite(
  sourceType: MailboxItemType,
  payload: Partial<MailboxPayload> = {},
  metadata?: Record<string, unknown>,
  structured: { intent?: 'deliver' | 'trigger_execution' | 'action_required'; round?: number } = {},
) {
  return {
    sourceType,
    payload: { summary: '', content: '', ...payload } as MailboxPayload,
    metadata,
    ...(structured.intent ? { envelope: { intent: structured.intent } } : {}),
    ...(structured.round !== undefined ? { round: structured.round } : {}),
  };
}

/** The golden table — every field of every type, exactly as the legacy scattered
 *  readers computed it on 2026-11-09. Changing any cell must be a conscious act. */
const GOLDEN: Record<MailboxItemType, {
  priority: number;
  invokesLLM: boolean;
  affinity: readonly string[];
  strictState: boolean;
  triageStaleDrop: boolean;
}> = {
  system_event:         { priority: 1, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: false },
  human_chat:           { priority: 0, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  task_comment:         { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  mention:              { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'user', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  session_reply:        { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  task_status_update:   { priority: 1, invokesLLM: false, affinity: ['task', 'system'], strictState: false, triageStaleDrop: true },
  a2a_message:          { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'workunit', 'system'], strictState: false, triageStaleDrop: false },
  review_request:       { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], strictState: true,  triageStaleDrop: false },
  requirement_comment:  { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  requirement_update:   { priority: 1, invokesLLM: false, affinity: ['requirement', 'system'], strictState: false, triageStaleDrop: false },
  daily_report:         { priority: 2, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  heartbeat:            { priority: 3, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  memory_consolidation: { priority: 4, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  workflow_update:      { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  callback_result:      { priority: 1, invokesLLM: true,  affinity: ['conversation', 'system'], strictState: false, triageStaleDrop: true },
};

describe('routeMailboxItem — golden decision table', () => {
  for (const [type, want] of Object.entries(GOLDEN) as [MailboxItemType, typeof GOLDEN[MailboxItemType]][]) {
    it(`${type} routes exactly as the legacy readers did`, () => {
      const r = routeMailboxItem(lite(type));
      expect(r.type).toBe(type);
      expect(r.priority).toBe(want.priority);
      expect(r.invokesLLM).toBe(want.invokesLLM);
      expect(r.affinity).toEqual(want.affinity);
      expect(r.strictState).toBe(want.strictState);
      expect(r.triageStaleDrop).toBe(want.triageStaleDrop);
    });
  }
});

describe('routeMailboxItem — 权威态只读结构字段（第六刀 C2）', () => {
  it('intent=trigger_execution 与类型无关地构成权威态', () => {
    const r = routeMailboxItem(lite('task_status_update', {}, undefined, { intent: 'trigger_execution' }));
    expect(r.strictState).toBe(true);
  });

  it('review_request 注册表内置权威态', () => {
    expect(routeMailboxItem(lite('review_request')).strictState).toBe(true);
  });

  it('intent=action_required 只对声明了 actionRequiredStrict 的类型成立', () => {
    expect(routeMailboxItem(lite('requirement_update', {}, undefined, { intent: 'action_required' })).strictState).toBe(true);
    expect(routeMailboxItem(lite('workflow_update', {}, undefined, { intent: 'action_required' })).strictState).toBe(true);
    // 心跳可能带动作（不得折叠），但它**不是**权威态——否则会占满并发锁。
    expect(routeMailboxItem(lite('heartbeat', {}, undefined, { intent: 'action_required' })).strictState).toBe(false);
    expect(routeMailboxItem(lite('requirement_update')).strictState).toBe(false);
  });

  it('改 payload.extra 不影响路由（I2：结构不从载荷推断）', () => {
    const base = { taskId: 'tsk_x' };
    const a = routeMailboxItem(lite('task_status_update', { ...base, extra: { triggerExecution: true, round: 7 } }));
    const b = routeMailboxItem(lite('task_status_update', { ...base, extra: { triggerExecution: false, round: 99, actionRequired: true } }));
    const c = routeMailboxItem(lite('task_status_update', { ...base }));
    // 三者除载荷外完全相同 → 路由必须逐字段相同（含 strictState / dedupeKey）。
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.strictState).toBe(false);
  });
});

describe('routeMailboxItem — 幂等键同样只读结构字段', () => {
  it('review_request + 结构 round → type:task:round（值不变）', () => {
    const r = routeMailboxItem(lite('review_request', { taskId: 'tsk_x' }, undefined, { round: 2 }));
    expect(r.dedupeKey).toBe('review_request:tsk_x:2');
  });

  it('payload.extra.round / metadata.round 不再进幂等键', () => {
    expect(routeMailboxItem(lite('review_request', { taskId: 'tsk_x', extra: { round: 3 } })).dedupeKey).toBeUndefined();
    expect(routeMailboxItem(lite('review_request', { taskId: 'tsk_x' }, { round: 3 })).dedupeKey).toBeUndefined();
  });

  it('缺 taskId 或缺 round → 不施加约束', () => {
    expect(routeMailboxItem(lite('review_request', { taskId: 'tsk_x' })).dedupeKey).toBeUndefined();
    expect(routeMailboxItem(lite('review_request', {}, undefined, { round: 1 })).dedupeKey).toBeUndefined();
  });

  it('非幂等类型永不施加约束', () => {
    expect(routeMailboxItem(lite('task_comment', { taskId: 'tsk_x' }, undefined, { round: 1 })).dedupeKey).toBeUndefined();
  });
});

describe('routeMailboxItem — pure and conservative', () => {
  it('is a pure function (same input → same output)', () => {
    const item = lite('mention', { taskId: 't1' }, { senderId: 'u1' });
    expect(routeMailboxItem(item)).toEqual(routeMailboxItem(item));
  });

  it('unknown type falls back conservatively (no throw, no silent drop)', () => {
    const r = routeMailboxItem({ sourceType: 'bogus_type' as MailboxItemType, payload: { summary: '', content: '' } });
    expect(r.invokesLLM).toBe(true);
    expect(r.priority).toBe(2);
    expect(r.affinity).toEqual(['system']);
    expect(r.strictState).toBe(false);
    expect(r.triageStaleDrop).toBe(false);
    expect(r.dedupeKey).toBeUndefined();
  });
});

describe('consumers must not fork from route()', () => {
  it('registry has no flat policy fields left — policy is nested', () => {
    const d = MAILBOX_TYPE_REGISTRY.human_chat as unknown as Record<string, unknown>;
    expect(d.policy).toBeTruthy();
    expect(d.priority).toBeUndefined();
    expect(d.defaultPriority).toBeUndefined();
    expect(d.invokesLLM).toBeUndefined();
    expect(d.entityScopes).toBeUndefined();
  });

  it('isStrictStateItem agrees with route() for every type', () => {
    for (const type of Object.keys(GOLDEN) as MailboxItemType[]) {
      expect(isStrictStateItem(lite(type))).toBe(routeMailboxItem(lite(type)).strictState);
    }
  });

  it('resolveEntityKeys derives keys only from route().affinity', () => {
    // A payload with every possible entity populated: the keys produced must be
    // exactly the affinity dims route() declares (minus system fallback).
    const item = lite('human_chat', { taskId: 't1', requirementId: 'r1' }, { senderId: 'u1', dbSessionId: 's1' });
    const keys = resolveEntityKeys(item, 'agent1');
    expect(keys).toContain('task:t1');
    expect(keys).toContain('req:r1');
    expect(keys).toContain('conv:s1');
  });
});

// ─── C8-A: entity identity converges on the WorkUnit ─────────────────────────
//
// The symptom this locks down: one piece of work reached the recipient through
// two different transport routes must NOT look like two entities. Conversely a
// row that predates the WorkUnit (workUnitRef null) must keep producing exactly
// today's keys — that is the whole read-only-compatibility promise.

describe('C8-A — resolveEntityKeys yields to the WorkUnit', () => {
  function withWu(
    sourceType: MailboxItemType,
    payload: Partial<MailboxPayload>,
    metadata: Record<string, unknown> | undefined,
    workUnitRef: string | null,
  ) {
    return { ...lite(sourceType, payload, metadata), workUnitRef };
  }

  it('same task + different channelKey + same WU → identical entity keys', () => {
    const a = resolveEntityKeys(
      withWu('a2a_message', {}, { senderId: 'agt_a' }, 'a2a:task:tsk_1'),
      'agent1',
    );
    const b = resolveEntityKeys(
      { ...withWu('a2a_message', {}, { senderId: 'agt_a' }, 'a2a:task:tsk_1'),
        payload: { summary: '', content: '', extra: { channelKey: 'dm:a2a:a:b' } } },
      'agent1',
    );
    expect(a).toEqual(b);
    expect(a).toContain('task:tsk_1');
  });

  it('a WU-carrying item emits no channel: or conv: key (transport identity)', () => {
    const keys = resolveEntityKeys(
      { ...withWu('a2a_message', {}, { senderId: 'agt_a', dbSessionId: 's1' }, 'a2a:channel:dm:a2a:a:b'),
        payload: { summary: '', content: '', extra: { channelKey: 'dm:a2a:a:b' } } },
      'agent1',
    );
    expect(keys.some(k => k.startsWith('channel:'))).toBe(false);
    expect(keys.some(k => k.startsWith('conv:'))).toBe(false);
    expect(keys).toEqual(['wu:a2a:channel:dm:a2a:a:b']);
  });

  it('legacy row with no WorkUnit falls back to the conservative system key — `channel:` is deleted, not kept', () => {
    // C8-A 是「删机制」而不是「加守卫」：`channel` 作用域整个消失，所以旧行不会
    // 再产出 `channel:` 键，而是落到「未知 = 保守串行」。这是**安全方向**的退化
    // （串行只是慢），而留着 `channel:` 会让投递通道继续拥有实体身份（分裂会复发）。
    const item = { ...lite('a2a_message', { extra: { channelKey: 'dm:a2a:a:b' } }, { senderId: 'agt_a' }), workUnitRef: null };
    expect(resolveEntityKeys(item, 'agent1')).toEqual(['system:agent1']);
  });

  it('never empty, even for a WU with no other dimension', () => {
    const keys = resolveEntityKeys(withWu('a2a_message', {}, undefined, 'a2a:channel:c'), 'agent1');
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('C8-A — dedupeKey derives from the entity, not from the payload', () => {
  it('takes the task id from the WU ref when the payload is silent', () => {
    const item = {
      ...lite('review_request', {}, undefined, { round: 3 }),
      workUnitRef: 'task_tsk_9_r3',
    };
    expect(routeMailboxItem(item).dedupeKey).toBe('review_request:tsk_9:3');
  });

  it('payload taskId still wins shape-wise for legacy rows (no WU)', () => {
    const item = lite('review_request', { taskId: 'tsk_x' }, undefined, { round: 2 });
    expect(routeMailboxItem(item).dedupeKey).toBe('review_request:tsk_x:2');
  });
});

describe('C8-A — three destinations, one decision point', () => {
  it('no entity (system fallback only) → overview', () => {
    expect(resolveMailboxDestination(['system:agent1'], [])).toBe('overview');
    expect(resolveMailboxDestination(['system:agent1'], null)).toBe('overview');
  });

  it('intersects the active turn → inject (never queue behind itself)', () => {
    expect(resolveMailboxDestination(['task:t1', 'wu:x'], ['task:t1'])).toBe('inject');
  });

  it('different entity → queue (parallel is safe)', () => {
    expect(resolveMailboxDestination(['task:t2'], ['task:t1'])).toBe('queue');
  });

  it('active turn unknown (idle agent) → queue, never inject', () => {
    expect(resolveMailboxDestination(['task:t1'], null)).toBe('queue');
    expect(resolveMailboxDestination(['task:t1'], [])).toBe('queue');
  });
});
