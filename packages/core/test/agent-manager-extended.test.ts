import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({
      content: 'Reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
    chatStream: vi.fn(async () => ({
      content: 'Stream.',
      finishReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
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

function createRoleTemplate(name: string, files: Record<string, string>) {
  const roleDir = join(rolesDir, name);
  mkdirSync(roleDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(roleDir, file), content);
  }
}

function createManager(overrides?: Partial<ConstructorParameters<typeof AgentManager>[0]>) {
  return new AgentManager({
    llmRouter: makeMockRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
    ...overrides,
  });
}

function makeTaskService(overrides?: Record<string, unknown>) {
  return {
    createTask: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'pending' })),
    listTasks: vi.fn(() => []),
    queryTasks: vi.fn(() => ({ tasks: [], total: 0 })),
    updateTaskStatus: vi.fn(() => ({ id: 'task_1', title: 'T', status: 'done' })),
    getTask: vi.fn((id: string) => ({
      id,
      title: 'Task',
      description: 'Work',
      status: 'in_progress',
      reviewerId: 'agt_reviewer',
      subtasks: [],
    })),
    assignTask: vi.fn(),
    addTaskNote: vi.fn(),
    updateTask: vi.fn(),
    rejectTask: vi.fn(),
    addSubtask: vi.fn(),
    completeSubtask: vi.fn(),
    submitForReview: vi.fn(async () => ({ id: 'task_1', status: 'in_review' })),
    requestRevision: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'in_progress' })),
    getTaskComments: vi.fn(async () => []),
    postTaskComment: vi.fn(async () => ({ id: 'cmt_1' })),
    postRequirementComment: vi.fn(async () => ({ id: 'rcmt_1' })),
    getTaskStatusHistory: vi.fn(async () => []),
    getRequirementComments: vi.fn(async () => []),
    updateScheduleFields: vi.fn(async () => ({ id: 'task_1', title: 'T', status: 'pending' })),
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-mgr-ext-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-mgr-ext-roles-'));
  roleLoader = new RoleLoader([rolesDir]);
  createRoleTemplate('custom', {
    'ROLE.md': '# Custom\nAgent role.',
    'HEARTBEAT.md': '- Ping',
    'POLICIES.md': '## Safe\n- Be safe',
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('AgentManager extended coverage', () => {
  it('resolveCurrentTaskId prefers in_progress task over stale currentTaskId', async () => {
    const taskService = makeTaskService({
      getTask: vi.fn((id: string) => ({
        id,
        title: 'Task',
        status: id === 'stale_task' ? 'completed' : 'in_progress',
        reviewerId: 'agt_reviewer',
        subtasks: [],
      })),
    });
    const slowRouter = makeMockRouter();
    (slowRouter.chatStream as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 400));
      return {
        content: 'Done.',
        finishReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const manager = createManager({ llmRouter: slowRouter });
    manager.setTaskService(taskService);

    const agent = await manager.createAgent({
      name: 'Worker',
      roleName: 'custom',
      orgId: 'org_stale',
      tools: [],
    });

    const execPromise = agent.executeTask('live_task', 'Current work', () => {});
    await vi.waitFor(() => agent.getActiveTasks().length > 0, { timeout: 2000 });

    const raw = await agent.getTools().get('task_submit_review')!.execute({
      summary: 'Finished live task',
      deliverables: [{ type: 'report', reference: 'out.txt', summary: 'Done' }],
    });
    expect(JSON.parse(raw).status).toBe('success');
    expect(taskService.submitForReview).toHaveBeenCalledWith(
      'live_task',
      expect.any(Array),
      expect.anything(),
    );
    await execPromise;
  });

  it('returns error when no in_progress task exists for submit review', async () => {
    const taskService = makeTaskService({
      getTask: vi.fn(() => ({
        id: 'done_task',
        title: 'Done',
        status: 'completed',
        reviewerId: 'agt_reviewer',
        subtasks: [],
      })),
    });
    const slowRouter = makeMockRouter();
    (slowRouter.chatStream as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 300));
      return {
        content: 'Done.',
        finishReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });
    const manager = createManager({ llmRouter: slowRouter });
    manager.setTaskService(taskService);

    const agent = await manager.createAgent({
      name: 'Worker',
      roleName: 'custom',
      orgId: 'org_none',
      tools: [],
    });
    const execPromise = agent.executeTask('done_task', 'Finished', () => {});
    await vi.waitFor(() => agent.getActiveTasks().length > 0, { timeout: 2000 });

    const raw = await agent.getTools().get('task_submit_review')!.execute({
      summary: 'Try submit',
      deliverables: [{ type: 'report', reference: 'out.txt', summary: 'Done' }],
    });
    expect(JSON.parse(raw).status).toBe('error');
    await execPromise;
  });

  it('warns and skips missing skills on createAgent', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());

    const agent = await manager.createAgent({
      name: 'Missing Skill Agent',
      roleName: 'custom',
      orgId: 'org_miss',
      tools: [],
      skills: ['nonexistent-skill'],
    });
    expect(agent.config.skills).toContain('nonexistent-skill');
  });

  it('continues when skill MCP server connection fails', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'broken-skill',
        version: '1.0.0',
        description: 'Broken MCP',
        author: 'test',
        category: 'productivity',
        mcpServers: { 'bad-server': { command: 'false', args: [] } },
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());
    const mcpManager = (manager as unknown as {
      mcpManager: { connectServer: ReturnType<typeof vi.fn> };
    }).mcpManager;
    vi.spyOn(mcpManager, 'connectServer').mockRejectedValue(new Error('connect failed'));

    const agent = await manager.createAgent({
      name: 'Broken MCP Agent',
      roleName: 'custom',
      orgId: 'org_broken',
      tools: [],
      skills: ['broken-skill'],
    });
    expect(agent).toBeDefined();
  });

  it('registers recall tool when callbacks are set', async () => {
    const manager = createManager();
    manager.setTaskService(makeTaskService());
    manager.setRecallCallbacks({
      listActivities: vi.fn(() => []),
      getActivityLogs: vi.fn(() => []),
    });

    const agent = await manager.createAgent({
      name: 'Recall Agent',
      roleName: 'custom',
      orgId: 'org_recall',
      tools: [],
    });
    expect(agent.getTools().has('recall_activity')).toBe(true);
  });

  it('injects builtin skill instructions from registry', async () => {
    const { InMemorySkillRegistry } = await import('../src/skills/registry.js');
    const registry = new InMemorySkillRegistry();
    registry.register({
      manifest: {
        name: 'always-on',
        version: '1.0.0',
        description: 'Always on',
        author: 'test',
        category: 'productivity',
        instructions: 'Follow these always-on rules.',
        builtIn: true,
        alwaysOn: true,
      },
    });

    const manager = createManager({ skillRegistry: registry });
    manager.setTaskService(makeTaskService());
    const agent = await manager.createAgent({
      name: 'Builtin Agent',
      roleName: 'custom',
      orgId: 'org_builtin',
      tools: [],
    });
    expect(agent.hasSkillInstructions('always-on')).toBe(true);
  });

  it('createAgent as team manager sets team data dir path policy', async () => {
    const manager = createManager();
    manager.setTaskService(makeTaskService());
    const agent = await manager.createAgent({
      name: 'Team Manager',
      roleName: 'custom',
      orgId: 'org_mgr',
      teamId: 'team_alpha',
      agentRole: 'manager',
      tools: [],
    });
    expect(agent.config.agentRole).toBe('manager');
  });

  it('requirement service tools are wired for manager agents', async () => {
    const manager = createManager();
    manager.setTaskService(makeTaskService());
    manager.setRequirementService({
      proposeRequirement: vi.fn(() => ({ id: 'req_1', title: 'New req', status: 'proposed' })),
      listRequirements: vi.fn(() => []),
      updateRequirementStatus: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'approved' })),
      rejectRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'rejected' })),
      cancelRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'cancelled' })),
      updateRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'active' })),
      resubmitRequirement: vi.fn(() => ({ id: 'req_1', title: 'R', status: 'proposed' })),
      getRequirement: vi.fn(() => ({
        id: 'req_1',
        title: 'Req',
        description: 'Desc',
        status: 'proposed',
        priority: 'medium',
        source: 'agent',
        taskIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    } as never);

    const agent = await manager.createAgent({
      name: 'Req Manager',
      roleName: 'custom',
      orgId: 'org_req',
      agentRole: 'manager',
      tools: [],
    });

    const propose = await agent.getTools().get('requirement_propose')!.execute({
      title: 'Need feature',
      description: 'Build OAuth',
    });
    expect(JSON.parse(propose).status).toBe('success');
  });
});
