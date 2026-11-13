import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSubagentTool,
  createParallelSubagentTool,
  type SubagentContext,
  type DelegationWorkUnitHandle,
  type DelegationWorkUnitPort,
} from '../src/tools/subagent.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { AgentToolHandler } from '../src/agent.js';
import { SUBAGENT_DEFAULT_ITERATION_BUDGET, WORK_UNIT_REF } from '@markus/shared';

/**
 * C7-B — 委派即产生父子 WU + 预算单一口径。
 *
 * 这些断言故意只用**端口**（`DelegationWorkUnitPort`），不起库：core 与 org-manager
 * 之间只有一个最小端口，测试应该钉住「core 向外承诺了什么」，而不是替 org-manager
 * 测 SQL。库侧（`work_units` / `status_transitions`）由 storage / org-manager 的
 * 既有测试与真实实例探针覆盖。
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'c7b-sub-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeMockRouter(responses: Array<{
  content: string;
  finishReason: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}>): LLMRouter {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const r = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return {
        content: r.content,
        finishReason: r.finishReason,
        toolCalls: r.toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    getModelContextWindow: vi.fn(() => 32000),
    ensureMarkusCatalogLoaded: vi.fn(async () => undefined),
  } as unknown as LLMRouter;
}

/** 永远请求工具的 router：没有预算就会一直跑到天荒地老。 */
function looper(): LLMRouter {
  return makeMockRouter([{
    content: 'loop',
    finishReason: 'tool_use',
    toolCalls: [{ id: 'tc1', name: 'echo', arguments: {} }],
  }]);
}

const echoTool: AgentToolHandler = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => '{"ok":true}',
};

/**
 * 记录型端口：把 core 的每一次承诺原样记下来，测试直接断言这些事实。
 * 它同时说明「唯一写者不在 core」——core 只调端口，不碰 SQL。
 */
function makeRecordingPort(opts?: { parentRef?: string | null }) {
  const ensured: Array<Parameters<DelegationWorkUnitPort['ensureChild']>[0]> = [];
  const settled: Array<{ ref: string; used: number; status: string; reason: string }> = [];
  const parent: DelegationWorkUnitHandle | null = opts?.parentRef
    ? { id: 'wu_parent', ref: opts.parentRef, status: 'running', contextRef: 'sess_parent' }
    : null;
  const port: DelegationWorkUnitPort = {
    resolve: (ref) => (parent && ref === parent.ref ? parent : null),
    ensureChild: (seed) => {
      ensured.push(seed);
      return { id: `wu_${ensured.length}`, ref: seed.ref, status: 'running', contextRef: seed.contextRef };
    },
    settle: (ref, o) => {
      settled.push({ ref, ...o });
    },
  };
  return { port, ensured, settled };
}

function makeCtx(
  router: LLMRouter,
  port: DelegationWorkUnitPort | undefined,
  parentRef: string | null,
): SubagentContext {
  return {
    llmRouter: router,
    contextEngine: new ContextEngine(),
    getTools: () => new Map([['echo', echoTool]]),
    getProvider: () => 'test',
    agentId: 'agt_parent',
    offloadLargeResult: (_name, result) => result,
    dataDir,
    workUnits: port,
    currentWorkUnitRef: () => parentRef,
  };
}

describe('C7-B delegation → child WorkUnit', () => {
  it('一次 fan-out 产生 1 父 + N 子：每个子 WU 的 parent_id 指向本轮父 WU', async () => {
    const { port, ensured } = makeRecordingPort({ parentRef: 'task_tsk_1_r1' });
    const router = makeMockRouter([
      { content: 'A done', finishReason: 'end_turn' },
      { content: 'B done', finishReason: 'end_turn' },
      { content: 'C done', finishReason: 'end_turn' },
    ]);
    const tool = createParallelSubagentTool(makeCtx(router, port, 'task_tsk_1_r1'));
    const raw = await tool.execute({
      tasks: [
        { id: 'a', task: 'Task A' },
        { id: 'b', task: 'Task B' },
        { id: 'c', task: 'Task C' },
      ],
    });
    const parsed = JSON.parse(raw);

    // N 个子 WU，父链可查（parent_id 是身份而不是「最近那条」）。
    expect(ensured).toHaveLength(3);
    for (const seed of ensured) {
      expect(seed.parentId).toBe('wu_parent');
      expect(seed.agentId).toBe('agt_parent');
      expect(seed.contextRef).toBe('sess_parent');
      expect(seed.ref.startsWith(`delegation:task_tsk_1_r1#`)).toBe(true);
    }
    // ref 唯一性：三个孩子不能共用一个 ref（否则 ref 就不再是幂等键）。
    expect(new Set(ensured.map((s) => s.ref)).size).toBe(3);
    // 结果里带上子 WU 的 ref，父级可以据此查台账而不是猜。
    expect(parsed.results.map((r: { workUnitRef: string }) => r.workUnitRef)).toEqual(
      ensured.map((s) => s.ref),
    );
  });

  it('spawn_subagent（单发）也登记子 WU，且没有父 WU 时显式用 root:<agentId>', async () => {
    const { port, ensured } = makeRecordingPort({ parentRef: null });
    const router = makeMockRouter([{ content: 'done', finishReason: 'end_turn' }]);
    const tool = createSubagentTool(makeCtx(router, port, null));
    const parsed = JSON.parse(await tool.execute({ task: 'Do work' }));

    expect(ensured).toHaveLength(1);
    expect(ensured[0]!.parentId).toBeNull();
    expect(ensured[0]!.ref.startsWith('delegation:root:agt_parent#')).toBe(true);
    expect(parsed.workUnitRef).toBe(ensured[0]!.ref);
  });

  it('端口未注入 ⇒ 子代理照常跑，没有 WU 身份（可知降级，不是隐藏崩溃）', async () => {
    const router = makeMockRouter([{ content: 'done', finishReason: 'end_turn' }]);
    const tool = createSubagentTool(makeCtx(router, undefined, null));
    const parsed = JSON.parse(await tool.execute({ task: 'Do work' }));
    expect(parsed.status).toBe('completed');
    expect(parsed.result).toBe('done');
    expect(parsed.workUnitRef).toBeUndefined();
  });
});

