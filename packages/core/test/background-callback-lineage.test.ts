/**
 * Background-callback lineage — ONE durable store, consumed-in-turn dedupe,
 * and same-origin coalescing.
 *
 * Defect background (Owner 2026-11-18/19 实测):
 *  1. Lineage lived in parallel in-memory maps → a restart orphaned every
 *     persisted callback row; completions fell back to the heartbeat reflex
 *     pack (no task tools) and landed on no entity.
 *  2. Every completion spawned a fresh attention cycle even when the launching
 *     turn had already read the result (~53k tokens / 0 tools / HEARTBEAT_OK).
 *  3. N completions for one waiting context = N sequential full-context turns.
 *
 * These tests pin the fixed contracts at the agent seam, with REAL processes
 * on the completion bus (no fixture can lie about exit timing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentOptions } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { MailboxItem } from '@markus/shared';
import { pendingCallbackRegistry } from '../src/pending-callback.js';
import {
  createBackgroundExecTool,
  createProcessTool,
  markBackgroundResultConsumed,
} from '../src/tools/process-manager.js';

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-cb-lineage-')); });
afterEach(async () => {
  // Reap real processes so no test leaks.
  const proc = createProcessTool();
  const list = JSON.parse(await proc.execute({ action: 'list' }));
  for (const s of list.sessions ?? []) {
    if (s.running) await proc.execute({ action: 'kill', sessionId: s.id });
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(), chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200000, getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000, getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000, getModelCost: () => undefined,
    isCompactionSupported: () => true, modelSupportsVision: () => false,
    listProviders: () => ['test'], getProvider: () => undefined,
    getDefaultProvider: () => 'test', defaultProviderName: 'test',
    resolveModalityCandidates: vi.fn(() => []),
  } as unknown as LLMRouter;
}

/** Unique id per test: the completion bus is process-wide, and only the
 *  registering agent (agentId match) may deliver. */
