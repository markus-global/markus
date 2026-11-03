import { describe, it, expect } from 'vitest';
import {
  AUTONOMIES,
  AUTONOMY_RANK,
  RESOURCE_SCOPES,
  SCOPE_RANK,
  autonomyNeedsApproval,
  contentHashIdempotencyKey,
  deriveStage,
  gateAction,
  gateVerdict,
  hasRegisteredPrefix,
  isPersonStage,
  isScope,
  parseThreadRef,
  scopeAtLeast,
  stageSortRank,
  threadRefOf,
  triggerPriority,
  type StageFacts,
  type ThreadStage,
  type ActionVerdict,
  type Autonomy,
  type ResourceScope,
} from './thread.js';

const base: StageFacts = {
  pendingApproval: false,
  openQuestion: false,
  submittedReview: false,
  reportedBlockedSinceHuman: false,
  assignment: { state: 'running' },
};

describe('deriveStage — 第一个命中胜出', () => {
  it('待审批永远最优先（即使其他条件也成立）', () => {
    expect(
      deriveStage({ ...base, pendingApproval: true, openQuestion: true, submittedReview: true, reportedBlockedSinceHuman: true }),
    ).toBe('person:approval');
  });

  it('待回答次之', () => {
    expect(deriveStage({ ...base, openQuestion: true, submittedReview: true })).toBe('person:answer');
  });

  it('待验收', () => {
    expect(deriveStage({ ...base, submittedReview: true, reportedBlockedSinceHuman: true })).toBe('person:review');
  });

  it('阻塞', () => {
    expect(deriveStage({ ...base, reportedBlockedSinceHuman: true })).toBe('person:blocked');
  });

  it('排队等资源', () => {
    expect(deriveStage({ ...base, assignment: { state: 'pending' } })).toBe('system:queued');
  });

  it('无分配 → idle', () => {
    expect(deriveStage({ ...base, assignment: undefined })).toBe('idle');
  });

  it('分配已结束 → idle', () => {
    expect(deriveStage({ ...base, assignment: { state: 'ended' } })).toBe('idle');
  });

  it('正在跑', () => {
    expect(deriveStage(base)).toBe('working');
  });

  it('任意事实组合恰有一个 stage，且七个值都可达（穷举 64 种）', () => {
    const seen = new Set<ThreadStage>();
    for (let mask = 0; mask < 64; mask++) {
      const facts: StageFacts = {
        pendingApproval: !!(mask & 1),
        openQuestion: !!(mask & 2),
        submittedReview: !!(mask & 4),
        reportedBlockedSinceHuman: !!(mask & 8),
        assignment: [{ state: 'pending' as const }, { state: 'running' as const }, { state: 'ended' as const }, undefined][
          (mask >> 4) & 3
        ],
      };
      const stage = deriveStage(facts);
      expect(typeof stage).toBe('string');
      seen.add(stage);
    }
    expect(seen.size).toBe(7);
  });
});

describe('stageSortRank / isPersonStage', () => {
  it('四类「在等人」排在最前且内部有序', () => {
    expect(stageSortRank('person:approval')).toBeLessThan(stageSortRank('person:answer'));
    expect(stageSortRank('person:answer')).toBeLessThan(stageSortRank('person:review'));
    expect(stageSortRank('person:review')).toBeLessThan(stageSortRank('person:blocked'));
    expect(stageSortRank('person:blocked')).toBeLessThan(stageSortRank('system:queued'));
    expect(stageSortRank('idle')).toBe(6);
  });

  it('isPersonStage 只认 person: 前缀', () => {
    expect(isPersonStage('person:blocked')).toBe(true);
    expect(isPersonStage('working')).toBe(false);
  });
});

