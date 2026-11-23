/**
 * C10-B —— 信号级 observe 天花板（计划 §B「verified=false 只能 observe」）。
 *
 * 两个事实、两个所有者，不撞 C10-C：
 *   · 本卡（信号级）：一条未验证外部信号**能要求什么** —— 唯一谓词
 *     mayExternalSignalDemandAction，唯一消费者 = ExternalSourceService 的唯一
 *     ingest 点（intent 封顶 deliver）。信号自身永不 spawning 动作回合
 *     （注册表 invokesLLM=false，record 类）。
 *   · C10-C（agent 级）：maySelfInitiate 重建 —— agent 能否自主发起动作。
 *
 * base（37c817aa）上必须红：谓词与注册表条目都不存在。
 */
import { describe, it, expect } from 'vitest';
import * as mail from '../src/mail.js';
import { buildDeliveryEnvelope } from '../src/mail.js';
import { MAILBOX_TYPE_REGISTRY, MAILBOX_CATEGORIES } from '../src/types/mailbox.js';
import { routeMailboxItem } from '../src/types/mailbox.js';

describe('C10-B：未验证外部信号只能 observe（信号级天花板）', () => {
  it('唯一谓词存在且真值表正确：只有 verified=true 才允许要求动作', () => {
    const fn = (mail as Record<string, unknown>)['mayExternalSignalDemandAction'];
    expect(typeof fn).toBe('function');
    const may = fn as (v: boolean) => boolean;
    expect(may(false)).toBe(false);
    expect(may(true)).toBe(true);
    // 非 true 的一切取值都按未验证处理（fail closed，不猜）。
    expect(may(undefined as unknown as boolean)).toBe(false);
    expect(may(null as unknown as boolean)).toBe(false);
  });

  it('external_signal 注册在唯一路由注册表：record 类、不 spawning LLM 动作回合', () => {
    const entry = MAILBOX_TYPE_REGISTRY['external_signal'];
    expect(entry, 'external_signal 必须在注册表（否则走 UNKNOWN_ROUTE 兜底 = 第二个路由答案）').toBeDefined();
    expect(entry!.signalClass).toBe('record');
    expect(entry!.policy.invokesLLM).toBe(false);
    expect(entry!.policy.actionRequiredStrict).toBe(false);
  });

  it('routeMailboxItem 对 external_signal 给出 record/invokesLLM=false（唯一路由决策点）', () => {
    const route = routeMailboxItem({
      sourceType: 'external_signal',
      payload: { summary: 's', content: 'c' },
      envelope: { intent: 'deliver' },
    });
    expect(route.signalClass).toBe('record');
    expect(route.invokesLLM).toBe(false);
  });

  it('注册表类目镜像：external_signal 归 notification 类（web-ui 镜像同提交更新）', () => {
    expect(MAILBOX_CATEGORIES['notification'].types).toContain('external_signal');
  });

  it('信封构造器对 external from 保持 auth=null / fromVerified 缺省 false（B 不做认证，C10-D 才写值）', () => {
    const env = buildDeliveryEnvelope({
      from: { kind: 'external', address: 'someone@example.com' },
      to: { kind: 'agent', agentId: 'agt_x' },
      messageId: 'm-1',
      signalClass: 'record',
    });
    expect(env.auth).toBeNull();
    expect(env.fromVerified).toBe(false);
    expect(env.workUnitRef).toBeNull(); // 信封槽恒 null（C7 裁定：唯一写者是 mailbox_items.work_unit_ref）
  });
});
