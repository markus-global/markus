/**
 * 【P5】`callback_result` 的回复必须落库到发起它的那个对话会话 —— 不再只写 MemoryStore。
 *
 * 现象（老板 2026-10-07 提问）：`background_exec` 完成 / `agent_send_message reply_in_session`
 * 的对端回复回到 Team Chat 对话时，**处理过程与结果都不呈现**：
 *   - 消费端走非流式的 `handleMessage()`（不传 `extra.onEvent`）⇒ 无 SSE token、无流式气泡；
 *   - 只有 `human_chat` 分支会兜底落库 ⇒ 回复只进内存会话上下文，用户在会话里永远看不到。
 *
 * 修法（P5）：把「谁是这一轮回复的落库执行者」收敛为**单一判据 + 单一执行点**
 * （`shouldPersistTurnReply` + `processMailboxItemCore` 的 finally），并用**白名单**
 * 保证内部 turn（心跳/任务/系统/记忆整理）的输出绝不泄漏进用户对话。
 *
 * 本文件锁三件事：
 *   1. `callback_result`（无发起方、只有内存会话）→ persister 必须被调用，
 *      且带 `memorySessionId` + `origin='callback_result'`（供装配层反查 cs_* 并广播气泡）；
 *   2. 非对话类 turn（如 `system_event`）→ 即便有回复也**不得**落库（白名单护栏）；
 *   3. 白名单本身是结构保证 —— 内部 turn 类型不在名单里。
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

const AGENT_ID = 'agt_p5_callback_visible';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-p5-cb-visible-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({
      content: 'background job finished',
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
      name: 'P5 Callback Visible Agent',
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
  memory: { createSession(agentId: string): { id: string } };
};
type PersistArg = {
  sessionId?: string;
  memorySessionId?: string;
  agentId: string;
  reply: string;
  tokensUsed: number;
  origin?: string;
};

function item(
  sourceType: MailboxItem['sourceType'],
  extra: Record<string, unknown> = {},
): MailboxItem {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    sourceType,
    status: 'processing',
    priority: 1,
    createdAt: new Date().toISOString(),
    payload: { summary: 'Background process succeeded', content: 'output tail', extra },
    metadata: {},
  } as unknown as MailboxItem;
}

/** 让这一轮拿到一个确定的回复文本（不真的走 LLM）。 */
function stubReply(agent: Agent, reply: string): void {
  vi.spyOn(
    agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: unknown) => Promise<string>;
    },
    'handleMessage',
  ).mockImplementation(async () => reply);
}

describe('P5：callback_result 回复对用户可见（落库执行点）', () => {
  it('无发起方的 callback_result（只有内存会话）→ persister 被调用，带 memorySessionId + origin', async () => {
    const agent = createTestAgent();
    const core = agent as unknown as PrivateCore;
    const origin = core.memory.createSession(AGENT_ID).id;
    stubReply(agent, 'background job finished: 42 tests green');

    const persister = vi.fn(async (_a: PersistArg) => {});
    agent.setAssistantReplyPersister(persister);

    await core.processMailboxItemCore(
      item('callback_result', {
        originSessionId: origin,
        // 契约：`deliverCallback` 把发起轮的内存会话表态为 `sessionHint`（kind:'memory'）。
        // 缺了它 hint 会退化为 'unknown' → 保持当前会话而不是回到发起会话。
        sessionHint: { kind: 'memory', memorySessionId: origin },
        callbackType: 'background_exec',
        scenario: 'task_execution',
      }),
    );

    expect(persister).toHaveBeenCalledTimes(1);
    const arg = persister.mock.calls[0]![0];
    // 只有内存会话 ⇒ 由装配层反查 cs_*（一级身份缺失不能变成「不写」）。
    expect(arg.memorySessionId).toBe(origin);
    expect(arg.sessionId).toBeUndefined();
    expect(arg.origin).toBe('callback_result');
    expect(arg.reply).toContain('42 tests green');
  });

  it('非对话类 turn（system_event）→ 即便有回复也不落库（白名单护栏：不泄漏进用户对话）', async () => {
    const agent = createTestAgent();
    const core = agent as unknown as PrivateCore;
    stubReply(agent, 'daily digest processed');

    const persister = vi.fn(async (_a: PersistArg) => {});
    agent.setAssistantReplyPersister(persister);

    await core.processMailboxItemCore(item('system_event', { callbackType: 'wakeup' }));

    expect(persister).not.toHaveBeenCalled();
  });

  it('白名单是结构保证：心跳 / 任务 / 系统 / 记忆整理均不纳入', () => {
    const allow = (Agent as unknown as { CHAT_CONVERSATION_TURN_TYPES: Set<string> })
      .CHAT_CONVERSATION_TURN_TYPES;
    expect(allow.has('human_chat')).toBe(true);
    expect(allow.has('callback_result')).toBe(true);
    for (const t of ['heartbeat', 'task_status_update', 'system_event', 'daily_report', 'memory_consolidation', 'review_request']) {
      expect(allow.has(t), t).toBe(false);
    }
  });

  it('没有注入 persister 时安全 no-op（不抛异常，不影响 turn）', async () => {
    const agent = createTestAgent();
    const core = agent as unknown as PrivateCore;
    const origin = core.memory.createSession(AGENT_ID).id;
    stubReply(agent, 'done');

    await expect(
      core.processMailboxItemCore(
        item('callback_result', {
          originSessionId: origin,
          sessionHint: { kind: 'memory', memorySessionId: origin },
          callbackType: 'background_exec',
        }),
      ),
    ).resolves.toBeDefined();
  });
});
