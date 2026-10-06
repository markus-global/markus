import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveSessionStates } from '../src/session-state.js';
import type { SessionRuntimeState } from '../src/session-state.js';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * P4 回归：会话处理状态 = 注册表（在跑的 turn）∪ mailbox 队列（仍 queued）的并集。
 *
 * 目的：让「哪些会话在跑」有一个**后端权威、重启一致、不可能泄漏**的答案，
 * 供前端对齐并否决本地乐观态（幽灵「空闲」）。
 */

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role', name: 'Test Role', description: 'test', category: 'engineering',
  systemPrompt: 'You are a test agent.', defaultSkills: [], heartbeatChecklist: '', defaultPolicies: [], builtIn: false,
};

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000, getActiveModelName: () => 'test-model', getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000, getModelMaxOutput: () => 8000, getModelCost: () => undefined,
    isCompactionSupported: () => true, modelSupportsVision: () => false,
  } as unknown as LLMRouter;
}

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-p4-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function reg(sessionKey: string, state: 'idle' | 'processing', itemIds: string[], outcome?: 'ok' | 'error'): SessionRuntimeState {
  return { sessionKey, state, itemIds: new Set(itemIds), processingSince: state === 'processing' ? 1 : undefined, lastOutcome: outcome, lastUpdated: 1 };
}

describe('P4 deriveSessionStates（并集派生）', () => {
  it('注册表在跑 ∪ 队列待处理 ⇒ 处理中', () => {
    const q = new Map<string, string[]>([['s1', ['mbx_q']], ['s2', ['mbx_q2']]]);
    const out = deriveSessionStates([reg('s1', 'processing', ['mbx_t'])], q);
    const s1 = out.find(s => s.sessionKey === 's1')!;
    expect(s1.state).toBe('processing');
    expect(s1.itemCount).toBe(2); // 1 在飞 + 1 排队
    expect(out.find(s => s.sessionKey === 's2')!.state).toBe('processing');
  });

  it('仅队列（重启后从 DB 载入）也 ⇒ 处理中（重启一致）', () => {
    const out = deriveSessionStates([], new Map([['sess_restored', ['mbx_1']]]));
    expect(out).toEqual([{ sessionKey: 'sess_restored', state: 'processing', itemCount: 1 }]);
  });

  it('注册表已 idle（历史）且无排队 ⇒ idle，保留 lastOutcome', () => {
    const out = deriveSessionStates([reg('s1', 'idle', [], 'error')], new Map());
    expect(out[0].state).toBe('idle');
    expect(out[0].lastOutcome).toBe('error');
  });

  it('空输入 ⇒ 空', () => {
    expect(deriveSessionStates([], new Map())).toEqual([]);
  });
});

describe('P4 Agent 派生状态（队列即处理中）', () => {
  it('入队带 session 的 item ⇒ 该会话立即显示处理中，isProcessing=true', async () => {
    const agent = new Agent({
      config: {
        id: 'p4-agent', name: 'P4 Agent', roleId: 'worker',
        llmConfig: { modelMode: 'custom', primary: 'anthropic' }, createdAt: new Date().toISOString(),
      } as never,
      role: MOCK_ROLE, llmRouter: makeMockRouter(), dataDir: tempDir,
    });
    await agent.start();

    expect(agent.getSessionStates().some(s => s.state === 'processing')).toBe(false);
    agent.getMailbox().enqueue('human_chat', { summary: 'hi', content: 'hi' }, { metadata: { sessionId: 'cs_p4' } });

    const states = agent.getSessionStates();
    const s = states.find(x => x.sessionKey === 'cs_p4');
    expect(s?.state).toBe('processing');
    expect(agent.isProcessing()).toBe(true);
    expect(agent.getAgentStatusSummary().sessionStates?.length).toBeGreaterThan(0);
  });
});
