import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskContextResponse } from '@markus/shared';
import {
  AGENT_A,
  PROJECT_1,
  REQ_1,
  REVIEWER,
  createTestServer,
  request,
  type TestContext,
} from './api-server-test-helpers.js';

describe('GET /api/tasks/:id/context', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  it('returns 404 when task does not exist', async () => {
    const res = await request(ctx.server, 'GET', '/api/tasks/nonexistent/context');
    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/not found/i);
  });

  it('returns TaskContextResponse shape with task, requirement, project, and dependencies', async () => {
    const upstream = ctx.taskService.createTask({
      orgId: 'default',
      title: 'Upstream Task',
      description: 'Blocks downstream',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
    });
    const upstreamTask = ctx.taskService.getTask(upstream.id)!;
    upstreamTask.notes = ['upstream note'];
    upstreamTask.completionSummary = 'Done upstream';
    ctx.taskService.updateTaskStatus(upstream.id, 'review');
    ctx.taskService.updateTaskStatus(upstream.id, 'completed');

    const task = ctx.taskService.createTask({
      orgId: 'default',
      title: 'Main Task',
      description: 'Implement feature',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
      projectId: PROJECT_1,
      requirementId: REQ_1,
      blockedBy: [upstream.id],
    });
    const mainTask = ctx.taskService.getTask(task.id)!;
    mainTask.notes = ['working on it'];
    ctx.taskService.addSubtask(task.id, 'Step 1');
    const subtask = ctx.taskService.getTask(task.id)!.subtasks[0]!;

    const downstream = ctx.taskService.createTask({
      orgId: 'default',
      title: 'Downstream Task',
      description: 'Depends on main',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
      blockedBy: [task.id],
    });

    const res = await request(ctx.server, 'GET', `/api/tasks/${task.id}/context`);
    expect(res.status).toBe(200);

    const body = res.json as TaskContextResponse;
    expect(body.task).toMatchObject({
      id: task.id,
      title: 'Main Task',
      description: 'Implement feature',
      status: task.status,
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
    });
    expect(body.task.subtasks).toHaveLength(1);
    expect(body.task.subtasks[0]).toMatchObject({ id: subtask.id, title: 'Step 1', status: 'pending' });
    expect(body.task.notes).toEqual(['working on it']);

    expect(body.requirement).toMatchObject({
      id: REQ_1,
      title: 'Req One',
    });

    expect(body.project).toMatchObject({
      id: PROJECT_1,
      name: 'Project One',
    });

    expect(body.upstream).toHaveLength(1);
    expect(body.upstream[0]).toMatchObject({
      id: upstream.id,
      title: 'Upstream Task',
      status: 'completed',
      completionSummary: 'Done upstream',
      notes: ['upstream note'],
    });

    expect(body.downstream).toHaveLength(1);
    expect(body.downstream[0]).toMatchObject({
      id: downstream.id,
      title: 'Downstream Task',
      status: downstream.status,
    });
  });

  it('returns empty upstream/downstream when task has no dependencies', async () => {
    const task = ctx.taskService.createTask({
      orgId: 'default',
      title: 'Standalone Task',
      description: 'No deps',
      assignedAgentId: AGENT_A,
      reviewerId: REVIEWER,
    });

    const res = await request(ctx.server, 'GET', `/api/tasks/${task.id}/context`);
    expect(res.status).toBe(200);

    const body = res.json as TaskContextResponse;
    expect(body.task.id).toBe(task.id);
    expect(body.upstream).toEqual([]);
    expect(body.downstream).toEqual([]);
    expect(body.requirement).toBeUndefined();
    expect(body.project).toBeUndefined();
  });
});
