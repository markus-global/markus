/**
 * 【P3】重启后 agent 回复不显示在前端 — core 层复现/语义锁（docs/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.4）
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
import { shouldPersistTurnReply } from '../src/recovered-reply-persist.js';

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
  persistTurnReplyIfUnowned(
    reply: string,
    extra: Record<string, unknown>,
    metadata: Record<string, unknown> | undefined,
    memorySessionId: string | undefined,
    origin?: string,
  ): Promise<void>;
  setAssistantReplyPersister(cb: ((args: {
    sessionId?: string;
    memorySessionId?: string;
    agentId: string;
    reply: string;
    tokensUsed: number;
    origin?: string;
  }) => Promise<void>) | null): void;
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

describe('shouldPersistTurnReply（纯决策：谁是回复落库的执行者）', () => {
  it('恢复项：responsePromise 非函数 ∧ 带 DB 会话 → worker 须回写', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'human_chat',
      sessionId: 'cs_restored_1',
      dbSessionId: undefined,
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.sessionId).toBe('cs_restored_1');
  });

  it('恢复项：extra.sessionId 缺失但有 metadata.dbSessionId → 取 dbSessionId 回写', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'human_chat',
      sessionId: undefined,
      dbSessionId: 'cs_restored_2',
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.sessionId).toBe('cs_restored_2');
  });

  it('正常 SSE / 正常非流式（responsePromise 是函数，发起方等待中自写）→ 不触发 worker 回写', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: true,
      sourceType: 'human_chat',
      sessionId: 'cs_live',
      dbSessionId: 'cs_live',
    });
    expect(d.shouldPersist).toBe(false);
  });

  it('SSE 断连但进程活着（responsePromise 仍在）→ 不触发 worker 回写（api-server 仍负责）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: true,
      sourceType: 'human_chat',
      sessionId: 'cs_live_nonsse',
      dbSessionId: 'cs_live_nonsse',
    });
    expect(d.shouldPersist).toBe(false);
  });

  it('恢复项：无任何 DB 会话身份 → 无法定位目标会话，不写（宁可缺也不落错）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'human_chat',
      sessionId: undefined,
      dbSessionId: undefined,
    });
    expect(d.shouldPersist).toBe(false);
    expect(d.reason).toBe('no-target');
  });

  // ── P5：无发起方的 turn（callback_result）只有内存会话 id ────────────────────
  it('【P5】只有内存会话 → 须交给装配层反查 cs_*（不是不写，而是换一级定位）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'callback_result',
      sessionId: undefined,
      dbSessionId: undefined,
      memorySessionId: 'sess_origin',
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.memorySessionId).toBe('sess_origin');
    expect(d.sessionId).toBeUndefined();
    expect(d.reason).toBe('mem-only');
  });

  it('【P5】cs_* 与内存会话同时存在 → cs_* 一级优先（行为与 P3 逐字一致）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'callback_result',
      sessionId: 'cs_known',
      memorySessionId: 'sess_origin',
    });
    expect(d.shouldPersist).toBe(true);
    expect(d.sessionId).toBe('cs_known');
    expect(d.reason).toBe('cs-known');
  });

  it('【P5】空白字符串不算身份（不得落到空会话）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'callback_result',
      sessionId: '   ',
      memorySessionId: '',
    });
    expect(d.shouldPersist).toBe(false);
    expect(d.reason).toBe('no-target');
  });
});

describe('【P5b】白名单 + 控制信号：哪些 turn 的回复可能属于用户对话（fail-closed）', () => {
  /**
   * 生产泄漏形态（2026-10-07）：心跳跳过 LLM 返回 [end_turn] 哨兵，当前会话绑着
   * 用户聊天会话的内存会话 → mem-only 反查 → 哨兵被当正文写进用户对话。
   * 修复：sourceType 白名单 + 控制信号拒绝，收敛在 shouldPersistTurnReply 单一判定处。
   */
  it('心跳轮：即便解析到内存会话（mem-only 形态）→ 拒绝（not-user-facing）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'heartbeat',
      memorySessionId: 'sess_chat_bound',
      reply: '[end_turn]',
    });
    expect(d.shouldPersist).toBe(false);
    expect(d.reason).toBe('not-user-facing');
  });

  it('system_event / daily_report / review_request / task_status_update / memory_consolidation → 一律拒绝', () => {
    for (const t of ['system_event', 'daily_report', 'review_request', 'task_status_update', 'memory_consolidation']) {
      const d = shouldPersistTurnReply({
        resolveIsFunction: false,
        sourceType: t,
        sessionId: 'cs_known',
        reply: 'internal output',
      });
      expect(d.shouldPersist, t).toBe(false);
      expect(d.reason, t).toBe('not-user-facing');
    }
  });

  it('sourceType 缺失 → 拒绝（fail-closed：未知来源宁可不写，也不猜）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sessionId: 'cs_known',
      reply: 'text',
    });
    expect(d.shouldPersist).toBe(false);
    expect(d.reason).toBe('not-user-facing');
  });

  it('回复是类型化哨兵 [end_turn] → 拒绝（控制信号不是正文，no-user-reply）', () => {
    const d = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'callback_result',
      memorySessionId: 'sess_origin',
      reply: '[end_turn]',
    });
    expect(d.shouldPersist).toBe(false);
    expect(d.reason).toBe('no-user-reply');
  });

  it('回复是 [preempted] / [cancelled] 控制信号 → 同样拒绝', () => {
    for (const r of ['[preempted]', '[cancelled]']) {
      const d = shouldPersistTurnReply({
        resolveIsFunction: false,
        sourceType: 'human_chat',
        sessionId: 'cs_known',
        reply: r,
      });
      expect(d.shouldPersist, r).toBe(false);
      expect(d.reason, r).toBe('no-user-reply');
    }
  });

  it('human_chat / callback_result + 真实正文 → 维持 P3/P5 判据（回归保护）', () => {
    const a = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'human_chat',
      sessionId: 'cs_restored_1',
      reply: 'Hello',
    });
    expect(a.shouldPersist).toBe(true);
    expect(a.reason).toBe('cs-known');
    const b = shouldPersistTurnReply({
      resolveIsFunction: false,
      sourceType: 'callback_result',
      memorySessionId: 'sess_origin',
      reply: 'background job finished',
    });
    expect(b.shouldPersist).toBe(true);
    expect(b.reason).toBe('mem-only');
  });
});

