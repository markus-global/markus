/**
 * C10-0B §3.5 / §4-7 —— 每日身份审计挂在**既有 AgentClock** 上（不新增 setInterval）。
 *
 * 判据：
 *   ① 端口已装配 → `Agent.start()` 注册具名时钟源 `identity-audit`，周期 24h；
 *   ② 端口未装配 → **没有**这个源（装配惰性由依赖缺席证明，不靠注释）；
 *   ③ 注册点是 start（生命周期）而不是模块加载；且首次运行有错峰延迟，
 *      启动那一刻不会跑审计（24h 一次的活不该在每次启动时抢闸）。
 *
 * 基线上 ① 立刻红：`setIdentityAuditPort` 不存在，端口本身也不存在。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;
let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Role for identity audit clock tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeRouter(): LLMRouter {
  const response = {
    content: 'ok',
    finishReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  return {
    chat: vi.fn(async () => response),
    chatStream: vi.fn(async () => response),
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

function makeAgent(id: string): Agent {
  return new Agent({
    config: {
      id,
      name: `Identity Audit Clock ${id}`,
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'test' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeRouter(),
    dataDir: tempDir,
  });
}

/** 私有 clock 的唯一只读访问口：`getStatus()` 是 AgentClock 的公开读面。 */
function clockSources(agent: Agent): Array<{ name: string; everyMs: number }> {
  const clock = (agent as unknown as {
    clock: { getStatus(): { sources: Array<{ name: string; everyMs: number }> } };
  }).clock;
  return clock.getStatus().sources;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-identity-audit-clock-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('C10-0B §3.5：身份审计时钟源', () => {
  it('端口已装配 → start() 注册 `identity-audit`，周期 24h', async () => {
    const agent = makeAgent('agt_audit_wired');
    const runDaily = vi.fn();
    agent.setIdentityAuditPort({ runDaily });

    await agent.start();
    const source = clockSources(agent).find(s => s.name === 'identity-audit');
    expect(source, '装配了端口就必须有时钟源').toBeDefined();
    expect(source!.everyMs).toBe(DAY_MS);
    // 错峰：启动那一刻不跑（否则重启风暴会把审计变成启动步骤）
    expect(runDaily, '首次运行必须错峰延迟，不得在启动时立即触发').not.toHaveBeenCalled();
    await agent.stop();
  });

  it('端口未装配 → 没有这个时钟源（依赖缺席即惰性证明）', async () => {
    const agent = makeAgent('agt_audit_unwired');
    await agent.start();
    expect(clockSources(agent).find(s => s.name === 'identity-audit')).toBeUndefined();
    await agent.stop();
  });
});