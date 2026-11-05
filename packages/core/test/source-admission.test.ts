/**
 * Source 准入：**什么算事件**。
 *
 * 这个文件锁的是设计 01 §4.6 那句话的可判定部分：
 * 「在进入领域之前丢掉机器人自己的消息与监听范围外的事件」。
 *
 * 为什么值得单独一个文件：它是**唯一**能挡住自激循环的地方。自激不会报错，
 * 只会把账单和噪音一起指数放大 —— 所以每条规则都必须有一条会因为「规则被删掉」而红的断言。
 */
import { describe, expect, it } from 'vitest';
import { admitEvent, policyOf, validateSourcePolicy } from '../src/source-admission.js';
import type { SourcePolicy } from '../src/source-admission.js';
import type { NormalizedEvent } from '../src/event-source.js';

const AT_NOON = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00Z

function ev(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    kind: 'external',
    idempotencyKey: 'gh:e1',
    ref: 'gh:owner/repo',
    actorKind: 'human',
    actorId: 'alice',
    addressing: 'ambient',
    summary: 'push e1',
    body: 'x',
    receivedAt: 1000,
    ...over,
  };
}

describe('自激保护：机器人自己发的消息进领域之前就被丢弃', () => {
  it('selfActorIds 命中 actorId → 拒绝，rule=self，理由可读', () => {
    const policy: SourcePolicy = { selfActorIds: ['markus-bot'] };
    const r = admitEvent(ev({ actorKind: 'bot', actorId: 'markus-bot' }), policy, AT_NOON);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.rule).toBe('self');
      expect(r.reason).toContain('markus-bot');
      expect(r.reason).toContain('自激');
    }
  });

  it('身份相同但 actorKind=human 不按 self 丢弃（同一 id 换语义不算自激）', () => {
    const policy: SourcePolicy = { selfActorIds: ['markus-bot'] };
    expect(admitEvent(ev({ actorKind: 'human', actorId: 'markus-bot' }), policy, AT_NOON).admitted).toBe(true);
  });

  it('未配置身份时**不**一刀切丢机器人：通用信封默认 actorKind=bot，全丢会让内部脚本事件全灭', () => {
    expect(admitEvent(ev({ actorKind: 'bot', actorId: 'ci-runner' }), {}, AT_NOON).admitted).toBe(true);
  });

  it('self 排在任何其他过滤器之前：该事件本来也不在监听范围内，也必须报 self', () => {
    // 顺序即优先级。若 self 排在 scope 后面，自激消息会先被 scope 拒掉，
    // 一旦监听范围扩大就又漏回来 —— 自激保护不能依赖另一条规则的副作用。
    const policy: SourcePolicy = { selfActorIds: ['markus-bot'], refPrefixes: ['xhs:'] };
    const r = admitEvent(ev({ actorKind: 'bot', actorId: 'markus-bot', ref: 'gh:owner/repo' }), policy, AT_NOON);
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.rule).toBe('self');
  });
});

describe('事件类别与监听范围', () => {
  it('acceptKinds 非空时只放行列出的类别', () => {
    const policy: SourcePolicy = { acceptKinds: ['mention'] };
    expect(admitEvent(ev({ kind: 'mention' }), policy, AT_NOON).admitted).toBe(true);
    const r = admitEvent(ev({ kind: 'external' }), policy, AT_NOON);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.rule).toBe('kind');
      expect(r.reason).toContain('external');
    }
  });

  it('acceptKinds 为空数组 = 全收（不用「空=全拒」这种反直觉语义）', () => {
    expect(admitEvent(ev({ kind: 'chat' }), { acceptKinds: [] }, AT_NOON).admitted).toBe(true);
  });

  it('refPrefixes 是监听范围：不在范围内的事件不进入领域', () => {
    const policy: SourcePolicy = { refPrefixes: ['gh:owner/repo', 'gh:owner/other'] };
    expect(admitEvent(ev({ ref: 'gh:owner/other' }), policy, AT_NOON).admitted).toBe(true);
    const r = admitEvent(ev({ ref: 'gh:someone/else' }), policy, AT_NOON);
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.rule).toBe('scope');
      expect(r.reason).toContain('gh:someone/else');
    }
  });
});

