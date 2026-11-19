/**
 * 身份字符串与 round 的**单一所有者**（C9 收尾）。
 *
 * 这一组用例守的是「值」而不是「形状」：
 *
 *   · 人类评论注入的会话 id 只能来自**在飞登记**（`taskExecutionsInFlight.sessionId`）。
 *     旧实现 `getTaskExecutionRound(_taskId) { return 1; }` 把它写死成 1，于是 r2 执行中
 *     的评论被注入到 `task_<id>_r1` —— 另一个纪元的会话。它没有 `??`、没有 cast，
 *     所以「单建造点」「类型必填」两类判据都会绿着放行（判据的第三类盲区）。
 *   · `injectUserMessage` 的 `taskId` 必须是**显式入参**，不得从 sessionId 反解：
 *     反解是建造者的镜像，格式一动就静默解析错，分支走错也无人知道。
 *   · 派发侧不给 round 时 core **不猜 1**（fail closed）：不启动执行纪元、不主张身份，
 *     只留一条结构化 warn + 事件给派发方。
 *   · 消费侧（活动日志 / 轮内 delta）读的 ref 必须是**本执行纪元**的 ref，不是邮箱焦点
 *     那条 —— 两者都可能在同一 agent 上同时存在。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, taskAsyncContext } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSettled } from './helpers/agent-start.js';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Role for identity single-owner tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

const TASK_ID = 'task_identity_owner';

function makeRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
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

function makeAgent(): Agent {
  return new Agent({
    config: {
      id: 'agt_identity_owner',
      name: 'Identity Owner Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'test' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeRouter(),
    dataDir: tempDir,
  });
}

/** 被测逻辑内部状态的唯一访问口（私有不等于不可观测，测试只读/只播种）。 */
interface AgentInternals {
  activeTasks: Set<string>;
  taskExecutionsInFlight: Map<string, { sessionId: string; round: number; startedAt: number }>;
  pendingInjections: Map<string, string[]>;
  currentTurnWorkUnitRef: string | null;
  turnDeltaInjectionEnabled: boolean;
  turnDeltaCursor: number;
  injectTurnDelta(sessionId: string): { decision: 'continue' | 'cancel'; text: string; decisiveItemId: string | null } | null;
  flushPendingInjections(sessionId: string): void;
}

function internals(agent: Agent): AgentInternals {
  return agent as unknown as AgentInternals;
}

async function processViaMailbox(
  agent: Agent,
  sourceType: string,
  payload: Record<string, unknown>,
  options?: Record<string, unknown>,
) {
  return new Promise<string>((resolve, reject) => {
    (agent.enqueueToMailbox as unknown as (t: string, p: unknown, o?: unknown) => unknown)(sourceType, payload, {
      refOrigin: 'pending-link',
      ...options,
      runtime: { responsePromise: { resolve, reject } },
    });
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-identity-owner-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('用例 A：人类评论注入由在飞登记回答，不重算 round', () => {
  it('r2 执行中 → 注入落 r2 会话，r1 会话一条都不多', async () => {
    const agent = makeAgent();
    await agent.start();
    const i = internals(agent);

    i.activeTasks.add(TASK_ID);
    i.taskExecutionsInFlight.set(TASK_ID, {
      sessionId: `task_${TASK_ID}_r2`,
      round: 2,
      startedAt: Date.now(),
    });

    const spy = vi.spyOn(agent, 'injectUserMessage');

    await processViaMailbox(agent, 'task_comment', {
      summary: 'Human comment',
      content: 'please also cover the r2 path',
      taskId: TASK_ID,
    }, { workUnitRef: `task_${TASK_ID}_r2` });

    // 目标会话只能来自在飞登记（旧实现的 `return 1` 会得到 r1 → 红）
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(`task_${TASK_ID}_r2`);
    expect(spy.mock.calls[0]![2]).toBe(TASK_ID);
    // r1 会话一条都不多（根本不建）
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r1`)).toBeUndefined();
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r2`)).toBeDefined();

    await agent.stop();
  });

  it('没有在飞登记 → 不注入（不猜轮次），改走排队回复', async () => {
    const agent = makeAgent();
    await agent.start();
    const i = internals(agent);

    // 任务在跑但没有登记（陈旧/缺失）：旧实现会猜 r1 并把消息灌进别人的会话
    i.activeTasks.add(TASK_ID);
    const spy = vi.spyOn(agent, 'injectUserMessage');

    await processViaMailbox(agent, 'task_comment', {
      summary: 'Human comment',
      content: 'is anyone there?',
      taskId: TASK_ID,
    }, { workUnitRef: `task_${TASK_ID}_r2` });

    expect(spy).not.toHaveBeenCalled();
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r1`)).toBeUndefined();
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r2`)).toBeUndefined();
    await agent.stop();
  });
});

describe('用例 B：injectUserMessage 的 taskId 是显式入参，不反解会话 id', () => {
  it('合法但形状不匹配的会话 id 仍按显式 taskId 走「活跃任务 → 缓冲」分支', async () => {
    const agent = makeAgent();
    await agent.start();
    const i = internals(agent);
    i.activeTasks.add(TASK_ID);

    // 会话 id 完全看不出属于哪个任务（旧反解会得到 undefined → 直接 append 到会话，不进缓冲）
    agent.injectUserMessage('sess_mismatched_shape', 'buffered please', TASK_ID);

    expect(i.pendingInjections.get('sess_mismatched_shape')).toEqual(['buffered please']);
    await agent.stop();
  });

  it('taskId 不在活跃集合时直接落会话（不在跑 = 不需要排队）', async () => {
    const agent = makeAgent();
    await agent.start();
    const i = internals(agent);

    agent.injectUserMessage('sess_direct', 'direct please', 'task_not_running');

    expect(i.pendingInjections.size).toBe(0);
    const session = agent.getMemory().getSession?.('sess_direct');
    expect(session?.messages.at(-1)?.content).toBe('direct please');
    await agent.stop();
  });
});

