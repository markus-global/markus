import { describe, it, expect, vi } from 'vitest';
import { createProjectTools, type ProjectToolsContext } from '../src/tools/project-tools.js';

function createMockContext(overrides?: Partial<ProjectToolsContext>): ProjectToolsContext {
  return {
    agentId: 'agt_test',
    orgId: 'org_default',
    webUiBaseUrl: 'http://localhost:3000',
    projectService: {
      listProjects: vi.fn(() => [
        { id: 'proj_001', name: 'Web App', description: 'Main project', status: 'active', teamIds: ['team_001'] },
      ]),
      getProject: vi.fn((id: string) => {
        if (id === 'proj_missing') return undefined;
        return {
          id,
          name: 'Web App',
          description: 'Main project',
          status: 'active',
          repositories: [{ localPath: '/repo', defaultBranch: 'main', role: 'primary' }],
          teamIds: ['team_001'],
          governancePolicy: { enabled: true, defaultTier: 'standard' },
        };
      }),
      createProject: vi.fn((opts) => ({
        id: 'proj_new',
        name: opts.name,
        status: 'active',
      })),
      updateProject: vi.fn((id, data) => ({
        id,
        name: data.name ?? 'Web App',
        status: data.status ?? 'active',
      })),
    },
    getProjectInfo: vi.fn(async (id) => {
      if (id === 'proj_missing') return null;
      return {
        id: id ?? 'proj_001',
        name: 'Web App',
        description: 'Main project',
        status: 'active',
        repositories: [{ localPath: '/repo', defaultBranch: 'main', role: 'primary' }],
        teamIds: ['team_001'],
        governancePolicy: { enabled: true, defaultTier: 'standard' },
      };
    }),
    deliverableCreate: vi.fn(async (opts) => ({
      id: 'dlv_001',
      type: opts.type,
      title: opts.title,
      status: 'active',
    })),
    deliverableSearch: vi.fn(async () => [
      { id: 'dlv_001', type: 'file', title: 'API Doc', summary: 'API reference', reference: '/docs/api.md', status: 'active', tags: ['api'] },
    ]),
    deliverableList: vi.fn(async () => [
      { id: 'dlv_001', type: 'file', title: 'API Doc', summary: 'API reference', reference: '/docs/api.md', status: 'active', tags: ['api'], updatedAt: '2024-01-01' },
    ]),
    deliverableUpdate: vi.fn(async (id) => ({ id, status: 'verified' })),
    ...overrides,
  };
}

function findTool(ctx: ProjectToolsContext, name: string) {
  const tools = createProjectTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('list_projects', () => {
  it('lists all projects', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'list_projects');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.projects[0].id).toBe('proj_001');
  });
});

describe('get_project', () => {
  it('returns full project details with repositories', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'get_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001' }));
    expect(result.status).toBe('success');
    expect(result.project.id).toBe('proj_001');
    expect(result.project.repositories).toHaveLength(1);
    expect(result.project.repositories[0].path).toBe('/repo');
    expect(result.project.repositories[0].branch).toBe('main');
    expect(result.project.repositories[0].role).toBe('primary');
    expect(result.project.teamIds).toEqual(['team_001']);
    expect(result.project.governancePolicy).toEqual({ enabled: true, defaultTier: 'standard' });
  });

  it('returns error for missing project', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'get_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_missing' }));
    expect(result.status).toBe('error');
  });

  it('falls back to getProjectInfo when no project_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'get_project');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('success');
    expect(result.project.name).toBe('Web App');
  });
});

describe('create_project', () => {
  it('creates a project (no approval)', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'create_project');
    const result = JSON.parse(await tool.execute({ name: 'New App', description: 'A new project' }));
    expect(result.status).toBe('success');
    expect(result.project.id).toBe('proj_new');
  });

  it('respects approval rejection', async () => {
    const ctx = createMockContext({
      requestApproval: vi.fn(async () => ({ approved: false, comment: 'Not now' })),
    });
    const tool = findTool(ctx, 'create_project');
    const result = JSON.parse(await tool.execute({ name: 'New App', description: 'A new project' }));
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('Not now');
  });
});

