/**
 * 【P5b】内部 turn 的回复绝不落库到用户对话 —— 生产泄漏复现（2026-10-07）。
 *
 * 现象（Owner 实测发现）：Team Chat 出现与心跳周期同步的 `[end_turn]` 气泡。
 * runtime-2026-10-07.log：
 *   07:27:14.792  Heartbeat: skipping LLM (idle/deep-sleep)
 *   07:27:14.797  P5: turn reply persisted ... {"reason":"mem-only","replyLength":10}
 * （10 = `'[end_turn]'.length`）
 *
 * 根因两层：
 *   1. 白名单 `CHAT_CONVERSATION_TURN_TYPES` 是**死代码** —— 只被注释与测试引用，
 *      无任何运行路径消费；旧护栏用例因「无会话身份 → no-target」空转变绿。
 *   2. 心跳跳过 LLM 时返回类型化哨兵 `[end_turn]`（attention 层认得并吞掉），
 *      落库判据不认 → 控制信号被当正文写进用户会话。
 *
 * 本文件锁一件事（先红后绿）：**生产形态复现** —— worker 的当前会话仍绑着
 * 用户聊天会话的内存会话（上一轮 human_chat / callback 留下的），此时心跳触发
 * 且跳过 LLM → persister **绝不被调用**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentOptions } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { MailboxItem } from '@markus/shared';

let tempDir: string;

const AGENT_ID = 'agt_p5b_heartbeat_leak';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-p5b-hb-leak-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: 'unused',
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
    $getRoles: () => [],
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

function createTestAgent(): Agent {
  return new Agent({
    config: {
      id: AGENT_ID,
      name: 'P5b Heartbeat Leak Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: { roleId: 'worker', name: 'Worker' } as never,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    tools: [],
  } as unknown as AgentOptions);
}

type PrivateCore = {
  processMailboxItemCore: (i: MailboxItem) => Promise<unknown>;
};

function item(sourceType: MailboxItem['sourceType']): MailboxItem {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    sourceType,
    status: 'processing',
    priority: 1,
    createdAt: new Date().toISOString(),
    payload: { summary: 'Scheduled heartbeat check-in', content: 'heartbeat' },
    metadata: {},
  } as unknown as MailboxItem;
}

describe('P5b：心跳轮回复绝不泄漏进用户对话（生产形态复现）', () => {
  it('currentSessionId 绑着聊天会话 + 心跳跳过 LLM（返回 [end_turn] 哨兵）→ persister 不得被调用', async () => {
    const agent = createTestAgent();
    const core = agent as unknown as PrivateCore;
    // 生产形态：心跳触发时，worker 的当前会话仍是用户聊天会话的内存会话
    // （上一次 human_chat / callback_result 轮留下的「保持当前会话」）。
    (agent as unknown as { currentSessionId: string | undefined }).currentSessionId =
      'sess_chat_bound';
    // "Heartbeat: skipping LLM (idle/deep-sleep)" —— handleHeartbeat 正常完成、无 LLM 输出。
    vi.spyOn(
      agent as unknown as { handleHeartbeat: (o: unknown) => Promise<string | undefined> },
      'handleHeartbeat',
    ).mockResolvedValue(undefined);

    const persister = vi.fn(async (_a: unknown) => {});
    agent.setAssistantReplyPersister(persister);

    await core.processMailboxItemCore(item('heartbeat'));

    expect(persister).not.toHaveBeenCalled();
  });
});