describe('入口 fail closed：派发不带 round → 不启动纪元、无身份、结构化 warn', () => {
  it('task_status_update(trigger_execution) 缺 executionRound → 事件 + 无会话 + 无活跃任务', async () => {
    const agent = makeAgent();
    await agent.start();

    const skipped: unknown[] = [];
    agent.getEventBus().on('agent:task-execution-skipped-no-round', e => skipped.push(e));

    const reply = await processViaMailbox(
      agent,
      'task_status_update',
      {
        summary: 'Task: no round',
        content: 'do the thing',
        taskId: TASK_ID,
        // 关键：extra 里**没有** executionRound（旧实现会 ?? 1 猜第 1 轮）
        extra: { onLog: () => {} },
      },
      { intent: 'trigger_execution', metadata: { taskId: TASK_ID } },
    );

    expect(reply).toBe('');
    expect(skipped).toHaveLength(1);
    // 无身份 = 没有为任何轮次建会话，也没有活跃任务
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r1`)).toBeUndefined();
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_rundefined`)).toBeUndefined();
    expect(agent.getActiveTasks()).toHaveLength(0);
    await agent.stop();
  });

  it('带 round 的同一条派发正常执行（对照组，证明上面红的是缺 round 而不是链路坏了）', async () => {
    const agent = makeAgent();
    await agent.start();

    const skipped: unknown[] = [];
    agent.getEventBus().on('agent:task-execution-skipped-no-round', e => skipped.push(e));

    const reply = await processViaMailbox(
      agent,
      'task_status_update',
      {
        summary: 'Task: with round',
        content: 'do the thing',
        taskId: TASK_ID,
        extra: { onLog: () => {}, executionRound: 3 },
      },
      { intent: 'trigger_execution', metadata: { taskId: TASK_ID } },
    );

    expect(reply).toBe('');
    expect(skipped).toHaveLength(0);
    expect(agent.getMemory().getSession?.(`task_${TASK_ID}_r3`)).toBeDefined();
    await agent.stop();
  });
});

describe('消费侧身份：活动日志与轮内 delta 读的是本执行纪元的 ref', () => {
  it('活动日志（startActivity / onActivityLogCb）带的是执行纪元的 workUnitRef', async () => {
    const agent = makeAgent();
    // Settle startup BEFORE arming the callbacks: the startup wake is its own
    // epoch, and capturing it would assert against the wrong work unit.
    await startSettled(agent);

    const logged: Array<{ workUnitRef?: string | null }> = [];
    // `startActivity` 写入 activity **对象字段**的那一路，用 `onStart` 收。
    // 旧写法读 `agent.getCurrentActivity()?.workUnitRef ?? `task_…_r2``：执行结束后
    // currentActivity 已被 `endActivity` 清空，`??` 兜底让 null / undefined 也照样通过
    // —— 那条断言永远不会红，等于没测（复审打回 ②）。这里不设任何兜底。
    const startedTaskActivities: Array<{ workUnitRef?: string | null }> = [];
    agent.setActivityCallbacks({
      onStart: (activity) => {
        if (activity.type === 'task') startedTaskActivities.push({ workUnitRef: activity.workUnitRef });
      },
      onLog: (data) => logged.push({ workUnitRef: data.workUnitRef }),
    });

    await agent.executeTask(TASK_ID, 'probe activity identity', () => {}, undefined, undefined, 2);

    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(entry.workUnitRef).toBe(`task_${TASK_ID}_r2`);
    }
    // `startActivity` 那一路：必须真实收到过任务活动，且每一条都带本纪元的 ref。
    expect(startedTaskActivities.length).toBeGreaterThan(0);
    for (const a of startedTaskActivities) {
      expect(a.workUnitRef).toBe(`task_${TASK_ID}_r2`);
    }
    await agent.stop();
  });

  it('轮内 delta 注入用执行纪元的 ref，而不是邮箱焦点那条', async () => {
    const agent = makeAgent();
    // 不 start：这条用例只测「注入用哪个 ref」，不需要注意力循环把队首条吃掉
    const i = internals(agent);
    i.turnDeltaInjectionEnabled = true;

    // 邮箱焦点链写入的实例字段：一条**别人的**会话 ref（并发时真实存在）
    i.currentTurnWorkUnitRef = 'session_cs_other_conv:r9';

    // 本执行纪元的两条 delta（只有挂在 task ref 上的才该被注入）
    agent.getMailbox().enqueue('task_comment', { summary: 'task-scoped fact', content: 'task-scoped fact', taskId: TASK_ID }, {
      workUnitRef: `task_${TASK_ID}_r2`,
      refOrigin: 'pending-link',
      intent: 'action_required',
    });
    agent.getMailbox().enqueue('task_comment', { summary: 'chat-scoped fact', content: 'chat-scoped fact', taskId: TASK_ID }, {
      workUnitRef: 'session_cs_other_conv:r9',
      refOrigin: 'pending-link',
      intent: 'action_required',
    });

    // 执行回合的会话在真实链路里由 _executeTaskInternal 建好；这里只补这一步前置
    agent.getMemory().getOrCreateSession(agent.id, `task_${TASK_ID}_r2`);

    const out = taskAsyncContext.run(
      { taskId: TASK_ID, workUnitRef: `task_${TASK_ID}_r2` },
      () => i.injectTurnDelta(`task_${TASK_ID}_r2`),
    );
    expect(out).not.toBeNull();
    expect(out!.text).toContain('task-scoped fact');
    expect(out!.text).not.toContain('chat-scoped fact');
    await agent.stop();
  });
});
