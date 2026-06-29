import { GatewayError, generateHandbook, type HandbookColleague, type HandbookProject } from '@markus/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

export async function handleGatewayRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    // ── External Agent Gateway ──────────────────────────────────────────────
    if (path === '/api/gateway/info' && req.method === 'GET') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      if (authUser.role !== 'admin') {
        server.json(res, 403, { error: 'Admin access required' });
        return true;
      }
      const host = req.headers['host'] ?? `localhost:${server.port}`;
      const proto = req.headers['x-forwarded-proto'] ?? 'http';
      const gatewayUrl = `${proto}://${host}/api/gateway`;
      const secret = server.gatewaySecret ?? '';
      const masked = secret.length > 8
        ? secret.slice(0, 4) + '*'.repeat(secret.length - 8) + secret.slice(-4)
        : secret;
      server.json(res, 200, {
        gatewayUrl,
        orgId: 'default',
        orgSecret: masked,
        orgSecretFull: secret,
        enabled: !!server.gateway,
      });
      return true;
    }

    if (path === '/api/gateway/register' && req.method === 'POST') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const body = await server.readBody(req);
      try {
        const reg = await server.gateway.register({
          externalAgentId: body['agentId'] as string,
          agentName: body['agentName'] as string,
          orgId: body['orgId'] as string,
          capabilities: (body['capabilities'] as string[]) ?? [],
          platform: body['platform'] as string | undefined,
          platformConfig: body['platformConfig'] as string | undefined,
          agentCardUrl: body['agentCardUrl'] as string | undefined,
          openClawConfig: body['openClawConfig'] as string | undefined,
        });
        server.json(res, 201, reg);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    if (path === '/api/gateway/auth' && req.method === 'POST') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const body = await server.readBody(req);
      try {
        const result = server.gateway.authenticate({
          externalAgentId: body['agentId'] as string,
          orgId: body['orgId'] as string,
          secret: body['secret'] as string,
        });
        server.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    if (path === '/api/gateway/message' && req.method === 'POST') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        server.json(res, 401, { error: 'Missing Bearer token' });
        return true;
      }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const body = await server.readBody(req);
        const result = await server.gateway.routeMessage(token, {
          type: body['type'] as 'task' | 'status' | 'heartbeat',
          content: body['content'] as string,
          metadata: body['metadata'] as Record<string, unknown> | undefined,
        });
        server.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    if (path === '/api/gateway/status' && req.method === 'GET') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        server.json(res, 401, { error: 'Missing Bearer token' });
        return true;
      }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const status = server.gateway.getStatus(token);
        server.json(res, 200, status);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Manual / Handbook ──────────────────────────────────────────
    if (path === '/api/gateway/manual' && req.method === 'GET') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        server.json(res, 401, { error: 'Missing Bearer token' });
        return true;
      }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const reg = server.gateway.listRegistrations(token.orgId)
          .find(r => r.externalAgentId === token.externalAgentId);

        const colleagues: HandbookColleague[] = server.orgService.getAgentManager().listAgents()
          .filter(a => a.id !== token.markusAgentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
        const mgr = colleagues.find(c => {
          const all = server.orgService.getAgentManager().listAgents();
          return all.find(a => a.id === c.id && a.agentRole === 'manager');
        });

        const projects: HandbookProject[] = server.projectService
          ? server.projectService.listProjects(token.orgId).map(p => ({
              id: p.id, name: p.name,
            }))
          : [];

        const handbook = generateHandbook({
          baseUrl: `http://localhost:${server.port}`,
          orgName: token.orgId,
          agentName: reg?.agentName,
          markusAgentId: token.markusAgentId,
          platform: reg?.platform,
          colleagues,
          manager: mgr ? { id: mgr.id, name: mgr.name } : undefined,
          projects,
        });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(handbook);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Team Context ────────────────────────────────────────────────
    if (path === '/api/gateway/team' && req.method === 'GET') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const agents = server.orgService.getAgentManager().listAgents();
        const colleagues = agents
          .filter(a => a.id !== token.markusAgentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status, agentRole: a.agentRole, skills: a.skills }));
        const manager = agents.find(a => a.agentRole === 'manager' && a.id !== token.markusAgentId);
        server.json(res, 200, {
          colleagues,
          manager: manager ? { id: manager.id, name: manager.name } : null,
        });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Projects ────────────────────────────────────────────────────
    if (path === '/api/gateway/projects' && req.method === 'GET') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        if (!server.projectService) { server.json(res, 200, { projects: [] }); return true; }
        const projects = server.projectService.listProjects(token.orgId).map(p => ({
          id: p.id, name: p.name, description: p.description, status: p.status,
          teamIds: p.teamIds,
        }));
        server.json(res, 200, { projects });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Requirements ────────────────────────────────────────────────
    if (path === '/api/gateway/requirements' && req.method === 'GET') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        if (!server.requirementService) { server.json(res, 200, { requirements: [] }); return true; }
        const url = new URL(req.url!, `http://localhost`);
        const projectId = url.searchParams.get('project_id') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const reqs = server.requirementService.listRequirements({
          orgId: token.orgId,
          projectId,
          status: status as any,
        }).map(r => ({
          id: r.id, title: r.title, description: r.description,
          status: r.status, priority: r.priority,
          projectId: r.projectId,
          source: r.source, createdAt: r.createdAt,
        }));
        server.json(res, 200, { requirements: reqs });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Deliverables ──────────────────────────────────────────────
    if (path === '/api/gateway/deliverables' && req.method === 'GET') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        server.gateway.verifyToken(authHeader.slice(7));
        if (!server.deliverableService) { server.json(res, 503, { error: 'Deliverable service not available' }); return true; }
        const q = url.searchParams.get('q') ?? undefined;
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const type = url.searchParams.get('type') as any ?? undefined;
        const { results } = server.deliverableService.search({ query: q, projectId, type });
        server.json(res, 200, { results });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    if (path === '/api/gateway/deliverables' && req.method === 'POST') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        if (!server.deliverableService) { server.json(res, 503, { error: 'Deliverable service not available' }); return true; }
        const body = await server.readBody(req);
        const d = await server.deliverableService.create({
          type: body['type'] as any ?? 'text',
          title: body['title'] as string,
          summary: body['summary'] as string ?? body['content'] as string,
          reference: body['reference'] as string,
          format: body['format'] as string | undefined,
          tags: body['tags'] as string[],
          agentId: token.markusAgentId,
          projectId: body['projectId'] as string,
        });
        server.json(res, 201, { deliverable: d });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    if (path.match(/^\/api\/gateway\/deliverables\/[^/]+$/) && req.method === 'PUT') {
      if (!server.gateway) { server.json(res, 503, { error: 'Gateway not configured' }); return true; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { server.json(res, 401, { error: 'Missing Bearer token' }); return true; }
      try {
        server.gateway.verifyToken(authHeader.slice(7));
        if (!server.deliverableService) { server.json(res, 503, { error: 'Deliverable service not available' }); return true; }
        const delivId = path.split('/')[4]!;
        const body = await server.readBody(req);
        const d = await server.deliverableService.update(delivId, {
          title: body['title'] as string | undefined,
          summary: body['summary'] as string | undefined,
          reference: body['reference'] as string | undefined,
          status: body['status'] as any,
          type: body['type'] as any,
          tags: body['tags'] as string[] | undefined,
        });
        if (!d) { server.json(res, 404, { error: 'Deliverable not found' }); return true; }
        server.json(res, 200, { deliverable: d });
      } catch (err) {
        if (err instanceof GatewayError) { server.json(res, err.statusCode, { error: err.message }); return true; }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Sync Endpoint ──────────────────────────────────────────────
    if (path === '/api/gateway/sync' && req.method === 'POST') {
      if (!server.gateway || !server.syncHandler) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        server.json(res, 401, { error: 'Missing Bearer token' });
        return true;
      }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const body = await server.readBody(req) as SyncRequest;
        const result = await server.syncHandler.handleSync(token.markusAgentId, token.orgId, body);
        server.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }

    // ── Gateway: Task Lifecycle Endpoints ────────────────────────────────────
    const gwTaskMatch = path.match(/^\/api\/gateway\/tasks\/([^/]+)\/(accept|progress|complete|fail|delegate|subtasks)$/);
    if (gwTaskMatch && req.method === 'POST') {
      if (!server.gateway) {
        server.json(res, 503, { error: 'Gateway not configured' });
        return true;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        server.json(res, 401, { error: 'Missing Bearer token' });
        return true;
      }
      try {
        const token = server.gateway.verifyToken(authHeader.slice(7));
        const taskId = gwTaskMatch[1]!;
        const action = gwTaskMatch[2]!;
        const body = await server.readBody(req);

        switch (action) {
          case 'accept': {
            const task = server.taskService.updateTaskStatus(taskId, 'in_progress', `ext:${token.markusAgentId}`);
            server.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'progress': {
            const task = server.taskService.getTask(taskId);
            if (!task) { server.json(res, 404, { error: 'Task not found' }); break; }
            if (task.status !== 'in_progress') {
              try { server.taskService.updateTaskStatus(taskId, 'in_progress', `ext:${token.markusAgentId}`); } catch { /* already in_progress */ }
            }
            server.json(res, 200, { taskId, progress: body['progress'], acknowledged: true });
            break;
          }
          case 'complete': {
            const task = server.taskService.updateTaskStatus(taskId, 'completed', `ext:${token.markusAgentId}`);
            server.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'fail': {
            const task = server.taskService.updateTaskStatus(taskId, 'failed', `ext:${token.markusAgentId}`);
            server.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'delegate': {
            server.json(res, 400, { error: 'Delegation is not supported — tasks must always have an assigned agent' });
            break;
          }
          case 'subtasks': {
            const parentTask = server.taskService.getTask(taskId);
            if (!parentTask) { server.json(res, 404, { error: 'Parent task not found' }); break; }
            const subtask = server.taskService.addSubtask(taskId, body['title'] as string);
            server.json(res, 201, { task: { id: subtask.id, title: subtask.title, status: subtask.status } });
            break;
          }
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          server.json(res, err.statusCode, { error: err.message });
          return true;
        }
        server.json(res, 500, { error: String(err) });
      }
      return true;
    }
  return false;
}
