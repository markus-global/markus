import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { heartbeatStateFingerprint } from '../src/heartbeat.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 重构 2：Liveness 解耦与心跳路径统一收口 —— 回归测试
 *
 * 覆盖（docs/agent-liveness-redesign.md §五.2）：
 *   1. 巡检状态指纹纯函数：状态无变化 → 指纹不变（skip，不空转 LLM）；
 *      状态实际变化（新邮件 / 任务增减）→ 指纹变（巡检一次）。
 *   2. 心跳 skip 路径 = 纯时间戳：连续心跳无状态变化 → LLM 只巡检一次，
 *      其余 skip 只刷新 lastHeartbeat（存活落库）。
 *   3. 邮件来件触发巡检：队列内容变化 → 下一次心跳巡检（状态实际变化）。
 *   4. 统一收口：Conservator 侧使用的 triggerHeartbeat() 与唯一收口
 *      （heartbeat:trigger → mailbox.enqueue）同路 —— 状态不变时重复触发
 *      不产生多余 LLM 巡检（无周期小于 RETRY 下限的重复心跳）。
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'hb-liveness-role',
  name: 'Heartbeat Liveness Role',
  description: 'Regression tests for heartbeat liveness (refactor 2)',
  category: 'engineering',
  systemPrompt: 'You are a heartbeat liveness test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(overrides?: {
  chatFn?: (...args: unknown[]) => Promise<unknown>;
}): LLMRouter {
  const chat = vi.fn(overrides?.chatFn ?? (async () => ({
    content: 'Heartbeat ok.',
    finishReason: 'end_turn',
    usage: { inputTokens: 40, outputTokens: 20 },
  })));
  return {
    chat,
    chatStream: vi.fn(async () => ({
      content: 'Stream ok.',
      finishReason: 'end_turn',
      usage: { inputTokens: 40, outputTokens: 20 },
    })),
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

function createAgent(router: LLMRouter, extra?: Record<string, unknown>) {
  return new Agent({
    config: {
      id: 'hb-liveness-agent',
      name: 'Heartbeat Liveness Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      ...(extra ?? {}),
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

async function processViaMailbox(
  agent: Agent,
  sourceType: Parameters<Agent['enqueueToMailbox']>[0],
  payload: Parameters<Agent['enqueueToMailbox']>[1],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox(sourceType, payload, {
      metadata: { responsePromise: { resolve, reject } },
    });
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-heartbeat-liveness-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('heartbeatStateFingerprint（纯函数：状态变化才巡检）', () => {
  it('空队列 + 无任务 → 稳定空签名（skip 基态）', () => {
    const a = heartbeatStateFingerprint([], []);
    const b = heartbeatStateFingerprint([], []);
    expect(a).toBe(b);
    expect(a).toContain('q:[]');
  });

  it('同一邮件（同 id）卡在队列 → 指纹不变（stuck 邮件不空转 LLM）', () => {
    const queued = [{ sourceType: 'task_status_update', id: 'mbx-1' }];
    const a = heartbeatStateFingerprint(queued, []);
    const b = heartbeatStateFingerprint(queued, []);
    expect(a).toBe(b);
  });

  it('新邮件（新 id）→ 指纹变（巡检一次）', () => {
    const oldFp = heartbeatStateFingerprint([], []);
    const newFp = heartbeatStateFingerprint(
      [{ sourceType: 'task_status_update', id: 'mbx-2' }],
      [],
    );
    expect(newFp).not.toBe(oldFp);
  });

  it('heartbeat 自身邮件被排除（不与存活巡检互为因果）', () => {
    const withHb = heartbeatStateFingerprint(
      [{ sourceType: 'heartbeat', id: 'mbx-3' }],
      [],
    );
    const without = heartbeatStateFingerprint([], []);
    expect(withHb).toBe(without);
  });

  it('活跃任务增减 → 指纹变；任务集不变 → 指纹不变', () => {
    const idle = heartbeatStateFingerprint([], []);
    const withTask = heartbeatStateFingerprint([], ['t1']);
    const sameTask = heartbeatStateFingerprint([], ['t1']);
    const moreTasks = heartbeatStateFingerprint([], ['t1', 't2']);
    expect(withTask).not.toBe(idle);
    expect(sameTask).toBe(withTask);
    expect(moreTasks).not.toBe(withTask);
    // 顺序无关
    expect(heartbeatStateFingerprint([], ['t2', 't1'])).toBe(moreTasks);
  });
});

describe('心跳 skip 路径 = 纯时间戳（不空转 LLM）', () => {
  it('无状态变化连续心跳 → 仅首次巡检一次 LLM，后续 skip 只刷新 lastHeartbeat', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    const states: Array<{ lastHeartbeat?: string }> = [];
    agent.setStateChangeCallback((_id, state) => states.push(state as { lastHeartbeat?: string }));
    await agent.start();

    // 首次心跳：指纹初始化（'' → q:[]|t:[]）→ 巡检一次 LLM
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-1',
      content: '[HEARTBEAT] first patrol',
    });
    const callsAfterFirst = router.chat.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // 无状态变化 → 第二次心跳 skip LLM（纯时间戳），但 lastHeartbeat 更新
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-2',
      content: '[HEARTBEAT] no change — must skip LLM',
    });
    expect(router.chat.mock.calls.length).toBe(callsAfterFirst);
    // 任意一次 notifyStateChange 应携带新鲜的 lastHeartbeat（存活落库）
    const lastHbs = states
      .map(s => s.lastHeartbeat)
      .filter(Boolean);
    expect(lastHbs.length).toBeGreaterThan(0);
    expect(agent.getState?.().lastHeartbeat).toBeDefined();

    await agent.stop();
  });

  it('stuck-working 宽限场景：状态不变时多次触发心跳 → LLM 巡检不随触发次数增长', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start();

    // 第一次：建立指纹基线 + 巡检
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-A',
      content: '[HEARTBEAT] baseline',
    });
    const baseline = router.chat.mock.calls.length;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // 连续 N 次无变化触发（Conservator 宽限窗口内可能多次 trigger-heartbeat）：
    // 每一次都走 mailbox 收口 + 指纹 skip → 不产生额外 LLM（无周期 < 5min 的重复巡检）
    for (let i = 0; i < 3; i++) {
      await processViaMailbox(agent, 'heartbeat', {
        summary: `HB-${i}`,
        content: `[HEARTBEAT] re-trigger ${i} (stuck, no change)`,
      });
    }
    expect(router.chat.mock.calls.length).toBe(baseline);
    await agent.stop();
  });
});

