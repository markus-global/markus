import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import type { AgentToolHandler, AgentOptions } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';

// ── P2 完整化专项测试：Agent 级「工具写互斥」 ────────────────────────────────
// 覆盖：
//  1. 写语义工具并发调用 → 强制串行（同 agent 状态写永不并发）
//  2. 读/纯计算工具并发调用 → 仍并行（互斥不伤并发）
//  3. 写工具持锁期间读工具不被阻塞（写互斥≠全局锁）
//  4. Agent.isWriteTool 分类正确（task_list/memory_search 是读）
//  5. 写工具抛错后锁正确释放，后续写工具能继续执行（防锁泄漏）

const SLEEP_MS = 120;

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

/** 观测工具：记录当前正在执行的调用数峰值。 */
function makeObservedTool(name: string, opts: { throwOn?: number; alwaysThrow?: boolean; active: { max: number } }): AgentToolHandler {
  let running = 0;
  const records: Array<{ id: number; enter: number; exit: number }> = [];
  let seq = 0;
  return {
    name,
    description: `observed ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const id = ++seq;
      running += 1;
      opts.active.max = Math.max(opts.active.max, running);
      const enter = Date.now();
      const self = { id, enter, exit: 0 };
      records.push(self);
      if (opts.alwaysThrow || opts.throwOn === id) {
        running -= 1;
        throw new Error(`boom-${id}`);
      }
      await new Promise(r => setTimeout(r, SLEEP_MS));
      self.exit = Date.now();
      running -= 1;
      return JSON.stringify({ status: 'ok', id, name });
    },
    _records: records,
  } as AgentToolHandler & { _records: typeof records };
}

let tempDir: string;

function createTestAgent(tools: AgentToolHandler[]): Agent {
  return new Agent({
    config: {
      id: 'write-lock-agent',
      name: 'Write Lock Test Agent',
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-writelock-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeToolCall(name: string, args: Record<string, unknown> = {}) {
  return { id: `call_${name}_${Math.random()}`, name, arguments: args };
}

describe('P2-A Agent 工具写互斥', () => {
  it('写语义工具并发调用强制串行（maxActive=1）', async () => {
    const active = { max: 0 };
    const memSave = makeObservedTool('memory_save', { active });
    const agent = createTestAgent([memSave]);
    const a = (agent as unknown as { executeTool: (tc: ReturnType<typeof makeToolCall>) => Promise<string> });

    const start = Date.now();
    const results = await Promise.all([
      a.executeTool(makeToolCall('memory_save', { content: 'one', type: 'note', tags: ['a'] })),
      a.executeTool(makeToolCall('memory_save', { content: 'two', type: 'note', tags: ['b'] })),
    ]);
    const elapsed = Date.now() - start;

    expect(active.max).toBe(1); // 永不重叠
    expect(elapsed).toBeGreaterThanOrEqual(SLEEP_MS * 2 - 20); // 串行 = 两段耗时相加
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('"status":"ok"');
    expect(results[1]).toContain('"status":"ok"');
  });

  it('读/计算工具并发调用仍并行（maxActive=2）', async () => {
    const active = { max: 0 };
    const memSearch = makeObservedTool('memory_search', { active });
    const agent = createTestAgent([memSearch]);
    const a = (agent as unknown as { executeTool: (tc: ReturnType<typeof makeToolCall>) => Promise<string> });

    const start = Date.now();
    const results = await Promise.all([
      a.executeTool(makeToolCall('memory_search', { query: 'x' })),
      a.executeTool(makeToolCall('memory_search', { query: 'y' })),
    ]);
    const elapsed = Date.now() - start;

    expect(active.max).toBe(2); // 读不互斥，真正并行
    expect(elapsed).toBeLessThan(SLEEP_MS * 2 - 30);
    expect(results).toHaveLength(2);
  });

  it('写工具持锁期间读工具不被阻塞（写互斥 ≠ 全局锁）', async () => {
    const writeActive = { max: 0 };
    const readActive = { max: 0 };
    const memSave = makeObservedTool('memory_save', { active: writeActive });
    const memSearch = makeObservedTool('memory_search', { active: readActive });
    const agent = createTestAgent([memSave, memSearch]);
    const a = (agent as unknown as { executeTool: (tc: ReturnType<typeof makeToolCall>) => Promise<string> });

    const start = Date.now();
    const [w, r] = await Promise.all([
      a.executeTool(makeToolCall('memory_save', { content: 'w', type: 'note' })),
      a.executeTool(makeToolCall('memory_search', { query: 'r' })),
    ]);
    const elapsed = Date.now() - start;

    expect(writeActive.max).toBe(1); // 写互斥
    expect(readActive.max).toBe(1); // 只有一个读调用，无法>1，但关键：
    expect(elapsed).toBeLessThan(SLEEP_MS * 2 - 30); // 读没有被写锁拖住（≈ 单段耗时）
  });

  it('isWriteTool 分类正确（task_* 前缀读工具不误伤）', () => {
    const cls = Agent as unknown as {
      isWriteTool: (name: string) => boolean;
    };
    // 写
    for (const w of ['task_update', 'task_comment', 'task_create', 'subtask_complete',
      'requirement_propose', 'memory_save', 'memory_update', 'notify_user',
      'agent_send_message', 'file_write', 'shell_execute', 'apply_patch',
      'deliverable_create', 'task_submit_review']) {
      expect(cls.isWriteTool(w)).toBe(true);
    }
    // 读 / 纯计算（即使带 task_ 前缀）
    for (const r of ['task_list', 'task_get', 'requirement_list', 'requirement_get',
      'memory_search', 'list_projects', 'team_list', 'web_search',
      'web_fetch', 'discover_tools', 'llm_switch_model' === '' ? '' : 'llm_list_providers']) {
      expect(cls.isWriteTool(r)).toBe(false);
    }
  });

  it('写工具抛错后锁释放，后续写工具能继续执行（防锁泄漏）', async () => {
    const active = { max: 0 };
    // 每次执行都抛错（executeToolInternal 内部重试也会失败 → 返回 error JSON）
    const memSave = makeObservedTool('memory_save', { active, alwaysThrow: true });
    const agent = createTestAgent([memSave]);
    const a = (agent as unknown as {
      executeTool: (tc: ReturnType<typeof makeToolCall>) => Promise<string>;
    });

    // executeTool 契约：工具错误被捕获并转成 JSON error，不向外抛
    const first = await a.executeTool(makeToolCall('memory_save', { content: 'boom', type: 'note' }));
    expect(first).toContain('boom');

    // 关键：同一 agent 上，锁已在失败路径释放——第二个写工具必须能正常执行
    // （若锁泄漏，第二个调用会永久卡在锁队列 → 测试超时）
    const okTool = makeObservedTool('task_update', { active: { max: 0 } });
    (agent as unknown as { tools: Map<string, AgentToolHandler> }).tools.set('task_update', okTool);
    const second = await a.executeTool(makeToolCall('task_update', { task_id: 'x', note: 'ok' }));
    expect(second).toContain('"status":"ok"');
    expect(second).toContain('"id":1'); // 独立观测工具的 seq 从 1 开始
  });
});