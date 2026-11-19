import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Owner 2026-11-18: 「一条能够被正常处理的消息，处理正常处理，还会触发一条 woke，
 * 这是一种浪费。核心要求是，不要有这种浪费，但是又不要让没归属的消息死等，
 * 或者很积压的消息太多。」
 *
 * 判据（咬人版）：rest 条件被一条**真实到达的条目**满足时，队列里**不得**多出任何
 * 唤醒条目 —— 承载"我醒了"这件事的就是那条条目本身。同时唤醒必须发生（
 * `wakeIdleLoop` 被调用），否则就是"死等"。
 *
 * 这两个断言必须同时成立，否则测不住：只断"没有多余行"会把"根本没唤醒"也判绿。
 */

const MOCK_ROLE = { name: 'Trigger Agent', description: '', systemPrompt: '', tools: [], skills: [] };

function makeMockRouter(): LLMRouter {
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

let tempDir = '';

function createAgent(): Agent {
  return new Agent({
    config: {
      id: 'rest-hit-cost-agent',
      name: 'Rest Hit Cost Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE as never,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
  });
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-rest-hit-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('rest-hit wake: no extra mailbox row, but the loop is still woken', () => {
  it('a matched subscription adds zero wake items and still pokes the idle loop', () => {
    const agent = createAgent();
    const mailbox = agent.getMailbox();
    const pokeSpy = vi.spyOn(mailbox, 'pokeIdle');

    agent.restOn({ wakeOn: { kind: 'mailbox-any' }, note: 'waiting for a human' });
    const before = mailbox.getQueuedItems().length;

    // 走生产路径：new-item 事件 → 订阅匹配 → 唤醒
    (agent as unknown as { eventBus: { emit: (e: string, p: unknown) => void } }).eventBus.emit(
      'mailbox:new-item',
      { agentId: 'rest-hit-cost-agent', item: { id: 'mbx-real-1', sourceType: 'human_chat', payload: { extra: {} } } },
    );

    const after = mailbox.getQueuedItems();
    // ① 不得多出唤醒行（承载者就是 mbx-real-1 自己，它由调用方入队）
    expect(after.filter(i => i.sourceType === 'system_event' && (i.payload as { extra?: Record<string, unknown> }).extra?.['triggerWake'] === true)).toHaveLength(0);
    expect(after.length).toBe(before);
    // ② 但唤醒必须发生（否则就是"死等"）
    expect(pokeSpy).toHaveBeenCalled();
  });
});