describe('update_project', () => {
  it('updates a project with description only (no approval needed)', async () => {
    const approval = vi.fn(async () => ({ approved: true }));
    const ctx = createMockContext({ requestApproval: approval });
    const tool = findTool(ctx, 'update_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001', description: 'Updated desc' }));
    expect(result.status).toBe('success');
    expect(approval).not.toHaveBeenCalled();
  });

  it('requires approval for status change', async () => {
    const approval = vi.fn(async () => ({ approved: true }));
    const ctx = createMockContext({ requestApproval: approval });
    const tool = findTool(ctx, 'update_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001', status: 'paused' }));
    expect(result.status).toBe('success');
    expect(approval).toHaveBeenCalledOnce();
  });

  it('requires approval for repositories change', async () => {
    const approval = vi.fn(async () => ({ approved: false, comment: 'Not now' }));
    const ctx = createMockContext({ requestApproval: approval });
    const tool = findTool(ctx, 'update_project');
    const result = JSON.parse(await tool.execute({
      project_id: 'proj_001',
      repositories: [{ localPath: '/new-repo', defaultBranch: 'main', role: 'primary' }],
    }));
    expect(result.status).toBe('rejected');
    expect(approval).toHaveBeenCalledOnce();
  });
});

describe('delete_project', () => {
  it('requires approval and deletes', async () => {
    const approval = vi.fn(async () => ({ approved: true }));
    const deleteProject = vi.fn();
    const ctx = createMockContext({
      requestApproval: approval,
      projectService: {
        ...createMockContext().projectService!,
        deleteProject,
      },
    });
    const tool = findTool(ctx, 'delete_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001', reason: 'No longer needed' }));
    expect(result.status).toBe('success');
    expect(approval).toHaveBeenCalledOnce();
    expect(deleteProject).toHaveBeenCalledWith('proj_001');
  });

  it('rejects when approval denied', async () => {
    const approval = vi.fn(async () => ({ approved: false, comment: 'Keep it' }));
    const ctx = createMockContext({
      requestApproval: approval,
      projectService: {
        ...createMockContext().projectService!,
        deleteProject: vi.fn(),
      },
    });
    const tool = findTool(ctx, 'delete_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001', reason: 'Cleanup' }));
    expect(result.status).toBe('rejected');
  });
});

describe('project_stats', () => {
  it('returns project statistics', async () => {
    const ctx = createMockContext({
      getProjectStats: vi.fn(async () => ({
        totalTasks: 10, completed: 3, inProgress: 2, inReview: 1, blocked: 0, pending: 4, failed: 0,
        totalRequirements: 4, completedRequirements: 1,
      })),
    } as any);
    const tool = findTool(ctx, 'project_stats');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001' }));
    expect(result.status).toBe('success');
    expect(result.totalTasks).toBe(10);
    expect(result.completed).toBe(3);
  });
});

describe('deliverable_create', () => {
  it('creates a deliverable', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'deliverable_create');
    const result = JSON.parse(await tool.execute({
      type: 'file',
      title: 'Architecture Doc',
      summary: 'System architecture overview',
      reference: '/docs/arch.md',
    }));
    expect(result.status).toBe('success');
    expect(result.deliverableId).toBe('dlv_001');
    expect(result.accessUrl).toContain('deliverables');
  });
});

describe('deliverable_search', () => {
  it('searches deliverables', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'deliverable_search');
    const result = JSON.parse(await tool.execute({ query: 'api' }));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.results[0].title).toBe('API Doc');
  });
});

describe('deliverable_list', () => {
  it('lists deliverables with filters', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'deliverable_list');
    const result = JSON.parse(await tool.execute({ type: 'file' }));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
  });
});

describe('deliverable_update', () => {
  it('updates a deliverable', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'deliverable_update');
    const result = JSON.parse(await tool.execute({
      deliverable_id: 'dlv_001',
      status: 'verified',
    }));
    expect(result.status).toBe('success');
    expect(result.deliverableStatus).toBe('verified');
  });

  it('returns error for missing deliverable', async () => {
    const ctx = createMockContext({
      deliverableUpdate: vi.fn(async () => undefined),
    });
    const tool = findTool(ctx, 'deliverable_update');
    const result = JSON.parse(await tool.execute({ deliverable_id: 'dlv_missing' }));
    expect(result.status).toBe('error');
  });
});