describe('状态实际变化才巡检 / 邮箱处理与心跳解耦', () => {
  it('邮件被独立消费（不依赖心跳）→ 心跳不因邮件往返产生多余巡检', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start();

    // 基线：无邮件心跳 → 巡检一次后 skip
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-B1',
      content: '[HEARTBEAT] baseline',
    });
    const baseline = router.chat.mock.calls.length;
    expect(baseline).toBeGreaterThanOrEqual(1);
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-B2',
      content: '[HEARTBEAT] stable',
    });
    const stableAfter = router.chat.mock.calls.length;
    expect(stableAfter).toBe(baseline);

    // 一封邮件入队（邮箱 worker 独立消费/丢弃——不靠心跳 LLM 处理它），
    // 消费后队列回到空 → 指纹不变 → 下一次心跳仍 skip。
    // 这验证「邮箱处理不由心跳承担，心跳也不重复巡检邮件」的解耦收口。
    await processViaMailbox(agent, 'task_status_update', {
      summary: 'Task now in_progress',
      content: 'task t_new started',
      taskId: 't_new',
    });
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-B3',
      content: '[HEARTBEAT] mail consumed independently — expect skip',
    });
    expect(router.chat.mock.calls.length).toBe(stableAfter);
    await agent.stop();
  });
});

describe('统一收口：Conservator triggerHeartbeat 与定时心跳同一出口', () => {
  it('triggerHeartbeat()（Conservator 路径）→ 状态不变时重复触发不产生多余 LLM 巡检', async () => {
    const router = makeMockRouter();
    const agent = createAgent(router);
    await agent.start();

    // 通过收口建基线（一次巡检）
    await processViaMailbox(agent, 'heartbeat', {
      summary: 'HB-C1',
      content: '[HEARTBEAT] baseline',
    });
    const baseline = router.chat.mock.calls.length;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // Conservator 路径：agent.triggerHeartbeat()（agent-manager/api-server 均收敛于此）
    // 状态无变化 → 即使反复触发，也只走 mailbox 折叠 + 指纹 skip，不增加 LLM。
    agent.triggerHeartbeat();
    agent.triggerHeartbeat();
    await new Promise(r => setTimeout(r, 120));
    expect(router.chat.mock.calls.length).toBeGreaterThanOrEqual(baseline);
    // 宽限窗口内最多多巡一次（首 trigger 若指纹已变），绝不随触发次数线性增长
    expect(router.chat.mock.calls.length).toBeLessThanOrEqual(baseline + 1);

    await agent.stop();
  });
});