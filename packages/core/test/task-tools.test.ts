import { describe, it, expect, vi } from 'vitest';
import { createAgentTaskTools, type AgentTaskContext } from '../src/tools/task-tools.js';

function createMockContext(overrides?: Partial<AgentTaskContext>): AgentTaskContext {
  return {
    agentId: 'agt_test',
    agentName: 'Test Agent',
    createTask: vi.fn(async (params) => ({
      id: 'tsk_001',
      title: params.title,
      status: 'pending',
    })),
    listTasks: vi.fn(async () => ({
      tasks: [
        { id: 'tsk_001', title: 'Task 1', description: 'Desc', status: 'in_progress', priority: 'medium', updatedAt: '2024-01-01' },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    })),
    updateTaskStatus: vi.fn(async (id, status) => ({ id, title: 'Task 1', status })),
    getTask: vi.fn(async (id) => ({
      id,
      title: 'Task 1',
      description: 'A test task',
      status: 'in_progress',
      priority: 'medium',
      assignedAgentId: 'agt_other',
    })),
    assignTask: vi.fn(async (taskId, agentId) => ({ id: taskId, status: 'in_progress' })),
    addTaskNote: vi.fn(async () => {}),
    updateTaskFields: vi.fn(async (id) => ({ id, title: 'Task 1', status: 'in_progress' })),
    addSubtask: vi.fn(async (taskId, title) => ({ id: 'sub_001', title, status: 'pending' })),
    completeSubtask: vi.fn(async (taskId, subtaskId) => ({ id: subtaskId, title: 'Sub', status: 'completed' })),
    getSubtasks: vi.fn(async () => [
      { id: 'sub_001', title: 'Sub 1', status: 'completed' },
      { id: 'sub_002', title: 'Sub 2', status: 'pending' },
    ]),
    proposeRequirement: vi.fn(async (params) => ({
      id: 'req_001',
      title: params.title,
      status: 'pending',
    })),
    listRequirements: vi.fn(async () => [
      { id: 'req_001', title: 'Req 1', description: 'Desc', status: 'approved', priority: 'high', source: 'agent', taskIds: ['tsk_001'] },
    ]),
    getRequirement: vi.fn(async () => ({
      id: 'req_001',
      title: 'Req 1',
      description: 'A requirement',
      status: 'approved',
      priority: 'high',
      source: 'agent',
      taskIds: ['tsk_001'],
      tags: [],
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      comments: [],
    })),
    submitForReview: vi.fn(async () => ({ id: 'tsk_001', status: 'review' })),
    requestRevision: vi.fn(async (taskId, reason) => ({ id: taskId, title: 'Task 1', status: 'in_progress' })),
    updateRequirementStatus: vi.fn(async (id, status) => ({ id, title: 'Req 1', status })),
    updateRequirement: vi.fn(async (id) => ({ id, title: 'Updated Req', status: 'approved' })),
    resubmitRequirement: vi.fn(async (id) => ({ id, title: 'Resubmitted Req', status: 'pending' })),
    postTaskComment: vi.fn(async () => ({ id: 'cmt_001' })),
    postRequirementComment: vi.fn(async () => ({ id: 'cmt_002' })),
    getCurrentActivityId: vi.fn(() => 'act_001'),
    ...overrides,
  };
}

function findTool(ctx: AgentTaskContext, name: string) {
  const tools = createAgentTaskTools(ctx);
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

describe('task_create', () => {
  it('creates a task successfully', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Implement login',
      description: 'Build login page',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_reviewer',
    }));
    expect(result.status).toBe('pending');
    expect(result.task.id).toBe('tsk_001');
    expect(ctx.createTask).toHaveBeenCalledOnce();
  });

  it('rejects when assigned_agent_id is missing', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Test',
      description: 'Desc',
      reviewer_id: 'agt_reviewer',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('assigned_agent_id');
  });

  it('rejects when reviewer_id is empty', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Test',
      description: 'Desc',
      assigned_agent_id: 'agt_worker',
      reviewer_id: '',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('reviewer_id');
  });

  it('rejects when reviewer equals assignee (both agents)', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Test',
      description: 'Desc',
      assigned_agent_id: 'agt_same',
      reviewer_id: 'agt_same',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('must differ');
  });

  it('allows same reviewer and assignee when reviewer is human', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Test',
      description: 'Desc',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_worker',
      reviewer_type: 'human',
    }));
    expect(result.status).toBe('pending');
  });

  it('passes schedule config for scheduled tasks', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    await tool.execute({
      title: 'Daily check',
      description: 'Run daily',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_reviewer',
      task_type: 'scheduled',
      schedule: { every: '1d', timezone: 'UTC' },
    });
    expect(ctx.createTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'scheduled',
      scheduleConfig: expect.objectContaining({ every: '1d' }),
    }));
  });

  it('rejects scheduled task without schedule config', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Daily check',
      description: 'Run daily',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_reviewer',
      task_type: 'scheduled',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('schedule');
  });
});

