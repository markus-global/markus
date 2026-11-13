/**
 * 第六刀 C2 · 投递点 4（§2.3 另修项）—— Conservator 兜底的**事件可达性**金测试。
 *
 * 既有事故：兜底路径统一 `emit` 到 manager bus 的 `heartbeat:trigger`，而每个 agent
 * 监听的是**自己的私有 bus** → 事件从未到达目标，脏 agent 永远无法恢复。
 *
 * 这条测试咬的就是「事件到底发到谁手上」：
 *  - 触发必须落在**该 agent 实例**上（私有 bus 的唯一入口是 `agent.triggerHeartbeat()`）；
 *  - 未知 agent 必须返回 false，不得假装成功（静默成功 = 下一次事故的温床）。
 *
 * 写法刻意只用 AgentManager 的公开方法 + 最小假 agent：任何「改回共享 bus」的实现
 * 都会让 `triggerHeartbeat` 一次都不被调用 → 立即变红。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentManager } from '../src/agent-manager.js';

/** 最小可注册的 agent 替身：只暴露兜底路径会碰的两个方法。 */
function fakeAgent() {
  return {
    id: 'agt_fake',
    triggerHeartbeat: vi.fn(),
    reconcileToIdle: vi.fn(() => true),
  };
}

function managerWith(fake: ReturnType<typeof fakeAgent>) {
  // AgentManager 依赖面很宽；本用例只用到内部注册表，故以最小依赖构造后注入替身。
  const manager = Object.create(AgentManager.prototype) as AgentManager;
  (manager as unknown as { agents: Map<string, unknown> }).agents = new Map([['agt_fake', fake]]);
  return manager;
}

describe('Conservator 兜底：事件必须落在 agent 私有入口', () => {
  it('triggerAgentHeartbeat 调用该 agent 实例（而不是往共享 bus 上发）', () => {
    const fake = fakeAgent();
    const manager = managerWith(fake);

    expect(manager.triggerAgentHeartbeat('agt_fake')).toBe(true);
    expect(fake.triggerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('reconcileAgentToIdle 调用该 agent 实例并透传结果', () => {
    const fake = fakeAgent();
    const manager = managerWith(fake);

    expect(manager.reconcileAgentToIdle('agt_fake')).toBe(true);
    expect(fake.reconcileToIdle).toHaveBeenCalledTimes(1);
  });

  it('未知 agent → false（不得假装已恢复）', () => {
    const fake = fakeAgent();
    const manager = managerWith(fake);

    expect(manager.triggerAgentHeartbeat('agt_missing')).toBe(false);
    expect(manager.reconcileAgentToIdle('agt_missing')).toBe(false);
    expect(fake.triggerHeartbeat).not.toHaveBeenCalled();
  });
});