describe('C7-B budget: finite per-child, one unit (iterations)', () => {
  it('未指定预算时每个孩子拿到有限的默认预算，到线只停它自己并交回结构化结果', async () => {
    const { port, ensured, settled } = makeRecordingPort({ parentRef: 'task_tsk_2_r1' });
    const tool = createParallelSubagentTool(makeCtx(looper(), port, 'task_tsk_2_r1'));
    const raw = await tool.execute({
      tasks: [
        { id: 'a', task: 'loop A' },
        { id: 'b', task: 'loop B' },
      ],
    });
    const parsed = JSON.parse(raw);

    // 每个孩子都是有限预算 —— 没有 sibling 分食的共享池。
    expect(ensured.map((s) => s.budget)).toEqual([
      SUBAGENT_DEFAULT_ITERATION_BUDGET,
      SUBAGENT_DEFAULT_ITERATION_BUDGET,
    ]);
    for (const r of parsed.results as Array<{ status: string; budgetHit: string; iterations: number; result: string }>) {
      expect(r.status).toBe('budget_exhausted');
      // 它自己的绳子，不是共享断路器。
      expect(r.budgetHit).toBe('own');
      expect(r.iterations).toBe(SUBAGENT_DEFAULT_ITERATION_BUDGET);
      // 结构化结果永远非空：父级能分辨「被截断」与「成功」。
      expect(r.result.length).toBeGreaterThan(0);
    }
    // 到线 → paused_budget，且 used = 实际 iteration 次数（唯一口径）。
    expect(settled).toHaveLength(2);
    for (const s of settled) {
      expect(s.status).toBe('paused_budget');
      expect(s.reason).toBe('subagent_budget_exhausted');
      expect(s.used).toBe(SUBAGENT_DEFAULT_ITERATION_BUDGET);
    }
  });

  it('正常结束的孩子收口为 idle，used 仍按 iteration 记账', async () => {
    const { port, settled } = makeRecordingPort({ parentRef: 'task_tsk_3_r1' });
    const router = makeMockRouter([{ content: 'done', finishReason: 'end_turn' }]);
    const tool = createSubagentTool(makeCtx(router, port, 'task_tsk_3_r1'));
    await tool.execute({ task: 'Do work' });

    expect(settled).toEqual([
      expect.objectContaining({ status: 'idle', reason: 'subagent_completed', used: 0 }),
    ]);
  });

  it('显式 iteration_budget 生效，且不串到 sibling', async () => {
    const { port, ensured } = makeRecordingPort({ parentRef: 'task_tsk_4_r1' });
    const tool = createParallelSubagentTool(makeCtx(looper(), port, 'task_tsk_4_r1'));
    const parsed = JSON.parse(await tool.execute({
      tasks: [
        { id: 'a', task: 'loop A', iteration_budget: 3 },
        { id: 'b', task: 'loop B' },
      ],
    }));

    expect(ensured.map((s) => s.budget)).toEqual([3, SUBAGENT_DEFAULT_ITERATION_BUDGET]);
    expect(parsed.results[0].iterations).toBe(3);
    expect(parsed.results[1].iterations).toBe(SUBAGENT_DEFAULT_ITERATION_BUDGET);
  });
});

describe('C7-B ref format (single generator)', () => {
  it('delegation ref 可反解且父 ref 原样保留', () => {
    expect(WORK_UNIT_REF.delegation('session:cs_1:r2', 'a')).toBe('delegation:session:cs_1:r2#a');
    expect(WORK_UNIT_REF.delegation('root:agt_x', 'sub_1')).toBe('delegation:root:agt_x#sub_1');
  });
});
