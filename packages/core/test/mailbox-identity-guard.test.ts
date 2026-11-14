/**
 * C8-P0 —— 「身份缺失」必须**可被发现**，而不是静默落 NULL。
 *
 * 2026-11-14 六个同族缺陷的共同句式：某条路径没传身份，系统当成「确实没有」。
 * 判据：非平台内部的事实，若既没 `workUnitRef` 也没 `refOrigin` 声明，
 * 必须计入 `takeUnclaimedIdentityCount()`（严格模式则抛错）。
 *
 * 删掉 mailbox.enqueue 里那段守卫，本文件立刻变红。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AgentMailbox, takeUnclaimedIdentityCount } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const payload = { summary: 'probe', content: 'probe' } as never;

afterEach(() => {
  takeUnclaimedIdentityCount(); // 重置计数，避免跨用例串味
});

describe('C8-P0：入队身份缺失守卫', () => {
  it('非平台事实、既无 ref 又无声明 → 计数 +1（不再静默）', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    mb.enqueue('human_chat', payload, {});
    expect(takeUnclaimedIdentityCount()).toBe(1);
  });

  it('声明 platform-internal → 豁免', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    mb.enqueue('session_reply', payload, { refOrigin: 'platform-internal' });
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });

  it('平台内部类型本就在豁免名单里（回执 / 内部事件）', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    mb.enqueue('system_event', payload, {});
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });

  it('声明 pending-link（稍后才拿身份）→ 豁免，但语义明确', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    mb.enqueue('task_status_update', payload, { refOrigin: 'pending-link' });
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });

  it('带了 ref → 不计数', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    mb.enqueue('human_chat', payload, { workUnitRef: 'session:cs_x:r1', refOrigin: 'turn' });
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });
});
