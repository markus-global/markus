/**
 * 第六刀 C3 —— FSM-2 的**声明式契约**。
 *
 * 这些断言锁的不是实现，而是三件事实：
 *  1. `dropped` 已经不是取值域（旧终态删除），`catch_all` 是新增的归集态；
 *  2. 矩阵是**唯一**的迁移判据，非法迁移被判死；
 *  3. `resolve(envelope)` 只读信封 —— 签名里根本没有 `payload` / `sourceType`，
 *     而且它只有两种结局：唯一 active 目标，或 `catch_all`（必有回声）。
 */
import { describe, it, expect } from 'vitest';
import {
  MAILBOX_TRANSITIONS,
  canTransitionSignal,
  normalizeSignalStatus,
  isBounceSignalStatus,
  isKnownSignalStatus,
  type MailboxItemStatus,
} from '../src/types/mailbox.js';
import {
  ACTIVE_BOUNCE_REASONS,
  BOUNCE_REASONS,
  catchAllTargetOf,
  isActiveBounceReason,
  isBounceReason,
  resolveEnvelopeTarget,
  type SignalAddressLookup,
} from '../src/mail.js';

const ALL: MailboxItemStatus[] = [
  'queued', 'processing', 'completed', 'deferred', 'merged', 'bounced', 'catch_all',
];