describe('时间条件（「只在时间上成立的事件」）', () => {
  const policy: SourcePolicy = { activeWindow: { fromMinute: 9 * 60, toMinute: 18 * 60, utcOffsetMinutes: 0 } };

  it('窗口内放行', () => {
    expect(admitEvent(ev(), policy, Date.UTC(2026, 10, 3, 9, 0, 0)).admitted).toBe(true);
    expect(admitEvent(ev(), policy, Date.UTC(2026, 10, 3, 17, 59, 0)).admitted).toBe(true);
  });

  it('窗口外拒绝，且理由说清窗口与现状', () => {
    const r = admitEvent(ev(), policy, Date.UTC(2026, 10, 3, 18, 0, 0));
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.rule).toBe('window');
      expect(r.reason).toContain('540');
      expect(r.reason).toContain('1080');
    }
  });

  it('跨零点窗口（to < from）两端都算窗口内', () => {
    const night: SourcePolicy = { activeWindow: { fromMinute: 22 * 60, toMinute: 6 * 60 } };
    expect(admitEvent(ev(), night, Date.UTC(2026, 10, 3, 23, 30, 0)).admitted).toBe(true);
    expect(admitEvent(ev(), night, Date.UTC(2026, 10, 3, 5, 30, 0)).admitted).toBe(true);
    expect(admitEvent(ev(), night, Date.UTC(2026, 10, 3, 12, 0, 0)).admitted).toBe(false);
  });

  it('utcOffsetMinutes 是按来源本地时间算的（北京时间 09:00 == 01:00Z）', () => {
    const workHours: SourcePolicy = { activeWindow: { fromMinute: 9 * 60, toMinute: 18 * 60, utcOffsetMinutes: 480 } };
    // 01:00Z = 北京 09:00 → 窗口内
    expect(admitEvent(ev(), workHours, Date.UTC(2026, 10, 3, 1, 0, 0)).admitted).toBe(true);
    // 14:00Z = 北京 22:00 → 窗口外（若漏了 offset，14:00「UTC 本地」会被错判成窗口内）
    expect(admitEvent(ev(), workHours, Date.UTC(2026, 10, 3, 14, 0, 0)).admitted).toBe(false);
  });
});

describe('配置的读路径宽容 / 写路径严格（一对相反的纪律，各有理由）', () => {
  it('policyOf 遇到垃圾类型时归一为「不限制」，绝不抛错', () => {
    expect(policyOf(null)).toEqual({});
    expect(policyOf({})).toEqual({});
    expect(policyOf({ policy: 'not-an-object' })).toEqual({});
    expect(policyOf({ policy: { selfActorIds: 'markus-bot' } })).toEqual({});
    expect(policyOf({ policy: { activeWindow: { fromMinute: 'x' } } })).toEqual({});
  });

  it('policyOf 保留合法字段', () => {
    const p = policyOf({
      policy: { selfActorIds: ['markus-bot'], acceptKinds: ['mention'], refPrefixes: ['gh:'], activeWindow: { fromMinute: 0, toMinute: 60 } },
    });
    expect(p.selfActorIds).toEqual(['markus-bot']);
    expect(p.acceptKinds).toEqual(['mention']);
    expect(p.refPrefixes).toEqual(['gh:']);
    expect(p.activeWindow).toEqual({ fromMinute: 0, toMinute: 60, utcOffsetMinutes: 0 });
  });

  it('validateSourcePolicy 把写错的地方说出来（否则规则静默不生效）', () => {
    expect(validateSourcePolicy({})).toEqual([]);
    expect(validateSourcePolicy({ policy: { selfActorIds: ['ok'] } })).toEqual([]);

    expect(validateSourcePolicy({ policy: [] })[0]).toContain('必须是对象');
    expect(validateSourcePolicy({ policy: { selfActorIds: 'markus-bot' } })[0]).toContain('selfActorIds');
    expect(validateSourcePolicy({ policy: { acceptKinds: [1, 2] } })[0]).toContain('acceptKinds');
    expect(validateSourcePolicy({ policy: { activeWindow: { fromMinute: 5000, toMinute: 10 } } })[0]).toContain('fromMinute');
  });
});
