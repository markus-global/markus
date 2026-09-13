import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AttentionController } from '../src/attention.js';
import type { AttentionDelegate, MailboxItem } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { createSessionWorkspace, sessionWorkspaceStore, type SessionWorkspace } from '../src/session-workspace.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

const AGENT_ID = 'test-cancel-directed-agent';

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for directed cancel tests',
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
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

type PrivateAgent = Agent & {
  workerWorkspaces: Map<number, SessionWorkspace>;
  attentionController: AttentionController;
  rootWorkspace: SessionWorkspace;
};

function createTestAgent(): PrivateAgent {
  return new Agent({
    config: {
      id: AGENT_ID,
      name: 'Directed Cancel Agent',
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-attention-directed-cancel-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 让 agent 的 attention delegate 缓存两个 worker workspace（模拟 worker 池就绪）。 */
function prepareWorkerWorkspaces(agent: PrivateAgent, count: number) {
  agent.attentionController.setWorkerCount(count);
  // start() 同步预创建 workerStates（launchWorkerPool → workerState(w)），随后 stop 空转循环。
  agent.attentionController.start();
  agent.attentionController.stop();
  // @ts-expect-error 私有 delegate 访问
  const delegate = agent.attentionController.delegate as AttentionDelegate;
  for (let w = 1; w <= count; w++) {
    delegate.getWorkerWorkspace?.(w);
  }
  // 兜底：确保每个 worker 的 workerState 已创建（避免 start/stop 时序差异）。
  for (let w = 1; w <= count; w++) {
    // @ts-expect-error 私有 workerState 访问
    agent.attentionController.workerState?.(w);
  }
}

/** 手动把某个 worker 置为「正在处理某 item」状态（模拟并发 worker focus）。 */
function plantFocus(agent: PrivateAgent, workerId: number, item: MailboxItem) {
  // @ts-expect-error 私有 workerStates 访问
  const wsState = agent.attentionController.workerStates.get(workerId);
  if (!wsState) throw new Error(`worker ${workerId} state missing`);
  wsState.focus = item;
  wsState.state = 'focused';
}

describe('并发模式定向取消（方案 B）', () => {
  it('findWorkerBySessionId 能按 sessionId 定位持有该会话的 worker', () => {
    const controller = new AttentionController(AGENT_ID, new AgentMailbox(AGENT_ID, new EventBus()), new EventBus());
    controller.setWorkerCount(2);
    controller.start();
    controller.stop();
    // @ts-expect-error 私有 workerStates 访问
    const ws1 = controller.workerStates.get(1)!;
    // @ts-expect-error 私有 workerStates 访问
    const ws2 = controller.workerStates.get(2)!;
    ws1.focus = { id: 'mbx_s1', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_AAA' } } as MailboxItem;
    ws2.focus = { id: 'mbx_s2', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_BBB' } } as MailboxItem;

    expect(controller.findWorkerBySessionId('ses_AAA')).toBe(1);
    expect(controller.findWorkerBySessionId('ses_BBB')).toBe(2);
    expect(controller.findWorkerBySessionId('ses_NOPE')).toBeUndefined();
    expect(controller.findWorkerByItemId('mbx_s2')).toBe(2);
  });

  it('findWorkerBySessionId 串行模式恒返回 1', () => {
    const controller = new AttentionController(AGENT_ID, new AgentMailbox(AGENT_ID, new EventBus()), new EventBus());
    expect(controller.findWorkerBySessionId('any')).toBe(1);
    expect(controller.findWorkerByItemId('any')).toBe(1);
  });

  it('requestUserCancelForWorker 只置位目标 worker，不波及其他 worker', () => {
    const controller = new AttentionController(AGENT_ID, new AgentMailbox(AGENT_ID, new EventBus()), new EventBus());
    controller.setWorkerCount(2);
    controller.start();
    controller.stop();
    // @ts-expect-error 私有 workerStates 访问
    const ws1 = controller.workerStates.get(1)!;
    // @ts-expect-error 私有 workerStates 访问
    const ws2 = controller.workerStates.get(2)!;
    ws1.focus = { id: 'mbx_1', sourceType: 'human_chat' } as MailboxItem;
    ws2.focus = { id: 'mbx_2', sourceType: 'human_chat' } as MailboxItem;

    const hit = controller.requestUserCancelForWorker(2);

    expect(hit).toBe(true);
    expect(ws1.userCancelCurrent ?? false).toBe(false);
    expect(ws2.userCancelCurrent ?? false).toBe(true);
    // 未处理目标 item 的 worker → 返回 false 且不置位
    expect(controller.requestUserCancelForWorker(99)).toBe(false);
  });

  it('外部线程（无 ALS）按 sessionId 定向 cancelActiveStream 只取消目标 worker 的流', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    prepareWorkerWorkspaces(a, 2);

    const ws1 = a.workerWorkspaces.get(1)!;
    const ws2 = a.workerWorkspaces.get(2)!;
    // worker 1 处理 ses_AAA，worker 2 处理 ses_BBB（外部线程的「当前」视角是 worker 1，
    // 但目标其实是 worker 2 —— 这正是方案 B 要修的场景）
    plantFocus(a, 1, { id: 'mbx_A', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_AAA' } } as MailboxItem);
    plantFocus(a, 2, { id: 'mbx_B', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_BBB' } } as MailboxItem);

    // 从无 ALS 上下文调用（外部 HTTP 线程等价）——sessionWorkspaceStore.getStore() 为 undefined
    expect(sessionWorkspaceStore.getStore()).toBeUndefined();
    agent.cancelActiveStream({ sessionId: 'ses_BBB' });

    // 目标 worker 2 的 activeStreamToken 被置位
    expect(ws2.activeStreamToken?.cancelled).toBe(true);
    expect(ws2.activeStreamToken?.userStopped).toBe(true);
    // worker 1 不受影响
    expect(ws1.activeStreamToken).toBeUndefined();
  });

  it('外部线程按 itemId 定向 cancelActiveStream 命中持有该 item 的 worker', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    prepareWorkerWorkspaces(a, 2);

    const ws1 = a.workerWorkspaces.get(1)!;
    const ws2 = a.workerWorkspaces.get(2)!;
    plantFocus(a, 1, { id: 'mbx_X', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_1' } } as MailboxItem);
    plantFocus(a, 2, { id: 'mbx_Y', sourceType: 'human_chat', metadata: { dbSessionId: 'ses_2' } } as MailboxItem);

    agent.cancelActiveStream({ itemId: 'mbx_X' });

    expect(ws1.activeStreamToken?.cancelled).toBe(true);
    expect(ws2.activeStreamToken).toBeUndefined();
  });

  it('无 target 时兼容旧行为：取消当前 ALS 上下文的流', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    prepareWorkerWorkspaces(a, 2);

    const ws2 = a.workerWorkspaces.get(2)!;
    // 模拟 worker 2 的 ALS 上下文内调用（无 target → 取消当前 worker）
    const ws = a.workerWorkspaces.get(2)!;
    sessionWorkspaceStore.run(ws, () => {
      agent.cancelActiveStream();
    });
    expect(ws2.activeStreamToken?.cancelled).toBe(true);
  });

  it('串行模式（workerCount=1）cancelActiveStream 行为与旧版一致', () => {
    const agent = createTestAgent();
    const a = agent as PrivateAgent;
    a.attentionController.setWorkerCount(1);

    agent.cancelActiveStream();
    expect(a.rootWorkspace.activeStreamToken?.cancelled).toBe(true);
    expect(a.rootWorkspace.activeStreamToken?.userStopped).toBe(true);
  });
});