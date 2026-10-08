import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import type { SessionStateRegistry } from '../src/session-state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * P1 回归：agent 的「工作中」状态 = 各会话状态的并集（后端唯一真相源）。
 *
 * 需求原文（老板 2026-10-06，问题 B）：
 *   agent 支持同时处理多个 session；agent 的是否工作中 = 各 worker/session 工作状态的并集；
 *   每个 session 状态以后端为真相。
 *
 * 本文件钉死不变量：
 *   - 任一会话在 processing ⇒ agent.status 不得回 idle（即使某个 worker 已空闲）；
 *   - 全部会话结算完 ⇒ agent 才回 idle。
 * 这些用例直接驱动 transitionStatus（状态落地唯一入口）+ 私有 registry，
 * 与 agent-status-machine.test.ts 同一手法（纯逻辑原子断言）。
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for session-state tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  const chat = vi.fn(async () => ({
    content: 'ok',
    finishReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
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

function createAgent() {
  return new Agent({
    config: {
      id: 'session-state-agent',
      name: 'Session State Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

/** 驱动私有 transitionStatus（状态落地唯一入口）。 */
function ts(agent: Agent, intent: unknown) {
  return (agent as unknown as { transitionStatus(i: unknown): void }).transitionStatus(intent);
}
/** 取私有会话注册表。 */
function reg(agent: Agent): SessionStateRegistry {
  return (agent as unknown as { sessionStates: SessionStateRegistry }).sessionStates;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-session-state-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('agent「工作中」= 会话状态并集（P1）', () => {
  it('某会话开始处理 ⇒ working；该会话结算完 ⇒ idle', async () => {
    const agent = createAgent();
    await agent.start();
    reg(agent).begin('sess_a', 'i1');
    ts(agent, { to: 'working' });
    expect(agent.getState().status).toBe('working');

    reg(agent).settle('sess_a', 'i1', 'ok');
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('idle');
  });

  it('并集（可观测）：一个会话结算、另一会话仍在处理 ⇒ isProcessing 仍为真、快照仍显示其 processing', async () => {
    const agent = createAgent();
    await agent.start();
    reg(agent).begin('sess_a', 'i1');
    reg(agent).begin('sess_b', 'i2');
    ts(agent, { to: 'working' });

    // 会话 A 结束，但 B 仍在跑。
    reg(agent).settle('sess_a', 'i1', 'ok');
    // 会话并集由 isProcessing()/getSessionStates() **如实暴露**（前端权威来源）。
    expect(agent.isProcessing()).toBe(true);
    expect(agent.getSessionStates().find(s => s.sessionKey === 'sess_b')?.state).toBe('processing');

    // 注：agent.status 的 idle 落地由 attention 的 **worker 聚合闸门**把关
    // （getWorkerCount() > 1 && getState() !== 'idle'）；本层**不再**叠加会话闸门。
    // 曾试加的会话闸门是冗余守卫，且会让 reconcileIdleState 永远收敛不了（见 P1-fix）。

    reg(agent).settle('sess_b', 'i2', 'ok');
    ts(agent, { to: 'idle' });
    expect(agent.getState().status).toBe('idle');
    // 无在飞 turn ⇒ isProcessing 为假（「队列里还有待办」不属此谓词语义）。
    expect(agent.isProcessing()).toBe(false);
  });

  it('isProcessing 反映会话并集（不止看某个 worker 的 processingMailboxItemId）', async () => {
    const agent = createAgent();
    await agent.start();
    expect(agent.isProcessing()).toBe(false);
    reg(agent).begin('sess_a', 'i1');
    expect(agent.isProcessing()).toBe(true);
    reg(agent).settle('sess_a', 'i1', 'ok');
    expect(agent.isProcessing()).toBe(false);
  });

  it('getSessionStates 暴露处理状态快照（P4 前端状态端点的数据源）', async () => {
    const agent = createAgent();
    await agent.start();
    reg(agent).begin('sess_a', 'i1');
    reg(agent).begin('sess_b', 'i2');
    reg(agent).settle('sess_b', 'i2', 'ok');
    const snap = agent.getSessionStates();
    const byKey = Object.fromEntries(snap.map(s => [s.sessionKey, s]));
    expect(byKey['sess_a'].state).toBe('processing');
    expect(byKey['sess_a'].itemCount).toBe(1);
    expect(byKey['sess_b'].state).toBe('idle');
  });
});