describe('task_list', () => {
  it('lists tasks with default filters', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.tasks[0].id).toBe('tsk_001');
  });

  it('passes filters through to context', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_list');
    await tool.execute({ status: 'review', project_id: 'proj_001' });
    expect(ctx.listTasks).toHaveBeenCalledWith(expect.objectContaining({
      status: 'review',
      projectId: 'proj_001',
    }));
  });
});

describe('task_get', () => {
  it('returns task details', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_get');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(result.status).toBe('success');
    expect(result.task.id).toBe('tsk_001');
  });

  it('returns error for missing task', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => null),
    });
    const tool = findTool(ctx, 'task_get');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_missing' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });
});

describe('task_update', () => {
  it('updates task status with a note', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'blocked',
      note: 'Waiting on API',
    }));
    expect(result.status).toBe('success');
    expect(ctx.updateTaskStatus).toHaveBeenCalledWith('tsk_001', 'blocked');
    expect(ctx.addTaskNote).toHaveBeenCalled();
  });

  it('denies worker from completing own task', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', assignedAgentId: 'agt_test',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'completed',
    }));
    expect(result.status).toBe('denied');
  });

  it('denies worker from setting review directly', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', assignedAgentId: 'agt_test',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'review',
    }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain('task_submit_review');
  });

  it('routes review→in_progress through requestRevision', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'Task 1', description: 'D', status: 'review',
        priority: 'medium', assignedAgentId: 'agt_other',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'in_progress',
      note: 'Needs more work',
    }));
    expect(result.status).toBe('success');
    expect(ctx.requestRevision).toHaveBeenCalledWith('tsk_001', 'Needs more work');
  });

  it('adds note-only update without status change', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      note: 'Progress update',
    }));
    expect(result.status).toBe('success');
    expect(ctx.addTaskNote).toHaveBeenCalled();
    expect(ctx.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('rejects empty update', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(result.status).toBe('error');
  });
});

describe('task_submit_review', () => {
  it('submits work for review successfully', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_submit_review');
    const result = JSON.parse(await tool.execute({
      summary: 'Implemented login page with OAuth support',
      deliverables: [{ type: 'file', reference: 'src/login.ts', summary: 'Login page' }],
    }));
    expect(result.status).toBe('success');
    expect(ctx.submitForReview).toHaveBeenCalled();
  });

  it('rejects empty summary', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_submit_review');
    const result = JSON.parse(await tool.execute({ summary: '' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('summary');
  });
});

describe('subtask tools', () => {
  it('creates a subtask', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'subtask_create');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', title: 'Research API' }));
    expect(result.status).toBe('success');
    expect(result.subtask.id).toBe('sub_001');
  });

  it('completes a subtask', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'subtask_complete');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', subtask_id: 'sub_001' }));
    expect(result.status).toBe('success');
  });

  it('rejects subtask_complete without subtask_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'subtask_complete');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('subtask_id');
  });

  it('lists subtasks with progress', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'subtask_list');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(result.status).toBe('success');
    expect(result.progress).toBe('1/2 completed');
  });
});

describe('requirement tools', () => {
  it('proposes a requirement', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_propose');
    const result = JSON.parse(await tool.execute({
      title: 'User auth',
      description: 'Implement user auth',
      project_id: 'proj_001',
    }));
    expect(result.status).toBe('success');
    expect(result.requirement.id).toBe('req_001');
  });

  it('lists requirements', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
  });

  it('gets a requirement by ID', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_get');
    const result = JSON.parse(await tool.execute({ requirement_id: 'req_001' }));
    expect(result.status).toBe('success');
    expect(result.requirement.id).toBe('req_001');
  });

  it('updates requirement fields', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_update');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      title: 'Updated title',
    }));
    expect(result.status).toBe('success');
    expect(ctx.updateRequirement).toHaveBeenCalled();
  });

  it('resubmits a rejected requirement', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_resubmit');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      description: 'Revised description',
    }));
    expect(result.status).toBe('success');
  });
});

describe('comment tools', () => {
  it('posts a task comment', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_comment');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      content: 'Looks good!',
      mentions: ['agt_other'],
    }));
    expect(result.status).toBe('success');
    expect(ctx.postTaskComment).toHaveBeenCalledWith('tsk_001', 'Looks good!', ['agt_other'], 'act_001');
  });

  it('rejects empty comment content', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_comment');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      content: '',
    }));
    expect(result.status).toBe('error');
  });

  it('posts a requirement comment', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_comment');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      content: 'Needs clarification',
    }));
    expect(result.status).toBe('success');
    expect(ctx.postRequirementComment).toHaveBeenCalled();
  });
});
