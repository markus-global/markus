import { describe, it, expect, vi } from 'vitest';
import { createManagerTools, createBuilderTools, type ManagerToolsContext, type BuilderToolsContext } from '../src/tools/manager.js';

function createMockContext(overrides?: Partial<ManagerToolsContext>): ManagerToolsContext {
  return {
    listAgents: vi.fn(() => [
      { id: 'agt_001', name: 'Alice', role: 'developer', status: 'active', skills: ['self-evolution'] },
      { id: 'agt_002', name: 'Bob', role: 'reviewer', status: 'idle', skills: [] },
    ]),
    delegateMessage: vi.fn(async () => 'ok'),
    getTeamStatus: vi.fn(() => [
      { id: 'agt_001', name: 'Alice', role: 'developer', status: 'active', currentTask: 'tsk_001', tokensUsedToday: 5000 },
      { id: 'agt_002', name: 'Bob', role: 'reviewer', status: 'idle', tokensUsedToday: 200 },
    ]),
    findDuplicateTasks: vi.fn(() => [
      { group: 'Login impl', tasks: [
        { id: 'tsk_001', title: 'Implement login', status: 'pending', createdAt: '2024-01-01' },
        { id: 'tsk_002', title: 'Implement login page', status: 'pending', createdAt: '2024-01-02' },
      ]},
    ]),
    cleanupDuplicateTasks: vi.fn(() => ({ cancelledIds: ['tsk_002'], count: 1 })),
    getTaskBoardHealth: vi.fn(() => ({
      totalTasks: 10,
      statusCounts: { in_progress: 3, pending: 5, review: 2 },
      duplicateWarnings: 1,
    })),
    listTemplates: vi.fn(() => [
      { id: 'tpl_dev', name: 'Developer', description: 'A developer', roleId: 'developer', category: 'development' },
    ]),
    hireFromTemplate: vi.fn(async (templateId, name) => ({
      id: 'agt_new',
      name,
      role: 'developer',
    })),
    installArtifact: vi.fn(async (type, name) => ({ type, installed: { name } })),
    listArtifacts: vi.fn(() => [
      { type: 'agent', name: 'custom-dev', description: 'Custom developer' },
    ]),
    updateTeam: vi.fn(async (teamId, data) => ({
      id: teamId,
      name: data.name ?? 'Team',
      description: data.description,
    })),
    updateAgentConfig: vi.fn(async (agentId, data) => ({
      id: agentId,
      name: data.name ?? 'Agent',
    })),
    ...overrides,
  };
}

function findTool(ctx: ManagerToolsContext, name: string) {
  const tools = createManagerTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('team_list', () => {
  it('lists team agents', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(2);
    expect(result.agents[0].name).toBe('Alice');
  });
});

describe('team_status', () => {
  it('returns team status with token usage', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_status');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(2);
    expect(result.team[0].tokensUsedToday).toBe(5000);
  });
});

describe('delegate_message', () => {
  it('dispatches message to agent', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'delegate_message');
    const result = JSON.parse(await tool.execute({
      agent_id: 'agt_001',
      message: 'Please review the PR',
    }));
    expect(result.status).toBe('dispatched');
    expect(ctx.delegateMessage).toHaveBeenCalledWith('agt_001', 'Please review the PR', 'manager');
  });
});

describe('task_check_duplicates', () => {
  it('finds duplicate tasks', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_check_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalGroups).toBe(1);
  });

  it('reports no duplicates', async () => {
    const ctx = createMockContext({
      findDuplicateTasks: vi.fn(() => []),
    });
    const tool = findTool(ctx, 'task_check_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalGroups).toBe(0);
    expect(result.message).toContain('No duplicates');
  });
});

describe('task_cleanup_duplicates', () => {
  it('cancels duplicate tasks', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_cleanup_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.cancelledIds).toContain('tsk_002');
  });
});

describe('task_board_health', () => {
  it('returns health summary', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_board_health');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalTasks).toBe(10);
  });
});

describe('team_list_templates', () => {
  it('lists available templates', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_list_templates');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(1);
    expect(result.templates[0].name).toBe('Developer');
  });
});

describe('team_hire_agent', () => {
  it('hires from template successfully', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_hire_agent');
    const result = JSON.parse(await tool.execute({
      template_id: 'tpl_dev',
      name: 'Charlie',
    }));
    expect(result.status).toBe('success');
    expect(result.agent.name).toBe('Charlie');
  });

  it('rejects missing template_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_hire_agent');
    const result = JSON.parse(await tool.execute({ name: 'Charlie' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('template_id');
  });

  it('rejects missing name', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_hire_agent');
    const result = JSON.parse(await tool.execute({ template_id: 'tpl_dev' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });
});

function createMockBuilderContext(overrides?: Partial<BuilderToolsContext>): BuilderToolsContext {
  return {
    installArtifact: vi.fn(async (type, name) => ({ type, installed: { name } })),
    listArtifacts: vi.fn(() => [
      { type: 'agent', name: 'custom-dev', description: 'Custom developer' },
    ]),
    ...overrides,
  };
}

function findBuilderTool(ctx: BuilderToolsContext, name: string) {
  const tools = createBuilderTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('builder_list', () => {
  it('lists artifacts', async () => {
    const ctx = createMockBuilderContext();
    const tool = findBuilderTool(ctx, 'builder_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(1);
    expect(result.artifacts[0].name).toBe('custom-dev');
  });
});

describe('builder_install', () => {
  it('installs an artifact', async () => {
    const ctx = createMockBuilderContext();
    const tool = findBuilderTool(ctx, 'builder_install');
    const result = JSON.parse(await tool.execute({ type: 'agent', name: 'custom-dev' }));
    expect(result.status).toBe('success');
    expect(result.next_steps).toBeDefined();
  });

  it('rejects invalid type', async () => {
    const ctx = createMockBuilderContext();
    const tool = findBuilderTool(ctx, 'builder_install');
    const result = JSON.parse(await tool.execute({ type: 'invalid', name: 'test' }));
    expect(result.status).toBe('error');
  });

  it('rejects missing name', async () => {
    const ctx = createMockBuilderContext();
    const tool = findBuilderTool(ctx, 'builder_install');
    const result = JSON.parse(await tool.execute({ type: 'agent' }));
    expect(result.status).toBe('error');
  });
});

describe('team_update', () => {
  it('updates team name', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({
      team_id: 'team_001',
      name: 'Alpha Team',
    }));
    expect(result.status).toBe('success');
    expect(result.team.name).toBe('Alpha Team');
  });

  it('rejects missing team_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({ name: 'Alpha Team' }));
    expect(result.status).toBe('error');
  });

  it('rejects when no fields provided', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({ team_id: 'team_001' }));
    expect(result.status).toBe('error');
  });
});

describe('agent_update', () => {
  it('renames an agent', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'agent_update');
    const result = JSON.parse(await tool.execute({
      agent_id: 'agt_001',
      name: 'Alice 2.0',
    }));
    expect(result.status).toBe('success');
    expect(result.agent.name).toBe('Alice 2.0');
  });

  it('rejects missing agent_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'agent_update');
    const result = JSON.parse(await tool.execute({ name: 'Alice' }));
    expect(result.status).toBe('error');
  });
});
