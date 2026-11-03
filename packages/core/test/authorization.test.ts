/**
 * 授权边界（A4）的行为测试 —— 两个方向都必须拒，且拒绝必须可行动。
 *
 * 为什么走 `executeTool` 而不是只测纯函数：纯函数算对了但没人调用，等于没有闸门
 * （`gateAction` 就是这样躺了很久）。这里断言三件事：
 *   1. 返回值是拒绝（含 reasonCode + hint）；
 *   2. **工具本体一次都没跑**（计数为 0）—— 防「先执行再拒绝」；
 *   3. 绑定类工具不被误伤（bootstrap），平台实体调用不受影响（无回归）。
 *
 * I5（直通不改变授权）单独一组：用真实 `ThreadService.route()` 造出「已订阅 → 直通」，
 * 再断言授权判定照样拒 —— 因为判定函数的入参里**根本没有**「事件怎么进来的」这一位。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentToolHandler, AgentOptions, ApprovalCallback } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import { authorizeToolCall } from '../src/action-gate.js';
import { ThreadService } from '../src/thread-service.js';
import type { DispositionStoreLike, ThreadRowLike, ThreadStoreLike, SubscriptionLike } from '../src/thread-service.js';

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

function makeProbeTool(name: string): AgentToolHandler & { calls: number } {
  const tool = {
    name,
    description: `probe for ${name}`,
    inputSchema: { type: 'object', properties: {} },
    calls: 0,
    async execute() {
      tool.calls += 1;
      return JSON.stringify({ status: 'ok', executed: name });
    },
  };
  return tool as AgentToolHandler & { calls: number };
}

let tempDir: string;

function createTestAgent(tools: AgentToolHandler[]): Agent {
  return new Agent({
    config: {
      id: 'authz-agent',
      name: 'Authz Test Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: { roleId: 'worker', name: 'Worker' } as never,
    llmRouter: makeMockRouter(),
    dataDir: tempDir,
    tools,
  } as AgentOptions);
}

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return { id: `call_${name}_${Math.random()}`, name, arguments: args };
}

type Executable = { executeTool: (tc: ReturnType<typeof makeToolCall>) => Promise<string> };

/** 给 agent 装上「我的责任域」与「这件事批了没有」——生产里由 AgentManager 注入。 */
function wireBindings(
  agent: Agent,
  bindings: Array<{ resource: string; scope: string; autonomy?: string }>,
  mandate: 'none' | 'pending' | 'approved' | 'denied' = 'none',
) {
  agent.getResourceBindings = () => bindings.map(b => ({ ...b, grantedBy: 'human:owner' }));
  agent.getMandate = () => mandate;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-authz-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('方向①：autonomy 高 ≠ 这件事批了', () => {
  it('admin 档动作 + 无 mandate + 无审批通道 → 拒绝，提示指向「需要人签字」，工具未执行', async () => {
    const wipe = makeProbeTool('resource_wipe_data'); // 含红线动词 wipe → admin 档
    const agent = createTestAgent([wipe]);
    wireBindings(agent, [{ resource: 'gh:o/r', scope: 'admin', autonomy: 'trusted' }], 'none');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_wipe_data', { resource: 'gh:o/r' })));

    expect(res.status).toBe('denied');
    expect(res.code).toBe('AUTHORIZATION_DENIED');
    expect(res.reasonCode).toBe('mandate-required');
    expect(res.reason).toContain('不构成批准');
    expect(res.hint).toContain('签字');
    expect(wipe.calls).toBe(0); // ← 把 allow 改回来，这里与上面三句同时变红
  });

  it('有审批通道时：先发审批（带上资源与档位），批了才执行；已批的同一件事不再重复问人', async () => {
    const wipe = makeProbeTool('resource_wipe_data');
    const agent = createTestAgent([wipe]);
    wireBindings(agent, [{ resource: 'gh:o/r', scope: 'admin', autonomy: 'trusted' }], 'none');
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);
    const a = agent as unknown as Executable;

    const first = JSON.parse(await a.executeTool(makeToolCall('resource_wipe_data', { resource: 'gh:o/r' })));
    expect(first.status).toBe('ok');
    expect(wipe.calls).toBe(1);
    // 审批单必须带上「哪块地、哪一档」，否则消费者无法把它记成 mandate
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0]![0]).toMatchObject({ resource: 'gh:o/r', actionScope: 'admin' });

    // 人批过之后：同一件事直接放行（不重复打扰人 —— 审批才有意义）
    agent.getMandate = () => 'approved';
    const second = JSON.parse(await a.executeTool(makeToolCall('resource_wipe_data', { resource: 'gh:o/r' })));
    expect(second.status).toBe('ok');
    expect(wipe.calls).toBe(2);
    expect(approve).toHaveBeenCalledOnce();
  });

  it('审批被拒（mandate=denied）→ 直接拒绝并说明「不要重复请求」，不再发新审批卡', async () => {
    const wipe = makeProbeTool('resource_wipe_data');
    const agent = createTestAgent([wipe]);
    wireBindings(agent, [{ resource: 'gh:o/r', scope: 'admin', autonomy: 'trusted' }], 'denied');
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_wipe_data', { resource: 'gh:o/r' })));
    expect(res.reasonCode).toBe('mandate-denied');
    expect(res.hint).toContain('不要重复请求');
    expect(approve).not.toHaveBeenCalled();
    expect(wipe.calls).toBe(0);
  });
});

