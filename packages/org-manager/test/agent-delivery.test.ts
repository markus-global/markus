/**
 * AgentDelivery —— A2A 投递/回复唯一执行点的行为测试（2026-10-25 事故回归）。
 *
 * 事故：12 条 DM 在 3 分钟内全部写进 channel_messages，对端**只被唤醒 1 次**，
 * 11 次被墙钟冷却静默丢弃；工具仍返回 dispatched。根因是"投递"与"唤醒"被拆成
 * 两个可分离动作，且唤醒上的闸会丢弃而不告知。
 *
 * 本测试锁住新模型的不变量（docs/architecture/mailbox-system.md §11.1.1–§11.1.4）：
 *   ① 投递**不可丢失**：N 次 deliver = N 次入队（是否合并是 mailbox 的事，不是这里丢）；
 *   ② 不存在半状态：要么入队，要么目标不存在（记录跳过），要么抛错——三者皆可见；
 *   ③ 因果链透传：chainId / depth 原样带进 payload，回复时沿用；
 *   ④ 回复只有一个写点：postReply 写一次、播一次，且**不触发任何人**。
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentDelivery, newChainId, type DeliveryDeps, type DeliveryRequest } from '../src/agent-delivery.js';

type Enqueued = { agentId: string; sourceType: string; payload: Record<string, unknown>; options?: Record<string, unknown> };

function makeDeps(overrides: Partial<DeliveryDeps> = {}) {
  const enqueued: Enqueued[] = [];
  const agents = new Map<string, { config: { name: string }; enqueueToMailbox: ReturnType<typeof vi.fn> }>();
  const ensure = (id: string) => {
    if (!agents.has(id)) {
      agents.set(id, {
        config: { name: `Agent ${id}` },
        enqueueToMailbox: vi.fn((sourceType: string, payload: Record<string, unknown>, options?: Record<string, unknown>) => {
          enqueued.push({ agentId: id, sourceType, payload, options });
        }),
      });
    }
    return agents.get(id)!;
  };
  const persistReply = vi.fn(async () => 'cm_reply_1');
  const broadcastReply = vi.fn();
  const deps: DeliveryDeps = {
    getAgent: (id: string) => (id === 'missing' ? undefined : ensure(id)),
    persistReply,
    broadcastReply,
    ...overrides,
  };
  return { deps, enqueued, persistReply, broadcastReply, agents };
}

function req(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    orgId: 'org-1',
    channelKey: 'dm:a2a:agt_a:agt_b',
    fromAgentId: 'agt_a',
    fromAgentName: 'Agent A',
    content: 'hello',
    targetAgentIds: ['agt_b'],
    chainId: 'chain_1',
    depth: 1,
    ...overrides,
  };
}

describe('AgentDelivery.deliver — 投递不可丢失', () => {
  it('12 条消息 = 12 次入队（合并发生在 mailbox，不在这里丢弃）', () => {
    const { deps, enqueued } = makeDeps();
    const delivery = new AgentDelivery(deps);
    for (let i = 0; i < 12; i++) {
      const out = delivery.deliver(req({ content: `msg ${i}` }));
      expect(out.state).toBe('queued');
      expect(out.deliveredTo).toEqual(['agt_b']);
    }
    expect(enqueued).toHaveLength(12);
    // deliver() 会加来源标记（[FROM AGENT]），正文必须完整保留
    expect(enqueued.map(e => (e.payload as { content: string }).content)).toEqual(
      Array.from({ length: 12 }, (_, i) => expect.stringContaining(`msg ${i}`)),
    );
  });

  it('多目标逐个入队，自己不会被投递给自己', () => {
    const { deps, enqueued } = makeDeps();
    const delivery = new AgentDelivery(deps);
    const out = delivery.deliver(req({ targetAgentIds: ['agt_a', 'agt_b', 'agt_c'] }));
    expect(out.deliveredTo).toEqual(['agt_b', 'agt_c']);
    expect(enqueued.map(e => e.agentId)).toEqual(['agt_b', 'agt_c']);
  });

  it('目标不存在 = 跳过并记录，不静默、不抛', () => {
    const { deps, enqueued } = makeDeps();
    const delivery = new AgentDelivery(deps);
    const out = delivery.deliver(req({ targetAgentIds: ['missing', 'agt_b'] }));
    expect(out.deliveredTo).toEqual(['agt_b']);
    expect(enqueued).toHaveLength(1);
  });

  it('入队抛错必须上抛（投递失败可见，不吞）', () => {
    const { deps, agents } = makeDeps();
    agents.set('agt_b', {
      config: { name: 'B' },
      enqueueToMailbox: vi.fn(() => { throw new Error('mailbox down'); }),
    });
    const delivery = new AgentDelivery(deps);
    expect(() => delivery.deliver(req())).toThrow('mailbox down');
  });
});

describe('AgentDelivery.deliver — 因果链与载荷', () => {
  it('chainId / depth 原样进入 payload（跨跳不重置）', () => {
    const { deps, enqueued } = makeDeps();
    new AgentDelivery(deps).deliver(req({ chainId: 'chain_x', depth: 3 }));
    const extra = (enqueued[0]!.payload as { extra: Record<string, unknown> }).extra;
    expect(extra['chainId']).toBe('chain_x');
    expect(extra['chainDepth']).toBe(3);
    expect(extra['channelKey']).toBe('dm:a2a:agt_a:agt_b');
  });

  it('@提及 与 throttled 是提示位，不影响投递', () => {
    const { deps, enqueued } = makeDeps();
    new AgentDelivery(deps).deliver(req({ mentions: ['Agent B'], throttled: true }));
    const extra = (enqueued[0]!.payload as { extra: Record<string, unknown> }).extra;
    expect(extra['directMention']).toBe(true);
    expect(extra['throttled']).toBe(true);
  });

  it('collectReply 返回与目标一一对应的 promise，并挂上 responsePromise', () => {
    const { deps, enqueued } = makeDeps();
    const out = new AgentDelivery(deps).deliver(req({ collectReply: true }));
    expect(out.replies).toHaveLength(1);
    const md = enqueued[0]!.options as { metadata: { responsePromise?: { resolve: (v: string) => void } } };
    expect(typeof md.metadata.responsePromise?.resolve).toBe('function');

    let settled = '';
    void out.replies![0]!.then(v => { settled = v; });
    md.metadata.responsePromise!.resolve('pong');
    return Promise.resolve().then(() => expect(settled).toBe('pong'));
  });

  it('被点名的目标带 [MENTIONED]，同一批里的围观者不带（逐目标判定，唯一写者）', () => {
    const { deps, enqueued } = makeDeps();
    const d = new AgentDelivery(deps);
    // 一条群发只 @ 了 agt_b：agt_b 被点名，agt_c 只是围观。
    // 旧模型用布尔 addressed，无法表达这个状态 → 要么全员以为被点名，要么被点名者不知道。
    d.deliver(req({
      targetAgentIds: ['agt_b', 'agt_c'],
      addressedTargetIds: ['agt_b'],
      content: 'broadcast',
    }));
    const toAddressed = (enqueued[0]!.payload as { content: string }).content;
    const toBystander = (enqueued[1]!.payload as { content: string }).content;
    expect(toAddressed).toContain('[MENTIONED]');
    // 「还有谁也 @ 了」必须随消息一起送达：收件方据此决定「必须我干」还是「谁先接谁干」。
    // 只 @ 了 agt_b 一个人 → 计数为 0（**照样输出**，不省略：省略会让前缀分叉）。
    expect(toAddressed).toContain('Others also addressed: 0');
    expect(toAddressed).toContain('broadcast');
    expect(toBystander).not.toContain('[MENTIONED]');
    expect(toBystander).toContain('broadcast');
  });

  it('同时 @ 多人时，每个被点名者都看到相同的「另有 N 人」', () => {
    const { deps, enqueued } = makeDeps();
    const d = new AgentDelivery(deps);
    d.deliver(req({
      targetAgentIds: ['agt_b', 'agt_c', 'agt_d'],
      addressedTargetIds: ['agt_b', 'agt_c'],
      content: 'group question',
    }));
    const toB = (enqueued[0]!.payload as { content: string }).content;
    const toC = (enqueued[1]!.payload as { content: string }).content;
    const toD = (enqueued[2]!.payload as { content: string }).content;
    // 两个被点名者各看到「另有 1 人」，且是同一个数字（同一个事实，一个来源）。
    expect(toB).toContain('Others also addressed: 1');
    expect(toC).toContain('Others also addressed: 1');
    // 围观者仍然不带标记。
    expect(toD).not.toContain('[MENTIONED]');
  });

  it('一个都没送到时报 undelivered —— 不谎报 queued', () => {
    // F2 的核心守卫（行为测试，不是源码文本断言）。
    // 旧实现无论收件人是否存在都回 `queued`，差异只体现在正文里一句 WARNING：
    // 于是调用方以为消息在路上，反复重发，而它从头到尾没有离开本机。
    const { deps, enqueued } = makeDeps();
    const d = new AgentDelivery(deps);
    const out = d.deliver(req({
      targetAgentIds: ['missing'],
      content: 'nobody will read this',
    }));
    expect(out.state).toBe('undelivered');
    expect(out.deliveredTo).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('部分送达时报 queued，且 deliveredTo 只列真正送达的目标', () => {
    // “部分送达”是个真实状态：不能因为有一个失败就把整批说成失败，
    // 也不能因为有一个成功就把失败的那个也算进 deliveredTo。
    const { deps, enqueued } = makeDeps();
    const d = new AgentDelivery(deps);
    const out = d.deliver(req({
      targetAgentIds: ['missing', 'agt_real'],
      content: 'partial',
    }));
    expect(out.state).toBe('queued');
    expect(out.deliveredTo).toEqual(['agt_real']);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.agentId).toBe('agt_real');
  });

  it('origin 决定来源标记：人类 vs 同事（唯一写者）', () => {
    const { deps, enqueued } = makeDeps();
    const d = new AgentDelivery(deps);
    d.deliver(req({ origin: 'human', fromAgentName: 'Jason' }));
    d.deliver(req({ origin: 'agent' }));
    const human = (enqueued[0]!.payload as { content: string }).content;
    const agent = (enqueued[1]!.payload as { content: string }).content;
    expect(human).toContain('[FROM HUMAN] Jason');
    expect(human).toContain('humans can see this channel');
    expect(agent).toContain('[FROM AGENT]');
    expect(agent).toContain('no human is waiting on this');
  });

  it('newChainId 每次唯一', () => {
    const a = newChainId();
    const b = newChainId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^chain_/);
  });
});

describe('AgentDelivery.postReply — 回复只有一个写点', () => {
  it('写一次、播一次', async () => {
    const { deps, persistReply, broadcastReply } = makeDeps();
    const res = await new AgentDelivery(deps).postReply({
      orgId: 'org-1', channelKey: 'dm:a2a:agt_a:agt_b', agentId: 'agt_b', text: 'pong',
    });
    expect(persistReply).toHaveBeenCalledTimes(1);
    expect(broadcastReply).toHaveBeenCalledTimes(1);
    expect(res.messageId).toBe('cm_reply_1');
  });

  it('空回复不落库', async () => {
    const { deps, persistReply } = makeDeps();
    await new AgentDelivery(deps).postReply({ orgId: 'org-1', channelKey: 'c', agentId: 'agt_b', text: '   ' });
    expect(persistReply).not.toHaveBeenCalled();
  });

  it('回复**不触发任何人**（自动回复链已删除）', async () => {
    const { deps, enqueued } = makeDeps();
    await new AgentDelivery(deps).postReply({ orgId: 'org-1', channelKey: 'dm:a2a:agt_a:agt_b', agentId: 'agt_b', text: 'pong' });
    // 唯一的投递入口是 deliver；postReply 不得产生任何 mailbox 入队
    expect(enqueued).toHaveLength(0);
  });
});
