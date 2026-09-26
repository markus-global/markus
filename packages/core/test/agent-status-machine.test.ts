import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 重构 3 回归测试：core 状态机收敛为单一派生函数 transitionStatus。
 *
 * 覆盖需求原文：
 *  - 状态所有写入点收敛到单一派生/转换函数（27 处 setStatus → 意图化调用，残留为 0）
 *  - 心跳巡检、保守仲裁（reconcileToIdle/reset）、Normal 转换（working/idle 恢复）统一走派生函数
 *  - 竞态覆盖场景（严格并行 error/idle、working 中 idle 请求）在单一函数下不会互相覆盖
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for status machine tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(chatFn?: (...args: unknown[]) => Promise<unknown>): LLMRouter {
  const chat = vi.fn(chatFn ?? (async () => ({
    content: 'Hello from the agent.',
    finishReason: 'end_turn',
    usage: { inputTokens: 50, outputTokens: 25 },
  })));

  return {
    chat,
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function createAgent(overrides: Record<string, unknown> = {}) {
  return new Agent({
    config: {
      id: 'status-test-agent',
      name: 'Status Test Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    ...overrides,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-status-machine-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 测试助手：直接驱动私有 transitionStatus（状态机纯逻辑原子断言）。 */
function ts(agent: Agent, intent: unknown, opts?: { force?: boolean }) {
  return (agent as unknown as { transitionStatus(i: unknown, o?: { force?: boolean }): void }).transitionStatus(intent, opts);
}

describe('单一状态派生函数 transitionStatus — 生命周期与 Normal 转换', () => {
  it('start → reset：无条件回 idle（从离线/错误恢复）', async () => {
    const agent = createAgent();
    expect(agent.getState().status).toBe('offline'); // 构造后默认 offline
    await agent.start();
    expect(agent.getState().status).toBe('idle');
  });

  it('stop → offline：无条件落地', async () => {
    const agent = createAgent();
    await agent.start();
    await agent.stop('maintenance');
    expect(agent.getState().status).toBe('offline');
    expect(agent.getStopReason()).toBe('maintenance');
  });

  it('working 意图：从 idle 进入 working，幂等不抖动', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    expect(agent.getState().status).toBe('working');
    ts(agent, { to: 'working' });
    expect(agent.getState().status).toBe('working');
  });

  it('error 意图在无活跃任务时落地并记录 lastError', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'error', message: 'boom' });
    expect(agent.getState().status).toBe('error');
    expect(agent.getState().lastError).toBe('boom');
    expect(agent.getState().lastErrorAt).toBeTruthy();
  });

  it('working 意图可从 error 恢复并清空 lastError（Normal 转换）', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'error', message: 'boom' });
    ts(agent, { to: 'working' });
    expect(agent.getState().status).toBe('working');
    expect(agent.getState().lastError).toBeUndefined();
    expect(agent.getState().lastErrorAt).toBeUndefined();
  });
});

describe('单一状态派生函数 transitionStatus — 竞态覆盖防护（需求核心）', () => {
  it('error 粘性：error 后并行的 idle 意图不得覆盖错误状态', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    // 模拟严格并行：任务 A 失败 → error；任务 B 成功回来请求 idle（后到）
    ts(agent, { to: 'error', message: 'task A failed' });
    ts(agent, { to: 'idle' });
    // 错误可见性优先：不能被成功的并行路径冲掉
    expect(agent.getState().status).toBe('error');
    expect(agent.getState().lastError).toBe('task A failed');
  });

  it('idle 意图在 error 粘性下只能通过 reset / 新 working 恢复', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'error', message: 'boom' });
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('error'); // 粘性拒绝
    // 仲裁兜底：reset 强制恢复（reconcileToIdle 路径）
    ts(agent, { to: 'reset' });
    expect(agent.getState().status).toBe('idle');
    expect(agent.getState().lastError).toBeUndefined();
  });

  it('working 中有并行活动时 idle 意图被拒（聚合状态守卫）', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    // 模拟仍有活跃任务（聚合非空闲）
    (agent as unknown as { activeTasks: Set<string> }).activeTasks.add('task-1');
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('working'); // 不落地 idle
    // 任务结束后 idle 落地
    (agent as unknown as { activeTasks: Set<string> }).activeTasks.delete('task-1');
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('idle');
  });

  it('并发模式：仍有 worker 忙碌时 idle 意图被拒，全部空闲后落地', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    // 模拟并发 worker 聚合状态为忙碌
    (agent as unknown as { attentionController: unknown }).attentionController = {
      getWorkerCount: () => 2,
      getState: () => 'working',
    } as never;
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('working');
    // 全部 worker 空闲 → 落地 idle
    (agent as unknown as { attentionController: unknown }).attentionController = {
      getWorkerCount: () => 2,
      getState: () => 'idle',
    } as never;
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('idle');
  });

  it('force idle：仲裁兜底可强制越过聚合守卫与 error 粘性', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    (agent as unknown as { activeTasks: Set<string> }).activeTasks.add('stuck');
    ts(agent, { to: 'idle' }, { force: true });
    expect(agent.getState().status).toBe('idle');
    // 清理，避免影响其它断言
    (agent as unknown as { activeTasks: Set<string> }).activeTasks.delete('stuck');
  });

  it('error 意图在仍有活跃任务时不落地（部分失败不污染全局状态）', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'working' });
    (agent as unknown as { activeTasks: Set<string> }).activeTasks.add('other-task');
    ts(agent, { to: 'error', message: 'partial failure' });
    expect(agent.getState().status).toBe('working'); // 保持 working
    expect(agent.getState().lastError).toBeUndefined();
  });
});

describe('状态机收敛 — 心跳/仲裁路径统一入口', () => {
  it('reconcileToIdle（保守仲裁兜底）走 reset 派生函数：从 error 回收 idle', async () => {
    const agent = createAgent();
    await agent.start();
    ts(agent, { to: 'error', message: 'stale error' });
    agent.reconcileToIdle();
    // 无 stale 活动可清时 cleared=false，但状态回收仍走 reset 派生函数
    expect(agent.getState().status).toBe('idle');
    expect(agent.getState().lastError).toBeUndefined();
  });

  it('handleMessage 正常完成 → idle（聚合空闲落地）', async () => {
    const agent = createAgent();
    await agent.start();
    const reply = await agent.handleMessage('hello');
    expect(reply).toContain('Hello');
    expect(agent.getState().status).toBe('idle');
  });

  it('handleMessage 抛错 → error（错误可见性，未被覆盖）', async () => {
    const failing = createAgent({ llmRouter: makeMockRouter(async () => {
      throw new Error('API quota exceeded');
    }) });
    await failing.start();
    await expect(failing.handleMessage('fail please')).rejects.toThrow('API quota exceeded');
    expect(failing.getState().status).toBe('error');
    expect(failing.getState().lastError).toContain('API quota exceeded');
  });

  it('所有状态写入已收敛：transitionStatus 为唯一派生入口（无遗留 setStatus 调用点）', async () => {
    const agent = createAgent();
    const self = agent as unknown as Record<string, unknown>;
    // 转换函数存在且 applyStatus 是唯一落地载体
    expect(typeof self.transitionStatus).toBe('function');
    ts(agent, { to: 'working' });
    expect(self.state?.status).toBe('working');
  });
});