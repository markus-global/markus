/**
 * C10-0B §3.1 / §4-1 —— task 执行链路的身份**在入队那一刻**就存在。
 *
 * 根因（R1：一个事实、两个建造点）：`Agent.sendTaskExecution` 入队时不带 ref，
 * 随后由 `TaskService.linkExecutionEpoch` → `linkMailboxItem` **只写 DB 列**补身份。
 * 决策台账读的是**内存** item 的 `workUnitRef`，所以同一条事实在库里带身份、
 * 在台账里永远是 NULL（真机：94% 的 pick 决策 `work_unit_ref IS NULL`）。
 *
 * 判据（行为，不读源码）：
 *   1. 执行指令入队时，内存 item 已带 `WORK_UNIT_REF.task(taskId, round)`；
 *   2. 同一 item 的 pick 决策行带同一个 ref（台账与邮箱同源）。
 *
 * 基线上第一条就红：base 的 `sendTaskExecution` 用 `refOrigin: 'pending-link'` 入队、
 * ref 为 null，pick 决策因此也是 null。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { AttentionDecision } from '../src/attention.js';
import type { MailboxItem, RoleTemplate } from '@markus/shared';
import { WORK_UNIT_REF } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSettled } from './helpers/agent-start.js';

const TASK_ID = 'tsk_c10_0b_enqueue';
const AGENT_ID = 'agt_c10_0b_enqueue';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Role for task execution identity tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeRouter(): LLMRouter {
  const response = {
    content: 'ok',
    finishReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  return {
    chat: vi.fn(async () => response),
    chatStream: vi.fn(async () => response),
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
      id: AGENT_ID,
      name: 'Identity At Enqueue Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'test' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeRouter(),
    dataDir: tempDir,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-identity-enqueue-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('C10-0B：task 执行身份在入队时落地（唯一建造点 = 唯一构造器）', () => {
  it('执行指令入队即带 ref，且该 item 的 pick 决策带同一个 ref', async () => {
    const agent = makeAgent();
    await startSettled(agent);

    const decisions: AttentionDecision[] = [];
    agent.getEventBus().on('attention:decision', (ctx) => {
      const payload = ctx as unknown as { decision?: AttentionDecision };
      if (payload.decision) decisions.push(payload.decision);
    });

    const mb = agent.getMailbox();
    const enqueueSpy = vi.spyOn(mb, 'enqueue');
    const round = 2;
    const ref = WORK_UNIT_REF.task(TASK_ID, round);

    // 第 10 个参数就是身份（必填；base 上它是 onItemEnqueued 回调）。
    const promise = agent.sendTaskExecution(
      TASK_ID,
      'do the thing',
      () => {},
      undefined,           // cancelToken
      undefined,           // taskProjectContext
      round,               // executionRound
      'Identity at enqueue',
      undefined,           // requirementId
      undefined,           // resumeNotice
      ref,                 // workUnitRef  ← 本卡新增的必填参数
    );
    // 基线会在 `onItemEnqueued({id})` 处抛 TypeError（它拿到的是字符串），这里不吞
    // 掉真实失败：下面的断言都只看结构事实，不看这个 promise 的结局。
    promise.catch(() => {});

    const item = enqueueSpy.mock.results[0]?.value as MailboxItem | undefined;
    expect(item, '执行指令必须真的入队').toBeDefined();
    expect(item!.sourceType).toBe('task_status_update');

    // ① 内存（= 台账读的那一份）在入队时就有身份
    expect(item!.workUnitRef, '身份必须在入队那一刻就落在内存 item 上').toBe(ref);

    // ② 该 item 的 pick 决策行带同一个身份（台账与邮箱同源）
    await vi.waitFor(() => {
      const pick = decisions.find(
        (d) => d.mailboxItemId === item!.id && d.decisionType === 'pick',
      );
      expect(pick, '必须在处理开始前记录一条 pick 决策').toBeDefined();
      expect(pick!.workUnitRef, 'pick 决策必须带邮箱行的身份').toBe(ref);
    }, { timeout: 5000 });

    await agent.stop();
    await promise.catch(() => {});
  });
});