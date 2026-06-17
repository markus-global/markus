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
    expect(ctx.postTaskComment).toHaveBeenCalledWith('tsk_001', 'Looks good!', ['agt_other'], 'act_001', undefined);
  });

  it('posts a task comment with reply', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_comment');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      content: 'Replying',
      reply_to_comment_id: 'cmt_prev',
    }));
    expect(result.status).toBe('success');
    expect(result.message).toContain('replying to cmt_prev');
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

describe('task_note', () => {
  it('adds a note without changing status', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_note');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', note: 'Checkpoint reached' }));
    expect(result.status).toBe('success');
    expect(ctx.addTaskNote).toHaveBeenCalledWith('tsk_001', 'Checkpoint reached', 'Test Agent');
  });
});

describe('task_assign', () => {
  it('assigns a task to another agent', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_assign');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', agent_id: 'agt_worker' }));
    expect(result.status).toBe('success');
    expect(result.taskId).toBe('tsk_001');
    expect(ctx.assignTask).toHaveBeenCalledWith('tsk_001', 'agt_worker');
  });
});

describe('task_get extended', () => {
  it('truncates notes, deliverables, comments, and status history by default', async () => {
    const notes = Array.from({ length: 60 }, (_, i) => `note ${i}`);
    const deliverables = Array.from({ length: 25 }, (_, i) => ({ id: `d${i}` }));
    const comments = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, authorId: 'a', authorName: 'A', content: `c${i}`, createdAt: '2024-01-01',
    }));
    const history = Array.from({ length: 30 }, (_, i) => ({
      id: i, fromStatus: 'pending', toStatus: 'in_progress',
      changedById: null, changedByType: 'agent', changedByName: null, reason: null, createdAt: '2024-01-01',
    }));
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', notes, deliverables,
      })),
      getTaskComments: vi.fn(async () => comments),
      getStatusHistory: vi.fn(async () => history),
    });
    const tool = findTool(ctx, 'task_get');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(result.status).toBe('success');
    expect(result.task._notesTruncated).toBeDefined();
    expect(result.task._deliverablesTruncated).toBeDefined();
    expect(result.task._commentsTruncated).toBeDefined();
    expect(result.task._statusHistoryTruncated).toBeDefined();
  });

  it('returns full data when full=true', async () => {
    const notes = Array.from({ length: 60 }, (_, i) => `note ${i}`);
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', notes,
      })),
    });
    const tool = findTool(ctx, 'task_get');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', full: true }));
    expect(result.task.notes).toHaveLength(60);
    expect(result.task._notesTruncated).toBeUndefined();
  });
});

describe('task_create extended', () => {
  it('returns pending message for approval-gated tasks', async () => {
    const ctx = createMockContext({
      createTask: vi.fn(async (params) => ({
        id: 'tsk_pending',
        title: params.title,
        status: 'pending',
      })),
    });
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'Needs approval',
      description: 'Desc',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_reviewer',
    }));
    expect(result.status).toBe('pending');
    expect(result.message).toContain('awaiting approval');
  });
});

describe('task_update extended', () => {
  it('updates description and blocked_by as creator', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'Old', status: 'in_progress',
        priority: 'medium', assignedAgentId: 'agt_other', createdBy: 'agt_test',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      description: 'Updated desc',
      blocked_by: ['tsk_000'],
    }));
    expect(result.status).toBe('success');
    expect(ctx.updateTaskFields).toHaveBeenCalledWith('tsk_001', expect.objectContaining({
      description: 'Updated desc',
      blockedBy: ['tsk_000'],
    }));
  });

  it('denies blocked_by change from non-creator', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', createdBy: 'agt_other',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      blocked_by: ['tsk_000'],
    }));
    expect(result.status).toBe('denied');
  });

  it('cancels a pending task as creator', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'Pending task', description: 'D', status: 'pending',
        priority: 'medium', createdBy: 'agt_test',
      })),
      cancelPendingTask: vi.fn(async (id) => ({ id, title: 'Pending task', status: 'cancelled' })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'cancelled',
      note: 'No longer needed',
    }));
    expect(result.status).toBe('success');
    expect(ctx.cancelPendingTask).toHaveBeenCalledWith('tsk_001');
  });

  it('denies worker from cancelling own running task', async () => {
    const ctx = createMockContext({
      getTask: vi.fn(async () => ({
        id: 'tsk_001', title: 'T', description: 'D', status: 'in_progress',
        priority: 'medium', assignedAgentId: 'agt_test',
      })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'cancelled',
    }));
    expect(result.status).toBe('denied');
    expect(result.error).toContain('abort all ongoing work');
  });

  it('updates schedule config for scheduled tasks', async () => {
    const ctx = createMockContext({
      updateScheduleConfig: vi.fn(async (id) => ({ id, title: 'Scheduled', status: 'in_progress' })),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      schedule: { every: '2h', timezone: 'UTC' },
    }));
    expect(result.status).toBe('success');
    expect(ctx.updateScheduleConfig).toHaveBeenCalledWith('tsk_001', expect.objectContaining({ every: '2h' }));
  });
});

