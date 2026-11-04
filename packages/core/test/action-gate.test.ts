import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentToolHandler, AgentOptions, ApprovalCallback } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';

// ── 红线闸门：工具边界上的行为测试 ────────────────────────────────────────────
// 这组测试守的是本文件之外**看不到**的东西：闸门真的在工具执行**之前**拦住。
//   · 只测 classifyToolAction 是不够的 —— 分类算对了但不拦，等于没拦。
//   · 只测源码里「调用了 isRedLineTool」也是不够的 —— 那是文本栅栏，重命名即失效。
// 所以这里一律走 `executeTool`（生产环境的唯一收口），断言两件事：
//   1. 返回值是拒绝；
//   2. **工具本体一次都没跑**（executed 计数为 0）。
// 第 2 条是关键：没有它，一个「先执行再拒绝」的实现也能骗过测试。

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

/** 探针工具：记录自己被执行了几次。 */
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
      id: 'action-gate-agent',
      name: 'Action Gate Test Agent',
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-action-gate-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('红线闸门 — 无审批通道时拒绝', () => {
  it('删除类工具被拒绝，且工具本体从未执行', async () => {
    const del = makeProbeTool('delete_project');
    const agent = createTestAgent([del]);
    const a = agent as unknown as Executable;

    const raw = await a.executeTool(makeToolCall('delete_project', { project_id: 'proj_1' }));
    const res = JSON.parse(raw);

    expect(res.status).toBe('denied');
    expect(res.code).toBe('RED_LINE_ACTION');
    expect(res.blockedTool).toBe('delete_project');
    expect(del.calls).toBe(0); // ← 关键断言：没有「先执行再拒绝」
  });

  it('拒绝返回可行动的提示，而不是死胡同', async () => {
    const del = makeProbeTool('delete_project');
    const agent = createTestAgent([del]);
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('delete_project', {})));

    // Agent 看不到日志，只能靠返回值建模 —— 必须告诉它「接下来该做什么」
    expect(res.hint).toBeTruthy();
    expect(res.hint).toContain('request_user_input');
    expect(res.reason).toBeTruthy();
  });

  it('未登记但名字含红线动词的工具同样被拦（未来新增也逃不掉）', async () => {
    const pay = makeProbeTool('pay_invoice');
    const publish = makeProbeTool('publish_article');
    const agent = createTestAgent([pay, publish]);
    const a = agent as unknown as Executable;

    const r1 = JSON.parse(await a.executeTool(makeToolCall('pay_invoice', { amount: 100 })));
    const r2 = JSON.parse(await a.executeTool(makeToolCall('publish_article', { id: 'a1' })));

    expect(r1.code).toBe('RED_LINE_ACTION');
    expect(r2.code).toBe('RED_LINE_ACTION');
    expect(pay.calls).toBe(0);
    expect(publish.calls).toBe(0);
  });
});

describe('红线闸门 — 有人工审批时走审批而不是硬失败', () => {
  it('人批准 → 工具执行', async () => {
    const del = makeProbeTool('delete_project');
    const agent = createTestAgent([del]);
    const a = agent as unknown as Executable;
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);

    const res = JSON.parse(await a.executeTool(makeToolCall('delete_project', { project_id: 'p1' })));

    expect(approve).toHaveBeenCalledOnce();
    expect(del.calls).toBe(1);
    expect(res.status).toBe('ok');
  });

  it('人拒绝 → 工具不执行，且提示「别换个写法重试」', async () => {
    const del = makeProbeTool('delete_project');
    const agent = createTestAgent([del]);
    const a = agent as unknown as Executable;
    agent.setApprovalCallback(
      (async () => ({ approved: false, comment: '这个项目还要用' })) as unknown as ApprovalCallback,
    );

    const res = JSON.parse(await a.executeTool(makeToolCall('delete_project', { project_id: 'p1' })));

    expect(res.status).toBe('denied');
    expect(res.code).toBe('RED_LINE_ACTION');
    expect(res.reason).toContain('这个项目还要用');
    expect(del.calls).toBe(0);
    // 防绕过：明确告诉 Agent 不要改名重试
    expect(res.hint).toContain('不要换个写法重试');
  });

  it('审批请求里带上了「为什么这是红线」，人才能判断', async () => {
    const del = makeProbeTool('delete_project');
    const agent = createTestAgent([del]);
    const a = agent as unknown as Executable;
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);

    await a.executeTool(makeToolCall('delete_project', { project_id: 'p1' }));

    const req = approve.mock.calls[0]![0] as unknown as { reason: string; toolName: string };
    expect(req.toolName).toBe('delete_project');
    expect(req.reason).toContain('红线');
  });
});

describe('红线闸门 — 不误伤普通动作', () => {
  it('普通写工具直接执行，不触发审批', async () => {
    const create = makeProbeTool('task_create');
    const agent = createTestAgent([create]);
    const a = agent as unknown as Executable;
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);

    const res = JSON.parse(await a.executeTool(makeToolCall('task_create', { title: 'x' })));

    expect(approve).not.toHaveBeenCalled(); // 红线闸门不该拦普通写
    expect(create.calls).toBe(1);
    expect(res.status).toBe('ok');
  });

  it('只读工具直接执行', async () => {
    const list = makeProbeTool('task_list');
    const agent = createTestAgent([list]);
    const a = agent as unknown as Executable;

    const res = JSON.parse(await a.executeTool(makeToolCall('task_list', {})));

    expect(list.calls).toBe(1);
    expect(res.status).toBe('ok');
  });

  it('豁免工具（memory_delete）不被当成红线', async () => {
    const memDel = makeProbeTool('memory_delete');
    const agent = createTestAgent([memDel]);
    const a = agent as unknown as Executable;
    const approve = vi.fn(async () => ({ approved: true }));
    agent.setApprovalCallback(approve as unknown as ApprovalCallback);

    const res = JSON.parse(await a.executeTool(makeToolCall('memory_delete', { ids: ['m1'] })));

    expect(approve).not.toHaveBeenCalled();
    expect(memDel.calls).toBe(1);
    expect(res.status).toBe('ok');
  });
});
