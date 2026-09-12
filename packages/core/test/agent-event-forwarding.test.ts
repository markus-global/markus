/**
 * 事件可达性契约测试（审计 P0-1）
 * ---------------------------------------------------------------------------
 * 背景（历史事故）：`agent:incomplete` 由 agent 私有 bus `emit`，唯一消费者
 * （`cli/start.ts` 的 WS 广播 / TaskService 自愈）却订阅在 manager bus 上。
 * 转发白名单 `FORWARDED_EVENTS` 漏登该事件 → 「任务执行闭包丢失 → 自动重调度」
 * 这条自愈路径从引入至今**不可达**，任务可永久卡在 `in_progress`。
 *
 * 这些测试锁死「跨 bus 可达性」这一契约，任何把事件从白名单移走的改动都会红。
 * 静态门禁（`scripts/architecture-guard.mjs` 的 event-reachability 规则）负责
 * 在提交前拦住「新增了被订阅的 agent 级事件却忘了登记」的情况；这里负责运行时行为。
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/events.js';
import { AGENT_FORWARDED_EVENTS, wireAgentEventForwarding } from '../src/agent-manager.js';

describe('agent 私有 bus → manager bus 事件转发契约（审计 P0-1）', () => {
  it('白名单收录 P0-1 两条历史漏登事件', () => {
    expect(AGENT_FORWARDED_EVENTS).toContain('agent:incomplete');
    expect(AGENT_FORWARDED_EVENTS).toContain('agent:entity-conflict');
  });

  it('P0-1：agent:incomplete 在私有 bus emit → manager bus 可达（自愈路径不再死代码）', () => {
    const agentBus = new EventBus();
    const managerBus = new EventBus();
    wireAgentEventForwarding(agentBus, managerBus);

    const received: unknown[] = [];
    managerBus.on('agent:incomplete', (p) => received.push(p));

    agentBus.emit('agent:incomplete', {
      agentId: 'agt_x',
      itemId: 'mbx_1',
      taskId: 'tsk_1',
      reason: 'resurfaced-task-execution-lost-closures',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      taskId: 'tsk_1',
      reason: 'resurfaced-task-execution-lost-closures',
    });
  });

  it('P0-1 同族：agent:entity-conflict 可达（conflictPolicy:report 的可见性信号）', () => {
    const agentBus = new EventBus();
    const managerBus = new EventBus();
    wireAgentEventForwarding(agentBus, managerBus);

    const received: unknown[] = [];
    managerBus.on('agent:entity-conflict', (p) => received.push(p));

    agentBus.emit('agent:entity-conflict', { entityKey: 'session:abc', workerId: 2 });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ entityKey: 'session:abc' });
  });

  it('反向（机制演示）：白名单缺项时确实不转发 —— 复现历史漏登的根因', () => {
    const agentBus = new EventBus();
    const managerBus = new EventBus();
    // 故意只登记不相关事件，模拟「agent:incomplete 漏登」的历史状态
    wireAgentEventForwarding(agentBus, managerBus, ['agent:started']);

    const received: unknown[] = [];
    managerBus.on('agent:incomplete', (p) => received.push(p));
    agentBus.emit('agent:incomplete', { taskId: 'tsk_lost' });

    expect(received).toHaveLength(0);
  });

  it('白名单内每条事件都可转发（全量覆盖）', () => {
    const agentBus = new EventBus();
    const managerBus = new EventBus();
    wireAgentEventForwarding(agentBus, managerBus);

    const unique = [...new Set(AGENT_FORWARDED_EVENTS)];
    for (const eventName of unique) {
      let hits = 0;
      managerBus.on(eventName, () => { hits += 1; });
      agentBus.emit(eventName, { eventName });
      expect(hits, `事件 ${eventName} 未转发到 manager bus`).toBeGreaterThan(0);
    }
  });
});