describe('task_submit_review extended', () => {
  it('parses deliverables from JSON string', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_submit_review');
    const result = JSON.parse(await tool.execute({
      summary: 'Done',
      deliverables: JSON.stringify([{ type: 'file', reference: '/out.md', summary: 'Output' }]),
    }));
    expect(result.status).toBe('success');
    expect(ctx.submitForReview).toHaveBeenCalledWith(
      'Done',
      expect.arrayContaining([expect.objectContaining({ reference: '/out.md' })]),
      undefined,
      undefined,
    );
  });

  it('returns helpful error when no active task', async () => {
    const ctx = createMockContext({
      submitForReview: vi.fn(async () => { throw new Error('No active task in context'); }),
    });
    const tool = findTool(ctx, 'task_submit_review');
    const result = JSON.parse(await tool.execute({ summary: 'Done' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('no active task');
  });
});

describe('requirement_update_status', () => {
  it('cancels a requirement with reason', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_update_status');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      status: 'cancelled',
      reason: 'Duplicate of req_002',
    }));
    expect(result.status).toBe('success');
    expect(ctx.updateRequirementStatus).toHaveBeenCalledWith('req_001', 'cancelled', 'Duplicate of req_002');
  });
});

describe('requirement_list extended', () => {
  it('truncates long result sets', async () => {
    const reqs = Array.from({ length: 60 }, (_, i) => ({
      id: `req_${i}`,
      title: `Req ${i}`,
      description: 'Desc',
      status: 'approved',
      priority: 'medium',
      source: 'agent',
      taskIds: [],
    }));
    const ctx = createMockContext({ listRequirements: vi.fn(async () => reqs) });
    const tool = findTool(ctx, 'requirement_list');
    const result = JSON.parse(await tool.execute({}));
    expect(result.total).toBe(60);
    expect(result._truncated).toBeDefined();
  });

  it('filters to mine_only requirements', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_list');
    await tool.execute({ mine_only: true });
    expect(ctx.listRequirements).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'agt_test' }));
  });
});

describe('requirement_get extended', () => {
  it('includes status history', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      id: i, fromStatus: 'pending', toStatus: 'approved',
      changedById: 'u1', changedByType: 'human', changedByName: 'Admin', reason: 'ok', createdAt: '2024-01-01',
    }));
    const ctx = createMockContext({ getStatusHistory: vi.fn(async () => history) });
    const tool = findTool(ctx, 'requirement_get');
    const result = JSON.parse(await tool.execute({ requirement_id: 'req_001' }));
    expect(result.status).toBe('success');
    expect(result.requirement._statusHistoryTruncated).toBeDefined();
  });

  it('returns error for missing requirement', async () => {
    const ctx = createMockContext({ getRequirement: vi.fn(async () => null) });
    const tool = findTool(ctx, 'requirement_get');
    const result = JSON.parse(await tool.execute({ requirement_id: 'req_missing' }));
    expect(result.status).toBe('error');
  });
});

