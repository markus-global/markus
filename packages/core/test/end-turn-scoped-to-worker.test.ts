import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, shouldContinueToolLoop } from '../src/agent.js';
import { createSessionWorkspace, sessionWorkspaceStore } from '../src/session-workspace.js';
import type { RoleTemplate } from '@markus/shared';
import type { LLMRouter } from '../src/llm/router.js';

/**
 * 回归：`end_turn` 信号必须是**回合级**事实，不能被别的分身借走。
 *
 * 事故（2026-11-17 真机，agent_activity_logs 实证）：
 *   15:07:42  `sys_…` 心跳回合调 end_turn  → Agent 实例上的 `endTurnRequested = true`
 *   15:08:08  `cs_66bc…` 聊天回合的响应回来（text + 合法 apply_patch）
 *   15:08:08  该回合直接写到 `status: Completed`，**没有任何 tool_start**
 *             → 工具被整批丢弃，用户只看到「四个问题我分开答…」然后问「你怎么又断了？」
 *
 * 根因：`endTurnRequested` / `endTurnCount` / `lastTurnEndedViaEndTurn` 都是 Agent
 * 实例字段，而并发模式下 5 个 worker 共用同一个 Agent 对象。谁调 end_turn，谁的
 * 「回合结束」就变成所有人的「回合结束」。
 *
 * 修法：三个事实全部下沉到 `SessionWorkspace`（per-worker = per-turn）。
 * 本文件的断言在旧实现下必红 —— 这就是它存在的意义。
 */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-endturn-scope-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'endturn-scope-role',
  name: 'EndTurn Scope Role',
  description: 'Role for end_turn scoping tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeAgent(): Agent {
  const router = {
    chat: async () => ({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
    chatStream: async () => ({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
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
  } as unknown as LLMRouter;

  return new Agent({
    config: {
      id: 'endturn-scope-agent',
      name: 'EndTurn Scope Agent',
      role: 'worker',
      llmConfig: { provider: 'anthropic', model: 'test-model', apiKey: 'test' },
      createdAt: new Date().toISOString(),
    },
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

/** 访问 private 访问器（本测试的对象正是它们的存储位置）。 */
type TurnFacts = {
  endTurnRequested: boolean;
  endTurnCount: number;
  lastTurnEndedViaEndTurn: boolean;
};

describe('end_turn 信号属于回合（per-worker workspace），不属于 Agent 实例', () => {
  it('一个分身的 end_turn 不得让另一个分身看到「已结束」', () => {
    const agent = makeAgent() as unknown as TurnFacts;
    const wsHeartbeat = createSessionWorkspace(1);
    const wsChat = createSessionWorkspace(2);

    // 心跳回合调用 end_turn
    sessionWorkspaceStore.run(wsHeartbeat, () => {
      agent.endTurnRequested = true;
      agent.endTurnCount += 1;
      agent.lastTurnEndedViaEndTurn = true;
    });

    // 聊天回合：必须完全看不到这件事
    sessionWorkspaceStore.run(wsChat, () => {
      expect(agent.endTurnRequested).toBe(false);
      expect(agent.endTurnCount).toBe(0);
      expect(agent.lastTurnEndedViaEndTurn).toBe(false);

      // 而这正是事故现场：该回合的响应带了合法工具调用，
      // 工具循环**必须**继续（旧实现此处读到 true → 直接丢弃工具）。
      expect(
        shouldContinueToolLoop(
          { finishReason: 'tool_use', toolCalls: [{ id: 't1', name: 'apply_patch', arguments: {} }] },
          { endTurnRequested: agent.endTurnRequested },
        ),
      ).toBe(true);
    });

    // 心跳回合自己的账没有被别人抹掉
    sessionWorkspaceStore.run(wsHeartbeat, () => {
      expect(agent.endTurnRequested).toBe(true);
      expect(agent.endTurnCount).toBe(1);
    });
  });

  it('endTurnCount 是 per-worker 单调计数：不会把别人的 end_turn 记成自己的', () => {
    const agent = makeAgent() as unknown as TurnFacts;
    const wsA = createSessionWorkspace(1);
    const wsB = createSessionWorkspace(2);

    // A 在自己的回合里用快照差值判定「本回合是否以 end_turn 收尾」
    sessionWorkspaceStore.run(wsA, () => {
      const before = agent.endTurnCount;
      // B 在另一个回合里调了 end_turn
      sessionWorkspaceStore.run(wsB, () => { agent.endTurnCount += 1; });
      expect(agent.endTurnCount).toBe(before); // A 的账没被 B 改
    });
  });
});