function createTestAgent(id: string): Agent {
  return new Agent({
    config: {
      id, name: 'CB Lineage Agent', roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: { roleId: 'worker', name: 'Worker' } as never,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    tools: [],
  } as unknown as AgentOptions);
}

function cbItem(extra: Record<string, unknown>): MailboxItem {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    sourceType: 'callback_result', status: 'processing', priority: 1,
    createdAt: new Date().toISOString(),
    payload: { summary: 'Background process succeeded', content: 'output tail', extra },
    metadata: {},
  } as unknown as MailboxItem;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const exec = createBackgroundExecTool();

async function launchReal(command: string): Promise<string> {
  const r = JSON.parse(await exec.execute({ command, timeout_seconds: 30 }));
  expect(r.status).toBe('running');
  return r.sessionId as string;
}

describe('血缘单一事实源（durable registry，无平行内存表）', () => {
  it('registerBackgroundSession 把 lineage 写进 registry（重启后可恢复的那一份）', () => {
    const agent = createTestAgent('agt_lin_store');
    agent.registerBackgroundSession('bg_store_1', 'task_t1_r1', 'pnpm test', 60000, 'task_execution');
    const reg = pendingCallbackRegistry.get('bg_store_1');
    expect(reg?.agentId).toBe('agt_lin_store');
    expect(reg?.originSessionId).toBe('task_t1_r1');
    expect(reg?.originScenario).toBe('task_execution');
    expect(reg?.type).toBe('background_exec');
    pendingCallbackRegistry.resolve('bg_store_1');
  });

  it('工具结果接缝捕获发起场景：task / chat 各回放各的，缺 origin 不登记', () => {
    const agent = createTestAgent('agt_lin_seam');
    const priv = agent as unknown as {
      activeScenario: string | undefined;
      registerAsyncCallbacksFromToolResult: (t: string, a: Record<string, unknown>, r: string, s?: string) => void;
    };
    const result = JSON.stringify({ status: 'running', sessionId: 'bg_seam_t' });
    priv.activeScenario = 'task_execution';
    priv.registerAsyncCallbacksFromToolResult('background_exec', { command: 'x', timeout_seconds: 30 }, result, 'task_t9_r1');
    expect(pendingCallbackRegistry.get('bg_seam_t')?.originScenario).toBe('task_execution');

    priv.activeScenario = 'chat';
    priv.registerAsyncCallbacksFromToolResult('background_exec', { command: 'x' },
      JSON.stringify({ status: 'running', sessionId: 'bg_seam_c' }), 'sess_chat_1');
    expect(pendingCallbackRegistry.get('bg_seam_c')?.originScenario).toBe('chat');

    // No origin session → nothing to route back to → no registration.
    priv.registerAsyncCallbacksFromToolResult('background_exec', { command: 'x' },
      JSON.stringify({ status: 'running', sessionId: 'bg_seam_none' }));
    expect(pendingCallbackRegistry.get('bg_seam_none')).toBeUndefined();

    pendingCallbackRegistry.resolve('bg_seam_t');
    pendingCallbackRegistry.resolve('bg_seam_c');
  });

  it('deliverCallback 把 workUnitRef 作为结构身份交给 mailbox（不在本层拼语法）', () => {
    const agent = createTestAgent('agt_lin_wu');
    const seen: Array<Record<string, unknown> | undefined> = [];
    vi.spyOn(agent as unknown as {
      enqueueToMailbox: (t: string, p: unknown, o?: Record<string, unknown>) => void;
    }, 'enqueueToMailbox').mockImplementation((_t, _p, o) => { seen.push(o); });
    agent.deliverCallback({
      callbackId: 'cb_wu', type: 'background_exec', deliveryMode: 'in_session',
      originSessionId: 'task_t1_r1', workUnitRef: 'task:tsk_1#round=2',
      summary: 's', content: 'c',
    });
    expect(seen[0]?.workUnitRef).toBe('task:tsk_1#round=2');
  });
});

describe('完成总线：lineage 从 durable registry 回放（真实进程）', () => {
  it('真实完成事件携带注册时的场景 + 发起会话投递', async () => {
    const agent = createTestAgent('agt_lin_bus');
    const seen: Array<{ type: string; extra: Record<string, unknown> }> = [];
    vi.spyOn(agent as unknown as {
      enqueueToMailbox: (t: string, p: { extra?: Record<string, unknown> }) => void;
    }, 'enqueueToMailbox').mockImplementation((t, p) => { seen.push({ type: t, extra: p.extra ?? {} }); });

    const id = await launchReal('echo bus-ok');
    agent.registerBackgroundSession(id, 'task_t1_r1', 'echo bus-ok', 60000, 'task_execution');
    await vi.waitFor(() => { expect(seen.length).toBe(1); }, { timeout: 3000 });

    expect(seen[0]!.type).toBe('callback_result');
    expect(seen[0]!.extra.scenario).toBe('task_execution');
    expect(seen[0]!.extra.originSessionId).toBe('task_t1_r1');
    expect(seen[0]!.extra.sessionHint).toEqual({ kind: 'memory', memorySessionId: 'task_t1_r1' });
    expect(seen[0]!.extra.callbackId).toBe(id);
    expect(pendingCallbackRegistry.get(id)).toBeUndefined();
  });

  it('轮内消费（injectTurnDelta）后，排队回调项在处理时被跳过，不烧注意力周期', async () => {
    const agent = createTestAgent('agt_lin_suppress');
    const handled: string[] = [];
    vi.spyOn(agent as unknown as { handleMessage: (c: string) => Promise<string> }, 'handleMessage')
      .mockImplementation(async (c) => { handled.push(c); return 'done'; });

    const id = await launchReal('echo early');
    agent.registerBackgroundSession(id, 'task_t1_r1', 'cmd', 60000, 'task_execution');
    await sleep(400); // bus fired first; the callback row is already queued
    // The launching turn consumes the result in-turn (as injectTurnDelta does).
    markBackgroundResultConsumed(id);

    const reply = await (agent as unknown as {
      processMailboxItemCore: (i: MailboxItem) => Promise<string>;
    }).processMailboxItemCore(cbItem({
      callbackId: id, callbackType: 'background_exec',
      originSessionId: 'task_t1_r1', scenario: 'task_execution',
    }));
    expect(handled.length).toBe(0);
    expect(reply).toContain('already consumed');
  });

  it('process poll 消费已完成会话后，排队回调项同样被跳过（exit-before-read）', async () => {
    const agent = createTestAgent('agt_lin_skip');
    const handled: string[] = [];
    vi.spyOn(agent as unknown as { handleMessage: (c: string) => Promise<string> }, 'handleMessage')
      .mockImplementation(async (c) => { handled.push(c); return 'done'; });

    const id = await launchReal('sleep 0.2; echo p');
    agent.registerBackgroundSession(id, 'task_t1_r1', 'cmd', 60000, 'task_execution');
    await sleep(500); // bus fired; item queued
    const proc = createProcessTool();
    const p = JSON.parse(await proc.execute({ action: 'poll', sessionId: id }));
    expect(p.running).toBe(false); // poll consumes the finished result

    const reply = await (agent as unknown as {
      processMailboxItemCore: (i: MailboxItem) => Promise<string>;
    }).processMailboxItemCore(cbItem({
      callbackId: id, callbackType: 'background_exec',
      originSessionId: 'task_t1_r1', scenario: 'task_execution',
    }));
    expect(handled.length).toBe(0);
    expect(reply).toContain('already consumed');
  });
});

describe('同源合并：一个等待上下文只醒一次', () => {
  it('同一发起会话的多个排队完成项合并进一个回合（siblings → merged）', async () => {
    const agent = createTestAgent('agt_lin_coalesce');
    const contents: string[] = [];
    vi.spyOn(agent as unknown as { handleMessage: (c: string) => Promise<string> }, 'handleMessage')
      .mockImplementation(async (c) => { contents.push(c); return 'done'; });

    for (const n of [1, 2, 3]) {
      agent.deliverCallback({
        callbackId: `cbx_${n}`, type: 'background_exec', deliveryMode: 'in_session',
        originSessionId: 'sess_coalesce', originScenario: 'task_execution',
        summary: `job ${n}`, content: `OUT-${n}`,
      });
    }
    const mailbox = (agent as unknown as { mailbox: { getQueuedItems: () => MailboxItem[] } }).mailbox;
    const queued = mailbox.getQueuedItems();
    expect(queued.length).toBe(3);

    await (agent as unknown as {
      processMailboxItemCore: (i: MailboxItem) => Promise<string>;
    }).processMailboxItemCore(queued[0]!);

    // ONE turn carries all three answers.
    expect(contents.length).toBe(1);
    expect(contents[0]).toContain('OUT-1');
    expect(contents[0]).toContain('OUT-2');
    expect(contents[0]).toContain('OUT-3');
    // Siblings are absorbed (merged), not left to fire two more turns.
    const after = mailbox.getQueuedItems().filter(i => i.id !== queued[0]!.id);
    expect(after.length).toBe(0);
  });
});
