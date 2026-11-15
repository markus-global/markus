/**
 * C9-A/C9-E · facts 能力装配的**唯一执行点**。
 *
 * 2026-11-15 真机事故：`createAgent` 里内联注册了四个 fact 工具，而 `applyFactService`
 * （补装路径，`restoreAgent` 与 `setFactService` 都走它）只 `agent.setFactService()`。
 * 重启后所有存量 agent 都走 `restoreAgent` —— 于是**全体没有 fact 工具**，而
 * `task_submit_review` 仍强制要求 `task.completion_evidence` 事实：模型被要求调用一个
 * 它不具备的工具，任务流转直接死锁。
 *
 * 这组测试锁的是「写者与入口必须同行」：只要补装只给 service 不给工具，第二条断言就红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

const FACT_TOOLS = ['fact_assert', 'fact_supersede', 'fact_query', 'fact_verify'];

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async function* () {
      yield { type: 'done', content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
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
  } as unknown as LLMRouter;
}

function createManager() {
  return new AgentManager({
    llmRouter: makeMockRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

/** 只满足装配与查询所需的最小写者；事实的 SQL 语义另由 fact-service 自己的测试覆盖。 */
function fakeFactService() {
  return {
    queryActive: vi.fn(() => []),
    assertFact: vi.fn(() => ({ status: 'ok' })),
    supersede: vi.fn(() => ({ status: 'ok' })),
    query: vi.fn(() => []),
    verify: vi.fn(() => ({ status: 'ok' })),
  };
}

beforeEach(() => {
  delete process.env['FACTS_ENABLED'];
  dataDir = mkdtempSync(join(tmpdir(), 'markus-facts-wiring-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-facts-wiring-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  const roleDir = join(rolesDir, 'developer');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Developer\nWrites code.');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('facts 能力装配（C9-A/C9-E）', () => {
  it('未接写者时不注册任何 fact 工具（能力不存在就不该暴露）', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_x', tools: [] });

    for (const name of FACT_TOOLS) {
      expect(agent.getTools().has(name), `${name} 不该在未接 facts 时存在`).toBe(false);
    }
  });

  it('运行期补装写者时，已存在的 agent 立刻拿到四个 fact 工具', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_x', tools: [] });

    manager.setFactService(fakeFactService() as never);

    for (const name of FACT_TOOLS) {
      expect(agent.getTools().has(name), `补装后 ${name} 必须可用（写者与入口同行）`).toBe(true);
    }
  });

  it('建 agent 时就接了写者：四个 fact 工具在装配当场注册', async () => {
    const manager = createManager();
    manager.setFactService(fakeFactService() as never);

    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_x', tools: [] });

    for (const name of FACT_TOOLS) {
      expect(agent.getTools().has(name), `${name} 必须在建 agent 时就注册`).toBe(true);
    }
  });

  it('FACTS_ENABLED=0 是唯一回滚通道：写者还在，但工具一个都不注册', async () => {
    process.env['FACTS_ENABLED'] = '0';
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Worker', roleName: 'developer', orgId: 'org_x', tools: [] });
    manager.setFactService(fakeFactService() as never);

    for (const name of FACT_TOOLS) {
      expect(agent.getTools().has(name), `${name} 必须随 FACTS_ENABLED=0 消失`).toBe(false);
    }
  });
});
