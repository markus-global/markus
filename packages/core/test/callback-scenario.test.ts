/**
 * 异步回调（`callback_result` / callback 型 `system_event`）的场景回放。
 *
 * 缺陷背景：这两个分派分支硬编码 `scenario: 'heartbeat'`。heartbeat 走 **reflex**
 * 包，而 `REFLEX_CORE_TOOLS` 里**没有任何写工具**（无 `file_write` / `file_edit` /
 * `shell_execute` / `task_note` / `subtask_*` / `deliverable_create`），提示词还写着
 * 「你的文本输出不可见 … 以 `HEARTBEAT_OK` 结束」。于是：
 *
 *   - 从 task_execution 会话里用 `background_exec` 跑构建/测试 → 作业完成后
 *     回调重入该会话，却被降级为 reflex → **无法继续任务**，只能发通知。
 *   - 这与 `background_exec` 自己的提示词契约（「等待期间继续其他子任务」）
 *     以及 §5.10 里刚补上的 `TASK_EXECUTION_EXTRA_TOOLS` 直接矛盾。
 *
 * 修法：注册回调时捕获**发起场景**，投递时回放；仅在确实重入来源会话时生效，
 * 否则回落 `heartbeat`。本文件锁住该契约。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentOptions } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { MailboxItem } from '@markus/shared';
import { asAgentScenario, AGENT_SCENARIOS } from '../src/session-workspace.js';
import { REFLEX_CORE_TOOLS } from '../src/capability-packs.js';
import { pendingCallbackRegistry } from '../src/pending-callback.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-cb-scenario-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMockRouter(): LLMRouter {
  return {
    chat: vi.fn(),
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

function createTestAgent(): Agent {
  return new Agent({
    config: {
      id: 'agt_cb_scenario',
      name: 'CB Scenario Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: { roleId: 'worker', name: 'Worker' } as never,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    tools: [],
  } as unknown as AgentOptions);
}

/** 构造一个回调邮箱项。`extra` 即 `deliverCallback` 写入的字段。 */
function cbItem(extra: Record<string, unknown>, sourceType: 'callback_result' | 'system_event' = 'callback_result'): MailboxItem {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    sourceType,
    status: 'processing',
    priority: 1,
    createdAt: new Date().toISOString(),
    payload: { summary: 'Background process succeeded', content: 'output tail', extra },
    metadata: {},
  } as unknown as MailboxItem;
}

