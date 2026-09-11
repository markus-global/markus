/**
 * 统一并发闸回归测试（设计稿 §7「两个并发门槛合并」/ AS-BUILT §5.1.3）。
 *
 * 断言的核心是**两个闸的一致性**：worker 数（AttentionController）与任务并发上限
 * （TaskExecutor → TaskQueue）必须由同一个「并发数」推导出来，不允许再出现：
 *   ① 「设置里并发数写着 3，任务却永远一个个跑」（两闸互相矛盾的历史态）；
 *   ② profile 侧反超 worker 侧（任务并发 > worker 并发）；
 *   ③ 运行中关掉并发关不掉（旧 setter 只在 enabled===true 时下发）。
 *
 * 硬约束（不可退让）：worker=1 ⇒ 任务闸=1（串行等价契约）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

function makeRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(),
    chatStream: vi.fn(),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-test'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
    ensureMarkusCatalogLoaded: vi.fn(async () => {}),
  } as unknown as LLMRouter;
}

function createManager() {
  return new AgentManager({
    llmRouter: makeRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

/** 断言两个闸同时等于期望值 —— 这是本文件所有用例的共同形状。 */
function expectGates(agent: { attention: { getWorkerCount(): number }; getTaskConcurrencyLimit(): number }, expected: number) {
  expect(agent.attention.getWorkerCount(), 'worker 闸').toBe(expected);
  expect(agent.getTaskConcurrencyLimit(), '任务并发闸').toBe(expected);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-unified-gate-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-unified-gate-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nUnified concurrency gate role.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- idle');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('统一并发闸：worker 闸 与 任务并发闸 同源', () => {
  it('默认（无显式配置）→ worker=3 且 任务闸=3（对齐设计，任务不再恒为 1）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Unified Default', roleName: 'developer', tools: [] });
    expectGates(agent, 3);
    await manager.stopAgent(agent.id).catch(() => {});
  });

  it('enabled:false → 两个闸都回落到 1（串行等价契约）', async () => {
    const manager = createManager();
    manager.concurrentConfig = { enabled: false };
    const agent = await manager.createAgent({ name: 'Unified Off', roleName: 'developer', tools: [] });
    expectGates(agent, 1);
    await manager.stopAgent(agent.id).catch(() => {});
  });

  it('maxWorkers=1 → 两个闸都为 1（任务必串行，profile 不能反超）', async () => {
    const manager = createManager();
    manager.concurrentConfig = { enabled: true, maxWorkers: 1 };
    const agent = await manager.createAgent({
      name: 'Unified Serial',
      roleName: 'developer',
      tools: [],
      profile: { maxConcurrentTasks: 5 },
    });
    expectGates(agent, 1);
    await manager.stopAgent(agent.id).catch(() => {});
  });

  it('profile.maxConcurrentTasks 作为更紧上限：worker=3 + profile=2 → 任务闸取 min=2', async () => {
    const manager = createManager();
    manager.concurrentConfig = { enabled: true, maxWorkers: 3 };
    const agent = await manager.createAgent({
      name: 'Unified Capped',
      roleName: 'developer',
      tools: [],
      profile: { maxConcurrentTasks: 2 },
    });
    expect(agent.attention.getWorkerCount(), 'worker 闸不受 profile 影响').toBe(3);
    expect(agent.getTaskConcurrencyLimit(), '任务闸取更紧的 profile 上限').toBe(2);
    await manager.stopAgent(agent.id).catch(() => {});
  });

  it('脏配置 profile.maxConcurrentTasks=0 不被误当成闸值（回落到 worker 闸）', async () => {
    const manager = createManager();
    manager.concurrentConfig = { enabled: true, maxWorkers: 3 };
    const agent = await manager.createAgent({
      name: 'Unified Dirty',
      roleName: 'developer',
      tools: [],
      profile: { maxConcurrentTasks: 0 },
    });
    expect(agent.getTaskConcurrencyLimit(), '0 是脏值，必须回落到 worker 闸而不是当 0 用').toBe(3);
    await manager.stopAgent(agent.id).catch(() => {});
  });

  it('热更新：两个闸一起变；enabled:false 必须能关回 1（回归「关不掉」bug）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Unified Hot', roleName: 'developer', tools: [] });
    expectGates(agent, 3);

    manager.concurrentConfig = { enabled: true, maxWorkers: 2 };
    expectGates(agent, 2);

    manager.concurrentConfig = { enabled: false };
    expectGates(agent, 1);

    manager.concurrentConfig = { enabled: true, maxWorkers: 4 };
    expectGates(agent, 4);
    await manager.stopAgent(agent.id).catch(() => {});
  });
});
