/**
 * C10-0A —— 声明了的身份必须存在：唯一装配点保证「ref ⇒ WorkUnit」。
 *
 * 根因（2026-11-19 真库 + Owner 实测）：身份不变量没有单一执行点。
 *  - 守卫要求调用方「表态」，但人触发的通知路径（需求审批/驳回）结构上拿不到
 *    回合身份 → 合法操作被拒（Owner 前端报错）；
 *  - 声明了 ref 的路径没人保证 WorkUnit 存在 → 5 条悬空 ref（11-16 实测）。
 *
 * 修法：调用方用唯一构造器 WORK_UNIT_REF 声明实体身份；装配点（enqueue）
 * 经 MailboxIdentityPort 确保实体存在。「声明了但没建」在结构上不再可表达。
 *
 * 删掉 enqueue 里的 ensure 段，本文件立刻变红。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  AgentMailbox,
  takeUnclaimedIdentityCount,
  takeIdentityEnsureFailedCount,
  type MailboxIdentityPort,
} from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const payload = { summary: 'probe', content: 'probe' } as never;

function recordingPort(ok = true): { port: MailboxIdentityPort; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    port: {
      ensureIdentity: (seed) => {
        calls.push({ ...seed });
        return ok;
      },
    },
  };
}

afterEach(() => {
  takeUnclaimedIdentityCount();
  takeIdentityEnsureFailedCount();
});

describe('C10-0A：声明的 ref 在装配点被 ensure', () => {
  it('带 ref 入队 → port.ensureIdentity 恰被调一次，ref/agentId/实体 id 透传', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    const { port, calls } = recordingPort();
    mb.setIdentityPort(port);
    const item = mb.enqueue(
      'task_status_update',
      { summary: 's', content: 'c', taskId: 'tsk_x' } as never,
      { workUnitRef: 'task_tsk_x_r1', refOrigin: 'entity' },
    );
    expect(item.workUnitRef).toBe('task_tsk_x_r1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ref: 'task_tsk_x_r1', agentId: 'agt_probe', taskId: 'tsk_x' });
  });

  it('requirement 实体 id 透传给 port（所有者解析归 org-manager，不在 core 猜）', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    const { port, calls } = recordingPort();
    mb.setIdentityPort(port);
    mb.enqueue(
      'requirement_update',
      { summary: 's', content: 'c', requirementId: 'req_x' } as never,
      { workUnitRef: 'requirement:req_x', refOrigin: 'entity' },
    );
    expect(calls[0]).toMatchObject({ ref: 'requirement:req_x', requirementId: 'req_x' });
  });

  it('ensure 失败 → 业务不被打断（入队照常），但失败可计数', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    const { port } = recordingPort(false);
    mb.setIdentityPort(port);
    const item = mb.enqueue(
      'task_status_update',
      { summary: 's', content: 'c', taskId: 'tsk_x' } as never,
      { workUnitRef: 'task_tsk_x_r1', refOrigin: 'entity' },
    );
    expect(item.workUnitRef).toBe('task_tsk_x_r1');
    expect(takeIdentityEnsureFailedCount()).toBe(1);
  });

  it('未接 port（旧装配/单测）→ 声明 ref 照常放行，不抛错', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    expect(() =>
      mb.enqueue('human_chat', payload, { workUnitRef: 'session:cs_x:r1', refOrigin: 'turn' }),
    ).not.toThrow();
  });

  it('平台内部类型不带 ref → 不调 ensure（本质无实体）', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    const { port, calls } = recordingPort();
    mb.setIdentityPort(port);
    mb.enqueue('system_event', payload, {});
    expect(calls).toHaveLength(0);
  });

  it('pending-link 且无 ref → 不调 ensure（身份稍后由行权威链接）', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    const { port, calls } = recordingPort();
    mb.setIdentityPort(port);
    mb.enqueue('human_chat', payload, { refOrigin: 'pending-link' });
    expect(calls).toHaveLength(0);
  });
});

describe('C10-0A：守卫只在真契约违规时拒绝，且提示可行动', () => {
  beforeEach(() => {
    delete process.env.MARKUS_LENIENT_IDENTITY;
  });
  afterEach(() => {
    process.env.MARKUS_LENIENT_IDENTITY = '1';
  });

  it('非平台事实、既无 ref 又无声明 → 抛错，提示指向唯一构造器与声明两条出路', () => {
    const mb = new AgentMailbox('agt_probe', new EventBus());
    expect(() => mb.enqueue('requirement_update', payload, {})).toThrow(/WORK_UNIT_REF/);
    expect(() => mb.enqueue('requirement_update', payload, {})).toThrow(/refOrigin/);
  });
});