import { describe, it, expect, vi } from 'vitest';
import { createWorkflowTools, type WorkflowToolsContext } from '../src/tools/workflow-tools.js';

function createMockContext(overrides?: Partial<WorkflowToolsContext>): WorkflowToolsContext {
  return {
    teamId: 'team_001',
    listWorkflows: vi.fn(() => [
      {
        name: 'content-publishing',
        displayName: 'Content Publishing',
        description: 'Publish content workflow',
        version: '1.0.0',
        roles: ['writer', 'editor'],
        hasSchedule: true,
        stepCount: 4,
        params: [{ name: 'topic', label: 'Topic', required: true, default: 'news' }],
      },
    ]),
    getWorkflow: vi.fn((name: string) => (name === 'content-publishing' ? { name } : null)),
    runWorkflow: vi.fn(async (name, params, projectId) => ({
      runId: 'run_001',
      runNumber: 1,
      requirementId: 'req_001',
      taskIds: ['tsk_001', 'tsk_002'],
    })),
    listRuns: vi.fn(async () => [
      {
        id: 'run_001',
        runNumber: 1,
        status: 'completed',
        taskIds: ['tsk_001'],
        triggeredBy: 'agt_test',
        startedAt: '2024-01-01T00:00:00Z',
        completedAt: '2024-01-01T01:00:00Z',
      },
    ]),
    getActiveRuns: vi.fn(() => [
      {
        id: 'run_002',
        workflowName: 'content-publishing',
        runNumber: 2,
        status: 'running',
        taskIds: ['tsk_003'],
        startedAt: '2024-01-02T00:00:00Z',
      },
    ]),
    cancelRun: vi.fn(async () => {}),
    addWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    removeWorkflow: vi.fn(),
    ...overrides,
  };
}

