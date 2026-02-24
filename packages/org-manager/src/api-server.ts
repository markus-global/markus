import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '@markus/shared';
import type { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';

const log = createLogger('api-server');

export class APIServer {
  private server?: ReturnType<typeof createServer>;

  constructor(
    private orgService: OrganizationService,
    private taskService: TaskService,
    private port: number = 3001,
  ) {}

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      log.info(`API server listening on port ${this.port}`);
    });
  }

  stop(): void {
    this.server?.close();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const path = url.pathname;

    this.route(req, res, path, url).catch((error) => {
      log.error('Request handler error', { error: String(error), path });
      this.json(res, 500, { error: 'Internal server error' });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    // Agents
    if (path === '/api/agents' && req.method === 'GET') {
      const agents = this.orgService.getAgentManager().listAgents();
      this.json(res, 200, { agents });
      return;
    }

    if (path === '/api/agents' && req.method === 'POST') {
      const body = await this.readBody(req);
      const agent = await this.orgService.hireAgent({
        name: body['name'] as string,
        roleName: body['roleName'] as string,
        orgId: (body['orgId'] as string) ?? 'default',
        teamId: body['teamId'] as string | undefined,
        skills: body['skills'] as string[] | undefined,
      });
      this.json(res, 201, { agent: { id: agent.id, name: agent.config.name, role: agent.role.name } });
      return;
    }

    if (path.startsWith('/api/agents/') && req.method === 'POST') {
      const parts = path.split('/');
      const agentId = parts[3];
      const action = parts[4];

      if (action === 'start') {
        await this.orgService.getAgentManager().startAgent(agentId!);
        this.json(res, 200, { status: 'started' });
        return;
      }
      if (action === 'stop') {
        await this.orgService.getAgentManager().stopAgent(agentId!);
        this.json(res, 200, { status: 'stopped' });
        return;
      }
      if (action === 'message') {
        const body = await this.readBody(req);
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        const reply = await agent.handleMessage(body['text'] as string, body['senderId'] as string | undefined);
        this.json(res, 200, { reply });
        return;
      }
    }

    if (path.startsWith('/api/agents/') && req.method === 'DELETE') {
      const agentId = path.split('/')[3]!;
      await this.orgService.fireAgent(agentId);
      this.json(res, 200, { deleted: true });
      return;
    }

    // Roles
    if (path === '/api/roles' && req.method === 'GET') {
      const roles = this.orgService.listAvailableRoles();
      this.json(res, 200, { roles });
      return;
    }

    if (path.startsWith('/api/roles/') && req.method === 'GET') {
      const roleName = path.split('/')[3]!;
      const role = this.orgService.getRoleDetails(roleName);
      this.json(res, 200, { role });
      return;
    }

    // Tasks
    if (path === '/api/tasks' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const status = url.searchParams.get('status') as import('@markus/shared').TaskStatus | undefined;
      const tasks = this.taskService.listTasks({ orgId, status });
      this.json(res, 200, { tasks });
      return;
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const body = await this.readBody(req);
      const task = this.taskService.createTask({
        orgId: (body['orgId'] as string) ?? 'default',
        title: body['title'] as string,
        description: body['description'] as string,
        priority: body['priority'] as import('@markus/shared').TaskPriority | undefined,
        assignedAgentId: body['assignedAgentId'] as string | undefined,
      });
      this.json(res, 201, { task });
      return;
    }

    if (path === '/api/taskboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const board = this.taskService.getTaskBoard(orgId);
      this.json(res, 200, { board });
      return;
    }

    // Organizations
    if (path === '/api/orgs' && req.method === 'GET') {
      const orgs = this.orgService.listOrganizations();
      this.json(res, 200, { orgs });
      return;
    }

    if (path === '/api/orgs' && req.method === 'POST') {
      const body = await this.readBody(req);
      const org = this.orgService.createOrganization(body['name'] as string, (body['ownerId'] as string) ?? 'default');
      this.json(res, 201, { org });
      return;
    }

    // Health
    if (path === '/api/health') {
      this.json(res, 200, {
        status: 'ok',
        version: '0.1.0',
        agents: this.orgService.getAgentManager().listAgents().length,
      });
      return;
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }
}
