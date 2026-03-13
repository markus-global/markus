import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger, generateId, saveConfig, getTextContent, type TaskStatus, type TaskPriority } from '@markus/shared';
import {
  GatewayError,
  WorkflowEngine,
  createDefaultTeamTemplates,
  createDefaultTemplateRegistry,
  PromptStudio,
  generateHandbook,
  GatewaySyncHandler,
  readSkillInstructions,
  type TeamTemplateRegistry,
  type AgentToolHandler,
  type ExternalAgentGateway,
  type LLMRouter,
  type ReviewService,
  type SkillRegistry,
  type SkillCategory,
  type TemplateRegistry,
  type WorkflowExecutor,
  type WorkflowDefinition,
  type SyncRequest,
  type HandbookColleague,
  type HandbookProject,
  discoverSkillsInDir,
  WELL_KNOWN_SKILL_DIRS,
} from '@markus/core';
import type { ChannelMsg } from '@markus/storage';
import type { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import type { BillingService } from './billing-service.js';
import type { AuditService, AuditEventType } from './audit-service.js';
import type { StorageBridge } from './storage-bridge.js';
import type { ProjectService } from './project-service.js';
import type { ReportService } from './report-service.js';
import type { KnowledgeService } from './knowledge-service.js';
import type { RequirementService } from './requirement-service.js';
import { WSBroadcaster } from './ws-server.js';
import { SSEHandler } from './sse-handler.js';

const log = createLogger('api-server');

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Simple JWT-lite using HMAC-SHA256 (no external deps required)
async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${data}.${sigB64}`;
}

async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/')), c =>
      c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
    if (payload['exp'] && (payload['exp'] as number) < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const PBKDF2_ITERATIONS = 10000;

async function hashPassword(password: string): Promise<string> {
  // Format: pbkdf2:<iterations>:<saltHex>:<hashHex>
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  // Support old format (3 parts) and new format (4 parts with iterations)
  if (parts[0] !== 'pbkdf2') return false;
  let iterations: number;
  let saltHex: string;
  let expectedHash: string;
  if (parts.length === 4) {
    iterations = parseInt(parts[1]!, 10);
    saltHex = parts[2]!;
    expectedHash = parts[3]!;
  } else if (parts.length === 3) {
    iterations = 100000; // legacy
    saltHex = parts[1]!;
    expectedHash = parts[2]!;
  } else {
    return false;
  }
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hashHex === expectedHash;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(part.slice(0, eqIdx).trim());
    const val = decodeURIComponent(part.slice(eqIdx + 1).trim());
    if (key) result[key] = val;
  }
  return result;
}

export class APIServer {
  private server?: ReturnType<typeof createServer>;
  private ws: WSBroadcaster;
  private skillRegistry?: SkillRegistry;
  private hitlService?: HITLService;
  private billingService?: BillingService;
  private auditService?: AuditService;
  private storage?: StorageBridge;
  private llmRouter?: LLMRouter;
  private markusConfigPath?: string;
  private gateway?: ExternalAgentGateway;
  private gatewaySecret?: string;
  private syncHandler?: GatewaySyncHandler;
  private gatewayMessageQueue = new Map<string, Array<{ id: string; from: string; fromName: string; content: string; timestamp: string }>>();
  private reviewService?: ReviewService;
  private registryCache?: Map<string, { data: unknown; ts: number }>;
  private templateRegistry?: TemplateRegistry;
  private workflowEngine?: WorkflowEngine;
  private teamTemplateRegistry: TeamTemplateRegistry;
  private promptStudio: PromptStudio;
  private customGroupChats: Array<{
    id: string;
    name: string;
    orgId: string;
    creatorId: string;
    creatorName: string;
    memberIds: string[];
    createdAt: string;
  }> = [];

  constructor(
    private orgService: OrganizationService,
    private taskService: TaskService,
    private port: number = 3001
  ) {
    this.ws = new WSBroadcaster();
    this.teamTemplateRegistry = createDefaultTeamTemplates();
    this.templateRegistry = createDefaultTemplateRegistry();
    this.promptStudio = new PromptStudio();
    // Propagate template registry to AgentManager so createAgentFromTemplate works
    const am = this.orgService.getAgentManager();
    if (this.templateRegistry && !am.getTemplateRegistry()) {
      am.setTemplateRegistry(this.templateRegistry);
    }

    // Wire up group chat handlers for agent communication tools
    am.setGroupChatHandlers({
      sendGroupMessage: async (
        channelKey: string,
        message: string,
        senderId: string,
        senderName: string
      ) => {
        if (this.storage) {
          await this.storage.channelMessageRepo.append({
            orgId: 'default',
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: message,
          });
        }
        this.ws.broadcast({
          type: 'chat:message',
          payload: {
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: message,
          },
          timestamp: new Date().toISOString(),
        });
        return 'Message sent to group chat';
      },
      createGroupChat: async (
        name: string,
        creatorId: string,
        creatorName: string,
        memberIds: string[]
      ) => {
        const chatId = `group:custom:${Date.now().toString(36)}`;
        this.customGroupChats.push({
          id: chatId,
          name,
          orgId: 'default',
          creatorId,
          creatorName,
          memberIds,
          createdAt: new Date().toISOString(),
        });
        this.ws.broadcast({
          type: 'chat:group_created',
          payload: { chatId, name, creatorId, creatorName },
          timestamp: new Date().toISOString(),
        });
        return { id: chatId, name };
      },
      listGroupChats: async () => {
        const teams = this.orgService.listTeamsWithMembers('default');
        const teamChats = teams.map(t => ({
          id: `group:${t.id}`,
          name: t.name,
          type: 'team',
          channelKey: `group:${t.id}`,
        }));
        const customChats = this.customGroupChats.map(c => ({
          id: c.id,
          name: c.name,
          type: 'custom',
          channelKey: c.id,
        }));
        return [...teamChats, ...customChats];
      },
    });
  }

  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  setBillingService(service: BillingService): void {
    this.billingService = service;
  }

  setAuditService(service: AuditService): void {
    this.auditService = service;
  }

  setHITLService(service: HITLService): void {
    this.hitlService = service;
    service.onNotification(n => {
      this.ws.broadcast({
        type: 'notification',
        payload: { notification: n },
        timestamp: new Date().toISOString(),
      });
    });
  }

  setStorage(storage: StorageBridge): void {
    this.storage = storage;
  }

  setGateway(gateway: ExternalAgentGateway, secret?: string): void {
    this.gateway = gateway;
    this.gatewaySecret = secret;
    this.initSyncHandler();
  }

  private initSyncHandler(): void {
    const self = this;
    this.syncHandler = new GatewaySyncHandler(
      {
        getTasksByAgent(agentId: string) {
          return self.taskService.getTasksByAgent(agentId).map(t => ({
            id: t.id, title: t.title, description: t.description,
            priority: t.priority, status: t.status, parentTaskId: t.parentTaskId,
            requirementId: t.requirementId,
            projectId: t.projectId,
          }));
        },
        updateTaskStatus(taskId: string, status: string, updatedBy?: string) {
          self.taskService.updateTaskStatus(taskId, status as TaskStatus, updatedBy);
        },
        createTask(req) {
          return self.taskService.createTask({
            title: req.title, description: req.description,
            priority: req.priority as TaskPriority,
            orgId: req.orgId, assignedAgentId: req.assignedAgentId,
            parentTaskId: req.parentTaskId, createdBy: req.createdBy,
          });
        },
      },
      {
        drainInbox(markusAgentId: string) {
          const queue = self.gatewayMessageQueue.get(markusAgentId) ?? [];
          self.gatewayMessageQueue.set(markusAgentId, []);
          return queue;
        },
        deliver(fromAgentId: string, toAgentId: string, content: string) {
          const fromAgent = self.orgService.getAgentManager().getAgent(fromAgentId);
          const queue = self.gatewayMessageQueue.get(toAgentId) ?? [];
          queue.push({
            id: `gwmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            from: fromAgentId,
            fromName: fromAgent?.config?.name ?? fromAgentId,
            content,
            timestamp: new Date().toISOString(),
          });
          self.gatewayMessageQueue.set(toAgentId, queue);
        },
      },
      {
        updateStatus(_agentId: string, _status: 'idle' | 'working' | 'error') {},
        updateHeartbeat(_agentId: string) {},
      },
    );

    this.syncHandler.setTeamBridge({
      getColleagues(agentId: string, _orgId: string) {
        return self.orgService.getAgentManager().listAgents()
          .filter(a => a.id !== agentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
      },
      getManager(agentId: string, _orgId: string) {
        const agents = self.orgService.getAgentManager().listAgents();
        const mgr = agents.find(a => a.agentRole === 'manager' && a.id !== agentId);
        return mgr ? { id: mgr.id, name: mgr.name } : undefined;
      },
    });

    this.syncHandler.setProjectBridge({
      getProjects(orgId: string) {
        if (!self.projectService) return [];
        return self.projectService.listProjects(orgId).map(p => {
          const iter = self.projectService!.getActiveIteration(p.id);
          return {
            id: p.id,
            name: p.name,
            currentIteration: iter ? { id: iter.id, name: iter.name, status: iter.status } : undefined,
          };
        });
      },
      getActiveRequirements(orgId: string) {
        if (!self.requirementService) return [];
        return self.requirementService.listRequirements({ orgId })
          .filter(r => r.status === 'approved' || r.status === 'in_progress')
          .map(r => ({
            id: r.id,
            title: r.title,
            status: r.status,
            priority: r.priority,
            projectId: r.projectId,
          }));
      },
    });
  }

  setReviewService(svc: ReviewService): void {
    this.reviewService = svc;
  }

  setTemplateRegistry(registry: TemplateRegistry): void {
    this.templateRegistry = registry;
  }

  setLLMRouter(router: LLMRouter): void {
    this.llmRouter = router;
  }

  setConfigPath(configPath: string): void {
    this.markusConfigPath = configPath;
  }

  initWorkflowEngine(): WorkflowEngine {
    const agentManager = this.orgService.getAgentManager();
    const executor: WorkflowExecutor = {
      executeStep: async (
        agentId: string,
        taskDescription: string,
        input: Record<string, unknown>
      ) => {
        const agent = agentManager.getAgent(agentId);
        const reply = await agent.handleMessage(
          taskDescription,
          'workflow-engine',
          { name: 'workflow', role: 'system' },
          {
            ephemeral: true,
            maxHistory: 15,
          }
        );
        return { reply, input };
      },
      findAgent: (skills: string[]) => {
        const agents = agentManager.listAgents();
        const found = agents.find(a =>
          skills.some(
            s =>
              a.role?.toLowerCase().includes(s.toLowerCase()) ||
              a.agentRole?.toLowerCase().includes(s.toLowerCase())
          )
        );
        return found?.id;
      },
    };
    this.workflowEngine = new WorkflowEngine(executor);
    return this.workflowEngine;
  }

  getTeamTemplateRegistry(): TeamTemplateRegistry {
    return this.teamTemplateRegistry;
  }

  /** Ensure at least one admin user exists; called once after storage init */
  async ensureAdminUser(orgId: string): Promise<void> {
    if (!this.storage) return;
    const allUsers = await this.storage.userRepo.listByOrg(orgId);
    if (allUsers.some(u => u.passwordHash && u.id === 'default')) return;

    // Remove any stale non-default admin users from old versions
    for (const u of allUsers.filter(u => u.passwordHash && u.id !== 'default')) {
      await this.storage.userRepo.delete(u.id);
    }

    const adminPassword = process.env['ADMIN_PASSWORD'] ?? 'markus123';
    const hash = await hashPassword(adminPassword);
    await this.storage.userRepo.upsert({
      id: 'default',
      orgId,
      name: 'Admin',
      email: 'admin@markus.local',
      role: 'owner',
      passwordHash: hash,
    });
    log.info('Created default admin user (admin@markus.local)');
  }

  private get jwtSecret(): string {
    return process.env['JWT_SECRET'] ?? 'markus-dev-secret-change-in-prod';
  }

  private get authEnabled(): boolean {
    return process.env['AUTH_ENABLED'] !== 'false';
  }

  /** Returns user payload from JWT cookie, or null if not authenticated */
  private async getAuthUser(
    req: IncomingMessage
  ): Promise<{ userId: string; orgId: string; role: string } | null> {
    if (!this.authEnabled) return { userId: 'anonymous', orgId: 'default', role: 'owner' };
    const cookies = parseCookies(req.headers['cookie']);
    const token = cookies['markus_token'];
    if (!token) return null;
    const payload = await verifyToken(token, this.jwtSecret);
    if (!payload) return null;
    return payload as { userId: string; orgId: string; role: string };
  }

  /** Returns user or sends 401 and returns null */
  private async requireAuth(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<{ userId: string; orgId: string; role: string } | null> {
    const user = await this.getAuthUser(req);
    if (!user) {
      this.json(res, 401, { error: 'Unauthorized' });
      return null;
    }
    return user;
  }

  /** Persist a chat turn (user + assistant) to DB if storage is available */
  private async persistChatTurn(
    agentId: string,
    userMessage: string,
    reply: string,
    senderId?: string,
    tokensUsed = 0,
    metadata?: unknown
  ): Promise<void> {
    if (!this.storage) return;
    try {
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, 1);
      let session = sessions[0];
      if (!session) {
        session = await this.storage.chatSessionRepo.createSession(agentId, senderId);
      }
      const title = !session.title ? userMessage.slice(0, 60) : undefined;
      await this.storage.chatSessionRepo.appendMessage(session.id, agentId, 'user', userMessage, 0);
      await this.storage.chatSessionRepo.appendMessage(
        session.id,
        agentId,
        'assistant',
        reply,
        tokensUsed,
        metadata
      );
      await this.storage.chatSessionRepo.updateLastMessage(session.id, title);
    } catch (err) {
      log.warn('Failed to persist chat turn', { error: String(err) });
    }
  }

  /** Persist the user message first (before LLM), returns session id for subsequent assistant persistence.
   *  When sessionId is provided, appends to that session; when null/undefined, creates a new session. */
  private async persistUserMessage(
    agentId: string,
    userMessage: string,
    senderId?: string,
    images?: string[],
    sessionId?: string | null,
  ): Promise<string | null> {
    if (!this.storage) return null;
    try {
      let session: { id: string; title: string | null } | undefined;
      if (sessionId) {
        session = await this.storage.chatSessionRepo.getSession(sessionId) ?? undefined;
      }
      if (!session) {
        session = await this.storage.chatSessionRepo.createSession(agentId, senderId);
      }
      const title = !session.title ? userMessage.slice(0, 60) : undefined;
      const meta = images?.length ? { images } : undefined;
      await this.storage.chatSessionRepo.appendMessage(session.id, agentId, 'user', userMessage, 0, meta);
      if (title) await this.storage.chatSessionRepo.updateLastMessage(session.id, title);
      return session.id;
    } catch (err) {
      log.warn('Failed to persist user message', { error: String(err) });
      return null;
    }
  }

  /** Persist the assistant reply after LLM completes */
  private async persistAssistantMessage(
    sessionId: string | null,
    agentId: string,
    reply: string,
    tokensUsed = 0,
    metadata?: unknown
  ): Promise<void> {
    if (!this.storage || !sessionId) return;
    try {
      await this.storage.chatSessionRepo.appendMessage(
        sessionId,
        agentId,
        'assistant',
        reply,
        tokensUsed,
        metadata
      );
      await this.storage.chatSessionRepo.updateLastMessage(sessionId);
    } catch (err) {
      log.warn('Failed to persist assistant message', { error: String(err) });
    }
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

    this.route(req, res, path, url).catch(error => {
      log.error('Request handler error', { error: String(error), path });
      if (res.headersSent) {
        // SSE or chunked stream already started — send an error event and close gracefully
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`);
        } catch {
          /* ignore if write also fails */
        }
        res.end();
      } else {
        this.json(res, 500, { error: 'Internal server error' });
      }
    });
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL
  ): Promise<void> {
    // ── Auth endpoints (no auth required) ──────────────────────────────────
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await this.readBody(req);
      const email = ((body['email'] as string) ?? '').trim().toLowerCase();
      const password = (body['password'] as string) ?? '';

      if (!this.authEnabled) {
        this.json(res, 200, { user: { id: 'anonymous', name: 'Admin', role: 'owner' } });
        return;
      }

      const userRow = this.storage ? await this.storage.userRepo.findByEmail(email) : null;
      if (!userRow || !userRow.passwordHash) {
        this.json(res, 401, { error: 'Invalid email or password' });
        return;
      }
      const valid = await verifyPassword(password, userRow.passwordHash);
      if (!valid) {
        this.json(res, 401, { error: 'Invalid email or password' });
        return;
      }
      await this.storage!.userRepo.updateLastLogin(userRow.id);
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, {
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          role: userRow.role,
          orgId: userRow.orgId,
        },
      });
      return;
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'markus_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/auth/me' && req.method === 'GET') {
      const authUser = await this.getAuthUser(req);
      if (!authUser) {
        this.json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (!this.authEnabled) {
        this.json(res, 200, {
          user: { id: 'anonymous', name: 'Admin', role: 'owner', orgId: 'default' },
        });
        return;
      }
      const userRow = this.storage ? await this.storage.userRepo.findById(authUser.userId) : null;
      if (!userRow) {
        this.json(res, 401, { error: 'User not found' });
        return;
      }
      this.json(res, 200, {
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          role: userRow.role,
          orgId: userRow.orgId,
        },
      });
      return;
    }

    if (path === '/api/auth/change-password' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const body = await this.readBody(req);
      const currentPassword = (body['currentPassword'] as string) ?? '';
      const newPassword = (body['newPassword'] as string) ?? '';
      if (!newPassword || newPassword.length < 6) {
        this.json(res, 400, { error: 'New password must be at least 6 characters' });
        return;
      }
      const userRow = await this.storage.userRepo.findById(authUser.userId);
      if (!userRow) {
        this.json(res, 404, { error: 'User not found' });
        return;
      }
      // If they already have a password, verify current one (skip for first-time setup where hash is null/empty)
      if (userRow.passwordHash && currentPassword) {
        const valid = await verifyPassword(currentPassword, userRow.passwordHash);
        if (!valid) {
          this.json(res, 401, { error: 'Current password is incorrect' });
          return;
        }
      }
      const newHash = await hashPassword(newPassword);
      await this.storage.userRepo.updatePassword(authUser.userId, newHash);
      // Re-issue token so session stays valid
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, { ok: true });
      return;
    }

    // ── Chat sessions ──────────────────────────────────────────────────────
    if (path.match(/^\/api\/agents\/[^/]+\/sessions$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { sessions: [] });
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '20');
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, limit);
      this.json(res, 200, { sessions });
      return;
    }

    if (path.match(/^\/api\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
      const sessionId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { messages: [], hasMore: false });
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before') ?? undefined;
      const result = await this.storage.chatSessionRepo.getMessages(sessionId, limit, before);
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/sessions\/[^/]+$/) && req.method === 'DELETE') {
      const sessionId = path.split('/')[3]!;
      if (this.storage) await this.storage.chatSessionRepo.deleteSession(sessionId);
      this.json(res, 204, {});
      return;
    }

    // ── Channel messages ───────────────────────────────────────────────────
    if (path.match(/^\/api\/channels\/[^/]+\/messages$/) && req.method === 'GET') {
      const channel = decodeURIComponent(path.split('/')[3]!);
      if (!this.storage) {
        this.json(res, 200, { messages: [], hasMore: false });
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before') ?? undefined;
      const result = await this.storage.channelMessageRepo.getMessages(channel, limit, before);
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/channels\/[^/]+\/messages$/) && req.method === 'POST') {
      const channel = decodeURIComponent(path.split('/')[3]!);
      const body = await this.readBody(req);
      const text = body['text'] as string;
      const senderId = (body['senderId'] as string) ?? 'anonymous';
      const senderName = (body['senderName'] as string) ?? 'You';
      const mentions = (body['mentions'] as string[]) ?? [];
      const targetAgentId = body['targetAgentId'] as string | undefined;
      const orgId = (body['orgId'] as string) ?? 'default';

      // Persist user message
      let userMsg: ChannelMsg | undefined;
      if (this.storage) {
        userMsg = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId,
          senderType: 'human',
          senderName,
          text,
          mentions,
        });
      }

      // DM / personal-notepad channels never route to agents
      const humanOnly = (body['humanOnly'] as boolean) === true;
      const isHumanChannel = humanOnly || channel.startsWith('notes:') || channel.startsWith('dm:');

      // Route to agent — for group chats, pick a team member (manager first)
      let routedAgentId: string | null | undefined = null;
      if (!isHumanChannel) {
        if (targetAgentId) {
          routedAgentId = targetAgentId;
        } else if (channel.startsWith('group:')) {
          // Extract teamId from channel key (e.g. "group:team_xxx" or "group:custom:xxx")
          const teamId = channel.replace(/^group:/, '');
          const team = this.orgService.getTeam(teamId);
          if (team) {
            // Prefer team lead/manager, then first available agent member
            const candidateId =
              team.leadAgentId ??
              (team.managerType === 'agent' ? team.managerId : undefined) ??
              team.memberAgentIds[0];
            if (candidateId) routedAgentId = candidateId;
          }
          // Fallback to org-wide routing if no team member found
          if (!routedAgentId) routedAgentId = this.orgService.routeMessage(orgId, { text });
        } else {
          routedAgentId = this.orgService.routeMessage(orgId, { text });
        }
      }
      if (!routedAgentId) {
        this.json(res, 200, { userMessage: userMsg ?? null, agentMessage: null });
        return;
      }
      const agent = this.orgService.getAgentManager().getAgent(routedAgentId);
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);

      // Build lightweight channel context (last 20 messages, not the agent's full session)
      let channelContext: Array<{ role: string; content: string }> = [];
      if (this.storage) {
        try {
          const recent = await this.storage.channelMessageRepo.getMessages(channel, 20);
          channelContext = (recent.messages ?? []).map((m: ChannelMsg) => ({
            role: m.senderType === 'agent' ? 'assistant' : 'user',
            content: m.senderType === 'agent' ? m.text : `[${m.senderName}]: ${m.text}`,
          }));
        } catch {
          /* ok */
        }
      }

      let reply: string;
      try {
        reply = await agent.handleMessage(text, senderId, senderInfo, {
          ephemeral: true,
          maxHistory: 20,
          channelContext,
        });
      } catch (err) {
        const raw = String(err);
        let detail = raw;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as {
              error?: { message?: string };
              message?: string;
            };
            detail = parsed.error?.message ?? parsed.message ?? raw;
          } catch {
            /* keep raw */
          }
        }

        // Persist error as a channel message so it survives page reloads
        let errorMsg: ChannelMsg | undefined;
        if (this.storage) {
          try {
            errorMsg = await this.storage.channelMessageRepo.append({
              orgId,
              channel,
              senderId: routedAgentId,
              senderType: 'system',
              senderName: 'System',
              text: `⚠ AI service error: ${detail.slice(0, 500)}`,
              mentions: [],
            });
          } catch (e) {
            log.warn('Failed to persist channel error message', { error: String(e) });
          }
        }

        const statusCode = raw.includes('402')
          ? 402
          : raw.includes('401')
            ? 401
            : raw.includes('429')
              ? 429
              : 502;
        this.json(res, statusCode, {
          userMessage: userMsg ?? null,
          agentMessage: errorMsg ?? null,
          error: detail,
        });
        return;
      }

      // Persist agent reply
      let agentMsg: ChannelMsg | undefined;
      if (this.storage) {
        agentMsg = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: reply,
          mentions: [],
        });
        void this.persistChatTurn(routedAgentId, text, reply, senderId);
      }

      this.ws.broadcastChat(routedAgentId, reply, 'agent');
      this.json(res, 200, {
        userMessage: userMsg ?? null,
        agentMessage: agentMsg ?? {
          id: `tmp_${Date.now()}`,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: reply,
          mentions: [],
          createdAt: new Date(),
        },
      });
      return;
    }

    // Agents
    if (path === '/api/agents' && req.method === 'GET') {
      const agents = this.orgService.getAgentManager().listAgents();
      if (this.gateway) {
        const extRegs = this.gateway.listRegistrations();
        const disconnectedIds = new Set(
          extRegs.filter(r => !r.connected && r.markusAgentId).map(r => r.markusAgentId!)
        );
        const adjusted = agents.map(a =>
          disconnectedIds.has(a.id) ? { ...a, status: 'offline' } : a
        );
        this.json(res, 200, { agents: adjusted });
      } else {
        this.json(res, 200, { agents });
      }
      return;
    }

    if (path === '/api/agents' && req.method === 'POST') {
      const body = await this.readBody(req);
      const agentName = body['name'] as string;
      const roleName = body['roleName'] as string;
      if (!agentName?.trim()) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      if (!roleName?.trim()) {
        this.json(res, 400, { error: 'roleName is required' });
        return;
      }
      const agent = await this.orgService.hireAgent({
        name: agentName,
        roleName,
        orgId: (body['orgId'] as string) ?? 'default',
        teamId: body['teamId'] as string | undefined,
        skills: body['skills'] as string[] | undefined,
        agentRole: body['agentRole'] as 'manager' | 'worker' | undefined,
        tools: body['tools'] as AgentToolHandler[] | undefined,
      });
      this.json(res, 201, {
        agent: {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          agentRole: agent.config.agentRole,
          status: agent.getState().status,
        },
      });
      return;
    }

    if (path.match(/^\/api\/agents\/[^/]+\/(start|stop|daily-report|a2a|message)$/) && req.method === 'POST') {
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
      if (action === 'a2a') {
        const body = await this.readBody(req);
        const fromAgentId = body['fromAgentId'] as string;
        const messageText = body['message'] as string;
        const targetAgent = this.orgService.getAgentManager().getAgent(agentId!);
        const fromAgent = this.orgService.getAgentManager().getAgent(fromAgentId);
        const reply = await targetAgent.handleMessage(messageText, fromAgentId, {
          name: fromAgent.config.name,
          role: fromAgent.config.agentRole ?? 'worker',
        });
        this.json(res, 200, { from: fromAgentId, to: agentId, reply });
        return;
      }
      if (action === 'message') {
        const body = await this.readBody(req);
        const stream = body['stream'] as boolean | undefined;
        const senderId = body['senderId'] as string | undefined;
        const sessionId = body['sessionId'] as string | undefined ?? undefined;
        const images = (body['images'] as string[] | undefined)?.filter(Boolean);
        const senderInfo = this.orgService.resolveHumanIdentity(senderId);
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'working');

        // When no sessionId is provided (user clicked "New Chat"), start a fresh agent session
        if (!sessionId) {
          agent.startNewSession();
        }

        const userText = body['text'] as string;

        if (stream) {
          const sseHandler = new SSEHandler({
            agentId: agentId!,
            agent,
            userText,
            images,
            senderId,
            senderInfo,
            sessionId,
            wsBroadcaster: this.ws,
            persistUserMessage: this.persistUserMessage.bind(this),
            persistAssistantMessage: this.persistAssistantMessage.bind(this),
          });

          await sseHandler.handle(res);
        } else {
          const userMsgPersisted = await this.persistUserMessage(agentId!, userText, senderId, images, sessionId);
          let reply: string;
          try {
            reply = await agent.handleMessage(userText, senderId, senderInfo, { images });
          } catch (err) {
            const errText = `⚠ AI service error: ${String(err).slice(0, 500)}`;
            void this.persistAssistantMessage(
              userMsgPersisted, agentId!, errText, 0, { isError: true },
            );
            throw err;
          }
          this.ws.broadcastChat(agentId!, reply, 'agent');
          this.json(res, 200, { reply, sessionId: userMsgPersisted });
          void this.persistAssistantMessage(
            userMsgPersisted,
            agentId!,
            reply,
            agent.getState().tokensUsedToday
          );
        }

        const _st = agent.getState();
        this.ws.broadcastAgentUpdate(agentId!, _st.status, { lastError: _st.lastError, lastErrorAt: _st.lastErrorAt, currentActivity: _st.currentActivity });
        return;
      }
    }

    if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === 'DELETE') {
      const agentId = path.split('/')[3]!;
      if (this.gateway) {
        const extReg = this.gateway.listRegistrations().find(r => r.markusAgentId === agentId);
        if (extReg) {
          await this.gateway.unregister(extReg.externalAgentId, extReg.orgId);
        }
      }
      await this.orgService.fireAgent(agentId);
      this.json(res, 200, { deleted: true });
      return;
    }

    // ── Group Chats ──────────────────────────────────────────────────────────────
    if (path === '/api/group-chats' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const teams = this.orgService.listTeamsWithMembers(orgId);
      const groupChats = teams.map(t => ({
        id: `group:${t.id}`,
        name: t.name,
        type: 'team' as const,
        teamId: t.id,
        memberCount: t.members.length,
        channelKey: `group:${t.id}`,
      }));
      // Also include custom group chats stored in localStorage-style metadata
      const customChats = this.customGroupChats.filter(c => c.orgId === orgId);
      this.json(res, 200, {
        chats: [
          ...groupChats,
          ...customChats.map(c => ({
            id: c.id,
            name: c.name,
            type: 'custom' as const,
            creatorId: c.creatorId,
            creatorName: c.creatorName,
            memberCount: c.memberIds?.length ?? 0,
            channelKey: c.id,
          })),
        ],
      });
      return;
    }

    if (path === '/api/group-chats' && req.method === 'POST') {
      const body = await this.readBody(req);
      const name = body['name'] as string;
      const orgId = (body['orgId'] as string) ?? 'default';
      const creatorId = body['creatorId'] as string;
      const creatorName = body['creatorName'] as string;
      const memberIds = body['memberIds'] as string[] | undefined;
      if (!name) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      const chatId = `group:custom:${Date.now().toString(36)}`;
      const chat = {
        id: chatId,
        name,
        orgId,
        creatorId,
        creatorName,
        memberIds: memberIds ?? [],
        createdAt: new Date().toISOString(),
      };
      this.customGroupChats.push(chat);
      this.ws?.broadcast({
        type: 'chat:group_created',
        payload: { chatId, name, creatorId, creatorName },
        timestamp: new Date().toISOString(),
      });
      this.json(res, 201, {
        chat: { id: chatId, name, type: 'custom', creatorId, creatorName, channelKey: chatId },
      });
      return;
    }

    // Teams
    if (path === '/api/teams' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const teams = this.orgService.listTeamsWithMembers(orgId);
      const ungrouped = this.orgService.listUngroupedMembers(orgId);
      this.json(res, 200, { teams, ungrouped });
      return;
    }

    if (path === '/api/teams' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const body = await this.readBody(req);
      const orgId = (body['orgId'] as string) ?? authUser.orgId ?? 'default';
      const name = body['name'] as string;
      if (!name) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      const team = await this.orgService.createTeam(
        orgId,
        name,
        body['description'] as string | undefined
      );
      // Notify Chat page so the new team appears as a group chat
      this.ws?.broadcast({
        type: 'chat:group_created',
        payload: {
          chatId: `group:${team.id}`,
          name: team.name,
          creatorId: authUser.userId,
          creatorName: '',
        },
        timestamp: new Date().toISOString(),
      });
      this.json(res, 201, { team });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+$/) && req.method === 'PATCH') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const team = await this.orgService.updateTeam(teamId, {
        name: body['name'] as string | undefined,
        description: body['description'] as string | undefined,
        managerId: body['managerId'] as string | undefined,
        managerType: body['managerType'] as 'human' | 'agent' | undefined,
      });
      this.json(res, 200, { team });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const deleteMembers = url.searchParams.get('deleteMembers') === 'true';
      await this.orgService.deleteTeam(teamId, deleteMembers);
      this.json(res, 200, { deleted: true });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const memberId = body['memberId'] as string;
      const memberType = body['memberType'] as 'human' | 'agent';
      if (!memberId || !memberType) {
        this.json(res, 400, { error: 'memberId and memberType are required' });
        return;
      }
      this.orgService.addMemberToTeam(teamId, memberId, memberType);
      this.ws.broadcastTeamUpdate(teamId, { action: 'member-added', memberId });
      this.json(res, 200, { ok: true });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const parts = path.split('/');
      const teamId = parts[3]!;
      const memberId = parts[5]!;
      this.orgService.removeMemberFromTeam(teamId, memberId);
      this.ws.broadcastTeamUpdate(teamId, { action: 'member-removed', memberId });
      this.json(res, 200, { ok: true });
      return;
    }

    // Team batch start
    if (path.match(/^\/api\/teams\/[^/]+\/start$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.startTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch stop
    if (path.match(/^\/api\/teams\/[^/]+\/stop$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.stopTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch pause
    if (path.match(/^\/api\/teams\/[^/]+\/pause$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const result = this.orgService.pauseTeamAgents(teamId, body['reason'] as string | undefined);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch resume
    if (path.match(/^\/api\/teams\/[^/]+\/resume$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = this.orgService.resumeTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team agent status
    if (path.match(/^\/api\/teams\/[^/]+\/status$/) && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const teamId = path.split('/')[3]!;
      const statuses = this.orgService.getTeamAgentStatuses(teamId);
      this.json(res, 200, { agents: statuses });
      return;
    }

    // Roles
    if (path === '/api/roles' && req.method === 'GET') {
      const roleNames = this.orgService.listAvailableRoles();
      const roles = roleNames.map(name => {
        try {
          const details = this.orgService.getRoleDetails(name);
          return {
            id: name,
            name,
            description: details.description ?? '',
            category: details.category ?? 'custom',
          };
        } catch {
          return { id: name, name, description: '', category: 'custom' };
        }
      });
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
      const status = url.searchParams.get('status') as TaskStatus | undefined;
      const assignedAgentId = url.searchParams.get('assignedAgentId') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const iterationId = url.searchParams.get('iterationId') ?? undefined;
      const tasks = this.taskService.listTasks({ orgId, status, assignedAgentId, projectId, iterationId });
      this.json(res, 200, { tasks });
      return;
    }

    if (path === '/api/tasks/dashboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const dashboard = this.taskService.getDashboard(orgId);
      this.json(res, 200, dashboard);
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const task = this.taskService.getTask(taskId);
      if (!task) {
        this.json(res, 404, { error: `Task not found: ${taskId}` });
        return;
      }
      this.json(res, 200, { task });
      return;
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const authUser = await this.getAuthUser(req);
      const body = await this.readBody(req);
      const task = this.taskService.createTask({
        orgId: (body['orgId'] as string) ?? 'default',
        title: body['title'] as string,
        description: body['description'] as string,
        priority: body['priority'] as TaskPriority | undefined,
        assignedAgentId: body['assignedAgentId'] as string | undefined,
        requiredSkills: body['requiredSkills'] as string[] | undefined,
        autoAssign: body['autoAssign'] as boolean | undefined,
        projectId: body['projectId'] as string | undefined,
        iterationId: body['iterationId'] as string | undefined,
        blockedBy: Array.isArray(body['blockedBy']) ? body['blockedBy'] as string[] : undefined,
        requirementId: body['requirementId'] as string | undefined,
        createdBy: authUser?.userId ?? 'unknown',
        creatorRole: 'human',
      });
      this.json(res, 201, { task });
      return;
    }

    if (path.startsWith('/api/tasks/') && req.method === 'PUT') {
      const authUser = await this.getAuthUser(req);
      const taskId = path.split('/')[3]!;
      const body = await this.readBody(req);

      if (body['status']) {
        const task = this.taskService.updateTaskStatus(taskId, body['status'] as TaskStatus, authUser?.userId);
        this.json(res, 200, { task });
        return;
      }

      if ('assignedAgentId' in body) {
        const agentId = body['assignedAgentId'] as string | null;
        const task = agentId
          ? this.taskService.assignTask(taskId, agentId)
          : this.taskService.unassignTask(taskId);
        this.json(res, 200, { task });
        return;
      }

      // General field update (title/description/priority/projectId/iterationId/blockedBy)
      if (
        body['title'] !== undefined ||
        body['description'] !== undefined ||
        body['priority'] !== undefined ||
        body['projectId'] !== undefined ||
        body['iterationId'] !== undefined ||
        body['blockedBy'] !== undefined
      ) {
        const task = this.taskService.updateTask(taskId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
          projectId: body['projectId'] !== undefined ? (body['projectId'] as string | null) : undefined,
          iterationId: body['iterationId'] !== undefined ? (body['iterationId'] as string | null) : undefined,
          blockedBy: Array.isArray(body['blockedBy']) ? body['blockedBy'] as string[] : undefined,
        }, authUser?.userId);
        this.json(res, 200, { task });
        return;
      }

      this.json(res, 400, { error: 'Provide status, assignedAgentId, or task fields to update' });
      return;
    }

    // Task approve/reject — the only way to transition out of pending_approval.
    // If the UI changed the assignee before approving, that's already on the task object.
    if (path.match(/^\/api\/tasks\/[^/]+\/approve$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.approveTask(taskId);
        this.json(res, 200, { task });
      } catch (err: unknown) {
        this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/reject$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.rejectTask(taskId);
        this.json(res, 200, { task });
      } catch (err: unknown) {
        this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (path.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const taskId = path.split('/')[3]!;
      this.taskService.deleteTask(taskId);
      this.json(res, 200, { ok: true });
      return;
    }

    // Subtasks
    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const subtasks = this.taskService.listSubtasks(taskId);
      this.json(res, 200, { subtasks });
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'POST') {
      const body = await this.readBody(req);
      const parentId = path.split('/')[3]!;
      const parent = this.taskService.getTask(parentId);
      if (!parent) {
        this.json(res, 404, { error: 'Parent task not found' });
        return;
      }
      const subtask = this.taskService.createTask({
        orgId: parent.orgId,
        title: body['title'] as string,
        description: (body['description'] as string) ?? '',
        priority: (body['priority'] as TaskPriority) ?? 'medium',
        parentTaskId: parentId,
      });
      this.json(res, 201, { subtask });
      return;
    }

    if (path === '/api/taskboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const iterationId = url.searchParams.get('iterationId') ?? undefined;
      const board = this.taskService.getTaskBoard(orgId, { projectId, iterationId });
      this.json(res, 200, { board });
      return;
    }

    // Comprehensive operations dashboard
    if (path === '/api/ops/dashboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      const period = (url.searchParams.get('period') ?? '24h') as '1h' | '24h' | '7d';
      const opsDashboard = this.buildOpsDashboard(orgId, period);
      this.json(res, 200, opsDashboard);
      return;
    }

    // Task execution: run a task with its assigned agent (fire-and-forget)
    if (path.match(/^\/api\/tasks\/[^/]+\/run$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        await this.taskService.runTask(taskId);
        this.json(res, 202, { status: 'running', taskId });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Task execution logs
    if (path.match(/^\/api\/tasks\/[^/]+\/logs$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { logs: [] });
        return;
      }
      try {
        const logs = await this.storage.taskLogRepo.getByTask(taskId);
        this.json(res, 200, { logs });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task comments — add a comment (text + optional image attachments)
    if (path.match(/^\/api\/tasks\/[^/]+\/comments$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      if (!this.storage?.taskCommentRepo) {
        this.json(res, 500, { error: 'Storage not available' });
        return;
      }
      try {
        const body = await this.readBody(req);
        const comment = await this.storage.taskCommentRepo.add({
          taskId,
          authorId: (body['authorId'] as string) ?? 'human',
          authorName: (body['authorName'] as string) ?? 'User',
          authorType: (body['authorType'] as string) ?? 'human',
          content: body['content'] as string,
          attachments: body['attachments'] as unknown[] | undefined,
        });
        // Broadcast real-time comment event via WS
        this.ws?.broadcast({
          type: 'task:comment',
          payload: {
            taskId,
            comment: {
              id: comment.id,
              taskId: comment.taskId,
              authorId: comment.authorId,
              authorName: comment.authorName,
              authorType: comment.authorType,
              content: comment.content,
              attachments: comment.attachments,
              createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
            },
          },
          timestamp: new Date().toISOString(),
        });
        this.json(res, 201, { comment });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task comments — list comments for a task
    if (path.match(/^\/api\/tasks\/[^/]+\/comments$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!this.storage?.taskCommentRepo) {
        this.json(res, 200, { comments: [] });
        return;
      }
      try {
        const comments = await this.storage.taskCommentRepo.getByTask(taskId);
        this.json(res, 200, { comments });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task pause — explicitly pause a running task
    if (path.match(/^\/api\/tasks\/[^/]+\/pause$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.getTask(taskId);
        if (!task) { this.json(res, 404, { error: 'Task not found' }); return; }
        if (task.status !== 'in_progress') {
          this.json(res, 400, { error: `Cannot pause task in ${task.status} status` });
          return;
        }
        const nextStatus = task.assignedAgentId ? 'assigned' : 'pending';
        this.taskService.updateTaskStatus(taskId, nextStatus as any);
        this.json(res, 200, { status: nextStatus, taskId });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Task resume — resume a paused task
    if (path.match(/^\/api\/tasks\/[^/]+\/resume$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        await this.taskService.runTask(taskId);
        this.json(res, 202, { status: 'running', taskId });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
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
      const org = await this.orgService.createOrganization(
        body['name'] as string,
        (body['ownerId'] as string) ?? 'default'
      );
      this.json(res, 201, { org });
      return;
    }

    // Agent metrics — must be before the generic GET /api/agents/:id handler
    if (path.match(/^\/api\/agents\/[^/]+\/metrics$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const period = (url.searchParams.get('period') ?? '24h') as '1h' | '24h' | '7d';
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const metrics = agent.getMetrics(period);
        this.json(res, 200, metrics);
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent config update (PATCH)
    if (path.match(/^\/api\/agents\/[^/]+\/config$/) && req.method === 'PATCH') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const cfg = agent.config as unknown as Record<string, unknown>;
        if (body['name'] !== undefined) cfg.name = body['name'];
        if (body['agentRole'] !== undefined) cfg.agentRole = body['agentRole'];
        if (body['skills'] !== undefined) cfg.skills = body['skills'];
        if (body['llmConfig'] !== undefined) {
          const lc = body['llmConfig'] as Record<string, unknown>;
          cfg.llmConfig = { ...(cfg.llmConfig as Record<string, unknown>), ...lc };
        }
        if (body['heartbeatIntervalMs'] !== undefined)
          cfg.heartbeatIntervalMs = body['heartbeatIntervalMs'];

        // Persist config changes to DB
        if (this.storage) {
          try {
            await this.storage.agentRepo.updateConfig(agentId, {
              name: body['name'] as string | undefined,
              agentRole: body['agentRole'] as string | undefined,
              skills: body['skills'] as unknown,
              llmConfig: cfg.llmConfig,
              heartbeatIntervalMs: body['heartbeatIntervalMs'] as number | undefined,
            });
          } catch (persistErr) {
            log.warn('Failed to persist agent config to DB', { agentId, error: String(persistErr) });
          }
        }

        this.json(res, 200, { ok: true, config: agent.config });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent memory summary
    if (path.match(/^\/api\/agents\/[^/]+\/memory$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const mem = agent.getMemory();
        const entries = mem.getEntries(undefined, 50);
        const sessions = mem.listSessions(agentId);
        const dailyLog = mem.getDailyLog();
        const recentDailyLogs = mem.getRecentDailyLogs(7);
        const longTermMemory = mem.getLongTermMemory();
        this.json(res, 200, {
          entries: entries.map(e => ({
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
            importance: (e as unknown as Record<string, unknown>).importance,
          })),
          sessions: sessions.map(s => ({
            id: s.id,
            agentId: s.agentId,
            messageCount: s.messages.length,
            createdAt:
              ((s as unknown as Record<string, unknown>).createdAt as string) ??
              new Date().toISOString(),
            updatedAt:
              ((s as unknown as Record<string, unknown>).updatedAt as string) ??
              new Date().toISOString(),
          })),
          dailyLog: dailyLog?.slice(0, 2000) ?? null,
          recentDailyLogs: recentDailyLogs?.slice(0, 5000) ?? null,
          longTermMemory: longTermMemory?.slice(0, 3000) ?? null,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent memory session messages
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/sessions\/[^/]+$/) && req.method === 'GET') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const sessionId = decodeURIComponent(parts[6]!);
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const session = agent.getMemory().getSession(sessionId);
        if (!session) {
          this.json(res, 404, { error: `Session not found: ${sessionId}` });
          return;
        }
        this.json(res, 200, {
          id: session.id,
          agentId: session.agentId,
          startedAt: session.startedAt,
          lastActivityAt: session.lastActivityAt,
          messages: session.messages.map(m => ({
            role: m.role,
            content: getTextContent(m.content).slice(0, 2000),
            ...(m.toolCalls?.length ? {
              toolCalls: m.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments).slice(0, 1000),
              })),
            } : {}),
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          })),
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent memory: update daily log
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/daily$/) && req.method === 'PUT') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const content = (body['content'] as string) ?? '';
        agent.getMemory().writeDailyLog(agentId, content);
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent memory: update long-term memory
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/longterm$/) && req.method === 'PUT') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const key = (body['key'] as string) ?? '';
        const content = (body['content'] as string) ?? '';
        agent.getMemory().addLongTermMemory(key, content);
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent role/prompt files: list
    if (path.match(/^\/api\/agents\/[^/]+\/files$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const roleDir = this.resolveAgentRoleDir(agent);
        if (!roleDir) {
          this.json(res, 404, { error: `Role directory not found for agent: ${agent.role.name}` });
          return;
        }
        const allowedNames = ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
        const files: Array<{ name: string; content: string }> = [];
        for (const name of allowedNames) {
          const filePath = join(roleDir, name);
          if (existsSync(filePath)) {
            files.push({ name, content: readFileSync(filePath, 'utf-8') });
          }
        }
        this.json(res, 200, { files });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent role/prompt files: update
    if (path.match(/^\/api\/agents\/[^/]+\/files\/[^/]+$/) && req.method === 'PUT') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const roleDir = this.resolveAgentRoleDir(agent);
        if (!roleDir) {
          this.json(res, 404, { error: `Role directory not found for agent: ${agent.role.name}` });
          return;
        }
        const allowedNames = ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
        if (!allowedNames.includes(filename)) {
          this.json(res, 400, { error: `Invalid filename. Allowed: ${allowedNames.join(', ')}` });
          return;
        }
        const body = await this.readBody(req);
        const content = (body['content'] as string) ?? '';
        writeFileSync(join(roleDir, filename), content, 'utf-8');
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent system prompt: update (runtime only)
    if (path.match(/^\/api\/agents\/[^/]+\/system-prompt$/) && req.method === 'PUT') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const systemPrompt = (body['systemPrompt'] as string) ?? '';
        (agent.role as { systemPrompt: string }).systemPrompt = systemPrompt;
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent skills: add
    if (path.match(/^\/api\/agents\/[^/]+\/skills$/) && req.method === 'POST') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const skillName = (body['skillName'] as string) ?? '';
        if (skillName && !agent.config.skills.includes(skillName)) {
          agent.config.skills.push(skillName);
          // Inject skill instructions into the running agent so it can use them immediately
          if (this.skillRegistry) {
            const skill = this.skillRegistry.get(skillName);
            if (skill?.manifest.instructions) {
              agent.injectSkillInstructions(skillName, skill.manifest.instructions);
            }
          }
        }
        if (this.storage) {
          try { await this.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill assignment', { agentId, error: String(e) }); }
        }
        this.json(res, 200, { ok: true, skills: agent.config.skills });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent skills: remove
    if (path.match(/^\/api\/agents\/[^/]+\/skills\/[^/]+$/) && req.method === 'DELETE') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const skillName = decodeURIComponent(parts[5]!);
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        agent.config.skills = agent.config.skills.filter(s => s !== skillName);
        if (this.storage) {
          try { await this.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill removal', { agentId, error: String(e) }); }
        }
        this.json(res, 200, { ok: true, skills: agent.config.skills });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent tools: toggle enable/disable (skeleton - tools can't easily be toggled at runtime)
    if (path.match(/^\/api\/agents\/[^/]+\/tools\/[^/]+\/toggle$/) && req.method === 'POST') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const toolName = decodeURIComponent(parts[5]!);
      try {
        this.orgService.getAgentManager().getAgent(agentId);
        const body = await this.readBody(req);
        const enabled = (body['enabled'] as boolean) ?? true;
        void toolName;
        void enabled;
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent recent activities — list summary of in-memory activities
    if (path.match(/^\/api\/agents\/[^/]+\/recent-activities$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const activities = agent.getRecentActivities();
        this.json(res, 200, { activities });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent activity logs — fetch in-memory activity log for a given activity ID
    if (path.match(/^\/api\/agents\/[^/]+\/activity-logs$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const activityId = url.searchParams.get('activityId');
      if (!activityId) {
        this.json(res, 400, { error: 'activityId query parameter is required' });
        return;
      }
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const logs = agent.getActivityLogs(activityId);
        const activity = agent.getCurrentActivity();
        this.json(res, 200, { logs, activity: activity?.id === activityId ? activity : undefined });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent heartbeat info
    if (path.match(/^\/api\/agents\/[^/]+\/heartbeat$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const hb = (
          agent as unknown as { heartbeat: { getHealthMetrics(): unknown; isRunning(): boolean } }
        ).heartbeat;
        this.json(res, 200, {
          running: hb.isRunning(),
          ...(hb.getHealthMetrics() as Record<string, unknown>),
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent detail (GET) — enriched with config, tools, heartbeat summary
    if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const state = agent.getState();
        const tools = (
          agent as unknown as { tools: Map<string, { name: string; description: string }> }
        ).tools;
        const toolList = [...tools.values()].map(t => ({
          name: t.name,
          description: t.description,
        }));
        const hb = (
          agent as unknown as { heartbeat: { getHealthMetrics(): unknown; isRunning(): boolean } }
        ).heartbeat;
        let heartbeatSummary: Record<string, unknown> = {};
        try {
          heartbeatSummary = {
            running: hb.isRunning(),
            ...(hb.getHealthMetrics() as Record<string, unknown>),
          };
        } catch {
          /* ok */
        }
        this.json(res, 200, {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          roleDescription: agent.role.description,
          agentRole: agent.config.agentRole,
          state,
          activeTaskCount: state.activeTaskCount,
          activeTaskIds: state.activeTaskIds,
          skills: agent.config.skills,
          proficiency: agent.getSkillProficiency(),
          config: {
            llmConfig: agent.config.llmConfig,
            channels: agent.config.channels,
            heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
            orgId: agent.config.orgId,
            teamId: agent.config.teamId,
            createdAt: agent.config.createdAt,
          },
          tools: toolList,
          heartbeat: heartbeatSummary,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // ── Review Service ─────────────────────────────────────────────────────
    if (path === '/api/reviews' && req.method === 'POST') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const body = await this.readBody(req);
      const report = await this.reviewService.runReview({
        taskId: body['taskId'] as string | undefined,
        agentId: body['agentId'] as string | undefined,
        changedFiles: body['changedFiles'] as string[] | undefined,
        description: body['description'] as string | undefined,
      });
      this.json(res, 200, report);
      return;
    }

    if (path === '/api/reviews' && req.method === 'GET') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const taskId = url.searchParams.get('taskId');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const reports = taskId
        ? this.reviewService.getReportsByTask(taskId)
        : this.reviewService.getRecentReports(limit);
      this.json(res, 200, { reports });
      return;
    }

    if (path.match(/^\/api\/reviews\/[^/]+$/) && req.method === 'GET') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const reviewId = path.split('/')[3]!;
      const report = this.reviewService.getReport(reviewId);
      if (!report) {
        this.json(res, 404, { error: 'Review not found' });
        return;
      }
      this.json(res, 200, report);
      return;
    }

    // ── External Agent Gateway ──────────────────────────────────────────────
    if (path === '/api/gateway/info' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Admin access required' });
        return;
      }
      const host = req.headers['host'] ?? `localhost:${this.port}`;
      const proto = req.headers['x-forwarded-proto'] ?? 'http';
      const gatewayUrl = `${proto}://${host}/api/gateway`;
      const secret = this.gatewaySecret ?? '';
      const masked = secret.length > 8
        ? secret.slice(0, 4) + '*'.repeat(secret.length - 8) + secret.slice(-4)
        : secret;
      this.json(res, 200, {
        gatewayUrl,
        orgId: 'default',
        orgSecret: masked,
        orgSecretFull: secret,
        enabled: !!this.gateway,
      });
      return;
    }

    if (path === '/api/gateway/register' && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const body = await this.readBody(req);
      try {
        const reg = await this.gateway.register({
          externalAgentId: body['agentId'] as string,
          agentName: body['agentName'] as string,
          orgId: body['orgId'] as string,
          capabilities: (body['capabilities'] as string[]) ?? [],
          openClawConfig: body['openClawConfig'] as string | undefined,
        });
        this.json(res, 201, reg);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/auth' && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const body = await this.readBody(req);
      try {
        const result = this.gateway.authenticate({
          externalAgentId: body['agentId'] as string,
          orgId: body['orgId'] as string,
          secret: body['secret'] as string,
        });
        this.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/message' && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Missing Bearer token' });
        return;
      }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const body = await this.readBody(req);
        const result = await this.gateway.routeMessage(token, {
          type: body['type'] as 'task' | 'status' | 'heartbeat',
          content: body['content'] as string,
          metadata: body['metadata'] as Record<string, unknown> | undefined,
        });
        this.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/status' && req.method === 'GET') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Missing Bearer token' });
        return;
      }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const status = this.gateway.getStatus(token);
        this.json(res, 200, status);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Manual / Handbook ──────────────────────────────────────────
    if (path === '/api/gateway/manual' && req.method === 'GET') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Missing Bearer token' });
        return;
      }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const reg = this.gateway.listRegistrations(token.orgId)
          .find(r => r.externalAgentId === token.externalAgentId);

        const colleagues: HandbookColleague[] = this.orgService.getAgentManager().listAgents()
          .filter(a => a.id !== token.markusAgentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
        const mgr = colleagues.find(c => {
          const all = this.orgService.getAgentManager().listAgents();
          return all.find(a => a.id === c.id && a.agentRole === 'manager');
        });

        const projects: HandbookProject[] = this.projectService
          ? this.projectService.listProjects(token.orgId).map(p => {
              const iter = this.projectService!.getActiveIteration(p.id);
              return { id: p.id, name: p.name, currentIteration: iter?.name };
            })
          : [];

        const handbook = generateHandbook({
          baseUrl: `http://localhost:${this.port}`,
          orgName: token.orgId,
          agentName: reg?.agentName,
          markusAgentId: token.markusAgentId,
          colleagues,
          manager: mgr ? { id: mgr.id, name: mgr.name } : undefined,
          projects,
        });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(handbook);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Team Context ────────────────────────────────────────────────
    if (path === '/api/gateway/team' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const agents = this.orgService.getAgentManager().listAgents();
        const colleagues = agents
          .filter(a => a.id !== token.markusAgentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status, agentRole: a.agentRole, skills: a.skills }));
        const manager = agents.find(a => a.agentRole === 'manager' && a.id !== token.markusAgentId);
        this.json(res, 200, {
          colleagues,
          manager: manager ? { id: manager.id, name: manager.name } : null,
        });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Projects ────────────────────────────────────────────────────
    if (path === '/api/gateway/projects' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        if (!this.projectService) { this.json(res, 200, { projects: [] }); return; }
        const projects = this.projectService.listProjects(token.orgId).map(p => {
          const iter = this.projectService!.getActiveIteration(p.id);
          const iterations = this.projectService!.listIterations(p.id);
          return {
            id: p.id, name: p.name, description: p.description, status: p.status,
            iterationModel: p.iterationModel,
            currentIteration: iter ? { id: iter.id, name: iter.name, status: iter.status } : null,
            iterationCount: iterations.length,
            teamIds: p.teamIds,
          };
        });
        this.json(res, 200, { projects });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Requirements ────────────────────────────────────────────────
    if (path === '/api/gateway/requirements' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        if (!this.requirementService) { this.json(res, 200, { requirements: [] }); return; }
        const url = new URL(req.url!, `http://localhost`);
        const projectId = url.searchParams.get('project_id') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const reqs = this.requirementService.listRequirements({
          orgId: token.orgId,
          projectId,
          status: status as any,
        }).map(r => ({
          id: r.id, title: r.title, description: r.description,
          status: r.status, priority: r.priority,
          projectId: r.projectId, iterationId: r.iterationId,
          source: r.source, createdAt: r.createdAt,
        }));
        this.json(res, 200, { requirements: reqs });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Knowledge ──────────────────────────────────────────────────
    if (path === '/api/gateway/knowledge/search' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        this.gateway.verifyToken(authHeader.slice(7));
        const query = url.searchParams.get('query') ?? '';
        const scope = url.searchParams.get('scope') as any;
        const category = url.searchParams.get('category') as any;
        this.json(res, 200, {
          results: this.knowledgeService?.search({ query, scope, category }) ?? [],
        });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/knowledge' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        if (!this.knowledgeService) { this.json(res, 503, { error: 'Knowledge service not available' }); return; }
        const body = await this.readBody(req);
        const entry = this.knowledgeService.contribute({
          scope: body['scope'] as any,
          scopeId: body['scopeId'] as string ?? token.orgId,
          category: body['category'] as any,
          title: body['title'] as string,
          content: body['content'] as string,
          source: token.markusAgentId ?? 'external',
          importance: body['importance'] as number,
          tags: body['tags'] as string[],
          supersedes: body['supersedes'] as string,
        });
        this.json(res, 201, { entry });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/gateway\/knowledge\/[^/]+\/flag-outdated$/) && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        this.gateway.verifyToken(authHeader.slice(7));
        if (!this.knowledgeService) { this.json(res, 503, { error: 'Knowledge service not available' }); return; }
        const knowledgeId = path.split('/')[4]!;
        const body = await this.readBody(req);
        this.knowledgeService.flagOutdated(knowledgeId, (body['reason'] as string) ?? '');
        this.json(res, 200, { status: 'flagged' });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Sync Endpoint ──────────────────────────────────────────────
    if (path === '/api/gateway/sync' && req.method === 'POST') {
      if (!this.gateway || !this.syncHandler) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Missing Bearer token' });
        return;
      }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const body = await this.readBody(req) as SyncRequest;
        const result = await this.syncHandler.handleSync(token.markusAgentId, token.orgId, body);
        this.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Task Lifecycle Endpoints ────────────────────────────────────
    const gwTaskMatch = path.match(/^\/api\/gateway\/tasks\/([^/]+)\/(accept|progress|complete|fail|delegate|subtasks)$/);
    if (gwTaskMatch && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'Gateway not configured' });
        return;
      }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        this.json(res, 401, { error: 'Missing Bearer token' });
        return;
      }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const taskId = gwTaskMatch[1]!;
        const action = gwTaskMatch[2]!;
        const body = await this.readBody(req);

        switch (action) {
          case 'accept': {
            const task = this.taskService.updateTaskStatus(taskId, 'in_progress', `ext:${token.markusAgentId}`);
            this.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'progress': {
            const task = this.taskService.getTask(taskId);
            if (!task) { this.json(res, 404, { error: 'Task not found' }); break; }
            if (task.status !== 'in_progress') {
              try { this.taskService.updateTaskStatus(taskId, 'in_progress', `ext:${token.markusAgentId}`); } catch { /* already in_progress */ }
            }
            this.json(res, 200, { taskId, progress: body['progress'], acknowledged: true });
            break;
          }
          case 'complete': {
            const task = this.taskService.updateTaskStatus(taskId, 'completed', `ext:${token.markusAgentId}`);
            this.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'fail': {
            const task = this.taskService.updateTaskStatus(taskId, 'failed', `ext:${token.markusAgentId}`);
            this.json(res, 200, { task: { id: task.id, status: task.status } });
            break;
          }
          case 'delegate': {
            const task = this.taskService.unassignTask(taskId);
            this.json(res, 200, { task: { id: task.id, status: task.status }, delegated: true });
            break;
          }
          case 'subtasks': {
            const parentTask = this.taskService.getTask(taskId);
            if (!parentTask) { this.json(res, 404, { error: 'Parent task not found' }); break; }
            const subtask = this.taskService.createTask({
              title: body['title'] as string,
              description: (body['description'] as string) ?? '',
              priority: (body['priority'] as TaskPriority) ?? 'medium',
              orgId: parentTask.orgId,
              parentTaskId: taskId,
              assignedAgentId: token.markusAgentId,
              createdBy: `ext:${token.markusAgentId}`,
            });
            this.json(res, 201, { task: { id: subtask.id, title: subtask.title, status: subtask.status } });
            break;
          }
        }
      } catch (err) {
        if (err instanceof GatewayError) {
          this.json(res, err.statusCode, { error: err.message });
          return;
        }
        this.json(res, 500, { error: String(err) });
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
      const orgId = (body['orgId'] as string) ?? 'default';
      const name = body['name'] as string;
      const role = (body['role'] as 'owner' | 'admin' | 'member' | 'guest') ?? 'member';
      const email = body['email'] as string | undefined;
      const password = body['password'] as string | undefined;
      const teamId = body['teamId'] as string | undefined;
      const userId = (body['id'] as string | undefined) ?? generateId('usr');

      // Persist to DB if storage is available and password is provided (for login-capable users)
      if (this.storage && (email || password)) {
        const passwordHash = password ? await hashPassword(password) : undefined;
        await this.storage.userRepo.create({
          id: userId,
          orgId,
          name,
          email: email ?? `${userId}@markus.local`,
          role,
          passwordHash,
        });
      }

      const user = this.orgService.addHumanUser(orgId, name, role, { id: userId, email });

      // Add to team if specified
      if (teamId) {
        try {
          this.orgService.addMemberToTeam(teamId, userId, 'human');
        } catch {
          /* ok */
        }
      }

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
      const images = (body['images'] as string[] | undefined)?.filter(Boolean);
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);
      const agent = this.orgService.getAgentManager().getAgent(targetAgentId);
      this.ws.broadcastAgentUpdate(targetAgentId, 'working');

      const stream = body['stream'] as boolean | undefined;
      if (stream) {
        const userText = body['text'] as string;

        // Persist user message to smart channel before LLM call so it's never lost
        if (this.storage) {
          void this.storage.channelMessageRepo
            .append({
              orgId: targetOrgId,
              channel: 'smart:default',
              senderId: senderId ?? 'anonymous',
              senderType: 'human',
              senderName: senderInfo?.name ?? 'You',
              text: userText,
              mentions: [],
            })
            .catch(err => log.warn('Failed to persist smart user message', { error: String(err) }));
        }

        const sseHandler = new SSEHandler({
          agentId: targetAgentId,
          agent,
          userText,
          images,
          senderId,
          senderInfo,
          onTextDelta: _text => {
            // Smart channels don't need WebSocket broadcast
          },
          onToolEvent: _event => {
            // Tool event handling hook
          },
          onComplete: async (reply, segments, tokensUsed) => {
            const smartMeta = segments.length > 0 ? { segments } : undefined;
            void this.persistChatTurn(
              targetAgentId,
              userText,
              reply,
              senderId,
              tokensUsed,
              smartMeta
            );

            if (this.storage) {
              void this.storage.channelMessageRepo
                .append({
                  orgId: targetOrgId,
                  channel: 'smart:default',
                  senderId: targetAgentId,
                  senderType: 'agent',
                  senderName: agent.config.name,
                  text: reply,
                  mentions: [],
                })
                .catch(err =>
                  log.warn('Failed to persist smart agent reply', { error: String(err) })
                );
            }
          },
          onError: async (error) => {
            if (!this.storage) return;
            const errText = `⚠ AI service error: ${String(error).slice(0, 500)}`;
            void this.storage.channelMessageRepo
              .append({
                orgId: targetOrgId,
                channel: 'smart:default',
                senderId: targetAgentId,
                senderType: 'system',
                senderName: 'System',
                text: errText,
                mentions: [],
              })
              .catch(e => log.warn('Failed to persist smart error message', { error: String(e) }));
          },
        });

        await sseHandler.handle(res);
      } else {
        const userText = body['text'] as string;
        // Persist user message before LLM call
        if (this.storage) {
          void this.storage.channelMessageRepo
            .append({
              orgId: targetOrgId,
              channel: 'smart:default',
              senderId: senderId ?? 'anonymous',
              senderType: 'human',
              senderName: senderInfo?.name ?? 'You',
              text: userText,
              mentions: [],
            })
            .catch(err => log.warn('Failed to persist smart user message', { error: String(err) }));
        }
        let reply: string;
        try {
          reply = await agent.handleMessage(userText, senderId, senderInfo, { images });
        } catch (err) {
          const errText = `⚠ AI service error: ${String(err).slice(0, 500)}`;
          if (this.storage) {
            void this.storage.channelMessageRepo
              .append({
                orgId: targetOrgId,
                channel: 'smart:default',
                senderId: targetAgentId,
                senderType: 'system',
                senderName: 'System',
                text: errText,
                mentions: [],
              })
              .catch(e => log.warn('Failed to persist smart error message', { error: String(e) }));
          }
          throw err;
        }
        this.json(res, 200, { reply, agentId: targetAgentId });
        void this.persistChatTurn(
          targetAgentId,
          userText,
          reply,
          senderId,
          agent.getState().tokensUsedToday
        );
        if (this.storage) {
          void this.storage.channelMessageRepo
            .append({
              orgId: targetOrgId,
              channel: 'smart:default',
              senderId: targetAgentId,
              senderType: 'agent',
              senderName: agent.config.name,
              text: reply,
              mentions: [],
            })
            .catch(err => log.warn('Failed to persist smart agent reply', { error: String(err) }));
        }
      }
      const _st2 = agent.getState();
      this.ws.broadcastAgentUpdate(targetAgentId, _st2.status, { lastError: _st2.lastError, lastErrorAt: _st2.lastErrorAt, currentActivity: _st2.currentActivity });
      return;
    }

    // Skills
    if (path === '/api/skills' && req.method === 'GET') {
      // Skills from in-memory registry
      const registrySkills = (this.skillRegistry?.list() ?? [])
        .map(s => ({
          name: s.name,
          version: s.version,
          description: s.description,
          author: s.author,
          category: s.category,
          tags: s.tags,
          hasInstructions: !!s.instructions,
          sourcePath: s.sourcePath,
          type: (s.sourcePath ? 'filesystem' : 'registry') as string,
        }));
      const seen = new Set(registrySkills.map(s => s.name));

      // Live filesystem scan for any skills not yet in registry
      const fsSkills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]; hasInstructions: boolean; sourcePath: string; type: string }> = [];
      for (const dir of WELL_KNOWN_SKILL_DIRS) {
        for (const discovered of discoverSkillsInDir(dir)) {
          if (seen.has(discovered.manifest.name)) continue;
          seen.add(discovered.manifest.name);
          fsSkills.push({
            name: discovered.manifest.name,
            version: discovered.manifest.version,
            description: discovered.manifest.description,
            author: discovered.manifest.author,
            category: discovered.manifest.category,
            tags: discovered.manifest.tags,
            hasInstructions: !!discovered.manifest.instructions,
            sourcePath: discovered.path,
            type: 'filesystem',
          });
        }
      }

      // DB imported skills
      let imported: Array<{ name: string; description: string; category: string; version: string; tags: string[]; hasInstructions: boolean; type: string }> = [];
      if (this.storage) {
        try {
          const mktSkills = (await this.storage.marketplaceSkillRepo.list()) as Array<{ name: string; description: string; category: string; version: string; tags: unknown }>;
          imported = mktSkills
            .filter(s => !seen.has(s.name))
            .map(s => ({
              name: s.name,
              description: s.description,
              category: s.category,
              version: s.version,
              tags: Array.isArray(s.tags) ? s.tags as string[] : [],
              hasInstructions: false,
              type: 'imported',
            }));
        } catch { /* storage unavailable */ }
      }

      const agents = this.orgService.getAgentManager().listAgents();
      const skillAgents: Record<string, string[]> = {};
      for (const agent of agents) {
        for (const skillName of agent.skills) {
          if (!skillAgents[skillName]) skillAgents[skillName] = [];
          skillAgents[skillName]!.push(agent.id);
        }
      }
      const all = [
        ...registrySkills.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
        ...fsSkills.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
        ...imported.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
      ];
      this.json(res, 200, { skills: all });
      return;
    }

    if (path.match(/^\/api\/skills\/[^/]+$/) && req.method === 'GET') {
      const skillName = decodeURIComponent(path.split('/')[3]!);
      if (!this.skillRegistry) {
        this.json(res, 404, { error: 'Skill registry not configured' });
        return;
      }
      const skill = this.skillRegistry.get(skillName);
      if (!skill) {
        this.json(res, 404, { error: `Skill not found: ${skillName}` });
        return;
      }
      const manifest = skill.manifest;
      this.json(res, 200, {
        skill: {
          ...manifest,
          hasInstructions: !!manifest.instructions,
          instructionsPreview: manifest.instructions?.slice(0, 500),
        },
      });
      return;
    }

    // Third-party skill registry — fetch from GitHub repos and cache
    if (path === '/api/skills/registry' && req.method === 'GET') {
      const source = url.searchParams.get('source') ?? 'openclaw';
      const now = Date.now();
      const cacheKey = `skill-registry-${source}`;
      const cached = this.registryCache?.get(cacheKey);
      if (cached && now - cached.ts < 600_000) {
        this.json(res, 200, { skills: cached.data, source, cached: true });
        return;
      }

      try {
        let skills: Array<{ name: string; description: string; category: string; source: string; sourceUrl: string; author: string; addedAt?: string }> = [];

        if (source === 'openclaw') {
          const resp = await fetch('https://raw.githubusercontent.com/LeoYeAI/openclaw-master-skills/main/README.md');
          if (resp.ok) {
            const readme = await resp.text();
            const tableLines = readme.split('\n').filter(l => l.startsWith('| ['));
            for (const line of tableLines) {
              const cols = line.split('|').map(c => c.trim()).filter(Boolean);
              if (cols.length >= 4) {
                const nameMatch = cols[0]?.match(/\[([^\]]+)\]/);
                const name = nameMatch?.[1] ?? '';
                const description = cols[1]?.replace(/\.\.\.$/, '').trim() ?? '';
                const category = cols[2]?.trim() ?? 'Other';
                const srcMatch = cols[3]?.match(/\[GitHub\]\(([^)]+)\)/);
                const addedAt = cols[4]?.trim();
                if (name) {
                  skills.push({
                    name,
                    description,
                    category,
                    source: 'openclaw',
                    sourceUrl: srcMatch?.[1] ?? `https://github.com/LeoYeAI/openclaw-master-skills/tree/main/skills/${name}`,
                    author: 'Community',
                    addedAt,
                  });
                }
              }
            }
          }
        }

        if (!this.registryCache) this.registryCache = new Map();
        this.registryCache.set(cacheKey, { data: skills, ts: now });
        this.json(res, 200, { skills, source, cached: false });
      } catch (err) {
        this.json(res, 500, { error: `Failed to fetch registry: ${String(err)}` });
      }
      return;
    }

    // Install a skill: download to ~/.markus/skills/ and register
    if (path === '/api/skills/install' && req.method === 'POST') {
      const body = await this.readBody(req);
      const skillName = body['name'] as string;
      const source = body['source'] as string | undefined; // 'skillhub' | 'skillssh' | 'openclaw'
      const slug = body['slug'] as string | undefined;
      const sourceUrl = body['sourceUrl'] as string | undefined;
      const description = body['description'] as string | undefined;
      const category = body['category'] as string | undefined;
      const version = body['version'] as string | undefined;
      const githubRepo = body['githubRepo'] as string | undefined; // e.g. "owner/repo"
      const githubSkillPath = body['githubSkillPath'] as string | undefined; // e.g. "skill-name"

      if (!skillName) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }

      const skillsDir = join(homedir(), '.markus', 'skills');
      const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const targetDir = join(skillsDir, safeName);

      try {
        mkdirSync(skillsDir, { recursive: true });

        let installed = false;
        let installMethod = 'metadata-only';

        // Strategy 1: SkillHub/ClawHub — download ZIP via Convex API
        if (source === 'skillhub' && slug) {
          try {
            const zipUrl = `https://wry-manatee-359.convex.site/api/v1/download?slug=${encodeURIComponent(slug)}`;
            const zipResp = await fetch(zipUrl);
            if (zipResp.ok) {
              const tmpZip = join(skillsDir, `_tmp_${safeName}.zip`);
              const buffer = Buffer.from(await zipResp.arrayBuffer());
              writeFileSync(tmpZip, buffer);
              mkdirSync(targetDir, { recursive: true });
              try {
                execSync(`unzip -o "${tmpZip}" -d "${targetDir}"`, { timeout: 30000 });
                installed = true;
                installMethod = 'clawhub-zip';
              } catch {
                console.warn('[skills/install] unzip failed');
              }
              try { execSync(`rm -f "${tmpZip}"`); } catch { /* cleanup */ }
            }
          } catch (err) {
            console.warn(`[skills/install] ClawHub download failed for ${slug}: ${String(err)}`);
          }
        }

        // Strategy 2: skills.sh — try to download SKILL.md from GitHub
        if (!installed && source === 'skillssh' && githubRepo) {
          try {
            const rawBase = `https://raw.githubusercontent.com/${githubRepo}/refs/heads/main`;
            const skillPath = githubSkillPath || safeName;
            const skillMdUrl = `${rawBase}/${skillPath}/SKILL.md`;
            const mdResp = await fetch(skillMdUrl, { signal: AbortSignal.timeout(15000) });
            if (mdResp.ok) {
              mkdirSync(targetDir, { recursive: true });
              writeFileSync(join(targetDir, 'SKILL.md'), await mdResp.text(), 'utf-8');
              installed = true;
              installMethod = 'github-skillmd';
            }
          } catch (err) {
            console.warn(`[skills/install] GitHub SKILL.md download failed: ${String(err)}`);
          }

          if (!installed) {
            try {
              const rawBase = `https://raw.githubusercontent.com/${githubRepo}/refs/heads/main`;
              const rootMd = `${rawBase}/SKILL.md`;
              const mdResp = await fetch(rootMd, { signal: AbortSignal.timeout(15000) });
              if (mdResp.ok) {
                mkdirSync(targetDir, { recursive: true });
                writeFileSync(join(targetDir, 'SKILL.md'), await mdResp.text(), 'utf-8');
                installed = true;
                installMethod = 'github-root-skillmd';
              }
            } catch { /* fallthrough */ }
          }
        }

        // Strategy 3: Try ClawHub ZIP as fallback (many skills.sh skills are cross-listed)
        if (!installed) {
          const trySlug = slug || safeName;
          try {
            const zipUrl = `https://wry-manatee-359.convex.site/api/v1/download?slug=${encodeURIComponent(trySlug)}`;
            const zipResp = await fetch(zipUrl, { signal: AbortSignal.timeout(20000) });
            if (zipResp.ok) {
              const tmpZip = join(skillsDir, `_tmp_${safeName}.zip`);
              const buffer = Buffer.from(await zipResp.arrayBuffer());
              writeFileSync(tmpZip, buffer);
              mkdirSync(targetDir, { recursive: true });
              try {
                execSync(`unzip -o "${tmpZip}" -d "${targetDir}"`, { timeout: 30000 });
                installed = true;
                installMethod = 'clawhub-zip-fallback';
              } catch {
                console.warn('[skills/install] unzip failed (fallback)');
              }
              try { execSync(`rm -f "${tmpZip}"`); } catch { /* cleanup */ }
            }
          } catch {
            console.warn(`[skills/install] ClawHub fallback failed for ${trySlug}`);
          }
        }

        if (!installed) {
          const hint = sourceUrl ?? (slug ? `https://clawhub.ai/${slug}` : '');
          this.json(res, 502, {
            error: `Download failed for "${skillName}". Please visit the source page and download manually.`,
            sourceUrl: hint,
          });
          return;
        }

        // Supplement manifest.json from metadata if download didn't include one
        if (!existsSync(join(targetDir, 'manifest.json'))) {
          const manifestData: Record<string, unknown> = {
            name: skillName,
            version: version ?? '1.0.0',
            description: description ?? `Skill: ${skillName}`,
            category: category ?? 'custom',
            source: source ?? 'unknown',
            sourceUrl: sourceUrl ?? '',
          };
          // Read SKILL.md for instructions
          const instructions = readSkillInstructions(targetDir);
          if (instructions) manifestData.instructions = instructions;
          writeFileSync(join(targetDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf-8');
        }

        // Register into runtime SkillRegistry so the skill is immediately available
        if (this.skillRegistry) {
          try {
            const discovered = discoverSkillsInDir(skillsDir).find(
              d => d.manifest.name === skillName || d.path === targetDir
            );
            if (discovered && !this.skillRegistry.get(discovered.manifest.name)) {
              discovered.manifest.sourcePath = discovered.path;
              this.skillRegistry.register({ manifest: discovered.manifest });
            }
          } catch (regErr) {
            log.warn('Failed to register installed skill into runtime registry', { error: String(regErr) });
          }
        }

        this.json(res, 201, {
          installed: true,
          name: skillName,
          path: targetDir,
          method: installMethod,
        });
        return;
      } catch (err) {
        this.json(res, 500, { error: `Install failed: ${String(err)}` });
        return;
      }
    }

    // Uninstall a skill: delete from filesystem and/or DB
    if (path.startsWith('/api/skills/installed/') && req.method === 'DELETE') {
      const skillName = decodeURIComponent(path.slice('/api/skills/installed/'.length));
      if (!skillName) {
        this.json(res, 400, { error: 'skill name is required' });
        return;
      }

      let deletedFs = false;
      let deletedDb = false;

      // Try delete from filesystem (~/.markus/skills/)
      const skillsDir = join(homedir(), '.markus', 'skills');
      const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const targetDir = join(skillsDir, safeName);
      if (existsSync(targetDir)) {
        try {
          execSync(`rm -rf "${targetDir}"`, { timeout: 10000 });
          deletedFs = true;
        } catch (err) {
          console.warn(`[skills/uninstall] fs delete failed: ${String(err)}`);
        }
      }

      // Try delete from marketplace_skills DB
      if (this.storage) {
        try {
          const dbSkills = (await this.storage.marketplaceSkillRepo.list()) as Array<{ id: string; name: string }>;
          const match = dbSkills.find(s => s.name === skillName);
          if (match) {
            await this.storage.marketplaceSkillRepo.delete(match.id);
            deletedDb = true;
          }
        } catch (err) {
          console.warn(`[skills/uninstall] db delete failed: ${String(err)}`);
        }
      }

      if (!deletedFs && !deletedDb) {
        this.json(res, 404, { error: `Skill "${skillName}" not found` });
        return;
      }

      // Unregister from runtime SkillRegistry
      if (this.skillRegistry) {
        this.skillRegistry.unregister(skillName);
      }

      // Remove from all agents that had this skill assigned
      const agentMgr = this.orgService.getAgentManager();
      const affectedAgents: string[] = [];
      for (const agentInfo of agentMgr.listAgents()) {
        try {
          const agent = agentMgr.getAgent(agentInfo.id);
          if (agent.config.skills.includes(skillName)) {
            agent.config.skills = agent.config.skills.filter(s => s !== skillName);
            affectedAgents.push(agentInfo.id);
            if (this.storage) {
              try { await this.storage.agentRepo.updateConfig(agentInfo.id, { skills: agent.config.skills }); }
              catch (e) { log.warn('Failed to persist skill removal from agent after uninstall', { agentId: agentInfo.id, error: String(e) }); }
            }
          }
        } catch { /* agent not accessible */ }
      }

      this.json(res, 200, { deleted: true, name: skillName, deletedFs, deletedDb, removedFromAgents: affectedAgents });
      return;
    }

    // Builder: Unified AI chat endpoint for agent/team/skill creation
    if (path === '/api/builder/chat' && req.method === 'POST') {
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not configured' });
        return;
      }
      const body = await this.readBody(req);
      const mode = body['mode'] as string;
      const userMessages = body['messages'] as Array<{ role: string; content: string }>;
      if (!mode || !['agent', 'team', 'skill'].includes(mode)) {
        this.json(res, 400, { error: 'mode must be one of: agent, team, skill' });
        return;
      }
      if (!Array.isArray(userMessages) || userMessages.length === 0) {
        this.json(res, 400, { error: 'messages array is required' });
        return;
      }

      // Build dynamic skills/roles context
      const skillEntries: Array<{ name: string; desc: string; type: string }> = [];
      const seenSkills = new Set<string>();
      if (this.skillRegistry) {
        for (const s of this.skillRegistry.list()) {
          seenSkills.add(s.name);
          skillEntries.push({ name: s.name, desc: s.description ?? '', type: s.sourcePath ? 'installed' : 'builtin' });
        }
      }
      for (const dir of WELL_KNOWN_SKILL_DIRS) {
        for (const { manifest } of discoverSkillsInDir(dir)) {
          if (seenSkills.has(manifest.name)) continue;
          seenSkills.add(manifest.name);
          skillEntries.push({ name: manifest.name, desc: manifest.description ?? '', type: 'installed' });
        }
      }
      const skillTable = skillEntries.map(s => `| \`${s.name}\` | ${s.desc.slice(0, 80)} | ${s.type} |`).join('\n');
      const availableRoles = this.orgService.listAvailableRoles();
      const roleList = availableRoles.map(r => `\`${r}\``).join(', ');

      const SYSTEM_PROMPTS: Record<string, string> = {
        agent: `You are Agent Father — an expert AI agent architect. You help users design and create powerful AI agents through natural conversation.

Your job:
1. Understand what the user needs — ask clarifying questions about the agent's purpose, expertise, and tools
2. Design the agent — suggest optimal configuration, system prompt, tools, and environment
3. When the user is satisfied, output the final configuration as a JSON block

Throughout the conversation, be helpful, proactive, and suggest best practices. When you have enough information, generate the configuration.

When outputting the final configuration, wrap it in a JSON code block with these fields:
\`\`\`json
{
  "name": "Agent Name",
  "description": "What this agent does",
  "roleName": "developer",
  "agentRole": "manager" | "worker",
  "category": "development" | "devops" | "management" | "productivity" | "general",
  "skills": "skill-id-1,skill-id-2",
  "tags": "comma-separated tags",
  "systemPrompt": "Detailed system prompt...",
  "llmProvider": "anthropic" | "openai" | "google" | "",
  "llmModel": "model name or empty",
  "temperature": 0.7,
  "toolWhitelist": ["shell_execute", "file_read", "file_write", "file_edit", "web_fetch", "web_search", "git_status", "git_diff", "git_commit", "git_log", "a2a_send", "a2a_list_colleagues", "task_create", "task_update", "task_list", "memory_save", "memory_search", "memory_list", "mcp_call"],
  "requiredEnv": ["git", "node", "python3", "docker", "pnpm", "java", "go"]
}
\`\`\`

## Available Skills (from system)
| Skill ID | Description | Type |
|----------|-------------|------|
${skillTable}

CRITICAL: The \`skills\` field must ONLY contain skill IDs from the table above. Do NOT invent skill names or use generic concepts.

## Available Role Templates
${roleList}

The \`roleName\` field must be one of the role templates listed above.

Always be conversational first. Only output the JSON when you have enough context. If the user's first message is already very detailed, you may output the JSON right away along with your explanation.`,

        team: `You are Team Factory — an expert AI team composition architect. You design optimal agent teams by creating **specialized, purpose-built agents** through natural conversation.

## Core Philosophy
Every agent in a team must be a specialist. Do NOT simply pick generic templates and give them names. Instead, design each agent with a unique identity, detailed system prompt, and tailored capabilities.

Your job:
1. Understand the team's purpose — ask about goals, domain, scale, and coordination needs
2. Design specialized agents — for each member, craft a detailed systemPrompt that defines their unique expertise, workflow, and behavioral guidelines
3. Compose the team — define collaboration patterns and output the final configuration

When outputting the final configuration, wrap it in a JSON code block:
\`\`\`json
{
  "name": "Team Name",
  "description": "Team purpose",
  "category": "development" | "devops" | "management" | "productivity" | "general",
  "tags": "comma-separated tags",
  "members": [
    {
      "name": "Agent Display Name",
      "role": "manager" | "worker",
      "count": 1,
      "roleName": "base-role-template",
      "description": "What this agent does in the team",
      "skills": "skill-id-1,skill-id-2",
      "systemPrompt": "Comprehensive system prompt defining this agent's unique personality, expertise, domain knowledge, workflow, output standards, and collaboration guidelines...",
      "temperature": 0.7
    }
  ]
}
\`\`\`

## Available Role Templates
${roleList}

The \`roleName\` field must be one of the role templates listed above.

## Available Skills (from system)
| Skill ID | Description | Type |
|----------|-------------|------|
${skillTable}

CRITICAL: The \`skills\` field must ONLY contain skill IDs from the table above. Do NOT invent skill names.

CRITICAL: Do NOT use \`templateId\`. Always use \`roleName\` + \`systemPrompt\`. Every member MUST have a detailed \`systemPrompt\` (at least 3-5 paragraphs). A team of generic agents with different names is useless — each agent must have deep, specialized expertise in its systemPrompt.

Every team needs exactly one manager and at least one worker. Be conversational and proactive.`,

        skill: `You are Skill Architect — an expert at creating agent skills following the Agent Skills open standard.

A skill is a SKILL.md file that teaches agents how to accomplish specific tasks using their existing tools (shell_execute, file_read, file_write, web_fetch, web_search, gui, etc.). Skills contain step-by-step instructions, not executable code.

Your job:
1. Understand what capability the user wants to create — ask about use cases, workflows, and expected behavior
2. Design the skill — plan the step-by-step instructions that guide an agent to accomplish the task using existing tools
3. When ready, output the final SKILL.md content in a markdown code block

When outputting the final skill, wrap it in a markdown code block with the \`skill\` language tag:
\`\`\`skill
---
name: skill-name-kebab-case
description: When and why an agent should use this skill
---

# Skill Name

## Overview
Brief description of what this skill helps agents accomplish.

## Instructions
Step-by-step instructions for the agent to follow, including:
- CLI commands to run via shell_execute
- Files to read or create
- Web resources to fetch
- Patterns, tips, and error handling guidance

## Examples
Example workflows or command sequences.
\`\`\`

Be conversational. Help the user think through the workflow, edge cases, and what existing tools the agent will use. If the user's request is clear, generate the SKILL.md immediately along with your explanation.`,
      };

      try {
        const llmMessages = [
          { role: 'system' as const, content: SYSTEM_PROMPTS[mode]! },
          ...userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ];

        const response = await this.llmRouter.chat({
          messages: llmMessages,
          maxTokens: 4000,
          temperature: 0.7,
        });

        const reply = response.content?.trim() ?? '';

        // Try to extract artifact from the reply
        let artifact: Record<string, unknown> | null = null;

        if (mode === 'skill') {
          // Extract SKILL.md content from ```skill code block
          const skillMatch = reply.match(/```skill\s*\n([\s\S]*?)\n```/);
          if (skillMatch?.[1]) {
            const skillMd = skillMatch[1].trim();
            const nameMatch = skillMd.match(/^---\s*\n[\s\S]*?name:\s*(.+)[\s\S]*?\n---/m);
            const descMatch = skillMd.match(/^---\s*\n[\s\S]*?description:\s*(.+)[\s\S]*?\n---/m);
            artifact = {
              name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? 'unnamed-skill',
              description: descMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '',
              skillMd,
            };
          }
        } else {
          // JSON artifact for team/prompt modes
          const jsonMatch = reply.match(/```json\s*\n([\s\S]*?)\n```/);
          if (jsonMatch?.[1]) {
            try { artifact = JSON.parse(jsonMatch[1]); } catch { /* no valid JSON */ }
          }
        }

        this.json(res, 200, { reply, artifact, mode });
      } catch (err) {
        this.json(res, 500, { error: `Chat failed: ${String(err)}` });
      }
      return;
    }

    // Builder: Create artifact from chat — actually creates real, usable resources
    if (path === '/api/builder/create' && req.method === 'POST') {
      const body = await this.readBody(req);
      const mode = body['mode'] as string;
      const artifact = body['artifact'] as Record<string, unknown>;
      if (!mode || !artifact) {
        this.json(res, 400, { error: 'mode and artifact are required' });
        return;
      }

      try {
        if (mode === 'agent') {
          // Hire a real agent with the custom systemPrompt written as ROLE.md
          const agentManager = this.orgService.getAgentManager();
          const agentName = (artifact.name as string) ?? 'New Agent';
          const skills = typeof artifact.skills === 'string'
            ? (artifact.skills as string).split(',').map(s => s.trim()).filter(Boolean)
            : [];

          const requestedRole = (artifact.roleName as string) ?? 'developer';
          const knownRoles = this.orgService.listAvailableRoles();
          const roleName = knownRoles.includes(requestedRole) ? requestedRole : 'developer';

          const agent = await this.orgService.hireAgent({
            name: agentName,
            roleName,
            orgId: 'default',
            teamId: body['teamId'] as string | undefined,
            agentRole: (artifact.agentRole as 'manager' | 'worker') ?? 'worker',
            skills,
          });

          // Overwrite the copied ROLE.md with the custom systemPrompt
          const customPrompt = (artifact.systemPrompt as string) ?? '';
          if (customPrompt) {
            const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
            mkdirSync(agentRoleDir, { recursive: true });
            writeFileSync(join(agentRoleDir, 'ROLE.md'), `# ${agentName}\n\n${customPrompt}`);
            agent.reloadRole();
          }

          await agentManager.startAgent(agent.id);
          this.json(res, 201, {
            agent: { id: agent.id, name: agent.config.name, role: agent.role.name, status: agent.getState().status },
          });

        } else if (mode === 'team') {
          // Create a real team and deploy specialized agents for each member
          const agentManager = this.orgService.getAgentManager();
          const teamName = (artifact.name as string) ?? 'New Team';
          const team = await this.orgService.createTeam('default', teamName, (artifact.description as string) ?? '');
          const members = Array.isArray(artifact.members) ? artifact.members as Array<Record<string, unknown>> : [];
          const createdAgents: Array<{ id: string; name: string; role: string }> = [];

          for (const member of members) {
            const count = (member.count as number) ?? 1;
            const memberRole = (member.role as 'manager' | 'worker') ?? 'worker';
            const memberName = (member.name as string) ?? 'Agent';

            // New format: roleName directly specified; fallback to templateId for backward compat
            const knownRoles = this.orgService.listAvailableRoles();
            let roleName = 'developer';
            const directRoleName = member.roleName as string | undefined;
            const templateId = member.templateId as string | undefined;
            if (directRoleName && knownRoles.includes(directRoleName)) {
              roleName = directRoleName;
            } else if (templateId) {
              const registryHit = this.templateRegistry?.get(templateId);
              if (registryHit) {
                roleName = registryHit.roleId;
              } else if (knownRoles.includes(templateId)) {
                roleName = templateId;
              }
            }

            const memberSkills = typeof member.skills === 'string'
              ? (member.skills as string).split(',').map(s => s.trim()).filter(Boolean)
              : [];
            const customPrompt = (member.systemPrompt as string) ?? '';

            for (let i = 0; i < count; i++) {
              const displayName = count > 1 ? `${memberName} ${i + 1}` : memberName;

              const agent = await this.orgService.hireAgent({
                name: displayName,
                roleName,
                orgId: 'default',
                teamId: team.id,
                agentRole: memberRole,
                skills: memberSkills.length > 0 ? memberSkills : undefined,
              });

              // Write custom ROLE.md if systemPrompt is provided (specialized agent)
              if (customPrompt) {
                const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
                mkdirSync(agentRoleDir, { recursive: true });
                writeFileSync(join(agentRoleDir, 'ROLE.md'), `# ${displayName}\n\n${customPrompt}`);
                agent.reloadRole();
              }

              if (memberRole === 'manager') {
                await this.orgService.updateTeam(team.id, { managerId: agent.id, managerType: 'agent' });
              }

              await agentManager.startAgent(agent.id);
              createdAgents.push({ id: agent.id, name: agent.config.name, role: agent.role.name });
            }
          }

          this.json(res, 201, { team: { id: team.id, name: teamName }, agents: createdAgents });

        } else if (mode === 'skill') {
          // Write SKILL.md to filesystem and register into runtime SkillRegistry
          const skillName = (artifact.name as string) ?? 'unnamed-skill';
          const skillMd = (artifact.skillMd as string) ?? '';
          const description = (artifact.description as string) ?? `Skill: ${skillName}`;
          const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-');
          const skillDir = join(homedir(), '.markus', 'skills', safeName);
          mkdirSync(skillDir, { recursive: true });

          // Write the SKILL.md file
          writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

          // Extract instructions (body without frontmatter)
          const instructions = skillMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();

          // Write manifest.json for metadata
          const manifest = {
            name: skillName,
            version: '1.0.0',
            description,
            author: 'AI Generated',
            category: 'custom' as SkillCategory,
            source: 'builder',
            instructions: instructions || undefined,
            sourcePath: skillDir,
          };
          writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

          // Register into runtime SkillRegistry immediately
          if (this.skillRegistry) {
            try {
              this.skillRegistry.register({ manifest });
            } catch (regErr) {
              log.warn('Failed to register skill into runtime registry', { error: String(regErr) });
            }
          }

          // Also save to marketplace DB for persistence
          if (this.storage) {
            try {
              const id = generateId('mkt-skill');
              await this.storage.marketplaceSkillRepo.create({
                id,
                name: skillName,
                description,
                source: 'community',
                status: 'published',
                version: '1.0.0',
                authorName: 'AI Generated',
                category: 'custom',
                tags: [],
                tools: [],
              });
            } catch (dbErr) {
              log.warn('Failed to persist skill to marketplace DB', { error: String(dbErr) });
            }
          }

          this.json(res, 201, { skill: { name: skillName, path: skillDir, status: 'registered' } });

        } else {
          this.json(res, 400, { error: `Unknown mode: ${mode}` });
        }
      } catch (err) {
        this.json(res, 500, { error: `Create failed: ${String(err)}` });
      }
      return;
    }

    // Skills registry: SkillHub (skillhub.tencent.com) — static JSON from Tencent CDN
    if (path === '/api/skills/registry/skillhub' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const category = url.searchParams.get('category') ?? '';
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = parseInt(url.searchParams.get('limit') ?? '24', 10);
      const sort = url.searchParams.get('sort') ?? 'score';

      const cacheKey = 'skillhub-data';
      const now = Date.now();
      const cached = this.registryCache?.get(cacheKey) as { data: { total: number; generated_at: string; featured: string[]; categories: Record<string, string[]>; skills: Array<{ slug: string; name: string; description: string; description_zh?: string; version: string; homepage: string; tags: string[]; downloads: number; stars: number; installs: number; updated_at: number; score: number }> }; ts: number } | undefined;

      try {
        let allData = cached && now - cached.ts < 3_600_000 ? cached.data : null;
        if (!allData) {
          const dataUrl = 'https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.66a05e01.json';
          const resp = await fetch(dataUrl);
          if (!resp.ok) {
            this.json(res, 502, { error: `SkillHub CDN returned ${resp.status}` });
            return;
          }
          allData = await resp.json() as typeof cached extends undefined ? never : NonNullable<typeof cached>['data'];
          if (!this.registryCache) this.registryCache = new Map();
          this.registryCache.set(cacheKey, { data: allData, ts: now });
        }

        let skills = allData!.skills;
        const categoryMap = allData!.categories ?? {};

        if (category && categoryMap[category]) {
          const catTags = new Set(categoryMap[category]!.map(t => t.toLowerCase()));
          skills = skills.filter(s => s.tags?.some(t => catTags.has(t.toLowerCase())));
        }

        if (q) {
          const lower = q.toLowerCase();
          skills = skills.filter(s =>
            s.name.toLowerCase().includes(lower) ||
            s.slug.toLowerCase().includes(lower) ||
            (s.description_zh ?? s.description ?? '').toLowerCase().includes(lower)
          );
        }

        if (sort === 'downloads') skills.sort((a, b) => b.downloads - a.downloads);
        else if (sort === 'stars') skills.sort((a, b) => b.stars - a.stars);
        else if (sort === 'installs') skills.sort((a, b) => b.installs - a.installs);
        else skills.sort((a, b) => b.score - a.score);

        const total = skills.length;
        const start = (page - 1) * limit;
        const pageSkills = skills.slice(start, start + limit);

        // Enrich homepage URLs: CDN data often has `clawhub.ai/{slug}` instead of `clawhub.ai/{owner}/{slug}`
        if (!this.registryCache) this.registryCache = new Map();
        const ownerCacheKey = 'skillhub-owner-map';
        const ownerMap: Map<string, string> = (this.registryCache.get(ownerCacheKey) as { data: Map<string, string> } | undefined)?.data ?? new Map();
        const needsEnrich = pageSkills.filter(s => {
          const hp = s.homepage ?? '';
          const hpPath = hp.replace(/^https?:\/\/clawhub\.ai\/?/, '');
          return hpPath && !hpPath.includes('/') && !ownerMap.has(s.slug);
        });
        if (needsEnrich.length > 0) {
          await Promise.allSettled(
            needsEnrich.map(async s => {
              try {
                const resp = await fetch(`https://wry-manatee-359.convex.site/api/v1/skills/${encodeURIComponent(s.slug)}`, { signal: AbortSignal.timeout(5000) });
                if (resp.ok) {
                  const detail = await resp.json() as { owner?: { handle?: string } };
                  if (detail.owner?.handle) {
                    ownerMap.set(s.slug, detail.owner.handle);
                  }
                }
              } catch { /* skip — will use original homepage */ }
            })
          );
          this.registryCache.set(ownerCacheKey, { data: ownerMap, ts: now });
        }
        const enrichedSkills = pageSkills.map(s => {
          const hp = s.homepage ?? '';
          const hpPath = hp.replace(/^https?:\/\/clawhub\.ai\/?/, '');
          if (hpPath && !hpPath.includes('/') && ownerMap.has(s.slug)) {
            return { ...s, homepage: `https://clawhub.ai/${ownerMap.get(s.slug)}/${s.slug}` };
          }
          return s;
        });

        this.json(res, 200, {
          skills: enrichedSkills,
          total,
          page,
          limit,
          categories: Object.keys(categoryMap),
          featured: allData!.featured,
          cached: !!(cached && now - cached.ts < 3_600_000),
        });
      } catch (err) {
        this.json(res, 500, { error: `SkillHub fetch failed: ${String(err)}` });
      }
      return;
    }

    // Skills registry: Proxy fetch from skills.sh leaderboard
    if (path === '/api/skills/registry/skillssh' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const cacheKey = `skillssh-${q || 'leaderboard'}`;
      const now = Date.now();
      const cached = this.registryCache?.get(cacheKey);
      if (cached && now - cached.ts < 600_000) {
        this.json(res, 200, { skills: cached.data, cached: true });
        return;
      }
      try {
        const fetchUrl = q
          ? `https://skills.sh/search?q=${encodeURIComponent(q)}`
          : 'https://skills.sh/';
        const resp = await fetch(fetchUrl);
        if (!resp.ok) {
          this.json(res, 502, { error: `skills.sh returned ${resp.status}` });
          return;
        }
        const html = await resp.text();
        const skills: Array<{ name: string; author: string; repo: string; installs: string; url: string; description?: string }> = [];
        const seen = new Set<string>();

        // Parse the leaderboard HTML: each skill is an <a> block with h3 (name), p (author/repo), span (installs)
        const blockRegex = /<a[^>]*href="\/([\w-]+\/[\w.-]+\/[\w][\w.-]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const IGNORED_PREFIXES = new Set(['_next', 'static', 'api', 'assets', 'images', 'fonts', 'css', 'js']);
        let match: RegExpExecArray | null;
        while ((match = blockRegex.exec(html)) !== null) {
          const fullPath = match[1]!;
          const parts = fullPath.split('/');
          if (parts.length < 3) continue;
          if (IGNORED_PREFIXES.has(parts[0]!)) continue;

          const author = parts[0]!;
          const repo = `${parts[0]}/${parts[1]}`;
          const block = match[2]!;

          // Extract skill name from <h3>
          const nameMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/);
          const name = nameMatch?.[1]?.trim() ?? parts[2]!;

          // Extract install count from last <span class="font-mono ...">
          const installMatches = [...block.matchAll(/<span[^>]*font-mono[^>]*>([\d.]+[KMB]?)<\/span>/g)];
          const installs = installMatches.length > 0 ? installMatches[installMatches.length - 1]![1] ?? '' : '';

          const key = `${author}/${repo}/${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          skills.push({ name, author, repo, installs, url: `https://skills.sh/${fullPath}` });
        }

        // Fetch descriptions for top skills in parallel (batch of first 20)
        const toFetch = skills.slice(0, 20).filter(s => !s.description);
        if (toFetch.length > 0) {
          const descResults = await Promise.allSettled(
            toFetch.map(async (s) => {
              const pageResp = await fetch(s.url, { signal: AbortSignal.timeout(8000) });
              if (!pageResp.ok) return { name: s.name, desc: '' };
              const pageHtml = await pageResp.text();
              const pMatch = pageHtml.match(/<p[^>]*class="[^"]*text-muted[^"]*"[^>]*>(.*?)<\/p>/);
              if (pMatch) return { name: s.name, desc: pMatch[1]!.replace(/<[^>]+>/g, '').trim() };
              const firstP = pageHtml.match(/<article[^>]*>[\s\S]*?<p[^>]*>(.*?)<\/p>/);
              if (firstP) return { name: s.name, desc: firstP[1]!.replace(/<[^>]+>/g, '').trim() };
              return { name: s.name, desc: '' };
            })
          );
          for (const r of descResults) {
            if (r.status === 'fulfilled' && r.value.desc) {
              const skill = skills.find(s => s.name === r.value.name);
              if (skill) skill.description = r.value.desc;
            }
          }
        }

        if (!this.registryCache) this.registryCache = new Map();
        this.registryCache.set(cacheKey, { data: skills, ts: now });
        this.json(res, 200, { skills, cached: false });
      } catch (err) {
        this.json(res, 500, { error: `skills.sh fetch failed: ${String(err)}` });
      }
      return;
    }

    // Agent Templates
    if (path === '/api/templates' && req.method === 'GET') {
      if (!this.templateRegistry) {
        this.json(res, 200, { templates: [] });
        return;
      }
      const source = url.searchParams.get('source') as
        | 'official'
        | 'community'
        | 'custom'
        | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const text = url.searchParams.get('q') ?? undefined;
      const result =
        source || category || text
          ? this.templateRegistry.search({ source: source ?? undefined, category, text })
          : { templates: this.templateRegistry.list(), total: this.templateRegistry.list().length };
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/templates\/[^/]+$/) && req.method === 'GET') {
      if (!this.templateRegistry) {
        this.json(res, 404, { error: 'Template registry not configured' });
        return;
      }
      const templateId = path.split('/')[3]!;
      const template = this.templateRegistry.get(templateId);
      if (!template) {
        this.json(res, 404, { error: `Template not found: ${templateId}` });
        return;
      }
      this.json(res, 200, { template });
      return;
    }

    if (path === '/api/templates/instantiate' && req.method === 'POST') {
      const body = await this.readBody(req);
      const templateId = body['templateId'] as string;
      const name = body['name'] as string;
      const orgId = (body['orgId'] as string) ?? 'default';
      const teamId = body['teamId'] as string | undefined;
      const agentRole = body['agentRole'] as 'manager' | 'worker' | undefined;
      if (!templateId || !name) {
        this.json(res, 400, { error: 'templateId and name are required' });
        return;
      }
      try {
        const agentManager = this.orgService.getAgentManager();

        // Try template registry first, fall back to marketplace DB for mkt-tpl-* IDs
        const registryHit = this.templateRegistry?.get(templateId);
        const agent = (!registryHit && templateId.startsWith('mkt-tpl-') && this.storage)
          ? await (async () => {
              const mktTpl = await this.storage!.marketplaceTemplateRepo.findById(templateId);
              if (!mktTpl) throw new Error(`Template not found: ${templateId}`);
              const knownRoles = this.orgService.listAvailableRoles();
              const resolvedRole = knownRoles.includes(mktTpl.roleId) ? mktTpl.roleId : 'developer';
              return agentManager.createAgent({
                name,
                roleName: resolvedRole,
                orgId,
                teamId,
                agentRole: (mktTpl.agentRole as 'manager' | 'worker') ?? 'worker',
                skills: mktTpl.skills ?? undefined,
              });
            })()
          : await agentManager.createAgentFromTemplate({
              templateId,
              name,
              orgId,
              teamId,
              overrides: body['overrides'] as Record<string, unknown> | undefined,
            });
        if (agentRole) agent.config.agentRole = agentRole;
        if (teamId) {
          this.orgService.addMemberToTeam(teamId, agent.id, 'agent');
        }

        // Persist to DB so agents survive restarts
        if (this.storage) {
          try {
            await this.storage.agentRepo.create({
              id: agent.id,
              name: agent.config.name,
              orgId,
              teamId,
              roleId: agent.config.roleId,
              roleName: agent.role.name,
              agentRole: agent.config.agentRole ?? 'worker',
              skills: agent.config.skills,
              llmConfig: agent.config.llmConfig,
              heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
            });
          } catch (persistErr) {
            log.warn('Failed to persist instantiated agent to DB', { error: String(persistErr) });
          }
        }

        await agentManager.startAgent(agent.id);
        this.json(res, 201, {
          agent: {
            id: agent.id,
            name: agent.config.name,
            role: agent.role.name,
            agentRole: agent.config.agentRole,
            status: agent.getState().status,
          },
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── External Agents ─────────────────────────────────────────────────────
    if (path === '/api/external-agents' && req.method === 'GET') {
      if (!this.gateway) {
        this.json(res, 200, { agents: [] });
        return;
      }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { agents: this.gateway.listRegistrations(orgId) });
      return;
    }

    if (path === '/api/external-agents/register' && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'External agent gateway not configured' });
        return;
      }
      const body = await this.readBody(req);
      try {
        const orgId = (body['orgId'] as string) ?? 'default';
        const reg = await this.gateway.register({
          externalAgentId: body['externalAgentId'] as string,
          agentName: body['agentName'] as string,
          orgId,
          capabilities: body['capabilities'] as string[] | undefined,
          openClawConfig: body['openClawConfig'] as string | undefined,
        });
        // Generate a token for the UI without marking the agent as connected.
        // authenticate() sets connected=true as a side effect, so we reset it
        // immediately — the agent should only appear online when it actually syncs.
        let token: string | undefined;
        if (reg.markusAgentId && this.gatewaySecret) {
          try {
            const authResult = this.gateway.authenticate({
              externalAgentId: reg.externalAgentId,
              orgId,
              secret: this.gatewaySecret,
            });
            token = authResult.token;
            reg.connected = false;
            reg.lastHeartbeat = undefined;
            this.gateway.resetConnectionStatus(reg.externalAgentId, orgId);
          } catch { /* auth may fail if secret isn't set; token stays undefined */ }
        }
        const host = req.headers['host'] ?? `localhost:${this.port}`;
        const proto = req.headers['x-forwarded-proto'] ?? 'http';
        const gatewayUrl = `${proto}://${host}/api/gateway`;
        this.json(res, 201, { registration: reg, token, gatewayUrl });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 400;
        this.json(res, code, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/external-agents\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'External agent gateway not configured' });
        return;
      }
      const externalId = path.split('/')[3]!;
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const reg = await this.gateway.unregister(externalId, orgId);
      if (reg?.markusAgentId) {
        try { await this.orgService.fireAgent(reg.markusAgentId); } catch { /* already gone */ }
      }
      this.json(res, reg ? 200 : 404, reg ? { deleted: true } : { error: 'Not found' });
      return;
    }

    // ── Marketplace: Templates ────────────────────────────────────────────────
    if (path === '/api/marketplace/templates' && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 200, { templates: [], total: 0 });
        return;
      }
      const source = url.searchParams.get('source') as
        | 'official'
        | 'community'
        | 'custom'
        | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status') ?? 'published';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);

      const templates = q
        ? await this.storage.marketplaceTemplateRepo.search(q, {
            source: source ?? undefined,
            category,
            limit,
          })
        : await this.storage.marketplaceTemplateRepo.list({
            source: source ?? undefined,
            status,
            category,
            limit,
            offset,
          });
      this.json(res, 200, { templates, total: templates.length });
      return;
    }

    if (path === '/api/marketplace/templates' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const body = await this.readBody(req);
      const id = generateId('mkt-tpl');
      const template = await this.storage.marketplaceTemplateRepo.create({
        id,
        name: body['name'] as string,
        description: body['description'] as string,
        source: (body['source'] as 'official' | 'community' | 'custom') ?? 'community',
        status: (body['publish'] as boolean) ? 'published' : 'draft',
        version: (body['version'] as string) ?? '1.0.0',
        authorId: body['authorId'] as string | undefined,
        authorName: body['authorName'] as string,
        roleId: body['roleId'] as string,
        agentRole: (body['agentRole'] as string) ?? 'worker',
        skills: body['skills'] as string[] | undefined,
        llmProvider: body['llmProvider'] as string | undefined,
        tags: body['tags'] as string[] | undefined,
        category: body['category'] as string,
        icon: body['icon'] as string | undefined,
        heartbeatIntervalMs: body['heartbeatIntervalMs'] as number | undefined,
        starterTasks: body['starterTasks'] as
          | Array<{ title: string; description: string; priority: string }>
          | undefined,
        config: body['config'] as Record<string, unknown> | undefined,
      });
      this.json(res, 201, { template });
      return;
    }

    if (
      path.match(/^\/api\/marketplace\/templates\/[^/]+$/) &&
      !path.includes('/rate') &&
      !path.includes('/reviews')
    ) {
      const templateId = path.split('/')[4]!;

      if (req.method === 'GET') {
        if (!this.storage) {
          this.json(res, 503, { error: 'Database not configured' });
          return;
        }
        const template = await this.storage.marketplaceTemplateRepo.findById(templateId);
        if (!template) {
          this.json(res, 404, { error: 'Template not found' });
          return;
        }
        this.json(res, 200, { template });
        return;
      }

      if (req.method === 'PUT') {
        if (!this.storage) {
          this.json(res, 503, { error: 'Database not configured' });
          return;
        }
        const body = await this.readBody(req);
        await this.storage.marketplaceTemplateRepo.update(templateId, {
          name: body['name'] as string | undefined,
          description: body['description'] as string | undefined,
          version: body['version'] as string | undefined,
          skills: body['skills'] as string[] | undefined,
          tags: body['tags'] as string[] | undefined,
          category: body['category'] as string | undefined,
          icon: body['icon'] as string | undefined,
        });
        const updated = await this.storage.marketplaceTemplateRepo.findById(templateId);
        this.json(res, 200, { template: updated });
        return;
      }

      if (req.method === 'DELETE') {
        if (!this.storage) {
          this.json(res, 503, { error: 'Database not configured' });
          return;
        }
        await this.storage.marketplaceTemplateRepo.delete(templateId);
        this.json(res, 200, { deleted: true });
        return;
      }
    }

    if (path.match(/^\/api\/marketplace\/templates\/[^/]+\/publish$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const templateId = path.split('/')[4]!;
      await this.storage.marketplaceTemplateRepo.updateStatus(templateId, 'published');
      this.json(res, 200, { published: true });
      return;
    }

    if (path.match(/^\/api\/marketplace\/templates\/[^/]+\/install$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const templateId = path.split('/')[4]!;
      const mktTemplate = await this.storage.marketplaceTemplateRepo.findById(templateId);
      if (!mktTemplate) {
        this.json(res, 404, { error: 'Template not found' });
        return;
      }

      await this.storage.marketplaceTemplateRepo.incrementDownloads(templateId);

      if (this.templateRegistry) {
        this.templateRegistry.register({
          id: mktTemplate.id,
          name: mktTemplate.name,
          description: mktTemplate.description,
          source: mktTemplate.source,
          version: mktTemplate.version,
          author: mktTemplate.authorName,
          roleId: mktTemplate.roleId,
          agentRole: mktTemplate.agentRole as 'manager' | 'worker',
          skills: mktTemplate.skills,
          llmProvider: mktTemplate.llmProvider ?? undefined,
          tags: mktTemplate.tags,
          category: mktTemplate.category as
            | 'development'
            | 'devops'
            | 'productivity'
            | 'management'
            | 'general',
          heartbeatIntervalMs: mktTemplate.heartbeatIntervalMs ?? undefined,
          starterTasks: mktTemplate.starterTasks as Array<{
            title: string;
            description: string;
            priority: 'low' | 'medium' | 'high';
          }>,
          icon: mktTemplate.icon ?? undefined,
        });
      }
      this.json(res, 200, { installed: true, templateId });
      return;
    }

    // ── Marketplace: Template Fork ──────────────────────────────────────────
    if (path.match(/^\/api\/marketplace\/templates\/[^/]+\/fork$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const templateId = path.split('/')[4]!;
      const original = await this.storage.marketplaceTemplateRepo.findById(templateId);
      if (!original) {
        this.json(res, 404, { error: 'Template not found' });
        return;
      }
      const body = await this.readBody(req);
      const forkId = generateId('mkt-tpl');
      const forked = await this.storage.marketplaceTemplateRepo.create({
        id: forkId,
        name: (body['name'] as string) ?? `${original.name} (fork)`,
        description: original.description,
        source: 'custom',
        status: 'draft',
        version: '1.0.0',
        authorId: body['authorId'] as string | undefined,
        authorName: (body['authorName'] as string) ?? 'anonymous',
        roleId: original.roleId,
        agentRole: original.agentRole,
        skills: original.skills,
        llmProvider: original.llmProvider ?? undefined,
        tags: original.tags,
        category: original.category,
        icon: original.icon ?? undefined,
        heartbeatIntervalMs: original.heartbeatIntervalMs ?? undefined,
        starterTasks: original.starterTasks as
          | Array<{ title: string; description: string; priority: string }>
          | undefined,
        config: { ...((original.config ?? {}) as Record<string, unknown>), forkedFrom: templateId },
      });
      // Increment fork count on original (best-effort via raw SQL)
      try {
        const db = (
          this.storage as unknown as { db: { execute: (q: unknown) => Promise<unknown> } }
        ).db;
        if (db?.execute) {
          await db.execute({
            sql: `UPDATE marketplace_templates SET fork_count = COALESCE(fork_count, 0) + 1 WHERE id = $1`,
            params: [templateId],
          });
        }
      } catch {
        /* ignore */
      }
      this.json(res, 201, { template: forked, forkedFrom: templateId });
      return;
    }

    // ── Marketplace: Skills ──────────────────────────────────────────────────
    if (path === '/api/marketplace/skills' && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 200, { skills: [], total: 0 });
        return;
      }
      const source = url.searchParams.get('source') as
        | 'official'
        | 'community'
        | 'custom'
        | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status') ?? 'published';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);

      const skills = q
        ? await this.storage.marketplaceSkillRepo.search(q, {
            source: source ?? undefined,
            category,
            limit,
          })
        : await this.storage.marketplaceSkillRepo.list({
            source: source ?? undefined,
            status,
            category,
            limit,
            offset,
          });
      this.json(res, 200, { skills, total: skills.length });
      return;
    }

    if (path === '/api/marketplace/skills' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const body = await this.readBody(req);
      const id = generateId('mkt-skill');
      const skill = await this.storage.marketplaceSkillRepo.create({
        id,
        name: body['name'] as string,
        description: body['description'] as string,
        source: (body['source'] as 'official' | 'community' | 'custom') ?? 'community',
        status: (body['publish'] as boolean) ? 'published' : 'draft',
        version: (body['version'] as string) ?? '1.0.0',
        authorId: body['authorId'] as string | undefined,
        authorName: body['authorName'] as string,
        category: body['category'] as string,
        tags: body['tags'] as string[] | undefined,
        tools: body['tools'] as Array<{ name: string; description: string }> | undefined,
        readme: body['readme'] as string | undefined,
        requiredPermissions: body['requiredPermissions'] as string[] | undefined,
        requiredEnv: body['requiredEnv'] as string[] | undefined,
      });
      this.json(res, 201, { skill });
      return;
    }

    if (path.match(/^\/api\/marketplace\/skills\/[^/]+$/) && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const skillId = path.split('/')[4]!;
      const skill = await this.storage.marketplaceSkillRepo.findById(skillId);
      if (!skill) {
        this.json(res, 404, { error: 'Skill not found' });
        return;
      }
      this.json(res, 200, { skill });
      return;
    }

    if (path.match(/^\/api\/marketplace\/skills\/[^/]+\/publish$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const skillId = path.split('/')[4]!;
      await this.storage.marketplaceSkillRepo.updateStatus(skillId, 'published');
      this.json(res, 200, { published: true });
      return;
    }

    if (path.match(/^\/api\/marketplace\/skills\/[^/]+\/install$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const skillId = path.split('/')[4]!;
      await this.storage.marketplaceSkillRepo.incrementDownloads(skillId);
      this.json(res, 200, { installed: true, skillId });
      return;
    }

    // ── Marketplace: Ratings ──────────────────────────────────────────────────
    if (path === '/api/marketplace/ratings' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Database not configured' });
        return;
      }
      const body = await this.readBody(req);
      const targetType = body['targetType'] as 'template' | 'skill';
      const targetId = body['targetId'] as string;
      const userId = body['userId'] as string;
      const rating = body['rating'] as number;
      const review = body['review'] as string | undefined;

      if (!targetType || !targetId || !userId || !rating) {
        this.json(res, 400, { error: 'targetType, targetId, userId, and rating are required' });
        return;
      }

      const existing = await this.storage.marketplaceRatingRepo.findUserRating(
        userId,
        targetType,
        targetId
      );
      if (existing) {
        await this.storage.marketplaceRatingRepo.update(existing.id, { rating, review });
      } else {
        const id = generateId('rating');
        await this.storage.marketplaceRatingRepo.create({
          id,
          targetType,
          targetId,
          userId,
          rating,
          review,
        });
      }

      const agg = await this.storage.marketplaceRatingRepo.getAggregation(targetType, targetId);
      if (targetType === 'template') {
        await this.storage.marketplaceTemplateRepo.updateRating(targetId, agg.avg, agg.count);
      } else {
        await this.storage.marketplaceSkillRepo.updateRating(targetId, agg.avg, agg.count);
      }
      this.json(res, 200, { rating: agg });
      return;
    }

    if (path.match(/^\/api\/marketplace\/ratings\/[^/]+$/) && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 200, { ratings: [] });
        return;
      }
      const targetId = path.split('/')[4]!;
      const targetType = (url.searchParams.get('type') as 'template' | 'skill') ?? 'template';
      const ratings = await this.storage.marketplaceRatingRepo.findByTarget(targetType, targetId);
      const agg = await this.storage.marketplaceRatingRepo.getAggregation(targetType, targetId);
      this.json(res, 200, { ratings, aggregation: agg });
      return;
    }

    // ── Marketplace: Stats ────────────────────────────────────────────────────
    if (path === '/api/marketplace/stats' && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 200, { templates: {}, skills: {} });
        return;
      }
      const templateCounts = await this.storage.marketplaceTemplateRepo.countBySource();
      this.json(res, 200, { templates: templateCounts });
      return;
    }

    // HITL: Approvals
    if (path === '/api/approvals' && req.method === 'GET') {
      const status = url.searchParams.get('status') as
        | 'pending'
        | 'approved'
        | 'rejected'
        | undefined;
      this.json(res, 200, {
        approvals: this.hitlService?.listApprovals(status ?? undefined) ?? [],
      });
      return;
    }

    if (path === '/api/approvals' && req.method === 'POST') {
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const body = await this.readBody(req);
      const approval = this.hitlService.requestApproval({
        agentId: body['agentId'] as string,
        agentName: (body['agentName'] as string) ?? 'Agent',
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
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const approvalId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const result = this.hitlService.respondToApproval(
        approvalId,
        body['approved'] as boolean,
        (body['respondedBy'] as string) ?? 'default'
      );
      if (!result) {
        this.json(res, 404, { error: 'Approval not found or not pending' });
        return;
      }
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
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const body = await this.readBody(req);
      const bounty = this.hitlService.postBounty({
        agentId: body['agentId'] as string,
        agentName: (body['agentName'] as string) ?? 'Agent',
        title: body['title'] as string,
        description: body['description'] as string,
        skills: body['skills'] as string[],
        reward: body['reward'] as string,
      });
      this.json(res, 201, { bounty });
      return;
    }

    if (path.startsWith('/api/bounties/') && req.method === 'POST') {
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const bountyId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const action = body['action'] as string;
      if (action === 'claim') {
        const result = this.hitlService.claimBounty(bountyId, body['userId'] as string);
        if (!result) {
          this.json(res, 404, { error: 'Bounty not found or not open' });
          return;
        }
        this.json(res, 200, { bounty: result });
      } else if (action === 'complete') {
        const result = this.hitlService.completeBounty(bountyId, body['result'] as string);
        if (!result) {
          this.json(res, 404, { error: 'Bounty not found or not claimed' });
          return;
        }
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
      this.json(res, 200, {
        notifications: this.hitlService?.listNotifications(userId, unread) ?? [],
      });
      return;
    }

    if (path.startsWith('/api/notifications/') && req.method === 'POST') {
      const notifId = path.split('/')[3]!;
      const read = this.hitlService?.markNotificationRead(notifId);
      this.json(res, 200, { success: read ?? false });
      return;
    }

    // Billing: Usage — computed from persisted agent metrics for restart-safety
    if (path === '/api/usage' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const plan = this.billingService?.getOrgPlan(orgId);

      const agentManager = this.orgService.getAgentManager();
      const allAgents = agentManager.listAgents();
      let llmTokens = 0;
      let toolCalls = 0;
      let messages = 0;

      for (const a of allAgents) {
        try {
          const agent = agentManager.getAgent(a.id);
          const stats = agent.getUsageStats();
          llmTokens += stats.totalTokens;
          toolCalls += stats.toolCallsToday;
          messages += stats.requestsToday;
        } catch { /* agent not loaded */ }
      }

      // Supplement with billing service data if available (for current-session records)
      const billingSummary = this.billingService?.getUsageSummary(orgId);
      if (billingSummary) {
        llmTokens = Math.max(llmTokens, billingSummary.llmTokens);
        toolCalls = Math.max(toolCalls, billingSummary.toolCalls);
        messages = Math.max(messages, billingSummary.messages);
      }

      this.json(res, 200, {
        usage: {
          orgId,
          period: new Date().toISOString().slice(0, 7),
          llmTokens,
          toolCalls,
          messages,
          storageBytes: billingSummary?.storageBytes ?? 0,
        },
        plan,
      });
      return;
    }

    // Billing: Per-agent usage — computed from persisted agent metrics
    if (path === '/api/usage/agents' && req.method === 'GET') {
      const agentManager = this.orgService.getAgentManager();
      const agentList = agentManager.listAgents();

      const agentUsage = agentList.map(a => {
        try {
          const agent = agentManager.getAgent(a.id);
          const stats = agent.getUsageStats();
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            status: a.status,
            tokensUsedToday: stats.tokensToday,
            totalTokens: stats.totalTokens,
            promptTokens: stats.promptTokens,
            completionTokens: stats.completionTokens,
            requestCount: stats.requestCount,
            toolCalls: stats.toolCalls,
            messages: stats.requestsToday,
            estimatedCost: stats.estimatedCost,
          };
        } catch {
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            status: a.status,
            tokensUsedToday: 0,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            requestCount: 0,
            toolCalls: 0,
            messages: 0,
            estimatedCost: 0,
          };
        }
      });

      this.json(res, 200, { agents: agentUsage });
      return;
    }

    // Billing: API Keys
    if (path === '/api/keys' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { keys: this.billingService?.listAPIKeys(orgId) ?? [] });
      return;
    }

    if (path === '/api/keys' && req.method === 'POST') {
      if (!this.billingService) {
        this.json(res, 503, { error: 'Billing service not available' });
        return;
      }
      const body = await this.readBody(req);
      const key = this.billingService.createAPIKey(
        (body['orgId'] as string) ?? 'default',
        (body['name'] as string) ?? 'Default Key',
        body['scopes'] as string[],
        body['expiresInDays'] as number | undefined
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
      if (!this.billingService) {
        this.json(res, 503, { error: 'Billing service not available' });
        return;
      }
      const body = await this.readBody(req);
      const plan = this.billingService.setOrgPlan(
        (body['orgId'] as string) ?? 'default',
        (body['tier'] as 'free' | 'pro' | 'enterprise') ?? 'free'
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

    // Audit log
    if (path === '/api/audit' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { entries: [] });
        return;
      }
      const entries = this.auditService.query({
        orgId: url.searchParams.get('orgId') ?? 'default',
        agentId: url.searchParams.get('agentId') ?? undefined,
        type: (url.searchParams.get('type') as AuditEventType) ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
        since: url.searchParams.get('since') ?? undefined,
      });
      this.json(res, 200, { entries });
      return;
    }

    if (path === '/api/audit/summary' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { summary: null });
        return;
      }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const summary = this.auditService.summary(orgId);
      this.json(res, 200, { summary });
      return;
    }

    if (path === '/api/audit/tokens' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { usage: [] });
        return;
      }
      const usage = this.auditService.getTokenUsage(
        url.searchParams.get('orgId') ?? undefined,
        url.searchParams.get('agentId') ?? undefined
      );
      this.json(res, 200, { usage });
      return;
    }

    // Settings — LLM configuration
    if (path === '/api/settings/llm' && req.method === 'GET') {
      if (!this.llmRouter) {
        this.json(res, 200, { defaultProvider: 'unknown', providers: {} });
        return;
      }
      this.json(res, 200, this.llmRouter.getEnhancedSettings());
      return;
    }

    if (path === '/api/settings/llm' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const body = await this.readBody(req);
      const { defaultProvider } = body as { defaultProvider?: string };
      if (!defaultProvider) {
        this.json(res, 400, { error: 'defaultProvider is required' });
        return;
      }
      try {
        this.llmRouter.setDefaultProvider(defaultProvider);
        try {
          saveConfig({ llm: { defaultProvider } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist defaultProvider to config file', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path === '/api/settings/llm/models' && req.method === 'GET') {
      if (!this.llmRouter) {
        this.json(res, 200, { models: [] });
        return;
      }
      this.json(res, 200, { models: this.llmRouter.getModelCatalog() });
      return;
    }

    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'PATCH') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      const body = await this.readBody(req);
      try {
        this.llmRouter.updateProviderModelConfig(
          providerName,
          body as {
            contextWindow?: number;
            maxOutputTokens?: number;
            cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
          }
        );
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Config Export
    if (path === '/api/settings/export' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const sections = (body.sections as string[]) ?? ['llm', 'teams', 'agents', 'templates'];
      const exportData: Record<string, unknown> = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        sections: {},
      };
      const sectionData = exportData.sections as Record<string, unknown>;
      if (sections.includes('llm') && this.llmRouter) {
        sectionData.llm = this.llmRouter.getEnhancedSettings();
      }
      if (sections.includes('teams')) {
        const teams = this.orgService.listTeams(auth.orgId);
        sectionData.teams = teams;
      }
      if (sections.includes('agents')) {
        const agents = this.orgService.getAgentManager().listAgents();
        sectionData.agents = agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
        }));
      }
      this.json(res, 200, exportData);
      return;
    }

    // Settings — Config Import (preview and apply)
    if (path === '/api/settings/import' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { data, preview } = body as { data: Record<string, unknown>; preview?: boolean };
      if (!data || !data.sections) {
        this.json(res, 400, { error: 'Invalid import data: missing sections' });
        return;
      }
      const sections = data.sections as Record<string, unknown>;
      const available = Object.keys(sections);
      if (preview) {
        const summary: Record<string, { count: number; items: string[] }> = {};
        if (sections.llm) {
          const llm = sections.llm as Record<string, unknown>;
          const provCount = llm.providers ? Object.keys(llm.providers as object).length : 0;
          summary.llm = {
            count: provCount,
            items: llm.providers ? Object.keys(llm.providers as object) : [],
          };
        }
        if (sections.teams) {
          const teams = sections.teams as Array<{ name: string }>;
          summary.teams = { count: teams.length, items: teams.map(t => t.name) };
        }
        if (sections.agents) {
          const agents = sections.agents as Array<{ name: string }>;
          summary.agents = { count: agents.length, items: agents.map(a => a.name) };
        }
        this.json(res, 200, { available, summary });
        return;
      }
      // Apply import
      const applied: string[] = [];
      if (sections.llm && this.llmRouter) {
        const llm = sections.llm as {
          defaultProvider?: string;
          providers?: Record<
            string,
            {
              cost?: { input: number; output: number };
              contextWindow?: number;
              maxOutputTokens?: number;
            }
          >;
        };
        if (llm.providers) {
          for (const [name, cfg] of Object.entries(llm.providers)) {
            if (cfg.cost || cfg.contextWindow || cfg.maxOutputTokens) {
              this.llmRouter.updateProviderModelConfig(name, {
                cost: cfg.cost,
                contextWindow: cfg.contextWindow,
                maxOutputTokens: cfg.maxOutputTokens,
              });
            }
          }
        }
        if (llm.defaultProvider && this.llmRouter.listProviders().includes(llm.defaultProvider)) {
          this.llmRouter.setDefaultProvider(llm.defaultProvider);
        }
        applied.push('llm');
      }
      this.json(res, 200, { applied, message: `Imported ${applied.length} sections` });
      return;
    }

    // Settings — Import from OpenClaw config
    if (path === '/api/settings/import/openclaw' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { configPath, preview } = body as { configPath?: string; preview?: boolean };

      const { existsSync: fsExists, readFileSync: fsRead } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
      const { homedir } = await import('node:os');

      const possiblePaths = [
        configPath,
        pathJoin(homedir(), '.openclaw', 'openclaw.json'),
        pathJoin(homedir(), '.openclaw', 'openclaw.json5'),
      ].filter(Boolean) as string[];

      let found = '';
      let rawContent = '';
      for (const p of possiblePaths) {
        if (fsExists(p)) {
          found = p;
          rawContent = fsRead(p, 'utf-8');
          break;
        }
      }

      if (!found) {
        this.json(res, 404, { error: 'No OpenClaw config found', searchedPaths: possiblePaths });
        return;
      }

      try {
        const cleaned = rawContent
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/,\s*([\]}])/g, '$1');
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;

        const modelsSection = parsed.models as
          | {
              providers?: Record<
                string,
                {
                  baseUrl?: string;
                  models?: Array<{
                    id: string;
                    name: string;
                    cost?: { input: number; output: number };
                    contextWindow?: number;
                    maxTokens?: number;
                  }>;
                }
              >;
            }
          | undefined;
        const channelsSection = parsed.channels as Record<string, unknown> | undefined;

        if (preview) {
          const summary: Record<string, unknown> = { configPath: found };
          if (modelsSection?.providers) {
            const provs = Object.entries(modelsSection.providers).map(([name, cfg]) => ({
              name,
              modelCount: cfg.models?.length ?? 0,
              baseUrl: cfg.baseUrl,
            }));
            summary.models = { providerCount: provs.length, providers: provs };
          }
          if (channelsSection) {
            summary.channels = Object.keys(channelsSection).filter(
              k => k !== 'defaults' && k !== 'modelByChannel'
            );
          }
          this.json(res, 200, { found: true, summary });
          return;
        }

        // Apply model configs
        let appliedModels = 0;
        if (modelsSection?.providers && this.llmRouter) {
          for (const [name, cfg] of Object.entries(modelsSection.providers)) {
            if (cfg.models) {
              for (const m of cfg.models) {
                if (m.cost || m.contextWindow || m.maxTokens) {
                  this.llmRouter.updateProviderModelConfig(name, {
                    cost: m.cost,
                    contextWindow: m.contextWindow,
                    maxOutputTokens: m.maxTokens,
                  });
                  appliedModels++;
                }
              }
            }
          }
        }
        this.json(res, 200, { applied: true, appliedModels, configPath: found });
      } catch (err) {
        this.json(res, 400, { error: `Failed to parse OpenClaw config: ${String(err)}` });
      }
      return;
    }

    // ── Workflow Engine ────────────────────────────────────────────────────
    if (path === '/api/workflows' && req.method === 'GET') {
      if (!this.workflowEngine) {
        this.json(res, 200, { executions: [] });
        return;
      }
      const executions = this.workflowEngine.listExecutions().map(e => ({
        id: e.id,
        workflowId: e.workflowId,
        status: e.status,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
        error: e.error,
        stepCount: e.steps.size,
      }));
      this.json(res, 200, { executions });
      return;
    }

    if (path === '/api/workflows' && req.method === 'POST') {
      if (!this.workflowEngine) this.initWorkflowEngine();
      const body = await this.readBody(req);
      const action = body['action'] as string;
      if (action === 'validate') {
        const errors = this.workflowEngine!.validate(body['workflow'] as WorkflowDefinition);
        this.json(res, 200, { valid: errors.length === 0, errors });
        return;
      }
      try {
        const execution = await this.workflowEngine!.start(
          body['workflow'] as WorkflowDefinition,
          (body['inputs'] as Record<string, unknown>) ?? {}
        );
        this.json(res, 201, {
          executionId: execution.id,
          status: execution.status,
          outputs: execution.outputs,
          error: execution.error,
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'GET') {
      if (!this.workflowEngine) {
        this.json(res, 404, { error: 'No workflow engine' });
        return;
      }
      const executionId = path.split('/')[3]!;
      const execution = this.workflowEngine.getExecution(executionId);
      if (!execution) {
        this.json(res, 404, { error: 'Execution not found' });
        return;
      }
      const steps = [...execution.steps.entries()].map(([id, s]) => ({
        id,
        status: s.status,
        agentId: s.agentId,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: s.error,
        retryCount: s.retryCount,
        output: s.output,
      }));
      this.json(res, 200, { execution: { ...execution, steps } });
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'DELETE') {
      if (!this.workflowEngine) {
        this.json(res, 404, { error: 'No workflow engine' });
        return;
      }
      const executionId = path.split('/')[3]!;
      const cancelled = this.workflowEngine.cancel(executionId);
      this.json(res, 200, { cancelled });
      return;
    }

    // ── Team Templates ───────────────────────────────────────────────────
    if (path === '/api/team-templates' && req.method === 'GET') {
      const query = url.searchParams.get('q');
      const templates = query
        ? this.teamTemplateRegistry.search(query)
        : this.teamTemplateRegistry.list();
      this.json(res, 200, { templates });
      return;
    }

    if (path === '/api/team-templates' && req.method === 'POST') {
      const body = await this.readBody(req);
      const tpl = body as unknown as {
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        members: Array<{
          templateId: string;
          name?: string;
          count?: number;
          role?: 'manager' | 'worker';
        }>;
        tags?: string[];
        category?: string;
      };
      if (!tpl.name || !tpl.members?.length) {
        this.json(res, 400, { error: 'name and members are required' });
        return;
      }
      tpl.id = tpl.id || generateId('team');
      tpl.version = tpl.version || '1.0.0';
      tpl.author = tpl.author || 'user';
      this.teamTemplateRegistry.register(tpl);
      this.json(res, 201, { template: tpl });
      return;
    }

    if (path.startsWith('/api/team-templates/') && req.method === 'GET') {
      const id = path.split('/')[3]!;
      const tpl = this.teamTemplateRegistry.get(id);
      if (!tpl) {
        this.json(res, 404, { error: 'Team template not found' });
        return;
      }
      this.json(res, 200, { template: tpl });
      return;
    }

    if (path.startsWith('/api/team-templates/') && req.method === 'DELETE') {
      const id = path.split('/')[3]!;
      this.teamTemplateRegistry.unregister(id);
      this.json(res, 200, { deleted: true });
      return;
    }

    // ── Prompt Studio ──────────────────────────────────────────────────

    if (path === '/api/prompts' && req.method === 'GET') {
      const category = url.searchParams.get('category') ?? undefined;
      const q = url.searchParams.get('q');
      const prompts = q
        ? this.promptStudio.searchPrompts(q)
        : this.promptStudio.listPrompts(category);
      this.json(res, 200, { prompts });
      return;
    }

    if (path === '/api/prompts' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { name, description, category, content, tags } = body as {
        name: string;
        description: string;
        category: string;
        content: string;
        tags?: string[];
      };
      if (!name || !content) {
        this.json(res, 400, { error: 'name and content are required' });
        return;
      }
      const prompt = this.promptStudio.createPrompt({
        name,
        description: description ?? '',
        category: category ?? 'general',
        content,
        author: auth.userId ?? 'user',
        tags,
      });
      this.json(res, 201, { prompt });
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+$/) && req.method === 'GET') {
      const promptId = path.split('/')[3]!;
      const prompt = this.promptStudio.getPrompt(promptId);
      if (!prompt) {
        this.json(res, 404, { error: 'Prompt not found' });
        return;
      }
      this.json(res, 200, { prompt });
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+$/) && req.method === 'DELETE') {
      const promptId = path.split('/')[3]!;
      this.promptStudio.deletePrompt(promptId);
      this.json(res, 200, { deleted: true });
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+\/versions$/) && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const promptId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const { content, changelog } = body as { content: string; changelog?: string };
      if (!content) {
        this.json(res, 400, { error: 'content is required' });
        return;
      }
      try {
        const version = this.promptStudio.updatePrompt(
          promptId,
          content,
          auth.userId ?? 'user',
          changelog
        );
        this.json(res, 201, { version });
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+\/render$/) && req.method === 'POST') {
      const promptId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const { variables, version } = body as {
        variables?: Record<string, string>;
        version?: number;
      };
      try {
        const rendered = this.promptStudio.renderPrompt(promptId, variables ?? {}, version);
        this.json(res, 200, { rendered });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // A/B Tests
    if (path === '/api/prompts/ab-tests' && req.method === 'GET') {
      const promptId = url.searchParams.get('promptId') ?? undefined;
      const tests = this.promptStudio.listABTests(promptId);
      this.json(res, 200, { tests });
      return;
    }

    if (path === '/api/prompts/ab-tests' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { name, promptId, variantA, variantB, splitRatio } = body as {
        name: string;
        promptId: string;
        variantA: number;
        variantB: number;
        splitRatio?: number;
      };
      try {
        const test = this.promptStudio.createABTest({
          name,
          promptId,
          variantA,
          variantB,
          splitRatio,
        });
        this.json(res, 201, { test });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/prompts\/ab-tests\/[^/]+\/start$/) && req.method === 'POST') {
      const testId = path.split('/')[4]!;
      const started = this.promptStudio.startABTest(testId);
      this.json(res, 200, { started });
      return;
    }

    if (path.match(/^\/api\/prompts\/ab-tests\/[^/]+\/complete$/) && req.method === 'POST') {
      const testId = path.split('/')[4]!;
      const result = this.promptStudio.completeABTest(testId);
      if (!result) {
        this.json(res, 404, { error: 'Test not found or not running' });
        return;
      }
      this.json(res, 200, { test: result });
      return;
    }

    if (path.match(/^\/api\/prompts\/ab-tests\/[^/]+\/record$/) && req.method === 'POST') {
      const testId = path.split('/')[4]!;
      const body = await this.readBody(req);
      const { variant, score } = body as { variant: 'A' | 'B'; score: number };
      this.promptStudio.recordABResult(testId, variant, score);
      this.json(res, 200, { ok: true });
      return;
    }

    if (path.match(/^\/api\/prompts\/ab-tests\/[^/]+\/results$/) && req.method === 'GET') {
      const testId = path.split('/')[4]!;
      const results = this.promptStudio.getABTestResults(testId);
      if (!results) {
        this.json(res, 404, { error: 'Test not found' });
        return;
      }
      this.json(res, 200, results);
      return;
    }

    // Evaluations
    if (path.match(/^\/api\/prompts\/[^/]+\/evaluations$/) && req.method === 'GET') {
      const promptId = path.split('/')[3]!;
      const version = url.searchParams.get('version')
        ? parseInt(url.searchParams.get('version')!, 10)
        : undefined;
      const evaluations = this.promptStudio.getEvaluations(promptId, version);
      this.json(res, 200, { evaluations });
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+\/evaluate$/) && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const promptId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const { version, testInput, variables } = body as {
        version: number;
        testInput: string;
        variables?: Record<string, string>;
      };
      if (!testInput || version === undefined) {
        this.json(res, 400, { error: 'version and testInput are required' });
        return;
      }

      // Wire up LLM as executor if available
      if (this.llmRouter && !this.promptStudio['executor']) {
        this.promptStudio.setExecutor({
          execute: async (prompt: string) => {
            const startMs = Date.now();
            const response = await this.llmRouter!.chat({
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a helpful assistant. Respond to the prompt accurately and concisely.',
                },
                { role: 'user', content: prompt },
              ],
            });
            return {
              output: response.content,
              latencyMs: Date.now() - startMs,
              tokenCount: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
            };
          },
        });
      }

      try {
        const result = await this.promptStudio.evaluate(
          promptId,
          version,
          testInput,
          variables ?? {},
          auth.userId ?? 'user'
        );
        this.json(res, 200, { evaluation: result });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/prompts\/evaluations\/[^/]+\/score$/) && req.method === 'POST') {
      const evaluationId = path.split('/')[4]!;
      const body = await this.readBody(req);
      const { score, notes } = body as { score: number; notes?: string };
      const updated = this.promptStudio.scoreEvaluation(evaluationId, score, notes);
      this.json(res, 200, { updated });
      return;
    }

    if (path.match(/^\/api\/prompts\/[^/]+\/evaluation-summary$/) && req.method === 'GET') {
      const promptId = path.split('/')[3]!;
      const version = url.searchParams.get('version')
        ? parseInt(url.searchParams.get('version')!, 10)
        : undefined;
      if (version === undefined) {
        this.json(res, 400, { error: 'version query param is required' });
        return;
      }
      const summary = this.promptStudio.getEvaluationSummary(promptId, version);
      this.json(res, 200, { summary });
      return;
    }

    // Health
    if (path === '/api/health') {
      this.json(res, 200, {
        status: 'ok',
        version: '0.7.0',
        agents: this.orgService.getAgentManager().listAgents().length,
      });
      return;
    }

    // ── Governance: System Controls ──────────────────────────────────────────

    if (path === '/api/system/pause-all' && req.method === 'POST') {
      const body = await this.readBody(req);
      const am = this.orgService.getAgentManager();
      await am.pauseAllAgents(body['reason'] as string | undefined);
      this.auditService?.record({
        orgId: 'system',
        type: 'system_pause_all',
        action: 'pause_all',
        detail: body['reason'] as string,
        success: true,
      });
      this.json(res, 200, { status: 'paused', message: 'All agents paused' });
      return;
    }

    if (path === '/api/system/resume-all' && req.method === 'POST') {
      const am = this.orgService.getAgentManager();
      await am.resumeAllAgents();
      this.auditService?.record({
        orgId: 'system',
        type: 'system_resume_all',
        action: 'resume_all',
        success: true,
      });
      this.json(res, 200, { status: 'resumed', message: 'All agents resumed' });
      return;
    }

    if (path === '/api/system/emergency-stop' && req.method === 'POST') {
      const am = this.orgService.getAgentManager();
      await am.emergencyStop();
      this.auditService?.record({
        orgId: 'system',
        type: 'system_emergency_stop',
        action: 'emergency_stop',
        success: true,
      });
      this.json(res, 200, { status: 'stopped', message: 'EMERGENCY STOP — all agents terminated' });
      return;
    }

    if (path === '/api/system/status' && req.method === 'GET') {
      const am = this.orgService.getAgentManager();
      this.json(res, 200, {
        globalPaused: am.isGlobalPaused(),
        emergencyMode: am.isEmergencyMode(),
      });
      return;
    }

    // ── Governance: Announcements ─────────────────────────────────────────

    if (path === '/api/system/announcements' && req.method === 'POST') {
      const body = await this.readBody(req);
      const am = this.orgService.getAgentManager();
      const announcement = {
        id: generateId('ann'),
        type: (body['type'] as string) ?? 'info',
        title: body['title'] as string,
        content: body['content'] as string,
        priority: (body['priority'] as string) ?? 'normal',
        createdBy: (body['createdBy'] as string) ?? 'human',
        createdAt: new Date().toISOString(),
        expiresAt: body['expiresAt'] as string | undefined,
        targetScope: (body['targetScope'] as string) ?? 'all',
        targetIds: body['targetIds'] as string[] | undefined,
        acknowledged: [],
      };
      am.broadcastAnnouncement(announcement as any);
      this.auditService?.record({
        orgId: 'system',
        type: 'announcement_broadcast',
        action: 'broadcast',
        detail: announcement.title,
        success: true,
      });
      this.json(res, 201, { announcement });
      return;
    }

    if (path === '/api/system/announcements' && req.method === 'GET') {
      const am = this.orgService.getAgentManager();
      this.json(res, 200, { announcements: am.getActiveAnnouncements() });
      return;
    }

    // ── File preview ──────────────────────────────────────────────────────

    if (path === '/api/files/preview' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        this.json(res, 400, { error: 'Missing "path" query parameter' });
        return;
      }

      try {
        const { resolve, extname } = await import('node:path');
        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const resolved = resolve(filePath);

        // Security: only allow files under home/.markus (agent workspaces & shared data)
        const markusBase = join(homedir(), '.markus');
        if (!resolved.startsWith(markusBase)) {
          this.json(res, 403, { error: 'Access denied: file is outside the allowed directory' });
          return;
        }

        if (!existsSync(resolved)) {
          this.json(res, 404, { error: 'File not found' });
          return;
        }

        const stat = statSync(resolved);
        if (!stat.isFile()) {
          this.json(res, 400, { error: 'Path is not a file' });
          return;
        }

        const maxSize = 2 * 1024 * 1024; // 2MB limit
        if (stat.size > maxSize) {
          this.json(res, 413, { error: 'File too large for preview', size: stat.size, maxSize });
          return;
        }

        const ext = extname(resolved).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
        if (imageExts.includes(ext)) {
          const data = readFileSync(resolved);
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
          this.json(res, 200, {
            type: 'image',
            name: resolved.split('/').pop(),
            mimeType: mimeMap[ext] ?? 'application/octet-stream',
            content: data.toString('base64'),
          });
        } else {
          const content = readFileSync(resolved, 'utf-8');
          const mdExts = ['.md', '.markdown'];
          this.json(res, 200, {
            type: mdExts.includes(ext) ? 'markdown' : 'text',
            name: resolved.split('/').pop(),
            content,
          });
        }
      } catch (err) {
        this.json(res, 500, { error: `Failed to read file: ${String(err)}` });
      }
      return;
    }

    // ── Requirements ─────────────────────────────────────────────────────

    if (path === '/api/requirements' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const status = url.searchParams.get('status') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const iterationId = url.searchParams.get('iterationId') ?? undefined;
      if (!this.requirementService) {
        this.json(res, 200, { requirements: [] });
        return;
      }
      this.json(res, 200, {
        requirements: this.requirementService.listRequirements({
          orgId,
          status: status as any,
          source: source as any,
          projectId,
          iterationId,
        }),
      });
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'GET') {
      const reqId = path.split('/')[3]!;
      const requirement = this.requirementService?.getRequirement(reqId);
      if (!requirement) {
        this.json(res, 404, { error: 'Requirement not found' });
        return;
      }
      this.json(res, 200, { requirement });
      return;
    }

    if (path === '/api/requirements' && req.method === 'POST') {
      const authUser = await this.getAuthUser(req);
      const body = await this.readBody(req);
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      const requirement = this.requirementService.createRequirement({
        orgId: (body['orgId'] as string) ?? 'default',
        title: body['title'] as string,
        description: (body['description'] as string) ?? '',
        priority: body['priority'] as TaskPriority | undefined,
        projectId: body['projectId'] as string | undefined,
        iterationId: body['iterationId'] as string | undefined,
        source: 'user',
        createdBy: authUser?.userId ?? 'unknown',
        tags: body['tags'] as string[] | undefined,
      });
      this.json(res, 201, { requirement });
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'PUT') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      const body = await this.readBody(req);
      try {
        const requirement = this.requirementService.updateRequirement(reqId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
          tags: body['tags'] as string[] | undefined,
        });
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 404, { error: String(e) });
      }
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/status$/) && req.method === 'POST') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      const body = await this.readBody(req);
      const authUser = await this.getAuthUser(req);
      try {
        const requirement = this.requirementService.updateRequirementStatus(
          reqId,
          body['status'] as string as import('@markus/shared').RequirementStatus,
          authUser?.userId ?? 'unknown'
        );
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 400, { error: String(e) });
      }
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/approve$/) && req.method === 'POST') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      const authUser = await this.getAuthUser(req);
      try {
        const requirement = this.requirementService.approveRequirement(
          reqId,
          authUser?.userId ?? 'unknown'
        );
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 400, { error: String(e) });
      }
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/reject$/) && req.method === 'POST') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      const authUser = await this.getAuthUser(req);
      const body = await this.readBody(req);
      try {
        const requirement = this.requirementService.rejectRequirement(
          reqId,
          authUser?.userId ?? 'unknown',
          (body['reason'] as string) ?? ''
        );
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 400, { error: String(e) });
      }
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+$/) && req.method === 'DELETE') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      try {
        this.requirementService.cancelRequirement(reqId);
        this.json(res, 200, { ok: true });
      } catch (e) {
        this.json(res, 404, { error: String(e) });
      }
      return;
    }

    // ── Governance: Projects ──────────────────────────────────────────────

    if (path === '/api/projects' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? undefined;
      this.json(res, 200, { projects: this.projectService?.listProjects(orgId) ?? [] });
      return;
    }

    if (path === '/api/projects' && req.method === 'POST') {
      if (!this.projectService) {
        this.json(res, 503, { error: 'Project service not available' });
        return;
      }
      const body = await this.readBody(req);
      const project = this.projectService.createProject({
        orgId: (body['orgId'] as string) ?? 'default',
        name: body['name'] as string,
        description: (body['description'] as string) ?? '',
        iterationModel: body['iterationModel'] as any,
        repositories: body['repositories'] as any,
        teamIds: body['teamIds'] as any,
        governancePolicy: body['governancePolicy'] as any,
      });
      this.json(res, 201, { project });
      return;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'GET') {
      const projectId = path.split('/')[3]!;
      const project = this.projectService?.getProject(projectId);
      if (!project) {
        this.json(res, 404, { error: 'Project not found' });
        return;
      }
      this.json(res, 200, { project });
      return;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'PUT') {
      if (!this.projectService) {
        this.json(res, 503, { error: 'Project service not available' });
        return;
      }
      const projectId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const project = this.projectService.updateProject(projectId, body as any);
        this.json(res, 200, { project });
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/projects\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.projectService) {
        this.json(res, 503, { error: 'Project service not available' });
        return;
      }
      const projectId = path.split('/')[3]!;
      this.projectService.deleteProject(projectId);
      this.json(res, 200, { deleted: true });
      return;
    }

    // ── Governance: Iterations ────────────────────────────────────────────

    if (path.match(/^\/api\/projects\/[^/]+\/iterations$/) && req.method === 'GET') {
      const projectId = path.split('/')[3]!;
      this.json(res, 200, { iterations: this.projectService?.listIterations(projectId) ?? [] });
      return;
    }

    if (path.match(/^\/api\/projects\/[^/]+\/iterations$/) && req.method === 'POST') {
      if (!this.projectService) {
        this.json(res, 503, { error: 'Project service not available' });
        return;
      }
      const projectId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const iteration = this.projectService.createIteration({
        projectId,
        name: body['name'] as string,
        goal: body['goal'] as string,
        startDate: body['startDate'] as string,
        endDate: body['endDate'] as string,
      });
      this.json(res, 201, { iteration });
      return;
    }

    if (path.match(/^\/api\/iterations\/[^/]+\/status$/) && req.method === 'PUT') {
      if (!this.projectService) {
        this.json(res, 503, { error: 'Project service not available' });
        return;
      }
      const iterationId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const iteration = this.projectService.updateIterationStatus(
          iterationId,
          body['status'] as any
        );
        this.json(res, 200, { iteration });
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // ── Governance: Task Review ───────────────────────────────────────────

    if (path.match(/^\/api\/tasks\/[^/]+\/accept$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const body = await this.readBody(req);
        const reviewerAgentId = body['reviewerAgentId'] as string | undefined;
        const task = await this.taskService.acceptTask(taskId, reviewerAgentId);
        this.json(res, 200, { task });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/revision$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const task = this.taskService.requestRevision(
          taskId,
          (body['reason'] as string) ?? 'Revisions needed'
        );
        this.json(res, 200, { task });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/archive$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.archiveTask(taskId);
        this.json(res, 200, { task });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── Governance: Governance Policy ─────────────────────────────────────

    if (path === '/api/governance/policy' && req.method === 'GET') {
      this.json(res, 200, { policy: this.taskService.getGovernancePolicy() });
      return;
    }

    if (path === '/api/governance/policy' && req.method === 'PUT') {
      const body = await this.readBody(req);
      this.taskService.setGovernancePolicy(body as any);
      this.json(res, 200, { policy: this.taskService.getGovernancePolicy() });
      return;
    }

    // ── Governance: Reports ───────────────────────────────────────────────

    if (path === '/api/reports' && req.method === 'GET') {
      this.json(res, 200, {
        reports:
          this.reportService?.listReports({
            scope: url.searchParams.get('scope') ?? undefined,
            scopeId: url.searchParams.get('scopeId') ?? undefined,
            type: url.searchParams.get('type') ?? undefined,
          }) ?? [],
      });
      return;
    }

    if (path === '/api/reports/generate' && req.method === 'POST') {
      if (!this.reportService) {
        this.json(res, 503, { error: 'Report service not available' });
        return;
      }
      const body = await this.readBody(req);
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

      const report = await this.reportService.generateReport({
        type: period as any,
        scope: scope as any,
        scopeId,
        periodStart,
        periodEnd,
        includePlan: body['includePlan'] as boolean,
      });
      this.json(res, 200, { report });
      return;
    }

    if (path.match(/^\/api\/reports\/[^/]+$/) && req.method === 'GET') {
      const reportId = path.split('/')[3]!;
      const report = this.reportService?.getReport(reportId);
      if (!report) {
        this.json(res, 404, { error: 'Report not found' });
        return;
      }
      this.json(res, 200, { report });
      return;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/plan\/approve$/) && req.method === 'POST') {
      if (!this.reportService) {
        this.json(res, 503, { error: 'Report service not available' });
        return;
      }
      const reportId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const report = this.reportService.approvePlan(
          reportId,
          (body['userId'] as string) ?? 'human'
        );
        this.json(res, 200, { report });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/plan\/reject$/) && req.method === 'POST') {
      if (!this.reportService) {
        this.json(res, 503, { error: 'Report service not available' });
        return;
      }
      const reportId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const report = this.reportService.rejectPlan(
          reportId,
          (body['userId'] as string) ?? 'human',
          (body['reason'] as string) ?? ''
        );
        this.json(res, 200, { report });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/feedback$/) && req.method === 'POST') {
      if (!this.reportService) {
        this.json(res, 503, { error: 'Report service not available' });
        return;
      }
      const reportId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const feedback = this.reportService.addFeedback({
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
      this.json(res, 201, { feedback });
      return;
    }

    if (path.match(/^\/api\/reports\/[^/]+\/feedback$/) && req.method === 'GET') {
      const reportId = path.split('/')[3]!;
      this.json(res, 200, { feedback: this.reportService?.getFeedback(reportId) ?? [] });
      return;
    }

    // ── Governance: Knowledge ─────────────────────────────────────────────

    if (path === '/api/knowledge/search' && req.method === 'GET') {
      const query = url.searchParams.get('query') ?? '';
      const scope = url.searchParams.get('scope') as any;
      const scopeId = url.searchParams.get('scopeId') ?? undefined;
      const category = url.searchParams.get('category') as any;
      this.json(res, 200, {
        results: this.knowledgeService?.search({ query, scope, scopeId, category }) ?? [],
      });
      return;
    }

    if (path === '/api/knowledge' && req.method === 'POST') {
      if (!this.knowledgeService) {
        this.json(res, 503, { error: 'Knowledge service not available' });
        return;
      }
      const body = await this.readBody(req);
      const entry = this.knowledgeService.contribute({
        scope: body['scope'] as any,
        scopeId: body['scopeId'] as string,
        category: body['category'] as any,
        title: body['title'] as string,
        content: body['content'] as string,
        source: (body['source'] as string) ?? 'human',
        importance: body['importance'] as number,
        tags: body['tags'] as string[],
        supersedes: body['supersedes'] as string,
      });
      this.json(res, 201, { entry });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/flag-outdated$/) && req.method === 'POST') {
      if (!this.knowledgeService) { this.json(res, 503, { error: 'Knowledge service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      const body = await this.readBody(req);
      this.knowledgeService.flagOutdated(knowledgeId, (body['reason'] as string) ?? '');
      this.json(res, 200, { status: 'flagged' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/verify$/) && req.method === 'POST') {
      if (!this.knowledgeService) { this.json(res, 503, { error: 'Knowledge service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      const body = await this.readBody(req);
      this.knowledgeService.verify(knowledgeId, (body['verifiedBy'] as string) ?? 'human');
      this.json(res, 200, { status: 'verified' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.knowledgeService) { this.json(res, 503, { error: 'Knowledge service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      this.knowledgeService.flagOutdated(knowledgeId, 'deleted by user');
      this.json(res, 200, { status: 'deleted' });
      return;
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private projectService?: ProjectService;
  private reportService?: ReportService;
  private knowledgeService?: KnowledgeService;
  private requirementService?: RequirementService;

  setProjectService(svc: ProjectService): void {
    this.projectService = svc;
  }
  setReportService(svc: ReportService): void {
    this.reportService = svc;
  }
  setKnowledgeService(svc: KnowledgeService): void {
    this.knowledgeService = svc;
  }
  setRequirementService(svc: RequirementService): void {
    this.requirementService = svc;
  }

  private buildOpsDashboard(orgId: string | undefined, period: '1h' | '24h' | '7d') {
    const taskDashboard = this.taskService.getDashboard(orgId);

    // Agent efficiency ranking with health scores
    const agentManager = this.orgService.getAgentManager();
    const allAgents = agentManager.listAgents();
    const agentRanking = allAgents
      .map(a => {
        try {
          const agent = agentManager.getAgent(a.id);
          const metrics = agent.getMetrics(period);
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            agentRole: a.agentRole,
            status: a.status,
            healthScore: metrics.healthScore,
            tokenUsage: metrics.tokenUsage,
            taskMetrics: metrics.taskMetrics,
            averageResponseTimeMs: metrics.averageResponseTimeMs,
            errorRate: metrics.errorRate,
            totalInteractions: metrics.totalInteractions,
          };
        } catch {
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            agentRole: a.agentRole,
            status: a.status,
            healthScore: 0,
            tokenUsage: { input: 0, output: 0, cost: 0 },
            taskMetrics: { completed: 0, failed: 0, cancelled: 0, averageCompletionTimeMs: 0 },
            averageResponseTimeMs: 0,
            errorRate: 0,
            totalInteractions: 0,
          };
        }
      })
      .sort((a, b) => b.healthScore - a.healthScore);

    // System health summary
    const healthScores = agentRanking.map(a => a.healthScore);
    const avgHealth =
      healthScores.length > 0
        ? Math.round(healthScores.reduce((s, h) => s + h, 0) / healthScores.length)
        : 0;
    const criticalAgents = agentRanking.filter(a => a.healthScore < 50);
    const totalTokenCost = agentRanking.reduce((s, a) => s + a.tokenUsage.cost, 0);
    const totalInteractions = agentRanking.reduce((s, a) => s + a.totalInteractions, 0);

    const taskSuccessRate =
      taskDashboard.totalTasks > 0
        ? Math.round((taskDashboard.statusCounts.completed / taskDashboard.totalTasks) * 100)
        : 0;

    const blockedTasks = taskDashboard.statusCounts.blocked ?? 0;

    return {
      period,
      generatedAt: new Date().toISOString(),
      systemHealth: {
        overallScore: avgHealth,
        activeAgents: allAgents.filter(a => a.status !== 'offline').length,
        totalAgents: allAgents.length,
        criticalAgents: criticalAgents.map(a => ({
          id: a.agentId,
          name: a.agentName,
          score: a.healthScore,
        })),
        totalTokenCost: Math.round(totalTokenCost * 10000) / 10000,
        totalInteractions,
      },
      taskKPI: {
        totalTasks: taskDashboard.totalTasks,
        statusCounts: taskDashboard.statusCounts,
        successRate: taskSuccessRate,
        blockedCount: blockedTasks,
        averageCompletionTimeMs: taskDashboard.averageCompletionTimeMs,
        recentActivity: taskDashboard.recentActivity.slice(0, 10),
      },
      agentEfficiency: agentRanking,
    };
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

  /** Resolve the role directory path for an agent. Uses roleId, normalized role name, or matching by display name. */
  private resolveAgentRoleDir(agent: {
    config: { id: string; roleId?: string };
    role: { name: string };
  }): string | null {
    // Prefer agent's own per-agent role directory (supports self-evolution)
    const agentDataDir = join(this.orgService.getAgentManager().getDataDir(), agent.config.id);
    const agentRoleDir = join(agentDataDir, 'role');
    if (existsSync(join(agentRoleDir, 'ROLE.md'))) return agentRoleDir;

    // Fall back to shared template directory
    const base = join(process.cwd(), 'templates', 'roles');
    if (!existsSync(base)) return null;

    const tryDir = (dirName: string): string | null => {
      const p = join(base, dirName, 'ROLE.md');
      return existsSync(p) ? join(base, dirName) : null;
    };

    if (agent.config.roleId) {
      const d = tryDir(agent.config.roleId);
      if (d) return d;
    }

    const normalized = agent.role.name.toLowerCase().replace(/\s+/g, '-');
    const d = tryDir(normalized);
    if (d) return d;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rolePath = join(base, entry.name, 'ROLE.md');
      if (!existsSync(rolePath)) continue;
      try {
        const content = readFileSync(rolePath, 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        const displayName = match?.[1]?.trim();
        if (displayName && displayName.toLowerCase() === agent.role.name.toLowerCase()) {
          return join(base, entry.name);
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }
}
