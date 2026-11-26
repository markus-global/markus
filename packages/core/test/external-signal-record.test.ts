/**
 * C10-B —— external_signal 在唯一装配点的行为（core 侧）。
 *
 * 判据：
 *   ① fail-closed：外部信号不是平台内部来源 —— 无 ref 入队必拒（#475 后结构保证，
 *      「先入队后补身份」不可表达）；
 *   ② 带唯一构造器 ref 入队 → 装配点 ensure 实体（identityPort），行带身份；
 *   ③ record 类不 spawning LLM 动作回合（invokesLLM=false → detectAbnormalCompletion
 *      不要求回复；信号经 delta 进 agent 自己的下一回合）。
 *
 * base（37c817aa）上 ②③ 红（类型未注册，走 UNKNOWN_ROUTE 兜底 = system/invokesLLM true）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { WORK_UNIT_REF } from '@markus/shared';
import { routeMailboxItem } from '@markus/shared';
import { detectAbnormalCompletion } from '../src/attention.js';
import type { MailboxItem } from '@markus/shared';

function makeBox() {
  const bus = new EventBus();
  const box = new AgentMailbox('agt_ext', bus);
  const ensured: Array<{ ref: string; agentId: string }> = [];
  box.setIdentityPort({
    ensureIdentity: (seed) => { ensured.push({ ref: seed.ref, agentId: seed.agentId }); return true; },
  });
  return { box, ensured };
}

describe('C10-B：external_signal 入队行为', () => {
  // 测试套件全局设 MARKUS_LENIENT_IDENTITY='1'（旧测试兼容）；fail-closed 抛错断言
  // 必须回到生产默认（无 LENIENT）才咬人 —— 与 mailbox-identity-ensure.test.ts 同口径。
  beforeEach(() => {
    delete process.env['MARKUS_LENIENT_IDENTITY'];
  });
  afterEach(() => {
    process.env['MARKUS_LENIENT_IDENTITY'] = '1';
  });

  it('无 ref 的外部信号入队必拒（fail-closed，不是平台内部来源）', () => {
    const { box } = makeBox();
    expect(() => box.enqueue('external_signal', { summary: 's', content: 'c' })).toThrow(/workUnitRef|refOrigin/);
  });

  it('带唯一构造器 ref 入队 → 装配点 ensure 实体，行带身份', () => {
    const { box, ensured } = makeBox();
    const ref = WORK_UNIT_REF.external('src_test', 'msg-1');
    const item = box.enqueue('external_signal', { summary: 's', content: 'c' }, {
      workUnitRef: ref,
      refOrigin: 'entity',
      origin: {
        from: { kind: 'external', address: 'feed@example.com' },
        messageId: 'msg-1',
        externalThreadRef: 'https://example.com/item/1',
      },
    });
    expect(item.workUnitRef).toBe(ref);
    expect(ensured).toEqual([{ ref, agentId: 'agt_ext' }]);
    expect(item.envelope?.from).toEqual({ kind: 'external', address: 'feed@example.com' });
    expect(item.envelope?.fromVerified).toBe(false);
    expect(item.envelope?.auth).toBeNull();
    expect(item.envelope?.externalThreadRef).toBe('https://example.com/item/1');
  });

  it('record 路由：不 spawning LLM 回合，空回复不判异常（信号经 delta 进 agent 自己的回合）', () => {
    const { box } = makeBox();
    const ref = WORK_UNIT_REF.external('src_test', 'msg-2');
    const item = box.enqueue('external_signal', { summary: 's', content: 'c' }, {
      workUnitRef: ref, refOrigin: 'entity',
    });
    const route = routeMailboxItem(item);
    expect(route.invokesLLM).toBe(false);
    expect(route.signalClass).toBe('record');
    expect(detectAbnormalCompletion(undefined, item as MailboxItem)).toBeUndefined();
  });

  it('同 messageId 重复投递：第二投不落第二条 queued（幂等退信 duplicate_message_id）', () => {
    const { box } = makeBox();
    const rows: Array<{ id: string; messageId: string; status: string; dropReason?: string }> = [];
    box.setPersistence({
      save: (item) => { rows.push({ id: item.id, messageId: item.envelope?.messageId ?? '', status: item.status }); return true; },
      findByMessageId: (agentId, messageId) => {
        const hit = rows.find(r => r.messageId === messageId && r.status !== 'bounced');
        return hit ? { id: hit.id, status: 'queued' } as never : undefined;
      },
      saveBounced: (item, reason) => { rows.push({ id: item.id, messageId: item.envelope?.messageId ?? '', status: 'bounced', dropReason: reason }); },
      updateStatus: () => {},
    });
    const ref = WORK_UNIT_REF.external('src_test', 'dup-1');
    const opts = {
      workUnitRef: ref, refOrigin: 'entity' as const,
      origin: { from: { kind: 'external' as const, address: 'x@y.z' }, messageId: 'dup-1' },
    };
    box.enqueue('external_signal', { summary: 's', content: 'c' }, opts);
    box.enqueue('external_signal', { summary: 's', content: 'c' }, opts);
    const queued = rows.filter(r => r.status !== 'bounced');
    expect(queued).toHaveLength(1);
    expect(rows.some(r => r.dropReason === 'duplicate_message_id')).toBe(true);
  });
});