describe('task tools error paths', () => {
  it('task_create returns error when createTask throws', async () => {
    const ctx = createMockContext({
      createTask: vi.fn(async () => { throw new Error('DB unavailable'); }),
    });
    const tool = findTool(ctx, 'task_create');
    const result = JSON.parse(await tool.execute({
      title: 'T',
      description: 'D',
      assigned_agent_id: 'agt_worker',
      reviewer_id: 'agt_reviewer',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('DB unavailable');
  });

  it('task_assign returns error when assignTask throws', async () => {
    const ctx = createMockContext({
      assignTask: vi.fn(async () => { throw new Error('Agent not found'); }),
    });
    const tool = findTool(ctx, 'task_assign');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', agent_id: 'agt_other' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Agent not found');
  });

  it('subtask_complete requires task_id and subtask_id', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'subtask_complete');
    const missingTask = JSON.parse(await tool.execute({ subtask_id: 'sub_001' }));
    expect(missingTask.status).toBe('error');
    expect(missingTask.error).toContain('task_id is required');

    const missingSub = JSON.parse(await tool.execute({ task_id: 'tsk_001' }));
    expect(missingSub.status).toBe('error');
    expect(missingSub.error).toContain('subtask_id is required');
  });

  it('requirement_propose returns error when proposeRequirement throws', async () => {
    const ctx = createMockContext({
      proposeRequirement: vi.fn(async () => { throw new Error('Project required'); }),
    });
    const tool = findTool(ctx, 'requirement_propose');
    const result = JSON.parse(await tool.execute({
      title: 'New feature',
      description: 'Details',
      project_id: 'proj_001',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Project required');
  });

  it('task_comment requires non-empty content', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'task_comment');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', content: '   ' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('content is required');
  });

  it('requirement_comment rejects empty content', async () => {
    const ctx = createMockContext();
    const tool = findTool(ctx, 'requirement_comment');
    const result = JSON.parse(await tool.execute({ requirement_id: 'req_001', content: '' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('content is required');
  });

  it('requirement_comment returns error when postRequirementComment throws', async () => {
    const ctx = createMockContext({
      postRequirementComment: vi.fn(async () => { throw new Error('Comment failed'); }),
    });
    const tool = findTool(ctx, 'requirement_comment');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      content: 'A comment',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Comment failed');
  });

  it('requirement_update_status returns error when update throws', async () => {
    const ctx = createMockContext({
      updateRequirementStatus: vi.fn(async () => { throw new Error('Status update denied'); }),
    });
    const tool = findTool(ctx, 'requirement_update_status');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      status: 'rejected',
      reason: 'Duplicate requirement',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Status update denied');
  });

  it('requirement_update returns error when updateRequirement throws', async () => {
    const ctx = createMockContext({
      updateRequirement: vi.fn(async () => { throw new Error('Update failed'); }),
    });
    const tool = findTool(ctx, 'requirement_update');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      title: 'Broken update',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Update failed');
  });

  it('task_update returns error when updateTaskStatus throws', async () => {
    const ctx = createMockContext({
      updateTaskStatus: vi.fn(async () => { throw new Error('Status update failed'); }),
    });
    const tool = findTool(ctx, 'task_update');
    const result = JSON.parse(await tool.execute({
      task_id: 'tsk_001',
      status: 'blocked',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Status update failed');
  });

  it('task_note returns error when addTaskNote throws', async () => {
    const ctx = createMockContext({
      addTaskNote: vi.fn(async () => { throw new Error('Note failed'); }),
    });
    const tool = findTool(ctx, 'task_note');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', note: 'Note' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Note failed');
  });

  it('task_comment returns error when postTaskComment throws', async () => {
    const ctx = createMockContext({
      postTaskComment: vi.fn(async () => { throw new Error('Post failed'); }),
    });
    const tool = findTool(ctx, 'task_comment');
    const result = JSON.parse(await tool.execute({ task_id: 'tsk_001', content: 'Note' }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Post failed');
  });

  it('requirement_resubmit returns error when resubmitRequirement throws', async () => {
    const ctx = createMockContext({
      resubmitRequirement: vi.fn(async () => { throw new Error('Resubmit denied'); }),
    });
    const tool = findTool(ctx, 'requirement_resubmit');
    const result = JSON.parse(await tool.execute({
      requirement_id: 'req_001',
      description: 'Updated',
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Resubmit denied');
  });
});
