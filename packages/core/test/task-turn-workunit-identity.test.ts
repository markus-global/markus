/**
 * 执行回合的 WU 身份 —— 2026-11-15 P0 死锁的回归守卫。
 *
 * 事故形态（真机取证，卡 tsk_55656102f06e176531cf2995）：
 *   `turnWorkUnitRef()` 只读实例字段 `currentTurnWorkUnitRef`，而它唯一的写入点是
 *   `onFocusChanged`（邮箱焦点链）。任务执行入口只写 `currentTaskId` → 执行回合里
 *   `fact_assert` / `fact_verify` 全部 `missing_provenance`。
 *   而 `task_submit_review`、agent 打回这两个终态闸门**要求先断言事实** ——
 *   写不进去 = 闸门永远无法满足 = 任何卡都进不了 review，全平台任务流转堵死。
 *
 * 修法（裁决 A）：身份进 `taskAsyncContext`（ALS，一份执行一份），不进实例字段；
 * 值只能来自 `WORK_UNIT_REF.task(taskId, round)`；工具层不得加 fallback。
 *
 * 这些测试**不注入伪造 ctx**：走真实的 `taskAsyncContext` + 真实 `createFactTools`，
 * 只把 FactService 换成探针（那是外部依赖，不是被测逻辑）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, taskAsyncContext } from '../src/agent.js';
import { createFactTools } from '../src/tools/fact-tools.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Role for work-unit identity tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
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

function makeAgent(): Agent {
  return new Agent({
    config: {
      id: 'agt_identity_test',
      name: 'Identity Test Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'test' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

const ASSERT_ARGS = {
  subject_kind: 'task',
  subject_id: 'tsk_demo',
  predicate: 'task.completion_evidence',
  value: { summary: 'done', evidence_refs: ['probe:x'] },
  source_refs: ['probe:x'],
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-wu-identity-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('执行回合的 WU 身份', () => {
  it('任务执行作用域内带着 task_<id>_r<round> 身份', () => {
    const agent = makeAgent();
    const ref = 'task_tsk_demo_r3';
    const got = taskAsyncContext.run({ taskId: 'tsk_demo', workUnitRef: ref }, () => agent.turnWorkUnitRef());
    expect(got).toBe(ref);
  });

  it('作用域外没有任务身份（聊天回合仍走实例字段，不被改写）', () => {
    expect(makeAgent().turnWorkUnitRef()).toBeNull();
  });

  it('同一 agent 并发两个执行，身份互不串（ALS 一份执行一份）', async () => {
    const agent = makeAgent();
    const slow = taskAsyncContext.run({ taskId: 'tsk_a', workUnitRef: 'task_tsk_a_r1' }, async () => {
      await new Promise(r => setTimeout(r, 10));
      return agent.turnWorkUnitRef();
    });
    const fast = taskAsyncContext.run({ taskId: 'tsk_b', workUnitRef: 'task_tsk_b_r2' }, async () =>
      agent.turnWorkUnitRef(),
    );
    expect(await Promise.all([slow, fast])).toEqual(['task_tsk_a_r1', 'task_tsk_b_r2']);
  });

  it('执行作用域内 fact_assert 拿到溯源，不再 missing_provenance', async () => {
    const agent = makeAgent();
    const facts = { assert: vi.fn(() => ({ status: 'ok', fact: { id: 'fact_x' } })) };
    const tools = createFactTools({
      agentId: 'agt_identity_test',
      facts: facts as never,
      turnWorkUnitRef: () => agent.turnWorkUnitRef(),
    });
    const factAssert = tools.find(t => t.name === 'fact_assert');
    expect(factAssert).toBeDefined();
    const out = await taskAsyncContext.run({ taskId: 'tsk_demo', workUnitRef: 'task_tsk_demo_r1' }, () =>
      factAssert!.execute(ASSERT_ARGS),
    );
    expect(out).not.toContain('missing_provenance');
    expect(facts.assert).toHaveBeenCalledTimes(1);
  });

  it('没有身份时仍然拒绝 —— 守卫不能被这条修复削弱', async () => {
    const agent = makeAgent();
    const facts = { assert: vi.fn(() => ({ status: 'ok' })) };
    const tools = createFactTools({
      agentId: 'agt_identity_test',
      facts: facts as never,
      turnWorkUnitRef: () => agent.turnWorkUnitRef(),
    });
    const out = await tools.find(t => t.name === 'fact_assert')!.execute(ASSERT_ARGS);
    expect(out).toContain('missing_provenance');
    expect(facts.assert).not.toHaveBeenCalled();
  });
});
