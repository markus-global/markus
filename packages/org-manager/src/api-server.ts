import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '@markus/shared';
import type { SkillRegistry } from '@markus/core';
import type { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import type { BillingService } from './billing-service.js';
import { WSBroadcaster } from './ws-server.js';

const log = createLogger('api-server');

export class APIServer {
  private server?: ReturnType<typeof createServer>;
  private ws: WSBroadcaster;
  private skillRegistry?: SkillRegistry;
  private hitlService?: HITLService;
  private billingService?: BillingService;

  constructor(
    private orgService: OrganizationService,
    private taskService: TaskService,
    private port: number = 3001,
  ) {
    this.ws = new WSBroadcaster();
  }

  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  setBillingService(service: BillingService): void {
    this.billingService = service;
  }

  setHITLService(service: HITLService): void {
    this.hitlService = service;
    service.onNotification((n) => {
      this.ws.broadcast({ type: 'notification', payload: { notification: n }, timestamp: new Date().toISOString() });
    });
  }

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.ws.attach(this.server);
    this.server.listen(this.port, () => {
      log.info(`API server listening on port ${this.port} (HTTP + WebSocket)`);
    });
  }

  stop(): void {
    this.server?.close();
  }

  getWSBroadcaster(): WSBroadcaster {
    return this.ws;
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
        agentRole: body['agentRole'] as 'manager' | 'worker' | undefined,
      });
      this.json(res, 201, { agent: { id: agent.id, name: agent.config.name, role: agent.role.name, agentRole: agent.config.agentRole, status: agent.getState().status } });
      return;
    }

    if (path.startsWith('/api/agents/') && req.method === 'POST') {
      const parts = path.split('/');
      const agentId = parts[3];
      const action = parts[4];

      if (action === 'start') {
        await this.orgService.getAgentManager().startAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'idle');
        this.json(res, 200, { status: 'started' });
        return;
      }
      if (action === 'stop') {
        await this.orgService.getAgentManager().stopAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'offline');
        this.json(res, 200, { status: 'stopped' });
        return;
      }
      if (action === 'daily-report') {
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        const report = await agent.generateDailyReport();
        this.json(res, 200, { agentId: agentId!, report });
        return;
      }
      if (action === 'message') {
        const body = await this.readBody(req);
        const stream = body['stream'] as boolean | undefined;
        const senderId = body['senderId'] as string | undefined;
        const senderInfo = this.orgService.resolveHumanIdentity(senderId);
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'working');

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          const reply = await agent.handleMessageStream(
            body['text'] as string,
            (event) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
              if (event.type === 'text_delta' && event.text) {
                this.ws.broadcastChat(agentId!, event.text, 'agent');
              }
            },
            senderId,
            senderInfo,
          );

          res.write(`data: ${JSON.stringify({ type: 'done', content: reply })}\n\n`);
          res.end();
        } else {
          const reply = await agent.handleMessage(body['text'] as string, senderId, senderInfo);
          this.ws.broadcastChat(agentId!, reply, 'agent');
          this.json(res, 200, { reply });
        }

        this.ws.broadcastAgentUpdate(agentId!, agent.getState().status);
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
        requiredSkills: body['requiredSkills'] as string[] | undefined,
        autoAssign: body['autoAssign'] as boolean | undefined,
      });
      this.json(res, 201, { task });
      return;
    }

    if (path.startsWith('/api/tasks/') && req.method === 'PUT') {
      const taskId = path.split('/')[3]!;
      const body = await this.readBody(req);

      if (body['status']) {
        const task = this.taskService.updateTaskStatus(taskId, body['status'] as import('@markus/shared').TaskStatus);
        this.json(res, 200, { task });
        return;
      }

      if (body['assignedAgentId']) {
        const task = this.taskService.assignTask(taskId, body['assignedAgentId'] as string);
        this.json(res, 200, { task });
        return;
      }

      this.json(res, 400, { error: 'Provide status or assignedAgentId' });
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
      const org = await this.orgService.createOrganization(body['name'] as string, (body['ownerId'] as string) ?? 'default');
      this.json(res, 201, { org });
      return;
    }

    // Agent status
    if (path.startsWith('/api/agents/') && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const state = agent.getState();
        this.json(res, 200, {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          agentRole: agent.config.agentRole,
          state,
          skills: agent.config.skills,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Human Users
    if (path === '/api/users' && req.method === 'GET') {
      const targetOrgId = url.searchParams.get('orgId') ?? 'default';
      const users = this.orgService.listHumanUsers(targetOrgId);
      this.json(res, 200, { users });
      return;
    }

    if (path === '/api/users' && req.method === 'POST') {
      const body = await this.readBody(req);
      const user = this.orgService.addHumanUser(
        (body['orgId'] as string) ?? 'default',
        body['name'] as string,
        (body['role'] as 'owner' | 'admin' | 'member' | 'guest') ?? 'member',
        { id: body['id'] as string | undefined, email: body['email'] as string | undefined },
      );
      this.json(res, 201, { user });
      return;
    }

    if (path.startsWith('/api/users/') && req.method === 'DELETE') {
      const userId = path.split('/')[3]!;
      this.orgService.removeHumanUser(userId);
      this.json(res, 200, { deleted: true });
      return;
    }

    // Message routing — smart routing to the right agent
    if (path === '/api/message' && req.method === 'POST') {
      const body = await this.readBody(req);
      const targetOrgId = (body['orgId'] as string) ?? 'default';
      const targetAgentId = this.orgService.routeMessage(targetOrgId, {
        targetAgentId: body['targetAgentId'] as string | undefined,
        channelId: body['channelId'] as string | undefined,
        text: body['text'] as string | undefined,
      });

      if (!targetAgentId) {
        this.json(res, 404, { error: 'No agent available to handle the message' });
        return;
      }

      const senderId = body['senderId'] as string | undefined;
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);
      const agent = this.orgService.getAgentManager().getAgent(targetAgentId);
      this.ws.broadcastAgentUpdate(targetAgentId, 'working');

      const stream = body['stream'] as boolean | undefined;
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        const reply = await agent.handleMessageStream(
          body['text'] as string,
          (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          },
          senderId,
          senderInfo,
        );
        res.write(`data: ${JSON.stringify({ type: 'done', content: reply, agentId: targetAgentId })}\n\n`);
        res.end();
      } else {
        const reply = await agent.handleMessage(body['text'] as string, senderId, senderInfo);
        this.json(res, 200, { reply, agentId: targetAgentId });
      }
      this.ws.broadcastAgentUpdate(targetAgentId, agent.getState().status);
      return;
    }

    // Skills
    if (path === '/api/skills' && req.method === 'GET') {
      const skills = this.skillRegistry?.list() ?? [];
      this.json(res, 200, { skills });
      return;
    }

    // HITL: Approvals
    if (path === '/api/approvals' && req.method === 'GET') {
      const status = url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | undefined;
      this.json(res, 200, { approvals: this.hitlService?.listApprovals(status ?? undefined) ?? [] });
      return;
    }

    if (path === '/api/approvals' && req.method === 'POST') {
      if (!this.hitlService) { this.json(res, 503, { error: 'HITL service not available' }); return; }
      const body = await this.readBody(req);
      const approval = this.hitlService.requestApproval({
        agentId: body['agentId'] as string,
        agentName: body['agentName'] as string ?? 'Agent',
        type: (body['type'] as 'action' | 'custom') ?? 'custom',
        title: body['title'] as string,
        description: body['description'] as string,
        details: body['details'] as Record<string, unknown>,
        targetUserId: body['targetUserId'] as string,
      });
      this.json(res, 201, { approval });
      return;
    }

    if (path.startsWith('/api/approvals/') && req.method === 'POST') {
      if (!this.hitlService) { this.json(res, 503, { error: 'HITL service not available' }); return; }
      const approvalId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const result = this.hitlService.respondToApproval(approvalId, body['approved'] as boolean, (body['respondedBy'] as string) ?? 'default');
      if (!result) { this.json(res, 404, { error: 'Approval not found or not pending' }); return; }
      this.json(res, 200, { approval: result });
      return;
    }

    // HITL: Bounties
    if (path === '/api/bounties' && req.method === 'GET') {
      const status = url.searchParams.get('status') as 'open' | 'claimed' | undefined;
      this.json(res, 200, { bounties: this.hitlService?.listBounties(status ?? undefined) ?? [] });
      return;
    }

    if (path === '/api/bounties' && req.method === 'POST') {
      if (!this.hitlService) { this.json(res, 503, { error: 'HITL service not available' }); return; }
      const body = await this.readBody(req);
      const bounty = this.hitlService.postBounty({
        agentId: body['agentId'] as string,
        agentName: body['agentName'] as string ?? 'Agent',
        title: body['title'] as string,
        description: body['description'] as string,
        skills: body['skills'] as string[],
        reward: body['reward'] as string,
      });
      this.json(res, 201, { bounty });
      return;
    }

    if (path.startsWith('/api/bounties/') && req.method === 'POST') {
      if (!this.hitlService) { this.json(res, 503, { error: 'HITL service not available' }); return; }
      const bountyId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const action = body['action'] as string;
      if (action === 'claim') {
        const result = this.hitlService.claimBounty(bountyId, body['userId'] as string);
        if (!result) { this.json(res, 404, { error: 'Bounty not found or not open' }); return; }
        this.json(res, 200, { bounty: result });
      } else if (action === 'complete') {
        const result = this.hitlService.completeBounty(bountyId, body['result'] as string);
        if (!result) { this.json(res, 404, { error: 'Bounty not found or not claimed' }); return; }
        this.json(res, 200, { bounty: result });
      } else {
        this.json(res, 400, { error: 'Unknown action. Use claim or complete' });
      }
      return;
    }

    // Notifications
    if (path === '/api/notifications' && req.method === 'GET') {
      const userId = url.searchParams.get('userId') ?? undefined;
      const unread = url.searchParams.get('unread') === 'true';
      this.json(res, 200, { notifications: this.hitlService?.listNotifications(userId, unread) ?? [] });
      return;
    }

    if (path.startsWith('/api/notifications/') && req.method === 'POST') {
      const notifId = path.split('/')[3]!;
      const read = this.hitlService?.markNotificationRead(notifId);
      this.json(res, 200, { success: read ?? false });
      return;
    }

    // Billing: Usage
    if (path === '/api/usage' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const period = url.searchParams.get('period') ?? undefined;
      const summary = this.billingService?.getUsageSummary(orgId, period);
      const plan = this.billingService?.getOrgPlan(orgId);
      this.json(res, 200, { usage: summary, plan });
      return;
    }

    // Billing: API Keys
    if (path === '/api/keys' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { keys: this.billingService?.listAPIKeys(orgId) ?? [] });
      return;
    }

    if (path === '/api/keys' && req.method === 'POST') {
      if (!this.billingService) { this.json(res, 503, { error: 'Billing service not available' }); return; }
      const body = await this.readBody(req);
      const key = this.billingService.createAPIKey(
        (body['orgId'] as string) ?? 'default',
        body['name'] as string ?? 'Default Key',
        body['scopes'] as string[],
        body['expiresInDays'] as number | undefined,
      );
      this.json(res, 201, { key });
      return;
    }

    if (path.startsWith('/api/keys/') && req.method === 'DELETE') {
      const keyId = path.split('/')[3]!;
      const revoked = this.billingService?.revokeAPIKey(keyId);
      this.json(res, 200, { revoked: revoked ?? false });
      return;
    }

    // Billing: Plan
    if (path === '/api/plan' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { plan: this.billingService?.getOrgPlan(orgId) });
      return;
    }

    if (path === '/api/plan' && req.method === 'POST') {
      if (!this.billingService) { this.json(res, 503, { error: 'Billing service not available' }); return; }
      const body = await this.readBody(req);
      const plan = this.billingService.setOrgPlan(
        (body['orgId'] as string) ?? 'default',
        (body['tier'] as 'free' | 'pro' | 'enterprise') ?? 'free',
      );
      this.json(res, 200, { plan });
      return;
    }

    // Team Templates
    if (path === '/api/templates/teams' && req.method === 'GET') {
      try {
        const { readdirSync, readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const teamsDir = resolve(process.cwd(), 'templates', 'teams');
        const files = readdirSync(teamsDir).filter(f => f.endsWith('.json'));
        const teams = files.map(f => JSON.parse(readFileSync(resolve(teamsDir, f), 'utf-8')));
        this.json(res, 200, { templates: teams });
      } catch {
        this.json(res, 200, { templates: [] });
      }
      return;
    }

    // Health
    if (path === '/api/health') {
      this.json(res, 200, {
        status: 'ok',
        version: '0.6.0',
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
