/**
 * 【P1】「停止 → 重发 → 两条处理中」core 层复现/语义锁（docs/records/message-stop-cancel-fix-plan.md §2.6）
 *
 * 场景：消息刚入队（human_chat item 尚未被 worker 拾取 → 无在途流），用户点「停止」。
 * 此时 `stopSending` 若传 `{ sessionId }`（既有会话）→ `resolveCancelTarget` 解析不到
 * 在途流 → `{ kind: 'none' }` → **取消 no-op** → mailbox 行不被 drop、卡在 processing/queued
 * （「第一次显示处理中但未真正处理」的 DB 侧机制）。
 *
 * 本测试锁两件事：
 * 1. **取消落空时行不 drop**（queued 行原地不动）—— 这就是概览页「处理中」假象的 DB 来源，
 *    也是 2c「stale processing 手动恢复入口」存在的原因；
 * 2. **落空取消不得误杀其它在途流**（root workspace 的 token 必须保持 untouched）——
 *    这保证把「无 target 的 root 取消」从 stopSending 里移除是安全的（2b）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { EventBus } from '../src/events.js';
import { AgentMailbox } from '../src/mailbox.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

const AGENT_ID = 'test-p1-stop-resend-agent';
const SESSION_ID = 'ses_P1_QQQ';

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for P1 stop/resend semantic lock',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  const chat = vi.fn(async () => ({
    content: 'Hello.',
    finishReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
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
    $getRoles: () => [],
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

type PrivateAgent = Agent & {
  attentionController: { setWorkerCount(n: number): void; getCurrentFocus(): unknown };
  rootWorkspace: { activeStreamToken?: { cancelled?: boolean; userStopped?: boolean } };
};

function createTestAgent(): PrivateAgent {
  return new Agent({
    config: {
      id: AGENT_ID,
      name: 'P1 Stop Resend Agent',
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-p1-stop-cancel-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('P1 停止→重发：取消落空 → 行停留 processing，且不误杀在途流', () => {
  it('消息刚入队（无在途流）→ 按 sessionId 取消 = no-op，行不被 drop（停留 queued/processing）', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    a.attentionController.setWorkerCount(1);

    // 用户发了一条消息，item 进入 mailbox 排队（尚未被 worker 拾取 → 无在途流）。
    const mb = agent.getMailbox();
    const payload = {
      summary: 'first message',
      content: 'first message',
      extra: { stream: true, sessionId: SESSION_ID },
    } as never;
    const item = mb.enqueue('human_chat', payload, {
      priority: 0,
      metadata: { senderId: 'user', senderName: 'User' } as never,
    });

    // 停止信号到达：stopSending → cancelProcessing(agentId, { sessionId })
    const hit = agent.cancelActiveStream({ sessionId: SESSION_ID });

    // ① 取消落空 → no-op（返回 undefined）→ 行不被 drop：
    expect(hit).toBeUndefined();
    const queued = mb.getQueuedItems();
    expect(queued.some(i => i.id === item.id)).toBe(true);
    expect(mb.getQueuedItems().find(i => i.id === item.id)?.status).toBe('queued');
  });

  it('串行模式：无 target 的 root 取消会把 root token 置 userStopped（这是 2b 移除的误杀源）', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    a.attentionController.setWorkerCount(1);

    // 旧 stopSending：占位会话时 target=undefined → 服务端走 root 兼容路径，
    // 把「当前 ALS/根上下文流」标记 userStopped。HTTP 线程无 ALS → 落 rootWorkspace。
    // 这就是「停止一条新消息 → 误伤另一个正在跑会话」的机制，2b 修法是让
    // 占位会话根本不发后端取消（resolveStopCancelDecision → skip）。
    expect(a.rootWorkspace.activeStreamToken).toBeUndefined();
    agent.cancelActiveStream(); // 无 target（= 旧 stopSending 占位行为的服务端表现）
    expect(a.rootWorkspace.activeStreamToken?.cancelled).toBe(true);
    expect(a.rootWorkspace.activeStreamToken?.userStopped).toBe(true);
  });
});