/**
 * 第六刀 C2 —— 投递信封（DeliveryEnvelope）的形状契约。
 *
 * 断言都是**行为**断言：跑真实构造器、看真实返回体/字节序列。
 * 这里锁住三件事：
 *  1. 信封只有**一个**形状写者（`buildDeliveryEnvelope`），预留槽位一次性补齐 null；
 *  2. 同一输入 → 同一字节序列（可缓存；形状不随输入变化）；
 *  3. 地址 / 身份不可互推：`agent:` / `im:` 永远不被当成邮箱地址（H1）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildDeliveryEnvelope,
  parseEnvelope,
  platformOriginRef,
  isAuthoritativeIntent,
  ACTIVE_BOUNCE_REASONS,
} from '../src/mail.js';
import {
  agentAddressRef,
  imAddressRef,
  platformAddressRef,
  parseAddress,
  describeAddress,
} from '../src/address.js';

describe('buildDeliveryEnvelope — 唯一形状写者', () => {
  it('预留槽位一次性补齐（auth / replyTo / workUnitRef 恒 null）', () => {
    const env = buildDeliveryEnvelope({
      from: agentAddressRef('agt_a'),
      to: agentAddressRef('agt_b'),
      messageId: 'm1',
      signalClass: 'a2a',
    });
    expect(env.auth).toBeNull();
    expect(env.replyTo).toBeNull();
    // C7 之前 workUnitRef 必须恒 null：先建引用后建实体 = 悬空引用。
    expect(env.workUnitRef).toBeNull();
    expect(env.externalThreadRef).toBeNull();
    expect(env.intent).toBe('deliver');
    expect(env.fromVerified).toBe(false);
  });

  it('同一输入 → 同一字节序列（缓存友好 / 形状不随输入变化）', () => {
    const input = {
      from: imAddressRef('feishu', 'u1'),
      to: agentAddressRef('agt_a'),
      messageId: 'm2',
      signalClass: 'chat' as const,
    };
    expect(JSON.stringify(buildDeliveryEnvelope(input))).toBe(JSON.stringify(buildDeliveryEnvelope(input)));
  });

  it('显式给空 subject 与省略 subject 得到同一字节序列（不为 0 时换形状）', () => {
    const base = { from: platformOriginRef(), to: agentAddressRef('a'), messageId: 'm3', signalClass: 'system' as const };
    expect(JSON.stringify(buildDeliveryEnvelope({ ...base, subject: '' })))
      .toBe(JSON.stringify(buildDeliveryEnvelope(base)));
  });
});

describe('parseEnvelope — 读侧归一（不编造信封）', () => {
  it('round-trip：写出去的信封读回来逐字段相等', () => {
    const env = buildDeliveryEnvelope({
      from: imAddressRef('slack', 'U123'),
      to: agentAddressRef('agt_a'),
      messageId: 'native-42',
      signalClass: 'chat',
      intent: 'deliver',
      subject: 'hi',
      externalThreadRef: 'th-1',
    });
    expect(parseEnvelope(JSON.stringify(env))).toEqual(env);
  });

  it('旧行（NULL / 空串）= 无信封 → undefined，绝不返回一个「看起来合法」的壳', () => {
    expect(parseEnvelope(null)).toBeUndefined();
    expect(parseEnvelope(undefined)).toBeUndefined();
    expect(parseEnvelope('')).toBeUndefined();
  });

  it('坏 JSON / 缺关键字段 → undefined（不抛、不猜）', () => {
    expect(parseEnvelope('{not json')).toBeUndefined();
    expect(parseEnvelope(JSON.stringify({ from: { kind: 'agent', agentId: 'x' } }))).toBeUndefined();
  });
});

describe('地址与身份不可互推（H1）', () => {
  it('agent / im 身份不是邮箱：parseAddress 一律拒绝', () => {
    expect(parseAddress('agent:agt_a').ok).toBe(false);
    expect(parseAddress('im:feishu:u1').ok).toBe(false);
  });

  it('平台保留地址只接受闭集成员（越界 undefined，不悄悄拼一个不存在的邮箱）', () => {
    expect(platformAddressRef('noreply')).toEqual({ kind: 'platform', address: 'noreply@markus.global', local: 'noreply' });
    expect(platformAddressRef('admin')).toBeUndefined();
    expect(platformAddressRef('cto')).toBeUndefined();
  });

  it('describeAddress 只做展示，回读不被当成身份', () => {
    expect(describeAddress(agentAddressRef('agt_a'))).toBe('agent:agt_a');
    expect(describeAddress(imAddressRef('feishu', 'u1'))).toBe('im:feishu:u1');
    expect(describeAddress(platformOriginRef())).toBe('noreply@markus.global');
  });
});

describe('意图与退信原因的闭集', () => {
  it('isAuthoritativeIntent 只有两种权威意图', () => {
    expect(isAuthoritativeIntent('trigger_execution')).toBe(true);
    expect(isAuthoritativeIntent('action_required')).toBe(true);
    expect(isAuthoritativeIntent('deliver')).toBe(false);
    expect(isAuthoritativeIntent(undefined)).toBe(false);
  });

  it('重复投递的退信原因在「可产生」集合里（V5 用的是它，不是预留位）', () => {
    expect(ACTIVE_BOUNCE_REASONS).toContain('duplicate_message_id');
  });
});