describe('方向②：批了 ≠ 有那个权（observe 上限不能靠审批绕过）', () => {
  it('binding autonomy=observe + 这件事已批 → 只记录不执行（record-only），工具未执行', async () => {
    const note = makeProbeTool('resource_note_append'); // 未登记 → draft
    const agent = createTestAgent([note]);
    wireBindings(agent, [{ resource: 'gh:o/r', scope: 'publish', autonomy: 'observe' }], 'approved');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_note_append', { resource: 'gh:o/r' })));

    expect(res.status).toBe('recorded-only');
    expect(res.code).toBe('AUTHORIZATION_OBSERVE');
    expect(res.reasonCode).toBe('autonomy-observe');
    expect(res.reason).toContain('审批不改变逐资源上限');
    expect(res.hint).toContain('autonomy');
    expect(note.calls).toBe(0); // ← 把 record-only 改成 allow，这里变红
  });

  it('动作超出绑定授予的档位 → 拒绝并指出「缺档位」，与 mandate 无关', async () => {
    const note = makeProbeTool('resource_note_append'); // draft
    const agent = createTestAgent([note]);
    wireBindings(agent, [{ resource: 'gh:o/r', scope: 'read', autonomy: 'trusted' }], 'approved');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_note_append', { resource: 'gh:o/r' })));

    expect(res.status).toBe('denied');
    expect(res.reasonCode).toBe('above-binding-scope');
    expect(res.hint).toContain('缺档位');
    expect(note.calls).toBe(0);
  });

  it('点名了资源但完全没有绑定 → 拒绝（缺 binding 不等于默认 observe）', async () => {
    const note = makeProbeTool('resource_note_append');
    const agent = createTestAgent([note]);
    wireBindings(agent, [], 'none');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_note_append', { resource: 'gh:o/r' })));
    expect(res.reasonCode).toBe('no-binding');
    expect(res.hint).toContain('缺 binding');
    expect(note.calls).toBe(0);
  });
});

describe('不误伤：bootstrap 豁免与平台实体路径', () => {
  it('绑定管理类工具（resource_bind）不被授权判定拦住 —— 否则第一次认领永远不可能', async () => {
    const bind = makeProbeTool('resource_bind');
    const agent = createTestAgent([bind]);
    wireBindings(agent, [], 'none');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('resource_bind', { resource: 'gh:o/r', scope: 'read' })));
    expect(res.status).toBe('ok');
    expect(bind.calls).toBe(1);
  });

  it('没有点名资源的平台实体调用（tsk_/proj_）不受绑定影响 —— 无回归', async () => {
    const probe = makeProbeTool('task_append_note');
    const agent = createTestAgent([probe]);
    wireBindings(agent, [], 'none');
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('task_append_note', { task_id: 'tsk_1' })));
    expect(res.status).toBe('ok');
    expect(probe.calls).toBe(1);
  });
});

// ── I5：直通不改变授权 ───────────────────────────────────────────────────────
class FakeThreads implements ThreadStoreLike {
  rows = new Map<string, ThreadRowLike>();
  subs = new Map<string, SubscriptionLike[]>();
  private n = 0;
  upsert(ref: string, now = 1000) {
    const cur = this.rows.get(ref);
    if (cur) return { thread: cur, created: false };
    const thread: ThreadRowLike = { id: `thr_${++this.n}`, ref, lastActivity: now };
    this.rows.set(ref, thread);
    this.subs.set(thread.id, []);
    return { thread, created: true };
  }
  getByRef(ref: string) {
    return this.rows.get(ref) ?? null;
  }
  touch() {}
  subscribe(id: string, ticketId: string, agentId: string, purpose: 'own' | 'context') {
    this.subs.get(id)!.push({ ticketId, agentId, purpose });
  }
  listSubscriptions(id: string) {
    return this.subs.get(id) ?? [];
  }
}

class FakeDispositions implements DispositionStoreLike {
  record() {
    return true;
  }
  countByTrigger() {
    return 0;
  }
}

describe('I5：已订阅 thread 上的越权请求仍被拒（直通只改变「谁先读到」）', () => {
  it('route 判 direct-through，但同一 agent 对同一资源的越权动作仍被授权判定拒绝', () => {
    const threads = new FakeThreads();
    const { thread } = threads.upsert('gh:o/r');
    threads.subscribe(thread.id, thread.id, 'agt_a', 'own');

    const wakes: unknown[] = [];
    const service = new ThreadService({
      threads,
      dispositions: new FakeDispositions(),
      autonomyFor: () => 'auto', // 自主档位足够 → 直通并叫醒
      onWake: e => wakes.push(e),
    });

    const routed = service.route({
      ref: 'gh:o/r',
      triggerId: 'trg_1',
      kind: 'external',
      actorKind: 'bot',
      addressing: 'ambient',
    });

    // 前置事实：这确实是一条「已订阅 → 直通 → 叫醒」的请求
    expect(routed.verdict).toBe('direct-through');
    expect(wakes).toHaveLength(1);

    // 同一个 agent 在同一资源上只被授到 read；本次要 publish
    const decision = authorizeToolCall({
      toolName: 'resource_note_append', // draft 档
      resource: 'gh:o/r',
      binding: { scope: 'read', autonomy: 'auto' },
      mandateFor: () => 'approved',
    });

    expect(decision.authz?.verdict).toBe('deny');
    expect(decision.authz?.code).toBe('above-binding-scope');
    // 说明一句：判定函数的入参里没有「事件是怎么进来的」，所以直通**结构上**
    // 无法减免授权 —— 想减免必须先改签名（评审可见），不可能顺手做掉。
  });
});
