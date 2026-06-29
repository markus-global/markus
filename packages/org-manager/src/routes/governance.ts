
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

export async function handleGovernanceRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    // ── Requirements ─────────────────────────────────────────────────────

    if (path === '/api/requirements' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const status = url.searchParams.get('status') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      if (!server.requirementService) {
        server.json(res, 200, { requirements: [] });
        return true;
      }
      server.json(res, 200, {
        requirements: server.requirementService.listRequirements({
          orgId,
          status: status as any,
          source: source as any,
          projectId,
        }),
      });
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'GET') {
      const reqId = path.split('/')[3]!;
      const requirement = server.requirementService?.getRequirement(reqId);
      if (!requirement) {
        server.json(res, 404, { error: 'Requirement not found' });
        return true;
      }
      server.json(res, 200, { requirement });
      return true;
    }

    if (path === '/api/requirements' && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const body = await server.readBody(req);
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      const title = (body['title'] as string | undefined)?.trim();
      const description = (body['description'] as string | undefined)?.trim();
      const projectId = body['projectId'] as string | undefined;
      if (!title) { server.json(res, 400, { error: 'Title is required' }); return true; }
      if (!description) { server.json(res, 400, { error: 'Description is required' }); return true; }
      if (!projectId) { server.json(res, 400, { error: 'Project is required' }); return true; }
      if (!authUser?.userId) { server.json(res, 400, { error: 'Creator identity is required' }); return true; }
      try {
        const requirement = server.requirementService.createRequirement({
          orgId: (body['orgId'] as string) ?? 'default',
          title,
          description,
          priority: body['priority'] as TaskPriority | undefined,
          projectId,
          source: 'user',
          createdBy: authUser.userId,
          tags: body['tags'] as string[] | undefined,
        });
        server.json(res, 201, { requirement });
      } catch (e) {
        server.json(res, 400, { error: String(e).replace('Error: ', '') });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'PUT') {
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      const body = await server.readBody(req);
      try {
        const requirement = server.requirementService.updateRequirement(reqId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
          tags: body['tags'] as string[] | undefined,
        });
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 404, { error: String(e) });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/status$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      const body = await server.readBody(req);
      try {
        const requirement = server.requirementService.updateRequirementStatus(
          reqId,
          body['status'] as string as RequirementStatus,
          authUser.userId
        );
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 400, { error: String(e) });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/approve$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      try {
        const requirement = server.requirementService.approveRequirement(
          reqId,
          authUser.userId
        );
        server.auditService?.record({
          orgId: requirement.orgId,
          type: 'requirement_approved',
          action: 'approve_requirement',
          detail: `Requirement "${requirement.title}" approved`,
          userId: authUser?.userId,
          success: true,
          metadata: { requirementId: reqId, projectId: requirement.projectId },
        });
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 400, { error: String(e) });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/reject$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      const body = await server.readBody(req);
      try {
        const requirement = server.requirementService.rejectRequirement(
          reqId,
          authUser.userId,
          (body['reason'] as string) ?? ''
        );
        server.auditService?.record({
          orgId: requirement.orgId,
          type: 'requirement_rejected',
          action: 'reject_requirement',
          detail: `Requirement "${requirement.title}" rejected`,
          userId: authUser?.userId,
          success: true,
          metadata: { requirementId: reqId, reason: (body['reason'] as string) ?? '' },
        });
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 400, { error: String(e) });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/cancel$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      try {
        const requirement = server.requirementService.cancelRequirement(reqId);
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 404, { error: String(e) });
      }
      return true;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
      if (!server.requirementService) {
        server.json(res, 503, { error: 'Requirement service not available' });
        return true;
      }
      try {
        const requirement = server.requirementService.cancelRequirement(reqId);
        server.json(res, 200, { requirement });
      } catch (e) {
        server.json(res, 404, { error: String(e) });
      }
      return true;
    }

    // ── Requirement Comments ──────────────────────────────────────────────

    if (path.match(/^\/api\/requirements\/[^/]+\/comments$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const reqId = path.split('/')[3]!;
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
        // Single entry point: DB write + WS broadcast + agent notifications
        const result = await server.taskService.postRequirementComment(
          reqId, authorId, authorName,
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

    if (path.match(/^\/api\/requirements\/[^/]+\/comments$/) && req.method === 'GET') {
      const reqId = path.split('/')[3]!;
      if (!server.storage?.requirementCommentRepo) {
        server.json(res, 200, { comments: [] });
        return true;
      }
      try {
        const comments = await server.storage.requirementCommentRepo.getByRequirement(reqId);
        server.json(res, 200, { comments });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // Requirement status history — list all status transitions for a requirement
    if (path.match(/^\/api\/requirements\/[^/]+\/history$/) && req.method === 'GET') {
      const reqId = path.split('/')[3]!;
      try {
        const history = server.requirementService?.getRequirementStatusHistory(reqId) ?? [];
        server.json(res, 200, { history });
      } catch (err) {
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Governance: Projects ──────────────────────────────────────────────

    if (path === '/api/projects' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      server.json(res, 200, { projects: server.projectService?.listProjects(orgId) ?? [] });
      return true;
    }

    if (path === '/api/projects' && req.method === 'POST') {
      if (!server.projectService) {
        server.json(res, 503, { error: 'Project service not available' });
        return true;
      }
      const body = await server.readBody(req);
      const authUser = await server.getAuthUser(req);
      const project = server.projectService.createProject({
        orgId: (body['orgId'] as string) ?? 'default',
        name: body['name'] as string,
        description: (body['description'] as string) ?? '',
        repositories: body['repositories'] as any,
        teamIds: body['teamIds'] as any,
        governancePolicy: body['governancePolicy'] as any,
        createdBy: authUser?.userId,
      });
      server.auditService?.record({
        orgId: project.orgId,
        type: 'project_created',
        action: 'create_project',
        detail: `Project "${project.name}" created`,
        userId: authUser?.userId,
        success: true,
        metadata: { projectId: project.id },
      });
      server.json(res, 201, { project });
      return true;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'GET') {
      const projectId = path.split('/')[3]!;
      const project = server.projectService?.getProject(projectId);
      if (!project) {
        server.json(res, 404, { error: 'Project not found' });
        return true;
      }
      server.json(res, 200, { project });
      return true;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'PUT') {
      if (!server.projectService) {
        server.json(res, 503, { error: 'Project service not available' });
        return true;
      }
      const projectId = path.split('/')[3]!;
      const body = await server.readBody(req);
      try {
        const project = server.projectService.updateProject(projectId, body as any);
        server.json(res, 200, { project });
      } catch (err) {
        server.json(res, 404, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'DELETE') {
      if (!server.projectService) {
        server.json(res, 503, { error: 'Project service not available' });
        return true;
      }
      const projectId = path.split('/')[3]!;
      server.projectService.deleteProject(projectId);
      server.json(res, 200, { deleted: true });
      return true;
    }

    // ── Governance: Task Review ───────────────────────────────────────────

    if (path.match(/^\/api\/tasks\/[^/]+\/accept$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const authUser = await server.getAuthUser(req);
        const body = await server.readBody(req);
        const reviewerId = (body['reviewerId'] as string | undefined) ?? authUser?.userId ?? 'human';
        const task = server.taskService.acceptTask(taskId, reviewerId);
        server.json(res, 200, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/revision$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      const authUser = await server.getAuthUser(req);
      const body = await server.readBody(req);
      try {
        const task = await server.taskService.requestRevision(
          taskId,
          (body['reason'] as string) ?? 'Revisions needed',
          authUser?.userId
        );
        server.json(res, 200, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/archive$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.archiveTask(taskId);
        server.json(res, 200, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // ── Governance: Schedule Control ──────────────────────────────────────

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/pause$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.getTask(taskId);
        if (!task) { server.json(res, 404, { error: 'Task not found' }); return true; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          server.json(res, 400, { error: 'Task is not a scheduled task' }); return true;
        }
        await server.taskService.updateScheduleConfig(taskId, { ...task.scheduleConfig, paused: true });
        server.json(res, 200, { task: { ...task, scheduleConfig: { ...task.scheduleConfig, paused: true } } });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/resume$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.getTask(taskId);
        if (!task) { server.json(res, 404, { error: 'Task not found' }); return true; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          server.json(res, 400, { error: 'Task is not a scheduled task' }); return true;
        }
        if (['archived', 'rejected'].includes(task.status)) {
          server.json(res, 400, { error: `Cannot resume schedule for ${task.status} task` }); return true;
        }
        const updated = { ...task.scheduleConfig, paused: false };
        await server.taskService.updateScheduleConfig(taskId, updated);
        server.json(res, 200, { task: { ...task, scheduleConfig: updated } });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/run-now$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = server.taskService.getTask(taskId);
        if (!task) { server.json(res, 404, { error: 'Task not found' }); return true; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          server.json(res, 400, { error: 'Task is not a scheduled task' }); return true;
        }
        if (task.status === 'in_progress') {
          server.json(res, 400, { error: 'Task is already running' }); return true;
        }
        if (task.status === 'review') {
          server.json(res, 400, { error: 'Task is awaiting review. Accept or reject before running again.' }); return true;
        }
        if (task.status === 'blocked') {
          server.json(res, 400, { error: 'Task is blocked by dependencies' }); return true;
        }
        if (task.status === 'pending') {
          server.json(res, 400, { error: 'Task is awaiting approval' }); return true;
        }
        if (['rejected', 'archived'].includes(task.status)) {
          server.json(res, 400, { error: `Cannot run task in ${task.status} status` }); return true;
        }
        await server.taskService.advanceScheduleConfig(taskId);
        const resettable = ['completed', 'cancelled', 'failed'];
        if (resettable.includes(task.status)) {
          await server.taskService.resetTaskForRerun(taskId);
        } else {
          await server.taskService.runTask(taskId);
        }
        server.json(res, 202, { status: 'running', taskId });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const taskId = path.split('/')[3]!;
      try {
        const body = await server.readBody(req);
        const task = await server.taskService.updateScheduleFields(taskId, {
          every: body['every'] as string | undefined,
          cron: body['cron'] as string | undefined,
          maxRuns: body['maxRuns'] !== null && body['maxRuns'] !== undefined ? Number(body['maxRuns']) : undefined,
          timezone: body['timezone'] as string | undefined,
        });
        server.json(res, 200, { task });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // ── Governance: Governance Policy ─────────────────────────────────────

    if (path === '/api/governance/policy' && req.method === 'GET') {
      server.json(res, 200, { policy: server.taskService.getGovernancePolicy() });
      return true;
    }

    if (path === '/api/governance/policy' && req.method === 'PUT') {
      const body = await server.readBody(req);
      server.taskService.setGovernancePolicy(body as any);
      server.json(res, 200, { policy: server.taskService.getGovernancePolicy() });
      return true;
    }

    // ── Governance: Reports ───────────────────────────────────────────────

    if (path === '/api/reports' && req.method === 'GET') {
      server.json(res, 200, {
        reports:
          server.reportService?.listReports({
            scope: url.searchParams.get('scope') ?? undefined,
            scopeId: url.searchParams.get('scopeId') ?? undefined,
            type: url.searchParams.get('type') ?? undefined,
          }) ?? [],
      });
      return true;
    }

    if (path === '/api/reports/generate' && req.method === 'POST') {
      if (!server.reportService) {
        server.json(res, 503, { error: 'Report service not available' });
        return true;
      }
      const body = await server.readBody(req);
      const period = (body['period'] as string) ?? (body['type'] as string) ?? 'weekly';
      const scope = (body['scope'] as string) ?? 'org';
      const scopeId = (body['orgId'] as string) ?? (body['scopeId'] as string) ?? 'default';

      const now = new Date();
      let periodStart: Date;
      if (body['periodStart']) {
        periodStart = new Date(body['periodStart'] as string);
      } else {
        switch (period) {
          case 'daily': {
            periodStart = new Date(now);
            periodStart.setHours(0, 0, 0, 0);
            break;
          }
          case 'monthly': {
            periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
          }
          default: {
            periodStart = new Date(now.getTime() - 7 * 86400000);
            break;
          }
        }
      }
      const periodEnd = body['periodEnd'] ? new Date(body['periodEnd'] as string) : now;

      const report = await server.reportService.generateReport({
        type: period as any,
        scope: scope as any,
        scopeId,
        periodStart,
        periodEnd,
        includePlan: body['includePlan'] as boolean,
      });
      server.json(res, 200, { report });
      return true;
    }

    if (path.match(/^\/api\/reports\/[^/]+$/) && req.method === 'GET') {
      const reportId = path.split('/')[3]!;
      const report = server.reportService?.getReport(reportId);
      if (!report) {
        server.json(res, 404, { error: 'Report not found' });
        return true;
      }
      server.json(res, 200, { report });
      return true;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/plan\/approve$/) && req.method === 'POST') {
      if (!server.reportService) {
        server.json(res, 503, { error: 'Report service not available' });
        return true;
      }
      const reportId = path.split('/')[3]!;
      const body = await server.readBody(req);
      try {
        const report = server.reportService.approvePlan(
          reportId,
          (body['userId'] as string) ?? 'human'
        );
        server.json(res, 200, { report });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/plan\/reject$/) && req.method === 'POST') {
      if (!server.reportService) {
        server.json(res, 503, { error: 'Report service not available' });
        return true;
      }
      const reportId = path.split('/')[3]!;
      const body = await server.readBody(req);
      try {
        const report = server.reportService.rejectPlan(
          reportId,
          (body['userId'] as string) ?? 'human',
          (body['reason'] as string) ?? ''
        );
        server.json(res, 200, { report });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/feedback$/) && req.method === 'POST') {
      if (!server.reportService) {
        server.json(res, 503, { error: 'Report service not available' });
        return true;
      }
      const reportId = path.split('/')[3]!;
      const body = await server.readBody(req);
      const feedback = server.reportService.addFeedback({
        reportId,
        authorId: (body['authorId'] as string) ?? 'human',
        authorName: (body['authorName'] as string) ?? 'Human Manager',
        type: (body['type'] as any) ?? 'comment',
        content: body['content'] as string,
        priority: body['priority'] as any,
        anchor: body['anchor'] as any,
        disclosure: (body['disclosure'] as any) ?? { scope: 'broadcast' },
        saveToKnowledge: body['saveToKnowledge'] as boolean,
        projectId: body['projectId'] as string,
      });
      server.json(res, 201, { feedback });
      return true;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/feedback$/) && req.method === 'GET') {
      const reportId = path.split('/')[3]!;
      server.json(res, 200, { feedback: server.reportService?.getFeedback(reportId) ?? [] });
      return true;
    }
  return false;
}
