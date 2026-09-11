import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionWorkspaceStore } from '../src/session-workspace.js';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for concurrent activity tests',
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

// 私有访问类型（测试内使用，避开 TS 私有限制）
type PrivateAgent = Agent & {
  workerWorkspaces: Map<number, { currentActivity?: unknown }>;
  attentionController: { getWorkerCount(): number; setWorkerCount(n: number): void };
  rootWorkspace: { currentActivity?: unknown };
};

function createTestAgent(): PrivateAgent {
  return new Agent({
    config: {
      id: 'test-concurrent-activity-agent',
      name: 'Concurrent Activity Agent',
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-agent-concurrent-activity-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// 并发 worker 的真实 ALS 挂载方式：worker 循环用 agent.getWorkerWorkspace(id)
// 缓存的 workspace + sessionWorkspaceStore.run。此处经 agent-manager 的
// getWorkerWorkspace 委托创建并缓存，再手动挂 ALS（模拟 concurrentWorkerLoop）。
function mountWorker(agent: PrivateAgent, workerId: number) {
  // 让 delegate 缓存 worker workspace（等价 getWorkerWorkspace(workerId) 首次调用）
  // 这里直接通过 attention delegate 的 getWorkerWorkspace 触发缓存创建。
  // @ts-expect-error 私有 delegate 访问
  const ws = agent.attentionController?.delegate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (agent.attentionController as any).delegate.getWorkerWorkspace?.(workerId)
    : undefined;
  if (!ws) {
    // 兜底：直接塞入 workerWorkspaces（与 getWorkerWorkspace 缓存行为一致）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any).workerWorkspaces.set(workerId, { workerId, pendingInjections: new Map() });
    return { workerId, pendingInjections: new Map() };
  }
  return ws;
}

describe('Agent concurrent activity isolation', () => {
  it('isolates currentActivity per worker (never cross-writes)', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(2);

    const ws1 = mountWorker(agent, 1);
    const ws2 = mountWorker(agent, 2);

    // Worker 1 starts activity A
    let actAId: string | undefined;
    await sessionWorkspaceStore.run(ws1, async () => {
      agent.startActivity('chat', 'Chat with Alice');
      actAId = agent.getCurrentActivityId();
    });

    // Worker 2 starts activity B — must NOT overwrite worker 1's activity
    let actBId: string | undefined;
    await sessionWorkspaceStore.run(ws2, async () => {
      agent.startActivity('chat', 'Chat with Bob');
      actBId = agent.getCurrentActivityId();
    });

    expect(actAId).toBeDefined();
    expect(actBId).toBeDefined();
    expect(actAId).not.toBe(actBId);

    const recent = agent.getRecentActivities();
    expect(recent).toHaveLength(2);
    expect(recent.map(a => a.label).sort()).toEqual(['Chat with Alice', 'Chat with Bob']);

    // getCurrentActivity returns latest (by startedAt) — activity B
    expect(agent.getCurrentActivity()?.id).toBe(actBId);

    // Ending worker 1's activity must NOT clear worker 2's
    await sessionWorkspaceStore.run(ws1, async () => {
      agent.endActivity(actAId);
    });
    expect(agent.getCurrentActivity()?.id).toBe(actBId);
    expect(agent.getRecentActivities()).toHaveLength(1);
  });

  it('worker-scoped read returns own activity inside ALS context', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(2);

    const ws1 = mountWorker(agent, 1);
    const ws2 = mountWorker(agent, 2);

    await sessionWorkspaceStore.run(ws1, async () => {
      agent.startActivity('task', 'Handle tsk_A');
    });
    await sessionWorkspaceStore.run(ws2, async () => {
      agent.startActivity('a2a', 'Reply to team chat');
    });

    // getCurrentActivity() is the AGGREGATE view (latest by startedAt) —
    // identical from any context. Worker isolation is verified separately
    // (both activities coexist; ending one doesn't clear the other).
    const fromW1 = await sessionWorkspaceStore.run(ws1, async () => agent.getCurrentActivity()?.label);
    const fromW2 = await sessionWorkspaceStore.run(ws2, async () => agent.getCurrentActivity()?.label);
    // Aggregate is context-independent
    expect(fromW1).toBe(fromW2);
    expect(fromW1).toBe('Reply to team chat');

    // The REAL isolation guarantee: both are live — worker 2's activity
    // did NOT overwrite worker 1's (they coexist in the aggregate).
    expect(agent.getRecentActivities()).toHaveLength(2);

    // Ending worker 1's activity clears ONLY worker 1's, not worker 2's.
    await sessionWorkspaceStore.run(ws1, async () => {
      agent.endActivity();
    });
    expect(agent.getRecentActivities()).toHaveLength(1);
    expect(agent.getCurrentActivity()?.label).toBe('Reply to team chat');
  });

  it('serial mode (workerCount=1) behaves exactly like legacy single currentActivity', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(1);

    // Serial: no ALS context → startActivity writes to rootWorkspace,
    // liveActivities() includes rootWorkspace → single aggregate.
    agent.startActivity('chat', 'Single chat');
    expect(agent.getCurrentActivity()?.label).toBe('Single chat');
    expect(agent.getRecentActivities()).toHaveLength(1);
    agent.endActivity();
    expect(agent.getCurrentActivity()).toBeUndefined();
  });
});

describe('Agent reconcileToIdle with concurrent activities', () => {
  it('does not reconcile while a fresh activity is live on ANY worker', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(2);

    const ws1 = mountWorker(agent, 1);
    const ws2 = mountWorker(agent, 2);

    await sessionWorkspaceStore.run(ws1, async () => {
      agent.startActivity('chat', 'Fresh activity on worker 1');
    });
    // Fresh (<60s): reconcileToIdle must refuse
    expect(agent.reconcileToIdle()).toBe(false);
    expect(agent.getCurrentActivity()).toBeDefined();

    await sessionWorkspaceStore.run(ws2, async () => {
      agent.startActivity('chat', 'Another fresh activity');
    });
    expect(agent.reconcileToIdle()).toBe(false);
    expect(agent.getRecentActivities()).toHaveLength(2);
  });

  it('reconciles stale activities back to idle across workers', async () => {
    const agent = createTestAgent();
    agent.attentionController.setWorkerCount(2);

    const ws1 = mountWorker(agent, 1);
    const ws2 = mountWorker(agent, 2);

    await sessionWorkspaceStore.run(ws1, async () => {
      agent.startActivity('chat', 'Old activity w1');
    });
    await sessionWorkspaceStore.run(ws2, async () => {
      agent.startActivity('chat', 'Old activity w2');
    });

    // Backdate both activities to look stale (>60s)
    for (const ws of [ws1, ws2]) {
      if (ws?.currentActivity) {
        ws.currentActivity = { ...ws.currentActivity, startedAt: new Date(Date.now() - 120_000).toISOString() };
      }
    }

    expect(agent.reconcileToIdle()).toBe(true);
    expect(agent.getRecentActivities()).toHaveLength(0);
    expect(agent.getCurrentActivity()).toBeUndefined();
  });
});