function findTool(ctx: WorkflowToolsContext, name: string) {
  const tools = createWorkflowTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('createWorkflowTools', () => {
  it('returns all workflow tools', () => {
    const ctx = createMockContext();
    const tools = createWorkflowTools(ctx);
    expect(tools.map(t => t.name)).toEqual([
      'workflow_list',
      'workflow_run',
      'workflow_status',
      'workflow_cancel',
      'workflow_create',
      'workflow_update',
      'workflow_delete',
    ]);
  });

  describe('workflow_list', () => {
    it('lists workflow templates', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_list');
      const result = JSON.parse(await tool.execute({}));
      expect(result.count).toBe(1);
      expect(result.workflows[0].name).toBe('content-publishing');
      expect(result.workflows[0].params[0].name).toBe('topic');
    });

    it('returns empty message when no templates', async () => {
      const ctx = createMockContext({ listWorkflows: vi.fn(() => []) });
      const tool = findTool(ctx, 'workflow_list');
      const result = JSON.parse(await tool.execute({}));
      expect(result.workflows).toEqual([]);
      expect(result.message).toContain('No workflow templates');
    });

    it('handles list errors', async () => {
      const ctx = createMockContext({
        listWorkflows: vi.fn(() => { throw new Error('db down'); }),
      });
      const tool = findTool(ctx, 'workflow_list');
      const result = JSON.parse(await tool.execute({}));
      expect(result.status).toBe('error');
      expect(result.error).toContain('db down');
    });
  });

  describe('workflow_run', () => {
    it('starts a workflow run', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_run');
      const result = JSON.parse(await tool.execute({
        name: 'content-publishing',
        project_id: 'proj_001',
        params: { topic: 'AI trends' },
        role_mapping: { writer: 'agt_writer' },
      }));
      expect(result.status).toBe('success');
      expect(result.run.runId).toBe('run_001');
      expect(result.message).toContain('2 tasks');
      expect(ctx.runWorkflow).toHaveBeenCalledWith(
        'content-publishing',
        { topic: 'AI trends' },
        'proj_001',
        { writer: 'agt_writer' },
      );
    });

    it('returns error when run fails', async () => {
      const ctx = createMockContext({
        runWorkflow: vi.fn(async () => { throw new Error('template missing'); }),
      });
      const tool = findTool(ctx, 'workflow_run');
      const result = JSON.parse(await tool.execute({
        name: 'missing',
        project_id: 'proj_001',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('template missing');
    });
  });

  describe('workflow_status', () => {
    it('shows active runs when name omitted', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_status');
      const result = JSON.parse(await tool.execute({}));
      expect(result.count).toBe(1);
      expect(result.activeRuns[0].id).toBe('run_002');
    });

    it('shows message when no active runs', async () => {
      const ctx = createMockContext({ getActiveRuns: vi.fn(() => []) });
      const tool = findTool(ctx, 'workflow_status');
      const result = JSON.parse(await tool.execute({}));
      expect(result.count).toBe(0);
      expect(result.message).toContain('No active workflow runs');
    });

    it('shows run history for a named workflow', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_status');
      const result = JSON.parse(await tool.execute({ name: 'content-publishing', limit: 10 }));
      expect(result.workflow).toBe('content-publishing');
      expect(result.count).toBe(1);
      expect(ctx.listRuns).toHaveBeenCalledWith('content-publishing', 10);
    });

    it('handles status errors', async () => {
      const ctx = createMockContext({
        listRuns: vi.fn(async () => { throw new Error('timeout'); }),
      });
      const tool = findTool(ctx, 'workflow_status');
      const result = JSON.parse(await tool.execute({ name: 'content-publishing' }));
      expect(result.status).toBe('error');
    });
  });

  describe('workflow_cancel', () => {
    it('cancels a run', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_cancel');
      const result = JSON.parse(await tool.execute({ run_id: 'run_002' }));
      expect(result.status).toBe('success');
      expect(ctx.cancelRun).toHaveBeenCalledWith('run_002');
    });

    it('returns error when cancel fails', async () => {
      const ctx = createMockContext({
        cancelRun: vi.fn(async () => { throw new Error('already finished'); }),
      });
      const tool = findTool(ctx, 'workflow_cancel');
      const result = JSON.parse(await tool.execute({ run_id: 'run_002' }));
      expect(result.status).toBe('error');
    });
  });

  describe('workflow_create', () => {
    it('adds a workflow template', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_create');
      const yaml = 'name: test\nsteps: []';
      const result = JSON.parse(await tool.execute({ name: 'new-flow', yaml }));
      expect(result.status).toBe('success');
      expect(ctx.addWorkflow).toHaveBeenCalledWith('new-flow', yaml);
    });
  });

  describe('workflow_update', () => {
    it('updates a workflow template', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_update');
      const result = JSON.parse(await tool.execute({ name: 'content-publishing', yaml: 'updated' }));
      expect(result.status).toBe('success');
      expect(ctx.updateWorkflow).toHaveBeenCalledWith('content-publishing', 'updated');
    });

    it('returns error when update is unavailable', async () => {
      const ctx = createMockContext({ updateWorkflow: undefined });
      const tool = findTool(ctx, 'workflow_update');
      const result = JSON.parse(await tool.execute({ name: 'x', yaml: 'y' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('not available');
    });
  });

  describe('workflow_delete', () => {
    it('deletes a workflow template', async () => {
      const ctx = createMockContext();
      const tool = findTool(ctx, 'workflow_delete');
      const result = JSON.parse(await tool.execute({ name: 'old-flow' }));
      expect(result.status).toBe('success');
      expect(ctx.removeWorkflow).toHaveBeenCalledWith('old-flow');
    });

    it('returns error when delete is unavailable', async () => {
      const ctx = createMockContext({ removeWorkflow: undefined });
      const tool = findTool(ctx, 'workflow_delete');
      const result = JSON.parse(await tool.execute({ name: 'old-flow' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('not available');
    });
  });
});
