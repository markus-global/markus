/**
 * 【P3】重启后 agent 回复不显示在前端 — core 层复现/语义锁（docs/records/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.4）
 *
 * 场景：重启后 `recoverStaleItems` → `loadQueued` 从 DB JSON 还原排队项，函数闭包
 * （`extra.onEvent`、`metadata.responsePromise`）序列化丢失 → `processMailboxItemCore`
 * human_chat 分支走**非流式** `handleMessage` → 回复只写 MemoryStore（sess_*），
 * 正常路径下回写 DB 会话（cs_*）的责任在 SSEHandler（HTTP 线程 `sendMessageStream`
 * resolve 后调 persistAssistantMessage），重启后 HTTP 线程已死 → 回复不落 DB →
 * 前端 `api.sessions.getMessages(cs_*)` 拉不到回复 → 刷新也不显示。
 *
 * 本测试锁两件事：
 * 1. **恢复项（onEvent / responsePromise 均丢失）处理完成 → 注入的 assistantReplyPersister
 *    必须被调用**（sessionId = 请求携带的 DB 会话 id，reply = 回合回复）—— worker 兜底
 *    回写 DB，前端刷新才能拉到；
 * 2. **发起方 promise 仍存活（正常非流式 sendMessage / 正常 SSE）→ 不得触发 worker 回写**——
 *    那些路径由 api-server 自己 persistAssistantMessage，双写会生成重复回复行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { shouldPersistRecoveredReply } from '../src/recovered-reply-persist.js';

let tempDir: string;

const AGENT_ID = 'test-p3-restart-reply-agent';

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for P3 restart reply persistence semantic lock',
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
      content: 'Hello from restored turn.',
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

type PrivateAgent = Agent & {
  persistRecoveredReplyIfNeeded(
    reply: string,
    extra: Record<string, unknown>,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void>;
  setAssistantReplyPersister(cb: ((args: { sessionId: string; agentId: string; reply: string; tokensUsed: number }) => Promise<void>) | null): void;
};

function createTestAgent(): PrivateAgent {
  return new Agent({
    config: {
      id: AGENT_ID,
      name: 'P3 Restart Reply Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  }) as unknown as PrivateAgent;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-p3-restart-reply-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('shouldPersistRecoveredReply（纯决策：谁是回复落库的执行者）', () => {
  it('恢复项：responsePromise 非函数 ∧ 带 DB 会话 → worker 须回写', () => {
    const d = shouldPersistRecoveredReply({
      resolveIsFunction: false,
      sessionId: 'cs_restored_1',
      dbSessionId: undefined,
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.sessionId).toBe('cs_restored_1');
  });

  it('恢复项：extra.sessionId 缺失但有 metadata.dbSessionId → 取 dbSessionId 回写', () => {
    const d = shouldPersistRecoveredReply({
      resolveIsFunction: false,
      sessionId: undefined,
      dbSessionId: 'cs_restored_2',
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.sessionId).toBe('cs_restored_2');
  });

  it('正常 SSE / 正常非流式（responsePromise 是函数，发起方等待中自写）→ 不触发 worker 回写', () => {
    const d = shouldPersistRecoveredReply({
      resolveIsFunction: true,
      sessionId: 'cs_live',
      dbSessionId: 'cs_live',
    });
    expect(d.shouldPersist).toBe(false);
  });

  it('SSE 断连但进程活着（responsePromise 仍在）→ 不触发 worker 回写（api-server 仍负责）', () => {
    const d = shouldPersistRecoveredReply({
      resolveIsFunction: true,
      sessionId: 'cs_live_nonsse',
      dbSessionId: 'cs_live_nonsse',
    });
    expect(d.shouldPersist).toBe(false);
  });

  it('恢复项：无任何 DB 会话身份 → 无法定位目标会话，不写（宁可缺也不落错）', () => {
    const d = shouldPersistRecoveredReply({
      resolveIsFunction: false,
      sessionId: undefined,
      dbSessionId: undefined,
    });
    expect(d.shouldPersist).toBe(false);
  });
});

describe('P3 恢复项：worker 兜底回写 DB 会话', () => {
  it('恢复形状（onEvent/responsePromise 均丢失）→ assistantReplyPersister 被调用，sessionId=请求 DB 会话、reply=回合回复', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistRecoveredReplyIfNeeded(
      'Hello from restored turn.',
      { stream: true, sessionId: 'cs_restored_1' },
      { senderId: 'user', dbSessionId: 'cs_restored_1' },
    );

    expect(persister).toHaveBeenCalledTimes(1);
    const arg = persister.mock.calls[0]![0];
    expect(arg.sessionId).toBe('cs_restored_1');
    expect(arg.agentId).toBe(AGENT_ID);
    expect(arg.reply).toBe('Hello from restored turn.');
  });

  it('发起方 promise 仍存活（正常路径）→ 不调用 persister（避免双写）', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistRecoveredReplyIfNeeded(
      'live reply',
      { stream: true, onEvent: () => {}, sessionId: 'cs_live' },
      { senderId: 'user', dbSessionId: 'cs_live', responsePromise: { resolve: () => {}, reject: () => {} } },
    );

    expect(persister).not.toHaveBeenCalled();
  });

  it('恢复项但回复为空 → 不调用 persister', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistRecoveredReplyIfNeeded(
      '',
      { stream: true, sessionId: 'cs_restored_3' },
      { dbSessionId: 'cs_restored_3' },
    );

    expect(persister).not.toHaveBeenCalled();
  });
});