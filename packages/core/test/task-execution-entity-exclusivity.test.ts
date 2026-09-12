import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { MailboxItem, RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * T3 · 消费侧实体独占（单飞）回归测试
 *
 * 回归目标（验收断言）：同一 task 在已有活跃执行会话时，第二次「执行指令」
 * （`task_status_update` + `extra.triggerExecution`）必须落在服务端代码层被判定为
 * non-actionable 并 drop 留痕 —— 断言**仅一次执行**、无重复收口/状态错乱。
 *
 * 未修复基线上，第二条指令会第二次调用 executeTask（同一 task 被两会话并发执行）。
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for task execution exclusivity',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: 'Hello.',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
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

type TestAgent = Agent & {
  attentionController: { setWorkerCount(n: number): void; getWorkerCount(): number };
  processMailboxItemInternal(item: MailboxItem): Promise<string | void>;
};

function createTestAgent(): TestAgent {
  return new Agent({
    config: {
      id: 'test-task-exclusivity-agent',
      name: 'Task Exclusivity Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  }) as unknown as TestAgent;
}

/** 构造一条「执行指令」mailbox item（与 sendTaskExecution 入队形状一致）。 */
function makeTaskExecutionItem(taskId: string, itemId: string, round = 1): MailboxItem {
  return {
    id: itemId,
    agentId: 'test-task-exclusivity-agent',
    sourceType: 'task_status_update',
    priority: 1,
    status: 'processing',
    payload: {
      summary: `Task: ${taskId}`,
      content: `Execute ${taskId}`,
      taskId,
      extra: { triggerExecution: true, onLog: () => { /* noop */ }, executionRound: round },
    },
    queuedAt: new Date().toISOString(),
  } as MailboxItem;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-task-exclusivity-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('T3 消费侧实体独占：同一 task 单飞', () => {
  it('活跃执行期内重复执行指令被 drop（non-actionable）：仅一次执行 + 可观测事件', async () => {
    const agent = createTestAgent();
    // 并发分身：两个 worker 可能同时取到同一 task 的两条指令
    agent.attentionController.setWorkerCount(2);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const executed: string[] = [];
    const executeTaskSpy = vi
      .spyOn(agent, 'executeTask')
      .mockImplementation(async (taskId: string) => {
        executed.push(taskId);
        await gate;
      });

    const skipped: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any).eventBus.on('agent:task-execution-skipped-duplicate', (p: Record<string, unknown>) => skipped.push(p));

    // 会话 A：开始执行 task_x（保持活跃）。
    // 等待条件用「executeTask 已被调用一次」而非修复引入的钩子——这样未修复基线上的
    // 失败原因落在「同一 task 被执行了两次」，而不是「缺少某个新方法」。
    const sessionA = agent.processMailboxItemInternal(makeTaskExecutionItem('task_x', 'mbx-a'));
    await vi.waitFor(() => {
      expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    });

    // 会话 B：同一 task 的重复执行指令并发到达
    await agent.processMailboxItemInternal(makeTaskExecutionItem('task_x', 'mbx-b'));

    // 断言：仅一次执行；第二条被 drop 并留痕
    expect(executeTaskSpy).toHaveBeenCalledTimes(1);
    expect(executed).toEqual(['task_x']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      agentId: agent.id,
      taskId: 'task_x',
      itemId: 'mbx-b',
      existingSessionId: 'task_task_x_r1',
    });

    // 终态后释放：合法重派（抢占重排/重试/新轮次）不被误伤
    release();
    await sessionA;
    await vi.waitFor(() => {
      expect(agent.isTaskExecutionInFlight('task_x')).toBe(false);
    });

    await agent.processMailboxItemInternal(makeTaskExecutionItem('task_x', 'mbx-c', 2));
    expect(executeTaskSpy).toHaveBeenCalledTimes(2);
  });

  it('不同 task 互不影响（单飞按 taskId 粒度）', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(2);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const executed: string[] = [];
    vi.spyOn(agent, 'executeTask').mockImplementation(async (taskId: string) => {
      executed.push(taskId);
      await gate;
    });

    const a = agent.processMailboxItemInternal(makeTaskExecutionItem('task_a', 'mbx-a'));
    const b = agent.processMailboxItemInternal(makeTaskExecutionItem('task_b', 'mbx-b'));

    await vi.waitFor(() => {
      expect(executed.sort()).toEqual(['task_a', 'task_b']);
    });

    release();
    await Promise.all([a, b]);
  });
});
