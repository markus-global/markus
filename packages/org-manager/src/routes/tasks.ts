import type { TaskStatus, TaskPriority, TaskSortField, SortOrder } from '@markus/shared';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

export async function handleTasksRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    if (path === '/api/tasks' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const status = url.searchParams.get('status') as TaskStatus | undefined;
      const assignedAgentId = url.searchParams.get('assignedAgentId') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const requirementId = url.searchParams.get('requirementId') ?? undefined;
      const priority = url.searchParams.get('priority') as TaskPriority | undefined;
      const search = url.searchParams.get('search') ?? undefined;
      const sortBy = url.searchParams.get('sortBy') as TaskSortField | undefined;
      const sortOrder = url.searchParams.get('sortOrder') as SortOrder | undefined;
      const pageParam = url.searchParams.get('page');
      const pageSizeParam = url.searchParams.get('pageSize');
      const page = pageParam ? parseInt(pageParam, 10) : undefined;
      const pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : undefined;

      const result = server.taskService.queryTasks({
        orgId, status, assignedAgentId, projectId, requirementId,
        priority, search, sortBy, sortOrder, page, pageSize,
      });
      server.json(res, 200, result);
      return true;
    }

    if (path === '/api/tasks/scheduled' && req.method === 'GET') {
      const tasks = server.taskService.listScheduledTasks();
      server.json(res, 200, { tasks });
      return true;
    }

    if (path === '/api/tasks/deliverables' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      if (server.deliverableService) {
        const { results } = server.deliverableService.search({ projectId, limit: 500 });
        const grouped = new Map<string, { taskId: string; taskTitle: string; taskStatus: string; projectId?: string; requirementId?: string; assignedAgentId?: string; updatedAt?: string; deliverables: typeof results }>();
        for (const d of results) {
          if (!d.taskId) continue;
          if (!grouped.has(d.taskId)) {
            const task = server.taskService.getTask(d.taskId);
            grouped.set(d.taskId, {
              taskId: d.taskId,
              taskTitle: task?.title ?? '',
              taskStatus: task?.status ?? '',
              projectId: task?.projectId,
              requirementId: task?.requirementId,
              assignedAgentId: task?.assignedAgentId,
              updatedAt: task?.updatedAt,
              deliverables: [],
            });
          }
          grouped.get(d.taskId)!.deliverables.push(d);
        }
        server.json(res, 200, { items: [...grouped.values()] });
      } else {
        const all = server.taskService.listTasks({ projectId });
        const items = all
          .filter(t => t.deliverables && t.deliverables.length > 0)
          .map(t => ({
            taskId: t.id,
            taskTitle: t.title,
            taskStatus: t.status,
            projectId: t.projectId,
            requirementId: t.requirementId,
            assignedAgentId: t.assignedAgentId,
            updatedAt: t.updatedAt,
            deliverables: t.deliverables,
          }));
        server.json(res, 200, { items });
      }
      return true;
    }

    // ── Unified Deliverables CRUD ──────────────────────────────────────────

    if (path === '/api/tasks/dashboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const dashboard = server.taskService.getDashboard(orgId);
      server.json(res, 200, dashboard);
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/context$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.getTask(taskId);
        if (!task) {
          server.json(res, 404, { error: 'Task not found' });
          return true;
        }

        const result: Record<string, unknown> = {
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            subtasks: task.subtasks || [],
            notes: task.notes || [],
            deliverables: task.deliverables || [],
            completionSummary: task.completionSummary,
            assignedAgentId: task.assignedAgentId,
            reviewerId: task.reviewerId,
            executionRound: task.executionRound,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          upstream: [] as Array<Record<string, unknown>>,
          downstream: [] as Array<Record<string, unknown>>,
        };

        if (task.requirementId && server.requirementService) {
          try {
            const reqData = server.requirementService.getRequirement(task.requirementId);
            if (reqData) {
              result.requirement = {
                id: reqData.id,
                title: reqData.title,
                description: reqData.description,
                status: reqData.status,
              };
            }
          } catch { /* requirement may not exist */ }
        }

        if (task.projectId && server.projectService) {
          try {
            const project = server.projectService.getProject(task.projectId);
            if (project) {
              result.project = {
                id: project.id,
                name: project.name,
                description: project.description,
                repositories: project.repositories || [],
              };
            }
          } catch { /* project may not exist */ }
        }

        if (task.blockedBy && task.blockedBy.length > 0) {
          for (const depId of task.blockedBy) {
            try {
              const dep = server.taskService.getTask(depId);
              if (dep) {
                (result.upstream as Array<Record<string, unknown>>).push({
                  id: dep.id,
                  title: dep.title,
                  status: dep.status,
                  notes: dep.notes,
                  completionSummary: dep.completionSummary,
                  deliverables: dep.deliverables,
                });
              }
            } catch { /* dep may not exist */ }
          }
        }

        try {
          const allTasks = server.taskService.queryTasks({ orgId: task.orgId });
          const downstream = allTasks.tasks.filter(t =>
            t.blockedBy && t.blockedBy.includes(task.id),
          );
          result.downstream = downstream.map(t => ({
            id: t.id,
            title: t.title,
            status: t.status,
          }));
        } catch { /* ignore */ }

        server.json(res, 200, result);
      } catch {
        server.json(res, 500, { error: 'Failed to fetch task context' });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const task = server.taskService.getTask(taskId);
      if (!task) {
        server.json(res, 404, { error: `Task not found: ${taskId}` });
        return true;
      }
      server.json(res, 200, { task });
      return true;
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const body = await server.readBody(req);
      const assignedAgentId = (body['assignedAgentId'] as string | undefined)?.trim();
      const reviewerId = (body['reviewerId'] as string | undefined)?.trim();
      const reviewerType = (body['reviewerType'] as string | undefined) === 'human' ? 'human' as const : 'agent' as const;
      if (!assignedAgentId || !reviewerId) {
        server.json(res, 400, { error: 'assignedAgentId and reviewerId are required' });
        return true;
      }
      const agentMgr = server.orgService.getAgentManager();
      if (!agentMgr.hasAgent(assignedAgentId)) {
        server.json(res, 400, { error: `Assigned agent not found: ${assignedAgentId}` });
        return true;
      }
      if (reviewerType !== 'human' && !agentMgr.hasAgent(reviewerId)) {
        server.json(res, 400, { error: `Reviewer agent not found: ${reviewerId}` });
        return true;
      }
      const scheduleRaw = body['scheduleConfig'] as Record<string, unknown> | undefined;
      let task: ReturnType<typeof server.taskService.createTask>;
      try {
        task = server.taskService.createTask({
          orgId: (body['orgId'] as string) ?? 'default',
          title: body['title'] as string,
          description: body['description'] as string,
          priority: body['priority'] as TaskPriority | undefined,
          assignedAgentId,
          reviewerId,
          reviewerType,
          projectId: body['projectId'] as string | undefined,
          blockedBy: Array.isArray(body['blockedBy']) ? body['blockedBy'] as string[] : undefined,
          requirementId: body['requirementId'] as string | undefined,
          createdBy: authUser?.userId ?? 'unknown',
          creatorRole: 'human',
          taskType: ((body['taskType'] as string | undefined) ?? 'standard') as 'standard' | 'scheduled',
          scheduleConfig: scheduleRaw ? {
            cron: scheduleRaw['cron'] as string | undefined,
            every: scheduleRaw['every'] as string | undefined,
            runAt: scheduleRaw['runAt'] as string | undefined,
            timezone: scheduleRaw['timezone'] as string | undefined,
            maxRuns: scheduleRaw['maxRuns'] as number | undefined,
          } : undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        let code = 'unknown';
        if (msg.includes('task cap reached') || msg.includes('active task cap')) code = 'task_limit_reached';
        else if (msg.includes('must reference an approved requirement')) code = 'requirement_required';
        else if (msg.includes('agent not found')) code = 'agent_not_found';
        server.json(res, 400, { error: msg, code });
        return true;
      }
      server.auditService?.record({
        orgId: task.orgId,
        type: 'task_created',
        action: 'create_task',
        detail: `Task "${task.title}" created`,
        userId: authUser?.userId,
        agentId: task.assignedAgentId,
        taskId: task.id,
        projectId: task.projectId,
        success: true,
        metadata: { reviewerId: task.reviewerId, requirementId: task.requirementId },
      });
      server.json(res, 201, { task });
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      const body = await server.readBody(req);

      if (body['status']) {
        const task = server.taskService.updateTaskStatus(taskId, body['status'] as TaskStatus, authUser?.userId);
        server.json(res, 200, { task });
        return true;
      }

      if ('assignedAgentId' in body) {
        const agentId = body['assignedAgentId'] as string | null;
        if (agentId) {
          const task = server.taskService.assignTask(taskId, agentId, authUser?.userId);
          server.json(res, 200, { task });
        } else {
          server.json(res, 400, { error: 'assignedAgentId is required — tasks must always have an assignee' });
        }
        return true;
      }

      // General field update (title/description/priority/projectId/requirementId/blockedBy/reviewerId/reviewerType)
      if (
        body['title'] !== undefined ||
        body['description'] !== undefined ||
        body['priority'] !== undefined ||
        body['projectId'] !== undefined ||
        body['requirementId'] !== undefined ||
        body['blockedBy'] !== undefined ||
        body['reviewerId'] !== undefined ||
        body['reviewerType'] !== undefined
      ) {
        const task = server.taskService.updateTask(taskId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
          projectId: body['projectId'] !== undefined ? (body['projectId'] as string | null) : undefined,
          requirementId: body['requirementId'] !== undefined ? (body['requirementId'] as string | null) : undefined,
          blockedBy: Array.isArray(body['blockedBy']) ? body['blockedBy'] as string[] : undefined,
          reviewerId: body['reviewerId'] as string | undefined,
          reviewerType: body['reviewerType'] as 'agent' | 'human' | undefined,
        }, authUser?.userId);
        server.json(res, 200, { task });
        return true;
      }

      server.json(res, 400, { error: 'Provide status, assignedAgentId, or task fields to update' });
      return true;
    }

    // Task approve/reject — the only way to transition out of pending.
    // If the UI changed the assignee before approving, that's already on the task object.
    if (path.match(/^\/api\/tasks\/[^/]+\/approve$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const body = await server.readBody(req).catch(() => ({} as Record<string, unknown>));
        const runNow = body['runNow'] === true;
        const task = server.taskService.approveTask(taskId, authUser?.userId, runNow);
        server.auditService?.record({
          orgId: task.orgId,
          type: 'task_approval_granted',
          action: 'approve_task',
          detail: `Task "${task.title}" approved`,
          userId: authUser?.userId,
          agentId: task.assignedAgentId,
          taskId: task.id,
          projectId: task.projectId,
          success: true,
        });
        server.json(res, 200, { task });
      } catch (err: unknown) {
        server.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/reject$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.rejectTask(taskId, authUser?.userId);
        server.auditService?.record({
          orgId: task.orgId,
          type: 'task_approval_rejected',
          action: 'reject_task',
          detail: `Task "${task.title}" rejected`,
          userId: authUser?.userId,
          agentId: task.assignedAgentId,
          taskId: task.id,
          projectId: task.projectId,
          success: true,
        });
        server.json(res, 200, { task });
      } catch (err: unknown) {
        server.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/cancel$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      const body = await server.readBody(req);
      const cascade = body['cascade'] === true;
      try {
        const task = server.taskService.cancelTask(taskId, cascade, authUser?.userId, 'human');
        server.auditService?.record({
          orgId: task.orgId,
          type: 'task_cancelled',
          action: 'cancel_task',
          detail: `Task "${task.title}" cancelled`,
          userId: authUser?.userId,
          agentId: task.assignedAgentId,
          taskId: task.id,
          projectId: task.projectId,
          success: true,
          metadata: { cascade },
        });
        server.json(res, 200, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/dependents$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const count = server.taskService.getDependentTaskCount(taskId);
      server.json(res, 200, { count });
      return true;
    }

    if (path.startsWith('/api/tasks/') && req.method === 'DELETE' && !path.includes('/subtasks/')) {
      server.json(res, 400, { error: 'Tasks cannot be deleted — use cancel instead to preserve audit trail' });
      return true;
    }

    // Subtasks (embedded within a task)
    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const task = server.taskService.getTask(taskId);
      if (!task) { server.json(res, 404, { error: 'Task not found' }); return true; }
      server.json(res, 200, { subtasks: task.subtasks });
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const body = await server.readBody(req);
      const taskId = path.split('/')[3]!;
      const subtask = server.taskService.addSubtask(taskId, body['title'] as string);
      server.json(res, 201, { subtask });
      return true;
    }

    // Complete/cancel a specific subtask
    const subtaskActionMatch = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/(complete|cancel)$/);
    if (subtaskActionMatch && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = subtaskActionMatch[1]!;
      const subtaskId = subtaskActionMatch[2]!;
      const action = subtaskActionMatch[3]!;
      const sub = action === 'complete'
        ? server.taskService.completeSubtask(taskId, subtaskId)
        : server.taskService.cancelSubtask(taskId, subtaskId);
      server.json(res, 200, { subtask: sub });
      return true;
    }

    // Delete a specific subtask
    const subtaskDeleteMatch = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)$/);
    if (subtaskDeleteMatch && req.method === 'DELETE') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = subtaskDeleteMatch[1]!;
      const subtaskId = subtaskDeleteMatch[2]!;
      server.taskService.deleteSubtask(taskId, subtaskId);
      server.json(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/taskboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const board = server.taskService.getTaskBoard(orgId, { projectId });
      server.json(res, 200, { board });
      return true;
    }

    // Comprehensive operations dashboard
    if (path === '/api/ops/dashboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const period = (url.searchParams.get('period') ?? '24h') as '1h' | '24h' | '7d';
      const opsDashboard = server.buildOpsDashboard(orgId, period);
      server.json(res, 200, opsDashboard);
      return true;
    }

    // Task execution: run a task with its assigned agent (fire-and-forget)
    if (path.match(/^\/api\/tasks\/[^/]+\/run$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.getTask(taskId);
        if (!task) { server.json(res, 404, { error: 'Task not found' }); return true; }
        if (task.status !== 'in_progress') {
          server.json(res, 400, { error: `Cannot run task in ${task.status} status — must be in_progress` });
          return true;
        }
        await server.taskService.runTask(taskId);
        server.json(res, 202, { status: 'running', taskId });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Unified execution stream logs
    if (path === '/api/execution-logs' && req.method === 'GET') {
      const sourceType = url.searchParams.get('sourceType');
      const sourceId = url.searchParams.get('sourceId');
      if (!sourceType || !sourceId) {
        server.json(res, 400, { error: 'sourceType and sourceId required' });
        return true;
      }
      if (!server.storage?.executionStreamRepo) {
        server.json(res, 200, { logs: [] });
        return true;
      }
      try {
        const logs = server.storage.executionStreamRepo.getBySource(sourceType, sourceId);
        server.json(res, 200, { logs });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task execution logs — rounds summary (lightweight metadata only)
    if (path.match(/^\/api\/tasks\/[^/]+\/logs\/summary$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!server.storage) {
        server.json(res, 200, { rounds: [] });
        return true;
      }
      try {
        const rounds = server.storage.taskLogRepo.getRoundsSummary(taskId);
        server.json(res, 200, { rounds });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task execution logs — optionally filtered by round
    if (path.match(/^\/api\/tasks\/[^/]+\/logs$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!server.storage) {
        server.json(res, 200, { logs: [] });
        return true;
      }
      try {
        const roundParam = url.searchParams.get('round');
        const logs = roundParam
          ? server.storage.taskLogRepo.getByTaskRound(taskId, parseInt(roundParam, 10))
          : await server.storage.taskLogRepo.getByTask(taskId);
        server.json(res, 200, { logs });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task comments — add a comment (text + optional image attachments + @mentions)
    if (path.match(/^\/api\/tasks\/[^/]+\/comments$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const body = await server.readBody(req);
        const mentions = (body['mentions'] as string[] | undefined) ?? [];
        let resolvedAuthorName = (body['authorName'] as string | undefined);
        if (!resolvedAuthorName && authUser?.userId && server.storage?.userRepo) {
          const userRow = await server.storage.userRepo.findById(authUser.userId);
          resolvedAuthorName = userRow?.name;
        }
        const authorId = (body['authorId'] as string) ?? authUser?.userId ?? 'human';
        const authorName = resolvedAuthorName ?? 'User';
        // Single entry point: DB write + WS broadcast + inject into running task + agent notifications
        const result = await server.taskService.postTaskComment(
          taskId, authorId, authorName,
          body['content'] as string,
          mentions, undefined,
          { authorType: (body['authorType'] as string) ?? 'human', attachments: body['attachments'] as unknown[] | undefined, replyToId: body['replyTo'] as string | undefined },
        );
        server.json(res, 201, { comment: result.comment });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task comments — list comments for a task
    if (path.match(/^\/api\/tasks\/[^/]+\/comments$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!server.storage?.taskCommentRepo) {
        server.json(res, 200, { comments: [] });
        return true;
      }
      try {
        const comments = await server.storage.taskCommentRepo.getByTask(taskId);
        server.json(res, 200, { comments });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task status history — list all status transitions for a task
    if (path.match(/^\/api\/tasks\/[^/]+\/history$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      try {
        const history = server.taskService.getTaskStatusHistory(taskId);
        server.json(res, 200, { history });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Task pause — explicitly pause a running task
    if (path.match(/^\/api\/tasks\/[^/]+\/pause$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        server.taskService.pauseTask(taskId, authUser.userId, 'human');
        server.json(res, 200, { status: 'blocked' as TaskStatus, taskId });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Task resume — resume a paused (blocked) task.
    // Transition blocked → in_progress via updateTaskStatus; the auto-start
    // side effect in handleTransitionSideEffects will schedule runTask.
    if (path.match(/^\/api\/tasks\/[^/]+\/resume$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        server.taskService.resumeTask(taskId, authUser.userId, 'human');
        server.json(res, 202, { status: 'running', taskId });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Task retry fresh — discard previous execution, start clean
    if (path.match(/^\/api\/tasks\/[^/]+\/retry$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const task = await server.taskService.retryTaskFresh(taskId);
        server.json(res, 202, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }
  return false;
}
