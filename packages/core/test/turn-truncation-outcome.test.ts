import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, turnSettleOutcome } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * P2b 回归：截断收尾必须**可见**为异常，不静默当成功。
 *
 * 现象（问题 A 的另一半）：模型持续被截断（无可信 finish_reason）时，循环会在
 * 迭代上限处停下并返回「部分内容」——旧实现等同于成功收尾，用户看到半截回复。
 *
 * 修复不变量：
 *  - 循环因「仍未结束」触界 ⇒ markTurnTruncated 置位；
 *  - 会话结算结果 = turnSettleOutcome(turnFailed, truncated)：截断 ⇒ 'error'。
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'test',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
  } as unknown as LLMRouter;
}

function createAgent() {
  return new Agent({
    config: {
      id: 'trunc-agent', name: 'Trunc Agent', roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

type TruncAccess = {
  markTurnTruncated(where: string, finishReason?: string): void;
  turnEndedTruncated: boolean;
};
const acc = (a: Agent) => a as unknown as TruncAccess;

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-trunc-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('P2b 截断收尾可见化', () => {
  it('turnSettleOutcome：任一异常 ⇒ error', () => {
    expect(turnSettleOutcome(false, false)).toBe('ok');
    expect(turnSettleOutcome(true, false)).toBe('error');
    expect(turnSettleOutcome(false, true)).toBe('error');
    expect(turnSettleOutcome(true, true)).toBe('error');
  });

  it('未结束（incomplete）触界 ⇒ 置截断标记', async () => {
    const agent = createAgent();
    await agent.start();
    acc(agent).markTurnTruncated('test', 'incomplete');
    expect(acc(agent).turnEndedTruncated).toBe(true);
  });

  it('正常结束（end_turn）即便触界也不误判为截断', async () => {
    const agent = createAgent();
    await agent.start();
    acc(agent).markTurnTruncated('test', 'end_turn');
    expect(acc(agent).turnEndedTruncated).toBe(false);
  });

  it('max_tokens 触界同样视为截断（输出不完整）', async () => {
    const agent = createAgent();
    await agent.start();
    acc(agent).markTurnTruncated('test', 'max_tokens');
    expect(acc(agent).turnEndedTruncated).toBe(true);
  });
});