describe('ThreadRef — 一套命名空间，不是两套分类法', () => {
  it('解析外部命名空间键', () => {
    expect(parseThreadRef('xhs:brand_01')).toEqual({ prefix: 'xhs', local: 'brand_01' });
    expect(parseThreadRef('gh:owner/repo')).toEqual({ prefix: 'gh', local: 'owner/repo' });
  });

  it('平台内置 id 无前缀', () => {
    expect(parseThreadRef('tsk_7f3a')).toBeNull();
    expect(parseThreadRef('cs_1b4bab83')).toBeNull();
  });

  it('畸形输入不抛异常，返回 null', () => {
    expect(parseThreadRef(':x')).toBeNull();
    expect(parseThreadRef('x:')).toBeNull();
    expect(parseThreadRef('')).toBeNull();
  });

  it('threadRefOf 归一化并拒绝空键', () => {
    expect(threadRefOf('  xhs:brand_01  ')).toBe('xhs:brand_01');
    expect(() => threadRefOf('   ')).toThrow(/THREAD_REF_EMPTY/);
  });

  it('前缀必须已注册（平台内置 id 免检）', () => {
    expect(hasRegisteredPrefix('tsk_1', [])).toBe(true);
    expect(hasRegisteredPrefix('xhs:a', ['xhs'])).toBe(true);
    expect(hasRegisteredPrefix('myspace:a', ['xhs'])).toBe(false);
  });
});

describe('triggerPriority — 规则函数，不是类型属性', () => {
  it('人说话永远第一', () => {
    expect(triggerPriority({ kind: 'chat', actorKind: 'human', addressing: 'direct' })).toBe(0);
  });

  it('人在等人的流里发言也优先（但不是 0）', () => {
    expect(triggerPriority({ kind: 'external', actorKind: 'bot', addressing: 'ambient', stage: 'person:answer' })).toBe(1);
  });

  it('a2a 点名 = 1；外部事件 = 2；默认 3；定时垫底', () => {
    expect(triggerPriority({ kind: 'a2a', actorKind: 'agent', addressing: 'direct' })).toBe(1);
    expect(triggerPriority({ kind: 'external', actorKind: 'bot', addressing: 'ambient' })).toBe(2);
    expect(triggerPriority({ kind: 'task', actorKind: 'system', addressing: 'ambient' })).toBe(3);
    expect(triggerPriority({ kind: 'schedule', actorKind: 'system', addressing: 'ambient' })).toBe(4);
  });
});

describe('gateVerdict — 顺序即语义', () => {
  const none = {
    alreadyHandled: false,
    actorKind: 'human' as const,
    addressing: 'ambient' as const,
    hasOwner: false,
    hasSubscriptions: false,
    threadEnded: false,
  };

  it('幂等命中永远第一个返回', () => {
    expect(gateVerdict('external', { ...none, alreadyHandled: true, directTargetAgentId: 'a1' })).toBe('duplicate');
  });

  it('已结束的卡不被 bot/CI 唤醒，但人发消息可以', () => {
    expect(gateVerdict('external', { ...none, actorKind: 'bot', threadEnded: true, hasOwner: true })).toBe('ignore-ended');
    expect(gateVerdict('external', { ...none, actorKind: 'human', threadEnded: true })).toBe('assess');
  });

  it('mention 算 explicit：人 @ 了谁就直接投给谁', () => {
    expect(gateVerdict('external', { ...none, addressing: 'mention', directTargetAgentId: 'agt_1' })).toBe('dispatch');
  });

  it('bot 的 mention 不算数（不能靠 @ 触发派发）', () => {
    expect(gateVerdict('external', { ...none, actorKind: 'bot', addressing: 'mention', directTargetAgentId: 'agt_1' })).toBe(
      'assess',
    );
  });

  it('有主或有订阅 → 直通', () => {
    expect(gateVerdict('external', { ...none, hasOwner: true })).toBe('direct-through');
    expect(gateVerdict('external', { ...none, hasSubscriptions: true })).toBe('direct-through');
  });

  it('指向既有实体 → attach', () => {
    expect(gateVerdict('external', { ...none, entityRef: 'tsk_1' })).toBe('attach');
  });

  it('判不了 → assess（v1 记录 reason 后延后）', () => {
    expect(gateVerdict('external', none)).toBe('assess');
  });
});

describe('scope 与 autonomy — 正交的两个维度', () => {
  it('scope 有序：read < draft < publish < admin', () => {
    expect(scopeAtLeast('publish', 'draft')).toBe(true);
    expect(scopeAtLeast('draft', 'publish')).toBe(false);
    expect(SCOPE_RANK.admin).toBe(3);
  });

  it('isScope 拒绝自由文本（防止 scope 退化成字符串）', () => {
    expect(isScope('publish')).toBe(true);
    expect(isScope('commit')).toBe(false);
    expect(isScope('')).toBe(false);
  });

  it('升到 auto 及以上需要人批，off/observe 可自助', () => {
    expect(autonomyNeedsApproval('observe')).toBe(false);
    expect(autonomyNeedsApproval('auto')).toBe(true);
    expect(autonomyNeedsApproval('trusted')).toBe(true);
    expect(AUTONOMY_RANK.off).toBe(0);
  });
});

