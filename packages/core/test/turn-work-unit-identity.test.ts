import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import { createSessionWorkspace, sessionWorkspaceStore } from '../src/session-workspace.js';
import type { LLMRouter } from '../src/llm/router.js';
import type { RoleTemplate } from '@markus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 一个回合的 WorkUnit 身份必须属于**这个回合**。
 *
 * 实测根因（2026-11-26）：`turnWorkUnitRef()` 对任务回合走 ALS（2026-11-15 P0 已修），
 * 但聊天 / A2A / 外部信号回合退回**共享实例字段** `currentTurnWorkUnitRef`，
 * 其唯一写者是邮箱焦点链 `onFocusChanged`。并发分身下后来者覆盖前者，于是
 * A 回合写的观测行被盖上 B 回合的 ref —— 实库可见两条不同 activity_id 在同一毫秒
 * 被盖同一个 ref，其中一条内容是 `Started: Human Chat`。
 *
 * 这是同一个 bug 换记号再犯：上次只把任务路径搬进 ALS，邮箱路径没搬。
 * 观测行的 `work_unit_ref` 建了索引（idx_*_wu），本就该是归属键；盖错 = 台账撒谎。
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'wu-identity-role',
  name: 'WU Identity Role',
  description: 'Tests per-turn work unit identity',
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

function createAgent(router: LLMRouter) {
  return new Agent({
    config: {
      id: 'wu-identity-agent',
      name: 'WU Identity Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
    } as never,
    role: MOCK_ROLE,
    llmRouter: router,
    dataDir: tempDir,
  });
}

function signalItem(id: string, workUnitRef: string) {
  return {
    id,
    agentId: 'wu-identity-agent',
    sourceType: 'external_signal',
    priority: 1,
    status: 'processing',
    payload: { summary: `fact ${id}`, content: `world fact ${id}` },
    metadata: {},
    envelope: { intent: 'action_required' },
    queuedAt: new Date().toISOString(),
    workUnitRef,
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-wu-ident-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('per-turn work unit identity', () => {
  it('each concurrent turn sees its OWN ref, not the last focus writer', async () => {
    const agent = createAgent(makeRouter());
    await agent.start();

    const refA = 'external:src_x:turn-A';
    const refB = 'external:src_x:turn-B';
    const seen: Array<{ id: string; ref: string | null }> = [];

    // 两个回合必须真正重叠：第一个进入后等第二个也进入，再一起返回。
    let entered = 0;
    let release!: () => void;
    const bothInside = new Promise<void>(r => { release = r; });
    (agent as unknown as { handleMessage: unknown }).handleMessage = vi.fn(
      async (content: string) => {
        const id = String(content).includes('mbx_A') ? 'A' : 'B';
        seen.push({ id, ref: agent.turnWorkUnitRef() });
        entered += 1;
        if (entered === 2) release();
        await bothInside;
        return 'ok';
      },
    );

    // 模拟焦点链已被别的分身改写（生产里 currentTurnWorkUnitRef 就是这么被覆盖的）。
    (agent as unknown as { currentTurnWorkUnitRef: string | null }).currentTurnWorkUnitRef =
      'external:src_x:SOMEONE-ELSE';

    const internal = (agent as unknown as {
      processMailboxItemInternal: (i: unknown) => Promise<unknown>;
    }).processMailboxItemInternal.bind(agent);

    const errs: string[] = [];
    await Promise.all([
      internal(signalItem('mbx_A', refA)).catch(e => errs.push('A:' + String(e))),
      internal(signalItem('mbx_B', refB)).catch(e => errs.push('B:' + String(e))),
    ]);

    // 夹具自检：两个回合必须真的进到 handleMessage，否则这条测试什么都没测。
    expect(errs).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(seen.find(s => s.id === 'A')?.ref).toBe(refA);
    expect(seen.find(s => s.id === 'B')?.ref).toBe(refB);
    await agent.stop();
  });

  /**
   * 同一根因换记号：delta **读游标**也曾是 Agent 实例字段（`turnDeltaCursor`），
   * 5 个并发 worker 共用一个数字。A 回合注入后推进 watermark，B 回合下一次扫 delta
   * 就从 A 的水位起读 —— B **跳过**了它自己还没读到的事实（静默漏事实，比重复注入更坏）。
   *
   * 重置点也不能留在共享焦点链 `onFocusChanged`：B 拿到焦点会把 A 正在用的游标抹掉。
   */
  it('each concurrent turn owns its delta cursor — A advancing must not skip B facts', async () => {
    const agent = createAgent(makeRouter());
    await agent.start();

    const seen: Record<string, { atStart: number; afterOtherAdvanced: number }> = {};
    let entered = 0;
    let release!: () => void;
    const bothInside = new Promise<void>(r => { release = r; });
    let advanced!: () => void;
    const aAdvanced = new Promise<void>(r => { advanced = r; });

    (agent as unknown as { handleMessage: unknown }).handleMessage = vi.fn(
      async (content: string) => {
        const id = String(content).includes('mbx_A') ? 'A' : 'B';
        const cursor = () => (agent as unknown as { turnDeltaCursor: number }).turnDeltaCursor;
        const atStart = cursor();
        entered += 1;
        if (entered === 2) release();
        await bothInside;
        if (id === 'A') {
          // A 报告完一批事实 → 推进自己的 watermark。
          (agent as unknown as { turnDeltaCursor: number }).turnDeltaCursor = atStart + 500;
          advanced();
        } else {
          await aAdvanced;
        }
        seen[id] = { atStart, afterOtherAdvanced: cursor() };
        return 'ok';
      },
    );

    const internal = (agent as unknown as {
      processMailboxItemInternal: (i: unknown) => Promise<unknown>;
    }).processMailboxItemInternal.bind(agent);

    // 生产里每个分身有自己的工作区（attention.getWorkerWorkspace）；这里照同一形状给。
    await Promise.all([
      sessionWorkspaceStore.run(createSessionWorkspace(1), () => internal(signalItem('mbx_A', 'external:src_x:turn-A'))),
      sessionWorkspaceStore.run(createSessionWorkspace(2), () => internal(signalItem('mbx_B', 'external:src_x:turn-B'))),
    ]);

    // 夹具自检：两个回合都真的进到了 handleMessage。
    expect(Object.keys(seen).sort()).toEqual(['A', 'B']);
    expect(seen.A.afterOtherAdvanced).toBe(seen.A.atStart + 500);
    // 这一条是判据：B 的游标不许被 A 推进。
    expect(seen.B.afterOtherAdvanced).toBe(seen.B.atStart);
    await agent.stop();
  });
});