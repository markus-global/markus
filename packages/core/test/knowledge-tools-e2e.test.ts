import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;
let kbDir: string;
let outsideDir: string;

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({
      content: 'E2E reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 25 },
    })),
    chatStream: vi.fn(async function* () {
      yield { type: 'content_delta', content: 'Hi' };
      yield { type: 'done', content: 'Hi', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
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

function makeDeliverableService() {
  return {
    create: vi.fn(async () => ({ id: 'dlv_1', type: 'file', title: 'KB Doc', status: 'active' })),
    search: vi.fn(() => ({
      results: [
        {
          id: 'dlv_kb1', type: 'file', title: '入门指南', summary: 'onboarding guide',
          reference: join(kbDir, 'guide.md'), status: 'active', tags: ['kb'],
          updatedAt: '2026-08-29T08:00:00.000Z',
        },
        {
          id: 'dlv_kb2', type: 'file', title: 'API 参考', summary: 'api reference',
          reference: join(kbDir, 'api.md'), status: 'active', tags: ['kb'],
          updatedAt: '2026-08-29T08:01:00.000Z',
        },
      ],
      total: 2,
    })),
    update: vi.fn(async () => ({ id: 'dlv_1', status: 'active' })),
  };
}

function makeProjectService() {
  return {
    listProjects: vi.fn(() => [
      { id: 'proj_kb', name: 'KB Project', description: 'd', status: 'active', teamIds: [] },
    ]),
    getProject: vi.fn((id: string) => ({
      id,
      name: 'KB Project',
      description: 'd',
      status: 'active',
      repositories: [],
      teamIds: [],
      knowledgeBasePaths: [kbDir],
    })),
    createProject: vi.fn((opts) => ({ id: 'proj_new', name: opts.name, status: 'active' })),
    updateProject: vi.fn((id, data) => ({ id, name: data.name ?? 'KB Project', status: 'active' })),
  };
}

async function createE2EAgent() {
  const manager = createManager();
  const ds = makeDeliverableService();
  const ps = makeProjectService();
  manager.setDeliverableService(ds);
  manager.setProjectService(ps as never);
  const agent = await manager.createAgent({
    name: 'KB Worker',
    roleName: 'custom',
    orgId: 'org_e2e',
    tools: [],
  });
  return { manager, agent, ds, ps };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-kbe2e-data-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-kbe2e-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  kbDir = mkdtempSync(join(tmpdir(), 'markus-kbe2e-kb-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'markus-kbe2e-outside-'));
  mkdirSync(join(kbDir, 'docs'), { recursive: true });
  writeFileSync(join(kbDir, 'guide.md'), '# 入门指南\n\n首次使用说明');
  writeFileSync(join(kbDir, 'api.md'), '# API 参考\n\n端点和参数');
  writeFileSync(join(kbDir, 'docs', '中文文档.md'), '中文内容');
  writeFileSync(join(outsideDir, 'secret.md'), '不该被读的内容');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
  rmSync(kbDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('Knowledge tools E2E (real Agent, tool surface)', () => {
  it('registers knowledge_search/list/read on the real Agent tool surface', async () => {
    const { agent } = await createE2EAgent();
    const tools = agent.getTools();
    expect(tools.has('knowledge_search')).toBe(true);
    expect(tools.has('knowledge_list')).toBe(true);
    expect(tools.has('knowledge_read')).toBe(true);
  });

  it('knowledge_search returns KB docs with updatedAt and forces source=knowledge', async () => {
    const { agent, ds } = await createE2EAgent();
    const raw = await agent.getTools().get('knowledge_search')!.execute({
      query: 'onboarding',
      project_id: 'proj_kb',
    });
    const res = JSON.parse(raw);
    expect(res.status).toBe('success');
    expect(res.source).toBe('knowledge');
    expect(res.count).toBe(2);
    expect(res.results[0].title).toBe('入门指南');
    expect(res.results[0].updatedAt).toBe('2026-08-29T08:00:00.000Z');
    expect(ds.search).toHaveBeenCalledWith(expect.objectContaining({
      source: 'knowledge',
      projectId: 'proj_kb',
    }));
  });

  it('knowledge_list returns KB docs for a project', async () => {
    const { agent, ds } = await createE2EAgent();
    const raw = await agent.getTools().get('knowledge_list')!.execute({ project_id: 'proj_kb' });
    const res = JSON.parse(raw);
    expect(res.status).toBe('success');
    expect(res.source).toBe('knowledge');
    expect(res.count).toBe(2);
    expect(ds.search).toHaveBeenCalledWith(expect.objectContaining({
      source: 'knowledge',
      projectId: 'proj_kb',
    }));
  });

  it('knowledge_read reads a doc inside the project knowledge root (prefix guard passes)', async () => {
    const { agent } = await createE2EAgent();
    const target = join(kbDir, 'guide.md');
    const raw = await agent.getTools().get('knowledge_read')!.execute({
      path: target,
      project_id: 'proj_kb',
    });
    const res = JSON.parse(raw);
    expect(res.status).toBe('success');
    expect(res.reference).toBe(target);
    expect(res.content).toContain('入门指南');
  });

  it('knowledge_read reads a Chinese-filename doc inside the knowledge root', async () => {
    const { agent } = await createE2EAgent();
    const target = join(kbDir, 'docs', '中文文档.md');
    const raw = await agent.getTools().get('knowledge_read')!.execute({
      path: target,
      project_id: 'proj_kb',
    });
    const res = JSON.parse(raw);
    expect(res.status).toBe('success');
    expect(res.content).toContain('中文内容');
  });

  it('knowledge_read rejects files outside the bound knowledge roots (prefix guard)', async () => {
    const { agent } = await createE2EAgent();
    const target = join(outsideDir, 'secret.md');
    const raw = await agent.getTools().get('knowledge_read')!.execute({
      path: target,
      project_id: 'proj_kb',
    });
    const res = JSON.parse(raw);
    expect(res.status).toBe('error');
  });

  it('knowledge_read still works without project_id (no scope enforcement)', async () => {
    const { agent } = await createE2EAgent();
    const target = join(outsideDir, 'secret.md');
    const raw = await agent.getTools().get('knowledge_read')!.execute({ path: target });
    const res = JSON.parse(raw);
    // No project scoping → bridge does not enforce roots and reads directly.
    expect(res.status).toBe('success');
    expect(res.content).toContain('不该被读的内容');
  });

  it('knowledge_read returns a friendly error for a missing document', async () => {
    const { agent } = await createE2EAgent();
    const raw = await agent.getTools().get('knowledge_read')!.execute({
      path: join(kbDir, 'missing.md'),
      project_id: 'proj_kb',
    });
    const res = JSON.parse(raw);
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/not readable/i);
  });

  it('knowledge_search returns success with zero count for empty results', async () => {
    const manager = createManager();
    const ds = makeDeliverableService();
    ds.search.mockReturnValue({ results: [], total: 0 });
    manager.setDeliverableService(ds);
    manager.setProjectService(makeProjectService() as never);
    const agent = await manager.createAgent({ name: 'KB Worker 2', roleName: 'custom', orgId: 'org_e2e', tools: [] });
    const raw = await agent.getTools().get('knowledge_search')!.execute({ query: 'nothing' });
    const res = JSON.parse(raw);
    expect(res.status).toBe('success');
    expect(res.count).toBe(0);
  });
});