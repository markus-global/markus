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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 入口级守卫（CTO 复审 2026-11-15 ③）。
 *
 * 上面那组用例自己 `taskAsyncContext.run({ workUnitRef })`、自己喂 `turnWorkUnitRef`，
 * 于是「入口有没有把身份写进作用域」这一段**根本没被测**：把
 * `executeTaskConcurrent` 里的 `workUnitRef: WORK_UNIT_REF.task(...)` 删掉，它们仍然全绿。
 * 而 P0 死锁恰恰就是那一段缺失造成的（`_executeTaskInternal` 只写 currentTaskId）。
 *
 * 所以下面两例从**真实执行入口**进去（`agent.executeTask`，与 TaskService 派发同一条链），
 * 在回合内部的工具里读身份、并真的调一次 `fact_assert`：
 *   · 带 round → 身份 = task_<id>_r<round>，fact_assert 不再 missing_provenance；
 *   · 不带 round → 身份与会话 id 共用同一个默认（一起落 r1），**不会自己分叉**。
 */
describe('真实执行入口把身份写进回合作用域', () => {
  const PROBE_TASK = 'task_entry_probe';

  function scriptedRouter(): LLMRouter {
    let call = 0;
    const router = makeMockRouter();
    (router as unknown as { chatStream: unknown }).chatStream = vi.fn(
      async (_req: unknown, onEvent?: (e: { type: string; text?: string }) => void) => {
        call++;
        if (call === 1) {
          onEvent?.({ type: 'text_delta', text: 'probing identity' });
          return {
            content: 'probing identity',
            finishReason: 'tool_use',
            toolCalls: [{ id: 'tc_probe', name: 'identity_probe', arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          content: 'done',
          finishReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    return router;
  }

  async function startedAgent(): Promise<Agent> {
    // 用脚本化 router：入口级用例要求真的跑一轮工具循环（第一个响应出 tool_use）。
    const agent = new Agent({
      config: {
        id: 'agt_identity_test',
        name: 'Identity Test Agent',
        roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'test' },
        createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE,
      llmRouter: scriptedRouter(),
      dataDir: tempDir,
    });
    await agent.start();
    return agent;
  }

  it('带 round：回合内身份 = task_<id>_r<round>，且 fact_assert 拿得到溯源', async () => {
    const agent = await startedAgent();
    const seenRefs: Array<string | null> = [];
    const assertedRefs: string[] = [];
    const factOutputs: string[] = [];
    const facts = {
      assert: vi.fn((input: { workUnitRef: string }) => {
        assertedRefs.push(input.workUnitRef);
        return { status: 'asserted', fact: { id: 'fact_entry' } };
      }),
    };
    const factTools = createFactTools({
      agentId: 'agt_identity_test',
      facts: facts as never,
      // 与生产装配同形：agent-manager.ts 的 applyFactsCapability 就是这个闭包
      turnWorkUnitRef: () => agent.turnWorkUnitRef(),
    });
    const factAssert = factTools.find(t => t.name === 'fact_assert')!;
    agent.registerTool(factAssert);
    agent.registerTool({
      name: 'identity_probe',
      description: 'Records the turn WorkUnit identity',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        seenRefs.push(agent.turnWorkUnitRef());
        factOutputs.push(String(await factAssert.execute(ASSERT_ARGS)));
        return '{"ok":true}';
      },
    });

    await agent.executeTask(PROBE_TASK, 'probe identity', () => {}, undefined, undefined, 2);

    // 身份来自入口写入，而不是任何注入的 ctx
    expect(seenRefs).toEqual(['task_task_entry_probe_r2']);
    // 事实真的写进去了：没有 missing_provenance，且 service 收到的 ref 同值
    expect(factOutputs[0]).not.toContain('missing_provenance');
    expect(assertedRefs).toEqual(['task_task_entry_probe_r2']);
    await agent.stop();
  });

  it('不带 round：身份与会话 id 共用同一个默认（一起落 r1，不分叉）', async () => {
    const agent = await startedAgent();
    const seenRefs: Array<string | null> = [];
    agent.registerTool({
      name: 'identity_probe',
      description: 'Records the turn WorkUnit identity',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        seenRefs.push(agent.turnWorkUnitRef());
        return '{"ok":true}';
      },
    });

    await agent.executeTask(PROBE_TASK, 'probe identity without round', () => {});

    // 会话 id 用的也是 r1（不在本测试断言，见 executeTaskConcurrent 的同源解析）；
    // 关键：身份不会凭空变成别的 round。
    expect(seenRefs).toEqual(['task_task_entry_probe_r1']);
    await agent.stop();
  });
});
