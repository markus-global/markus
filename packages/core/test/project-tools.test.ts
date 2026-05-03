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
  it('returns project details', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'get_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001' }));
    expect(result.status).toBe('success');
    expect(result.project.id).toBe('proj_001');
    expect(result.project.governance).toBe('standard');
  });

  it('returns error for missing project', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'get_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_missing' }));
    expect(result.status).toBe('error');
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
  it('updates a project', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'update_project');
    const result = JSON.parse(await tool.execute({ project_id: 'proj_001', status: 'paused' }));
    expect(result.status).toBe('success');
  });
});

describe('project_info', () => {
  it('returns current project info', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'project_info');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('success');
    expect(result.project.name).toBe('Web App');
  });

  it('returns error when no project found', async () => {
    const ctx = createMockContext({
      getProjectInfo: vi.fn(async () => null),
    });
    const tool = findTool(ctx, 'project_info');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('error');
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
