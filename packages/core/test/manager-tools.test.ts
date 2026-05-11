import { describe, it, expect, vi } from 'vitest';
import { createManagerTools, createPackageTools, type ManagerToolsContext, type PackageToolsContext } from '../src/tools/manager.js';

function createMockManagerContext(overrides?: Partial<ManagerToolsContext>): ManagerToolsContext {
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

function createMockPackageContext(overrides?: Partial<PackageToolsContext>): PackageToolsContext {
  const listTemplatesFn = vi.fn(() => [
    { id: 'tpl_dev', name: 'Developer', description: 'A developer', roleId: 'developer', category: 'development' },
  ]);
  const hireFromTemplateFn = vi.fn(async (_templateId: string, name: string) => ({
    id: 'agt_new',
    name,
    role: 'developer',
  }));
  const installArtifactFn = vi.fn(async (type: string, name: string) => {
    if (type === 'agent' && name === 'custom-dev') return { type, installed: { name } };
    throw new Error(`Artifact not found: ${type}/${name}`);
  });
  const listArtifactsFn = vi.fn((type?: string) => {
    const all = [{ type: 'agent', name: 'custom-dev', description: 'Custom developer' }];
    return type ? all.filter(a => a.type === type) : all;
  });
  const searchHubFn = vi.fn(async () => [
    { id: 'hub_001', name: 'research-team', type: 'team', description: 'A research team', author: 'community', downloads: 42 },
  ]);
  const downloadAndInstallFn = vi.fn(async () => ({ type: 'team', installed: { name: 'research-team' } }));

  return {
    listTemplates: () => listTemplatesFn,
    hireFromTemplate: () => hireFromTemplateFn,
    installArtifact: () => installArtifactFn,
    listArtifacts: () => listArtifactsFn,
    searchHub: () => searchHubFn,
    downloadAndInstall: () => downloadAndInstallFn,
    ...overrides,
  };
}

function findManagerTool(ctx: ManagerToolsContext, name: string) {
  const tools = createManagerTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

function findPackageTool(ctx: PackageToolsContext, name: string) {
  const tools = createPackageTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('team_list', () => {
  it('lists team agents', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'team_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(2);
    expect(result.agents[0].name).toBe('Alice');
  });
});

describe('team_status', () => {
  it('returns team status with token usage', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'team_status');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(2);
    expect(result.team[0].tokensUsedToday).toBe(5000);
  });
});

describe('delegate_message', () => {
  it('dispatches message to agent', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'delegate_message');
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
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'task_check_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalGroups).toBe(1);
  });

  it('reports no duplicates', async () => {
    const ctx = createMockManagerContext({
      findDuplicateTasks: vi.fn(() => []),
    });
    const tool = findManagerTool(ctx, 'task_check_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalGroups).toBe(0);
    expect(result.message).toContain('No duplicates');
  });
});

describe('task_cleanup_duplicates', () => {
  it('cancels duplicate tasks', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'task_cleanup_duplicates');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.cancelledIds).toContain('tsk_002');
  });
});

describe('task_board_health', () => {
  it('returns health summary', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'task_board_health');
    const result = JSON.parse(await tool.execute({ org_id: 'org_default' }));
    expect(result.status).toBe('success');
    expect(result.totalTasks).toBe(10);
  });
});

describe('package_list', () => {
  it('lists all packages including roles when no type filter', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.count).toBe(2);
    expect(result.items.some((i: { source?: string }) => i.source === 'role')).toBe(true);
  });

  it('lists roles and agent packages when type is agent', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_list');
    const result = JSON.parse(await tool.execute({ type: 'agent' }));
    expect(result.count).toBe(2);
  });

  it('lists only team packages when type is team', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_list');
    const result = JSON.parse(await tool.execute({ type: 'team' }));
    expect(result.count).toBe(0);
  });
});

describe('package_install', () => {
  it('installs an agent artifact package', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_install');
    const result = JSON.parse(await tool.execute({ type: 'agent', name: 'custom-dev' }));
    expect(result.status).toBe('success');
    expect(result.next_steps).toBeDefined();
  });

  it('falls back to role template when agent package not found', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_install');
    const result = JSON.parse(await tool.execute({
      type: 'agent',
      name: 'tpl_dev',
      agent_name: 'Charlie',
    }));
    expect(result.status).toBe('success');
    expect(result.agent.name).toBe('Charlie');
  });

  it('rejects role fallback without agent_name', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_install');
    const result = JSON.parse(await tool.execute({ type: 'agent', name: 'nonexistent-pkg' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('agent_name');
  });

  it('rejects invalid type', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_install');
    const result = JSON.parse(await tool.execute({ type: 'invalid', name: 'test' }));
    expect(result.status).toBe('error');
  });

  it('rejects missing name', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'package_install');
    const result = JSON.parse(await tool.execute({ type: 'agent' }));
    expect(result.status).toBe('error');
  });
});

describe('hub_search', () => {
  it('searches the hub', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'hub_search');
    const result = JSON.parse(await tool.execute({ query: 'research' }));
    expect(result.count).toBe(1);
    expect(result.items[0].name).toBe('research-team');
  });
});

describe('hub_install', () => {
  it('installs from hub', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'hub_install');
    const result = JSON.parse(await tool.execute({ item_id: 'hub_001' }));
    expect(result.status).toBe('success');
    expect(result.next_steps).toBeDefined();
  });

  it('rejects missing item_id', async () => {
    const ctx = createMockPackageContext();
    const tool = findPackageTool(ctx, 'hub_install');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('error');
    expect(result.error).toContain('item_id');
  });
});

describe('team_update', () => {
  it('updates team name', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({
      team_id: 'team_001',
      name: 'Alpha Team',
    }));
    expect(result.status).toBe('success');
    expect(result.team.name).toBe('Alpha Team');
  });

  it('rejects missing team_id', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({ name: 'Alpha Team' }));
    expect(result.status).toBe('error');
  });

  it('rejects when no fields provided', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'team_update');
    const result = JSON.parse(await tool.execute({ team_id: 'team_001' }));
    expect(result.status).toBe('error');
  });
});

describe('agent_update', () => {
  it('renames an agent', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'agent_update');
    const result = JSON.parse(await tool.execute({
      agent_id: 'agt_001',
      name: 'Alice 2.0',
    }));
    expect(result.status).toBe('success');
    expect(result.agent.name).toBe('Alice 2.0');
  });

  it('rejects missing agent_id', async () => {
    const ctx = createMockManagerContext();
    const tool = findManagerTool(ctx, 'agent_update');
    const result = JSON.parse(await tool.execute({ name: 'Alice' }));
    expect(result.status).toBe('error');
  });
});