describe('P3 恢复项：worker 兜底回写 DB 会话', () => {
  it('恢复形状（onEvent/responsePromise 均丢失）→ assistantReplyPersister 被调用，sessionId=请求 DB 会话、reply=回合回复', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistTurnReplyIfUnowned(
      'Hello from restored turn.',
      { stream: true, sessionId: 'cs_restored_1' },
      { senderId: 'user', dbSessionId: 'cs_restored_1' },
      undefined,
      undefined,
      'human_chat',
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

    await agent.persistTurnReplyIfUnowned(
      'live reply',
      { stream: true, onEvent: () => {}, sessionId: 'cs_live' },
      { senderId: 'user', dbSessionId: 'cs_live', responsePromise: { resolve: () => {}, reject: () => {} } },
      undefined,
      undefined,
      'human_chat',
    );

    expect(persister).not.toHaveBeenCalled();
  });

  it('恢复项但回复为空 → 不调用 persister', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistTurnReplyIfUnowned(
      '',
      { stream: true, sessionId: 'cs_restored_3' },
      { dbSessionId: 'cs_restored_3' },
      undefined,
      undefined,
      'human_chat',
    );

    expect(persister).not.toHaveBeenCalled();
  });

  /**
   * 【P5】无发起方的 turn（callback_result）——只有内存会话 id 时也必须落库，
   * 而且要把 origin 一并交给装配层（前端据此渲染「后台任务完成」标记）。
   */
  it('【P5】无发起方的 turn：persister 收到 memorySessionId + origin，且不带 sessionId', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistTurnReplyIfUnowned(
      'background job finished: 42 tests green',
      { callbackType: 'background_exec' },
      {},
      'sess_origin',
      'callback_result',
      'callback_result',
    );

    expect(persister).toHaveBeenCalledTimes(1);
    const arg = persister.mock.calls[0]![0];
    expect(arg.memorySessionId).toBe('sess_origin');
    expect(arg.sessionId).toBeUndefined();
    expect(arg.origin).toBe('callback_result');
    expect(arg.agentId).toBe(AGENT_ID);
    expect(arg.reply).toBe('background job finished: 42 tests green');
  });

  /**
   * 【P5b】控制信号不是正文：哨兵回复即便来自白名单类型也不得写进用户对话。
   */
  it('【P5b】哨兵回复（[end_turn]）→ 不调用 persister（控制信号不是正文）', async () => {
    const agent = createTestAgent();
    const persister = vi.fn(async () => {});
    agent.setAssistantReplyPersister(persister);

    await agent.persistTurnReplyIfUnowned(
      '[end_turn]',
      { callbackType: 'background_exec' },
      {},
      'sess_origin',
      'callback_result',
      'callback_result',
    );

    expect(persister).not.toHaveBeenCalled();
  });
});