describe('异步回调的场景回放', () => {
  it('asAgentScenario 只接受已知场景（未知值不得静默变成场景）', () => {
    expect(asAgentScenario('task_execution')).toBe('task_execution');
    for (const s of AGENT_SCENARIOS) expect(asAgentScenario(s)).toBe(s);
    for (const bad of ['nonsense', '', undefined, null, 42, {}, 'HEARTBEAT']) {
      expect(asAgentScenario(bad)).toBeUndefined();
    }
  });

  it('reflex 包不含任何写工具（这正是「回调降级为 heartbeat」致命的原因）', async () => {
    const cls = Agent as unknown as { isWriteTool: (n: string) => boolean };
    const writeToolsInReflex = (REFLEX_CORE_TOOLS as readonly string[])
      .filter(n => cls.isWriteTool(n));
    // notify_user / memory_save 等是写，但**干活**的工具必须一个都没有
    for (const workTool of ['file_write', 'file_edit', 'shell_execute', 'task_note',
      'subtask_complete', 'deliverable_create', 'task_submit_review', 'apply_patch']) {
      expect(writeToolsInReflex, `reflex 不得含 ${workTool}`).not.toContain(workTool);
      expect(REFLEX_CORE_TOOLS as readonly string[]).not.toContain(workTool);
    }
    // 顺带确认分类器仍认为它们是写工具（上面的断言才有意义）
    expect(cls.isWriteTool('file_write')).toBe(true);
    expect(cls.isWriteTool('task_note')).toBe(true);
  });

  it('deliverCallback 把发起场景写进 extra（两种投递方式）', () => {
    const agent = createTestAgent();
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(agent as unknown as {
      enqueueToMailbox: (type: string, p: { extra?: Record<string, unknown> }) => void;
    }, 'enqueueToMailbox').mockImplementation((_t, p) => { seen.push(p.extra ?? {}); });

    agent.deliverCallback({
      callbackId: 'cb1', type: 'background_exec', deliveryMode: 'in_session',
      originSessionId: 'task_t1_r1', originScenario: 'task_execution',
      summary: 's', content: 'c',
    });
    agent.deliverCallback({
      callbackId: 'cb2', type: 'background_exec', deliveryMode: 'mailbox',
      originScenario: 'task_execution', summary: 's', content: 'c',
    });

    expect(seen[0]!.scenario).toBe('task_execution');
    expect(seen[0]!.originSessionId).toBe('task_t1_r1');
    expect(seen[1]!.scenario).toBe('task_execution');
  });

  it('registerBackgroundSession 记录发起场景（完成时在回合之外，无法再读 activeScenario）', () => {
    const agent = createTestAgent();
    agent.registerBackgroundSession('bg_1', 'task_t9_r1', 'pnpm test', 60000, 'task_execution');
    const cb = pendingCallbackRegistry.getByAgentId('agt_cb_scenario').find(c => c.id === 'bg_1');
    expect(cb?.originScenario).toBe('task_execution');
    expect(cb?.originSessionId).toBe('task_t9_r1');
    pendingCallbackRegistry.resolve('bg_1');
  });

  it('分派：callback_result 重入来源会话时沿用来源场景（而非 heartbeat）', async () => {
    const agent = createTestAgent();
    const scen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { scenario?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { scen.push(o?.scenario); return 'done'; });

    await (agent as unknown as {
      processMailboxItemCore: (i: MailboxItem) => Promise<unknown>;
    }).processMailboxItemCore(cbItem({
      originSessionId: 'task_t1_r1', callbackType: 'background_exec', scenario: 'task_execution',
    }));

    expect(scen).toEqual(['task_execution']);
  });

  it('分派：携带场景优先于默认值（两种投递方式一致 —— 作业完成后要真能继续干活）', async () => {
    const agent = createTestAgent();
    const scen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { scenario?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { scen.push(o?.scenario); return 'done'; });

    const core = agent as unknown as { processMailboxItemCore: (i: MailboxItem) => Promise<unknown> };
    // in_session（重入来源会话）
    await core.processMailboxItemCore(cbItem({
      originSessionId: 'task_t9_r1', callbackType: 'background_exec', scenario: 'task_execution',
    }));
    // mailbox（新注意力周期，无来源会话）—— 仍应携带发起场景，
    // 否则作业完成了也改不了代码、提交不了子任务。
    await core.processMailboxItemCore(cbItem({ callbackType: 'background_exec', scenario: 'task_execution' }));

    expect(scen).toEqual(['task_execution', 'task_execution']);
  });

  it('分派：未携带场景时回落 heartbeat（安全默认）', async () => {
    const agent = createTestAgent();
    const scen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { scenario?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { scen.push(o?.scenario); return 'done'; });

    await (agent as unknown as {
      processMailboxItemCore: (i: MailboxItem) => Promise<unknown>;
    }).processMailboxItemCore(cbItem({ callbackType: 'wakeup' }));

    expect(scen).toEqual(['heartbeat']);
  });

  it('分派：非法/缺失场景值必须回落 heartbeat，不得直传', async () => {
    const agent = createTestAgent();
    const scen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { scenario?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { scen.push(o?.scenario); return 'done'; });

    const core = agent as unknown as { processMailboxItemCore: (i: MailboxItem) => Promise<unknown> };
    await core.processMailboxItemCore(cbItem({ originSessionId: 'sess_x', callbackType: 'wakeup', scenario: 'bogus-scenario' }));
    await core.processMailboxItemCore(cbItem({ originSessionId: 'sess_y', callbackType: 'wakeup' }));

    expect(scen).toEqual(['heartbeat', 'heartbeat']);
  });

  it('分派：callback 型 system_event 同样回放场景；非 callback 的保持 heartbeat', async () => {
    const agent = createTestAgent();
    const scen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { scenario?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { scen.push(o?.scenario); return 'done'; });

    const core = agent as unknown as { processMailboxItemCore: (i: MailboxItem) => Promise<unknown> };
    // callback 型（deliverCallback 的 mailbox 分支）→ 回放 task_execution
    await core.processMailboxItemCore(cbItem({ callbackType: 'background_exec', scenario: 'task_execution' }, 'system_event'));
    // 真正的系统事件（告警/日报）→ 无 callbackType → heartbeat
    await core.processMailboxItemCore(cbItem({}, 'system_event'));

    expect(scen).toEqual(['task_execution', 'heartbeat']);
  });

  // ── 会话身份契约：本会话里发出的东西，必须由本会话处理 ────────────────────
  // 旧实现消费端写的是 `originSessionId ?? `sys_${this.id}_${ts}``：一旦 origin
  // 缺失就**每完成一次新建一个会话**，把后台结果从原会话里孤立出去（磁盘上实测
  // 累计 200+ 个 `sys_*` 空壳会话）。契约规定「推不出来就保持当前会话」。
  it('会话身份：deliverCallback 把发起会话表态为 memory 契约（否则落到 unknown：告警且不绑定）', () => {
    const agent = createTestAgent();
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(agent as unknown as {
      enqueueToMailbox: (type: string, p: { extra?: Record<string, unknown> }) => void;
    }, 'enqueueToMailbox').mockImplementation((_t, p) => { seen.push(p.extra ?? {}); });

    agent.deliverCallback({
      callbackId: 'cb1', type: 'background_exec', deliveryMode: 'in_session',
      originSessionId: 'sess_origin_1', summary: 's', content: 'c',
    });
    // mailbox 分支是「新注意力周期」，没有发起会话 —— 不得表态 memory。
    agent.deliverCallback({
      callbackId: 'cb2', type: 'wakeup', deliveryMode: 'mailbox', summary: 's', content: 'c',
    });

    expect(seen[0]!.sessionHint).toEqual({ kind: 'memory', memorySessionId: 'sess_origin_1' });
    expect(seen[1]!.sessionHint).toBeUndefined();
  });

  it('会话身份：回调回到发起会话；无 origin 时保持当前会话，绝不新建 sys_* 空壳', async () => {
    const agent = createTestAgent();
    const seen: Array<string | undefined> = [];
    vi.spyOn(agent as unknown as {
      handleMessage: (c: string, s?: string, si?: unknown, o?: { sessionId?: string }) => Promise<string>;
    }, 'handleMessage').mockImplementation(async (_c, _s, _si, o) => { seen.push(o?.sessionId); return 'done'; });

    const core = agent as unknown as { processMailboxItemCore: (i: MailboxItem) => Promise<unknown> };

    // ① 契约表态 memory → 回到发起轮
    await core.processMailboxItemCore(cbItem({
      originSessionId: 'sess_origin_1',
      sessionHint: { kind: 'memory', memorySessionId: 'sess_origin_1' },
      callbackType: 'background_exec',
    }));
    // ② origin 缺失 → 保持当前会话（不传 sessionId），不得兜底造 id
    await core.processMailboxItemCore(cbItem({ callbackType: 'background_exec' }));

    expect(seen[0]).toBe('sess_origin_1');
    expect(seen[1]).toBeUndefined();
    for (const sid of seen) expect(String(sid ?? '')).not.toMatch(/^sys_/);
  });
});
