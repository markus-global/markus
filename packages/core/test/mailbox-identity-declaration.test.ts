/**
 * C9 附带缺陷 —— 「身份缺失守卫」要求的能力，在需要它的回合必须**可达**。
 *
 * 背景（2026-11-15 真机）：`mailbox.enqueue(task_status_update)` 一天 13 次 ERROR，
 * 提示是「declare refOrigin」，但全仓 `packages/*​/src` **零个**调用方使用 `refOrigin`。
 * 也就是说闸门要求每个调用方表态，而表态通道没有一处示范 —— 典型的
 * 「闸门要求的能力在该回合不可达」。修法不是删闸门，而是让真实调用方表态。
 *
 * 本文件是**双向**断言，缺一半就会退化成 fail-open：
 *
 *   1. 正向：走真实装配链（`Agent.sendTaskExecution` → `mailbox.enqueue`）在
 *      `MARKUS_STRICT_IDENTITY=1` 下**不得抛错**，且入队那一刻 memory item 就带着
 *      该执行纪元的实体 ref。C10-0B：`sendTaskExecution` 的尾部参数已从
 *      `onItemEnqueued` 回调改成**必填** `workUnitRef: string`（删掉 ref 传参 ⇒ 本例变红）。
 *   2. 负向：同类型事实若**未表态**，`enqueue` 必须抛错。删掉 `mailbox.ts` 守卫里的
 *      `throw` ⇒ 本例变红（不许用「安静」换「正确」）。
 *
 * 注意：正反两例都不直接构造 `refOrigin` 去伪造表态 —— 正向必须经由生产链路，
 * 否则测的只是「options 能传值」，测不到「生产调用方到底表没表态」。
 *
 * C10-0B：不再有「身份稍后由另一个写者补 DB 列」这一档（`pending-link` 已删除）：
 * 身份在入队时就是事实，内存与 DB 同源。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { takeUnclaimedIdentityCount, type MailboxItem } from '../src/mailbox.js';
import type { LLMRouter } from '../src/llm/router.js';
import { WORK_UNIT_REF, type RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 严格是默认；LENIENT=1 才是豁免。全局夹具设了 LENIENT，所以这里要**清掉**它。
const LENIENT = 'MARKUS_LENIENT_IDENTITY';
const TASK_ID = 'task_identity_declaration';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Role for identity declaration tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

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
      id: 'agt_identity_declaration',
      name: 'Identity Declaration Agent',
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-identity-declaration-'));
  delete process.env[LENIENT];
  takeUnclaimedIdentityCount();
});

afterEach(() => {
  process.env[LENIENT] = '1';
  takeUnclaimedIdentityCount();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('C9 附带缺陷：task_status_update 入队必须表态身份', () => {
  it('正向：真实装配链 sendTaskExecution 在严格模式下不抛错，且入队即带实体 ref', async () => {
    const agent = makeAgent();
    const mb = agent.getMailbox();
    const enqueueSpy = vi.spyOn(mb, 'enqueue');
    // C10-0B §3.1：身份由调用方用唯一构造器 WORK_UNIT_REF 算好，作为**必填**的
    // 尾部参数交给 sendTaskExecution —— 入队那一刻写进内存 item（与 DB 行同源）。
    const workUnitRef = WORK_UNIT_REF.task(TASK_ID, 2);

    let rejected: unknown = null;
    const promise = agent.sendTaskExecution(
      TASK_ID,
      'do the thing',
      () => {},
      undefined,      // cancelToken
      undefined,      // taskProjectContext
      2,              // executionRound
      'Identity declaration',  // taskTitle
      undefined,      // requirementId
      undefined,      // resumeNotice
      workUnitRef,    // workUnitRef（必填，fail closed）
    );
    promise.catch((err) => { rejected = err; });

    // 入队发生在 Promise executor 内：守卫若抛错，会变成 rejection 而不是同步异常。
    await new Promise((r) => setImmediate(r));
    expect(rejected).toBeNull();

    // 链路没有被改动：确有一条 task_status_update 入队，且 memory item 在入队那一刻
    // 就带着该执行纪元的 identity（不是 null，也不需要事后再补）。
    const items = enqueueSpy.mock.results.map((r) => r.value as MailboxItem);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceType).toBe('task_status_update');
    expect(items[0]?.workUnitRef).toBe(workUnitRef);
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });

  it('负向：同类型事实未表态 → 严格模式下必须抛错（防 fail-open 回归）', () => {
    const agent = makeAgent();
    // 记录形状（intent=deliver、只有 metadata.taskId、没有 ref、没有声明）：
    // 这是真实存在过的「忘了表态」形状，不是人造参数。
    expect(() =>
      agent.enqueueToMailbox(
        'task_status_update',
        { summary: 'Task created via gateway', content: 'rec', taskId: TASK_ID },
        { intent: 'deliver', metadata: { taskId: TASK_ID } },
      ),
    ).toThrow(/has no workUnitRef and no refOrigin/);
  });
});