describe('MAILBOX_TRANSITIONS — 状态机取值域与边', () => {
  it('取值域里没有 dropped（终态已删），有 catch_all（归集态）', () => {
    expect(ALL as string[]).not.toContain('dropped');
    expect(ALL).toContain('catch_all');
    expect(Object.keys(MAILBOX_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('关键边齐备：认领 / 收口 / preempt / 回队 / 归集 / 人认领 / 补偿重投', () => {
    expect(canTransitionSignal('queued', 'processing')).toBe(true);
    expect(canTransitionSignal('processing', 'completed')).toBe(true);
    expect(canTransitionSignal('processing', 'deferred')).toBe(true);
    expect(canTransitionSignal('processing', 'merged')).toBe(true);
    expect(canTransitionSignal('processing', 'bounced')).toBe(true);
    expect(canTransitionSignal('processing', 'queued')).toBe(true);   // 回队/租约回收
    expect(canTransitionSignal('deferred', 'queued')).toBe(true);     // resurfaceDue
    expect(canTransitionSignal('bounced', 'catch_all')).toBe(true);   // 归集
    expect(canTransitionSignal('catch_all', 'queued')).toBe(true);    // 人认领
    // 补偿重投（P1.x R6）：复用既有未收口行 → 重投时必须能回队，
    // storage `requeueItem` 的 WHERE 也显式列了 `bounced`。
    expect(canTransitionSignal('bounced', 'queued')).toBe(true);
  });

  it('终态不可反向：completed / merged 没有出口', () => {
    expect(MAILBOX_TRANSITIONS.completed).toEqual([]);
    expect(MAILBOX_TRANSITIONS.merged).toEqual([]);
    for (const to of ALL) {
      expect(canTransitionSignal('completed', to)).toBe(to === 'completed');
      expect(canTransitionSignal('merged', to)).toBe(to === 'merged');
    }
  });

  it('非法跳转被判死（不是“没写规则就放行”）', () => {
    expect(canTransitionSignal('queued', 'catch_all')).toBe(false);   // 必须先 bounced
    expect(canTransitionSignal('completed', 'queued')).toBe(false);   // 不能复活
    expect(canTransitionSignal('merged', 'processing')).toBe(false);
    expect(canTransitionSignal('catch_all', 'completed')).toBe(false);
  });

  it('同态写不被判非法（它是字段更新，不是迁移）', () => {
    for (const s of ALL) expect(canTransitionSignal(s, s)).toBe(true);
  });

  it('取值域外的历史态（failed）一律判非法，且不抛异常', () => {
    // 真实库里有 C3 之前的 failed 行；它们仍可由 requeueItem 的 SQL 回队，
    // 但绝不因为“矩阵里没写规则”就获得默认放行 —— 也不应该把数据问题变成崩溃。
    expect(canTransitionSignal('failed', 'queued')).toBe(false);
    expect(canTransitionSignal('failed', 'completed')).toBe(false);
    expect(isKnownSignalStatus('failed')).toBe(false);
    expect(isKnownSignalStatus('bounced')).toBe(true);
    expect(() => canTransitionSignal('some-future-state', 'queued')).not.toThrow();
  });
});

describe('历史 dropped 行的读归一（只读，不回填）', () => {
  it('dropped → bounced；当前取值域原样返回', () => {
    expect(normalizeSignalStatus('dropped')).toBe('bounced');
    for (const s of ALL) expect(normalizeSignalStatus(s)).toBe(s);
  });

  it('退信态谓词只认 bounced / catch_all', () => {
    expect(isBounceSignalStatus('bounced')).toBe(true);
    expect(isBounceSignalStatus('catch_all')).toBe(true);
    expect(isBounceSignalStatus('completed')).toBe(false);
    expect(isBounceSignalStatus('queued')).toBe(false);
  });
});

describe('catch-all 桶 id —— 唯一构造点', () => {
  it('一个 agent 一个桶，形状稳定', () => {
    expect(catchAllTargetOf('agt_1')).toBe('catchall:agt_1');
    expect(catchAllTargetOf('agt_1')).toBe(catchAllTargetOf('agt_1')); // 同一输入同一字节序列
  });
});

describe('resolveEnvelopeTarget —— 唯一解析器（只读信封 / 两种结局）', () => {
  const book = (map: Record<string, { agentId: string; targetRef: string }>): SignalAddressLookup => ({
    findActive: (address) => map[address],
  });

  it('to=agent 直达：内部投递不需要地址簿', () => {
    const r = resolveEnvelopeTarget({ to: { kind: 'agent', agentId: 'agt_a' } }, 'agt_a');
    expect(r).toEqual({ matched: true, targetRef: 'agent:agt_a', agentId: 'agt_a', address: 'agent:agt_a' });
  });

  it('to=markus 命中 active 绑定 → 唯一目标', () => {
    const addr = 'cto.markus@markus.global';
    const r = resolveEnvelopeTarget(
      { to: { kind: 'markus', address: addr, local: 'cto', orgSlug: 'markus' } },
      'agt_owner',
      book({ [addr]: { agentId: 'agt_b', targetRef: 'agent:agt_b' } }),
    );
    expect(r).toMatchObject({ matched: true, agentId: 'agt_b', targetRef: 'agent:agt_b' });
  });

  it('to=markus 没有 active 绑定 → catch_all(no_active_target) 且带桶 id', () => {
    const addr = 'ghost.markus@markus.global';
    const r = resolveEnvelopeTarget(
      { to: { kind: 'markus', address: addr, local: 'ghost', orgSlug: 'markus' } },
      'agt_owner',
      book({}),
    );
    expect(r).toMatchObject({ matched: false, reason: 'no_active_target', catchAll: 'catchall:agt_owner' });
  });

  it('外部域 / 平台保留 / IM 身份都不是可投的内部收件人 → unresolved_address', () => {
    const owner = 'agt_owner';
    for (const to of [
      { kind: 'external', address: 'someone@gmail.com' } as const,
      { kind: 'platform', address: 'noreply@markus.global', local: 'noreply' } as const,
      { kind: 'im', platform: 'feishu', nativeUserId: 'u1' } as const,
    ]) {
      const r = resolveEnvelopeTarget({ to }, owner);
      expect(r.matched, JSON.stringify(to)).toBe(false);
      if (!r.matched) {
        expect(r.reason).toBe('unresolved_address');
        expect(r.catchAll).toBe('catchall:agt_owner');
      }
    }
  });

  it('没有地址簿也能解析（不抛异常、不返回 undefined）：缺省即 catch_all', () => {
    const addr = 'cto.markus@markus.global';
    const r = resolveEnvelopeTarget(
      { to: { kind: 'markus', address: addr, local: 'cto', orgSlug: 'markus' } },
      'agt_owner',
    );
    expect(r).toMatchObject({ matched: false, reason: 'no_active_target' });
  });
});

describe('退信原因闭集 —— 只产生六类，第七类只预留', () => {
  it('可产生的原因恰好六类（C5 补 payload_invalid）', () => {
    expect([...ACTIVE_BOUNCE_REASONS]).toEqual([
      'unresolved_address', 'no_active_target', 'lease_expired', 'duplicate_message_id', 'stale_signal',
      'payload_invalid',
    ]);
  });

  it('payload_invalid 可产生且可写库（入参校验失败必须有一个真实名字）', () => {
    expect(isActiveBounceReason('payload_invalid')).toBe(true);
    expect(isBounceReason('payload_invalid')).toBe(true);
  });

  it('dsn_bounce 在闭集里但不属于「可产生」集合（写入侧必须拒绝它）', () => {
    expect(BOUNCE_REASONS).toContain('dsn_bounce');
    expect(isActiveBounceReason('dsn_bounce')).toBe(false);
    for (const reason of ACTIVE_BOUNCE_REASONS) expect(isActiveBounceReason(reason)).toBe(true);
  });
});