describe('幂等键兜底', () => {
  it('同一时间窗内同内容 → 同一个键', () => {
    // 两个时间点必须落在同一个 60s 桶内（bucket = floor(ts/window)）；
    // 用绝对时间分桶是刻意的：重启后仍能对同一批重投去重。
    const a = contentHashIdempotencyKey('external', 'CI failed on main', 60_000, 1_000_000);
    const b = contentHashIdempotencyKey('external', 'CI failed on main', 60_000, 1_010_000);
    expect(a).toBe(b);
  });

  it('跨窗口或内容不同 → 不同键', () => {
    const a = contentHashIdempotencyKey('external', 'x', 60_000, 1_000_000);
    const b = contentHashIdempotencyKey('external', 'x', 60_000, 1_120_000);
    const c = contentHashIdempotencyKey('external', 'y', 60_000, 1_000_000);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('gateAction — 执行前闸门（四档 × 四级真值表）', () => {
  /**
   * 16 个组合全部列出来，而不是只测几个「有代表性」的。
   * 漏列的组合 = 默许了一种没人审过的行为，等出事时没人能说它「本来该怎样」。
   */
  const EXPECTED: Record<Autonomy, Record<ResourceScope, ActionVerdict>> = {
    off: { read: 'deny', draft: 'deny', publish: 'deny', admin: 'deny' },
    observe: { read: 'allow', draft: 'record-only', publish: 'record-only', admin: 'deny' },
    auto: { read: 'allow', draft: 'allow', publish: 'allow', admin: 'deny' },
    trusted: { read: 'allow', draft: 'allow', publish: 'allow', admin: 'deny' },
  };

  it('16 组合全部符合设计 §7.8 的四档表', () => {
    for (const autonomy of AUTONOMIES) {
      for (const scope of RESOURCE_SCOPES) {
        expect(gateAction(scope, autonomy), `${autonomy} × ${scope}`).toBe(
          EXPECTED[autonomy][scope],
        );
      }
    }
  });

  // ↓ B3.1–B3.5 逐档判据
  it('B3.1 off：任何动作都直接拒绝（连读都不行）', () => {
    for (const scope of RESOURCE_SCOPES) expect(gateAction(scope, 'off')).toBe('deny');
  });

  it('B3.2 observe：除只读外只记录判断，不执行', () => {
    expect(gateAction('read', 'observe')).toBe('allow');
    expect(gateAction('draft', 'observe')).toBe('record-only');
    expect(gateAction('publish', 'observe')).toBe('record-only');
  });

  it('B3.3 auto：非红线动作放行', () => {
    expect(gateAction('draft', 'auto')).toBe('allow');
    expect(gateAction('publish', 'auto')).toBe('allow');
  });

  it('B3.4 trusted：非红线动作放行', () => {
    expect(gateAction('draft', 'trusted')).toBe('allow');
    expect(gateAction('publish', 'trusted')).toBe('allow');
  });

  it('B3.5 红线：admin 级在任何档位（含 trusted）都被拒绝', () => {
    for (const autonomy of AUTONOMIES) expect(gateAction('admin', autonomy)).toBe('deny');
    // 单独把 trusted 再钉一次：这条最容易被“信任了就都放行”的直觉误放
    expect(gateAction('admin', 'trusted')).toBe('deny');
  });

  it('默认档位（observe）下「改内容」不会被执行——record-only 不是 allow 的别名', () => {
    // 这条防的是一个很自然的退化：「反正也是要执行，先记后执行算了」
    expect(gateAction('draft', 'observe')).not.toBe('allow');
    expect(gateAction('publish', 'observe')).not.toBe('allow');
  });

  it('授权闸门与执行闸门不是同一件事（防止两者再被混用）', () => {
    // autonomyNeedsApproval 问的是「能不能升档」，auto 升档需人批……
    expect(autonomyNeedsApproval('auto')).toBe(true);
    // ……但已授权为 auto 的 agent 在执行 publish 级动作时是放行的。
    // 把这两句当成同一件事，就会出现「auto 也要每次审批」或「observe 也能直接发」两种错。
    expect(gateAction('publish', 'auto')).toBe('allow');
    expect(gateAction('publish', 'observe')).toBe('record-only');
  });
});
