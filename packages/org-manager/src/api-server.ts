import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger, generateId, saveConfig, getTextContent, stripInternalBlocks, extractThinkBlocks, APP_VERSION, buildManifest, readManifest, manifestFilename, validateManifest, type TaskStatus, type TaskPriority, type TaskSortField, type SortOrder, type PackageType, type RequirementStatus } from '@markus/shared';
import {
  GatewayError,
  WorkflowEngine,
  createDefaultTeamTemplates,
  createDefaultTemplateRegistry,
  generateHandbook,
  GatewaySyncHandler,
  readSkillInstructions,
  type TeamTemplateRegistry,
  type AgentToolHandler,
  type ExternalAgentGateway,
  type LLMRouter,
  type ReviewService,
  type SkillRegistry,
  type TemplateRegistry,
  type WorkflowExecutor,
  type WorkflowDefinition,
  type SyncRequest,
  type HandbookColleague,
  type HandbookProject,
  discoverSkillsInDir,
  WELL_KNOWN_SKILL_DIRS,
  type AgentManager,
  type SkillCategory,
} from '@markus/core';
import type { ChannelMsg } from '@markus/storage';
import { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import type { BillingService } from './billing-service.js';
import type { AuditService, AuditEventType } from './audit-service.js';
import type { StorageBridge } from './storage-bridge.js';
import type { ProjectService } from './project-service.js';
import type { ReportService } from './report-service.js';
import type { KnowledgeService } from './knowledge-service.js';
import type { DeliverableService } from './deliverable-service.js';
import type { RequirementService } from './requirement-service.js';
import { WSBroadcaster } from './ws-server.js';
import { SSEHandler } from './sse-handler.js';
import { installSkill } from './skill-service.js';

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
  private hubUrl = 'https://markus.global';
  private webUiDir?: string;
  private gateway?: ExternalAgentGateway;
  private gatewaySecret?: string;
  private syncHandler?: GatewaySyncHandler;
  private gatewayMessageQueue = new Map<string, Array<{ id: string; from: string; fromName: string; content: string; timestamp: string }>>();
  private reviewService?: ReviewService;
  private registryCache?: Map<string, { data: unknown; ts: number }>;
  private templateRegistry?: TemplateRegistry;
  private workflowEngine?: WorkflowEngine;
  private teamTemplateRegistry: TeamTemplateRegistry;
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
    private port: number = 8056
  ) {
    this.ws = new WSBroadcaster();
    this.teamTemplateRegistry = createDefaultTeamTemplates();
    this.templateRegistry = createDefaultTemplateRegistry();
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
        const cleanText = stripInternalBlocks(message);
        if (this.storage) {
          await this.storage.channelMessageRepo.append({
            orgId: 'default',
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: cleanText,
          });
        }
        this.ws.broadcast({
          type: 'chat:message',
          payload: {
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: cleanText,
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
            priority: t.priority, status: t.status,
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
            orgId: req.orgId,
            assignedAgentId: req.assignedAgentId,
            reviewerAgentId: req.reviewerAgentId,
            createdBy: req.createdBy,
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
        return self.projectService.listProjects(orgId).map(p => ({
          id: p.id,
          name: p.name,
        }));
      },
      getActiveRequirements(orgId: string) {
        if (!self.requirementService) return [];
        return self.requirementService.listRequirements({ orgId })
          .filter(r => r.status === 'in_progress')
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

  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  setWebUiDir(dir: string): void {
    this.webUiDir = dir;
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
        const reply = await agent.sendMessage(
          taskDescription,
          'workflow-engine',
          { name: 'workflow', role: 'system' },
          {
            sourceType: 'task_assignment',
            ephemeral: true,
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
    if (allUsers.some((u: any) => u.passwordHash && u.id === 'default')) return;

    // Remove any stale non-default admin users from old versions
    for (const u of allUsers.filter((u: any) => u.passwordHash && u.id !== 'default')) {
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

  /**
   * Process a single agent's reply in a group chat broadcast.
   * Each agent decides independently whether to respond.
   * Replies are persisted and broadcast via WebSocket.
   */
  private async processGroupChatReply(
    agentId: string,
    userMessage: string,
    senderId: string,
    senderInfo: { name: string; role: string } | undefined,
    channel: string,
    orgId: string,
    channelContext: Array<{ role: string; content: string }>,
    agentManager: AgentManager,
    teamSize: number,
  ): Promise<void> {
    try {
      const agent = agentManager.getAgent(agentId);
      const agentName = agent.config.name;

      const groupChatPrefix = [
        `[GROUP CHAT — ${teamSize} team members]`,
        'You are in a group chat with your team. Every member receives this message independently.',
        'Only respond if the message is relevant to your role or expertise.',
        'If you have nothing meaningful to contribute, respond with exactly: [NO_RESPONSE]',
        '---',
        '',
      ].join('\n');

      const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
      const reply = await agent.sendMessage(
        groupChatPrefix + userMessage,
        senderId,
        senderInfo,
        {
          sourceType: 'human_chat',
          ephemeral: true,
          channelContext,
          toolEventCollector: toolEvents,
        }
      );

      // Skip if the agent chose not to respond
      if (!reply || reply.trim() === '[NO_RESPONSE]' || !reply.trim()) {
        return;
      }

      // Separate clean text from internal process data
      const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
      if (!cleanReply.trim() || cleanReply.trim() === '[NO_RESPONSE]') return;

      const metadata: Record<string, unknown> = {};
      if (thinking.length > 0) metadata['thinking'] = thinking;
      if (toolEvents.length > 0) metadata['toolCalls'] = toolEvents;

      // Persist agent reply
      if (this.storage) {
        await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId: agentId,
          senderType: 'agent',
          senderName: agentName,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata as any : undefined,
        });
      }

      // Broadcast via WebSocket so the frontend picks it up
      this.ws.broadcast({
        type: 'chat:message',
        payload: {
          channel,
          senderId: agentId,
          senderType: 'agent',
          senderName: agentName,
          text: cleanReply,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('Group chat agent reply failed', { agentId, error: String(err) });

      // Persist error for visibility
      if (this.storage) {
        try {
          const errDetail = String(err).slice(0, 500);
          await this.storage.channelMessageRepo.append({
            orgId,
            channel,
            senderId: agentId,
            senderType: 'system',
            senderName: 'System',
            text: `⚠ AI service error: ${errDetail}`,
            mentions: [],
          });
        } catch { /* best-effort */ }
      }
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
      const title = !session!.title ? userMessage.slice(0, 60) : undefined;
      const meta = images?.length ? { images } : undefined;
      await this.storage.chatSessionRepo.appendMessage(session!.id, agentId, 'user', userMessage, 0, meta);
      if (title) await this.storage.chatSessionRepo.updateLastMessage(session!.id, title);
      return session!.id;
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
    this.server.listen(this.port, '0.0.0.0', () => {
      log.info(`API server listening on 0.0.0.0:${this.port} (HTTP + WebSocket)`);
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

      // Build lightweight channel context (last 20 messages, strip internal blocks for agents)
      const buildChannelContext = async (): Promise<Array<{ role: string; content: string }>> => {
        if (!this.storage) return [];
        try {
          const recent = await this.storage.channelMessageRepo.getMessages(channel, 20);
          return (recent.messages ?? []).map((m: ChannelMsg) => ({
            role: m.senderType === 'agent' ? 'assistant' : 'user',
            content: m.senderType === 'agent'
              ? stripInternalBlocks(m.text)
              : `[${m.senderName}]: ${m.text}`,
          }));
        } catch {
          return [];
        }
      };

      // ── Group chat broadcast: all team members respond independently ──
      if (!isHumanChannel && channel.startsWith('group:') && !targetAgentId) {
        const teamId = channel.replace(/^group:/, '');
        const team = this.orgService.getTeam(teamId);
        const allAgentIds = team?.memberAgentIds ?? [];

        if (allAgentIds.length === 0) {
          this.json(res, 200, { userMessage: userMsg ?? null, agentMessage: null });
          return;
        }

        const channelContext = await buildChannelContext();
        const senderInfo = this.orgService.resolveHumanIdentity(senderId);
        const agentManager = this.orgService.getAgentManager();

        // Fire-and-forget: each agent processes the message independently
        for (const agentId of allAgentIds) {
          void this.processGroupChatReply(
            agentId, text, senderId, senderInfo, channel, orgId, channelContext, agentManager, allAgentIds.length,
          );
        }

        // Return immediately with only the user message
        this.json(res, 200, { userMessage: userMsg ?? null, agentMessage: null });
        return;
      }

      // ── Single-agent routing (@mention, non-group, or fallback) ──
      let routedAgentId: string | null | undefined = null;
      if (!isHumanChannel) {
        if (targetAgentId) {
          routedAgentId = targetAgentId;
        } else if (channel.startsWith('group:')) {
          // @mention already handled above; this is a fallback for custom group chats
          routedAgentId = this.orgService.routeMessage(orgId, { text });
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

      const channelContext = await buildChannelContext();

      let reply: string;
      const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
      try {
        reply = await agent.sendMessage(text, senderId, senderInfo, {
          sourceType: 'human_chat',
          ephemeral: true,
          channelContext,
          toolEventCollector: toolEvents,
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

      // Separate clean text from internal process data
      const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
      const metadata: Record<string, unknown> = {};
      if (thinking.length > 0) metadata['thinking'] = thinking;
      if (toolEvents.length > 0) metadata['toolCalls'] = toolEvents;

      // Persist agent reply
      let agentMsg: ChannelMsg | undefined;
      if (this.storage) {
        agentMsg = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata as any : undefined,
        });
        void this.persistChatTurn(routedAgentId, text, reply, senderId);
      }

      // No WS broadcast here — the HTTP response delivers the agentMessage directly
      // to the requesting client. WS broadcast is only needed for group chat async replies.
      this.json(res, 200, {
        userMessage: userMsg ?? null,
        agentMessage: agentMsg ?? {
          id: `tmp_${Date.now()}`,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
        const reply = await targetAgent.sendMessage(messageText, fromAgentId, {
          name: fromAgent.config.name,
          role: fromAgent.config.agentRole ?? 'worker',
        }, { sourceType: 'a2a_message' });
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

        if (!sessionId) {
          agent.startNewSession();
        } else if (this.storage) {
          // Restore agent memory context from DB session history so the agent
          // has full conversation context when replying to an existing chat.
          try {
            const histResult = await this.storage.chatSessionRepo.getMessages(sessionId, 200);
            agent.restoreSessionFromHistory(
              sessionId,
              histResult.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
            );
          } catch (err) {
            log.warn('Failed to restore session history, starting fresh', { sessionId, error: String(err) });
            agent.startNewSession();
          }
        }

        const userText = body['text'] as string;

        // Wrap persistUserMessage to bind DB session → memory session on first message
        const bindingPersist = async (
          aId: string, text: string, sId?: string, imgs?: string[], sessId?: string,
        ): Promise<string | null> => {
          const dbSessId = await this.persistUserMessage(aId, text, sId, imgs, sessId);
          if (dbSessId && !sessId) {
            agent.bindDbSession(dbSessId);
          }
          return dbSessId;
        };

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
            persistUserMessage: bindingPersist,
            persistAssistantMessage: this.persistAssistantMessage.bind(this),
            executionStreamRepo: this.storage?.executionStreamRepo,
          });

          await sseHandler.handle(res);
        } else {
          const userMsgPersisted = await bindingPersist(agentId!, userText, senderId, images, sessionId);
          const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
          let reply: string;
          try {
            reply = await agent.sendMessage(userText, senderId, senderInfo, { images, toolEventCollector: toolEvents });
          } catch (err) {
            const errText = `⚠ AI service error: ${String(err).slice(0, 500)}`;
            void this.persistAssistantMessage(
              userMsgPersisted, agentId!, errText, 0, { isError: true },
            );
            throw err;
          }
          this.json(res, 200, { reply, sessionId: userMsgPersisted });
          const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
          const segments: Array<Record<string, unknown>> = [];
          if (thinking.length > 0) segments.push({ type: 'text', content: '', thinking: thinking.join('\n\n') });
          for (const te of toolEvents) {
            segments.push({ type: 'tool', tool: te.tool, status: te.status, arguments: te.arguments, result: te.result, durationMs: te.durationMs });
          }
          if (segments.length > 0) segments.push({ type: 'text', content: cleanReply });
          const meta = segments.length > 0 ? { segments } : undefined;
          void this.persistAssistantMessage(
            userMsgPersisted,
            agentId!,
            reply,
            agent.getState().tokensUsedToday,
            meta
          );
        }

        const _st = agent.getState();
        this.ws.broadcastAgentUpdate(agentId!, _st.status, { lastError: _st.lastError, lastErrorAt: _st.lastErrorAt, currentActivity: _st.currentActivity });
        return;
      }
    }

    if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === 'DELETE') {
      const agentId = path.split('/')[3]!;
      if (this.orgService.isProtectedAgent(agentId)) {
        this.json(res, 403, { error: 'The Secretary agent is a protected system agent and cannot be deleted.' });
        return;
      }
      if (this.gateway) {
        const extReg = this.gateway.listRegistrations().find(r => r.markusAgentId === agentId);
        if (extReg) {
          await this.gateway.unregister(extReg.externalAgentId, extReg.orgId);
        }
      }
      const purgeFiles = url.searchParams.get('purgeFiles') === 'true';
      await this.orgService.fireAgent(agentId, { purgeFiles });
      this.json(res, 200, { deleted: true, purgedFiles: purgeFiles });
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
      const purgeFiles = url.searchParams.get('purgeFiles') === 'true';
      await this.orgService.deleteTeam(teamId, deleteMembers, { purgeFiles });
      this.json(res, 200, { deleted: true, purgedFiles: purgeFiles });
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

    // Team files (announcements, norms, etc.)
    if (path.match(/^\/api\/teams\/[^/]+\/files$/) && req.method === 'GET') {
      const teamId = path.split('/')[3]!;
      const dir = this.orgService.getTeamDataDir(teamId);
      if (!existsSync(dir)) {
        this.json(res, 200, { files: [] });
        return;
      }
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      this.json(res, 200, { files });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/files\/[^/]+$/) && req.method === 'GET') {
      const parts = path.split('/');
      const teamId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      if (filename.includes('..') || filename.includes('/')) {
        this.json(res, 400, { error: 'Invalid filename' });
        return;
      }
      const filePath = join(this.orgService.getTeamDataDir(teamId), filename);
      if (!existsSync(filePath)) {
        this.json(res, 404, { error: 'File not found' });
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      this.json(res, 200, { filename, content });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/files\/[^/]+$/) && req.method === 'PUT') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const parts = path.split('/');
      const teamId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      if (filename.includes('..') || filename.includes('/')) {
        this.json(res, 400, { error: 'Invalid filename' });
        return;
      }
      const body = await this.readBody(req);
      const content = body['content'] as string | undefined;
      const dir = this.orgService.getTeamDataDir(teamId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), content ?? '', 'utf-8');
      this.json(res, 200, { ok: true });
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
      const requirementId = url.searchParams.get('requirementId') ?? undefined;
      const priority = url.searchParams.get('priority') as TaskPriority | undefined;
      const search = url.searchParams.get('search') ?? undefined;
      const sortBy = url.searchParams.get('sortBy') as TaskSortField | undefined;
      const sortOrder = url.searchParams.get('sortOrder') as SortOrder | undefined;
      const pageParam = url.searchParams.get('page');
      const pageSizeParam = url.searchParams.get('pageSize');
      const page = pageParam ? parseInt(pageParam, 10) : undefined;
      const pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : undefined;

      const result = this.taskService.queryTasks({
        orgId, status, assignedAgentId, projectId, requirementId,
        priority, search, sortBy, sortOrder, page, pageSize,
      });
      this.json(res, 200, result);
      return;
    }

    if (path === '/api/tasks/scheduled' && req.method === 'GET') {
      const tasks = this.taskService.listScheduledTasks();
      this.json(res, 200, { tasks });
      return;
    }

    if (path === '/api/tasks/deliverables' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const all = this.taskService.listTasks({ projectId });
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
      this.json(res, 200, { items });
      return;
    }

    // ── Unified Deliverables CRUD ──────────────────────────────────────────

    if (path === '/api/deliverables' && req.method === 'GET') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const q = url.searchParams.get('q') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const taskId = url.searchParams.get('taskId') ?? undefined;
      const type = url.searchParams.get('type') as any ?? undefined;
      const status = url.searchParams.get('status') as any ?? undefined;
      const artifactType = url.searchParams.get('artifactType') as any ?? undefined;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
      const { results, total } = this.deliverableService.search({ query: q, projectId, agentId, taskId, type, status, artifactType, offset, limit });
      this.json(res, 200, { results, total });
      return;
    }

    if (path === '/api/deliverables' && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.create({
          type: body['type'] as any,
          title: body['title'] as string,
          summary: body['summary'] as string,
          reference: body['reference'] as string,
          tags: body['tags'] as string[],
          taskId: body['taskId'] as string,
          agentId: body['agentId'] as string,
          projectId: body['projectId'] as string,
          requirementId: body['requirementId'] as string,
        });
        this.json(res, 201, { deliverable: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/deliverables\/[^/]+$/) && req.method === 'PUT') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const delivId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.update(delivId, {
          title: body['title'] as string | undefined,
          summary: body['summary'] as string | undefined,
          reference: body['reference'] as string | undefined,
          tags: body['tags'] as string[] | undefined,
          status: body['status'] as any,
          type: body['type'] as any,
        });
        if (!d) { this.json(res, 404, { error: 'Deliverable not found' }); return; }
        this.json(res, 200, { deliverable: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/deliverables\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const delivId = path.split('/')[3]!;
      await this.deliverableService.remove(delivId);
      this.json(res, 200, { status: 'removed' });
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
      const assignedAgentId = (body['assignedAgentId'] as string | undefined)?.trim();
      const reviewerAgentId = (body['reviewerAgentId'] as string | undefined)?.trim();
      if (!assignedAgentId || !reviewerAgentId) {
        this.json(res, 400, { error: 'assignedAgentId and reviewerAgentId are required' });
        return;
      }
      const agentMgr = this.orgService.getAgentManager();
      if (!agentMgr.hasAgent(assignedAgentId)) {
        this.json(res, 400, { error: `Assigned agent not found: ${assignedAgentId}` });
        return;
      }
      if (!agentMgr.hasAgent(reviewerAgentId)) {
        this.json(res, 400, { error: `Reviewer agent not found: ${reviewerAgentId}` });
        return;
      }
      const scheduleRaw = body['scheduleConfig'] as Record<string, unknown> | undefined;
      const task = this.taskService.createTask({
        orgId: (body['orgId'] as string) ?? 'default',
        title: body['title'] as string,
        description: body['description'] as string,
        priority: body['priority'] as TaskPriority | undefined,
        assignedAgentId,
        reviewerAgentId,
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
        if (agentId) {
          const task = this.taskService.assignTask(taskId, agentId);
          this.json(res, 200, { task });
        } else {
          this.json(res, 400, { error: 'assignedAgentId is required — tasks must always have an assignee' });
        }
        return;
      }

      // General field update (title/description/priority/projectId/requirementId/blockedBy/reviewerAgentId)
      if (
        body['title'] !== undefined ||
        body['description'] !== undefined ||
        body['priority'] !== undefined ||
        body['projectId'] !== undefined ||
        body['requirementId'] !== undefined ||
        body['blockedBy'] !== undefined ||
        body['reviewerAgentId'] !== undefined
      ) {
        const task = this.taskService.updateTask(taskId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
          projectId: body['projectId'] !== undefined ? (body['projectId'] as string | null) : undefined,
          requirementId: body['requirementId'] !== undefined ? (body['requirementId'] as string | null) : undefined,
          blockedBy: Array.isArray(body['blockedBy']) ? body['blockedBy'] as string[] : undefined,
          reviewerAgentId: body['reviewerAgentId'] as string | undefined,
        }, authUser?.userId);
        this.json(res, 200, { task });
        return;
      }

      this.json(res, 400, { error: 'Provide status, assignedAgentId, or task fields to update' });
      return;
    }

    // Task approve/reject — the only way to transition out of pending.
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

    if (path.match(/^\/api\/tasks\/[^/]+\/cancel$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      const authUser = await this.getAuthUser(req);
      const body = await this.readBody(req);
      const cascade = body['cascade'] === true;
      try {
        const task = this.taskService.cancelTask(taskId, cascade, authUser?.userId);
        this.json(res, 200, { task });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/dependents$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const count = this.taskService.getDependentTaskCount(taskId);
      this.json(res, 200, { count });
      return;
    }

    if (path.startsWith('/api/tasks/') && req.method === 'DELETE' && !path.includes('/subtasks/')) {
      this.json(res, 400, { error: 'Tasks cannot be deleted — use cancel instead to preserve audit trail' });
      return;
    }

    // Subtasks (embedded within a task)
    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      const task = this.taskService.getTask(taskId);
      if (!task) { this.json(res, 404, { error: 'Task not found' }); return; }
      this.json(res, 200, { subtasks: task.subtasks });
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/subtasks$/) && req.method === 'POST') {
      const body = await this.readBody(req);
      const taskId = path.split('/')[3]!;
      const subtask = this.taskService.addSubtask(taskId, body['title'] as string);
      this.json(res, 201, { subtask });
      return;
    }

    // Complete/cancel a specific subtask
    const subtaskActionMatch = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/(complete|cancel)$/);
    if (subtaskActionMatch && req.method === 'POST') {
      const taskId = subtaskActionMatch[1]!;
      const subtaskId = subtaskActionMatch[2]!;
      const action = subtaskActionMatch[3]!;
      const sub = action === 'complete'
        ? this.taskService.completeSubtask(taskId, subtaskId)
        : this.taskService.cancelSubtask(taskId, subtaskId);
      this.json(res, 200, { subtask: sub });
      return;
    }

    // Delete a specific subtask
    const subtaskDeleteMatch = path.match(/^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)$/);
    if (subtaskDeleteMatch && req.method === 'DELETE') {
      const taskId = subtaskDeleteMatch[1]!;
      const subtaskId = subtaskDeleteMatch[2]!;
      this.taskService.deleteSubtask(taskId, subtaskId);
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/taskboard' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const board = this.taskService.getTaskBoard(orgId, { projectId });
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

    // Unified execution stream logs
    if (path === '/api/execution-logs' && req.method === 'GET') {
      const sourceType = url.searchParams.get('sourceType');
      const sourceId = url.searchParams.get('sourceId');
      if (!sourceType || !sourceId) {
        this.json(res, 400, { error: 'sourceType and sourceId required' });
        return;
      }
      if (!this.storage?.executionStreamRepo) {
        this.json(res, 200, { logs: [] });
        return;
      }
      try {
        const logs = this.storage.executionStreamRepo.getBySource(sourceType, sourceId);
        this.json(res, 200, { logs });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task execution logs — rounds summary (lightweight metadata only)
    if (path.match(/^\/api\/tasks\/[^/]+\/logs\/summary$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { rounds: [] });
        return;
      }
      try {
        const rounds = this.storage.taskLogRepo.getRoundsSummary(taskId);
        this.json(res, 200, { rounds });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task execution logs — optionally filtered by round
    if (path.match(/^\/api\/tasks\/[^/]+\/logs$/) && req.method === 'GET') {
      const taskId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { logs: [] });
        return;
      }
      try {
        const roundParam = url.searchParams.get('round');
        const logs = roundParam
          ? this.storage.taskLogRepo.getByTaskRound(taskId, parseInt(roundParam, 10))
          : await this.storage.taskLogRepo.getByTask(taskId);
        this.json(res, 200, { logs });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // Task comments — add a comment (text + optional image attachments + @mentions)
    if (path.match(/^\/api\/tasks\/[^/]+\/comments$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      if (!this.storage?.taskCommentRepo) {
        this.json(res, 500, { error: 'Storage not available' });
        return;
      }
      try {
        const authUser = await this.getAuthUser(req);
        const body = await this.readBody(req);
        const mentions = (body['mentions'] as string[] | undefined) ?? [];
        let resolvedTaskAuthorName = (body['authorName'] as string | undefined);
        if (!resolvedTaskAuthorName && authUser?.userId && this.storage.userRepo) {
          const userRow = await this.storage.userRepo.findById(authUser.userId);
          resolvedTaskAuthorName = userRow?.name;
        }
        const comment = await this.storage.taskCommentRepo.add({
          taskId,
          authorId: (body['authorId'] as string) ?? authUser?.userId ?? 'human',
          authorName: resolvedTaskAuthorName ?? 'User',
          authorType: (body['authorType'] as string) ?? 'human',
          content: body['content'] as string,
          attachments: body['attachments'] as unknown[] | undefined,
          mentions,
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
              mentions: comment.mentions,
              createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
            },
          },
          timestamp: new Date().toISOString(),
        });
        // Inject live comment into running agent's context
        this.taskService.injectCommentIntoRunningTask(
          taskId,
          resolvedTaskAuthorName ?? 'User',
          body['content'] as string
        );
        // Notify agents about the comment
        {
          const authorName = resolvedTaskAuthorName ?? 'User';
          const commenterId = (body['authorId'] as string) ?? authUser?.userId ?? 'human';
          const task = this.taskService.getTask(taskId);
          const taskTitle = task?.title ?? taskId;
          const taskStatus = task?.status ?? 'unknown';
          const agentMgr = this.orgService.getAgentManager();
          const notified = new Set<string>();

          const notifyAgent = (agentId: string, reason: string) => {
            if (notified.has(agentId) || agentId === commenterId) return;
            if (task?.status === 'in_progress' && task.assignedAgentId === agentId) return;
            notified.add(agentId);
            try {
              const agent = agentMgr.getAgent(agentId);
              if (!agent) return;
              const notif = [
                `${reason} on task "${taskTitle}" (ID: ${taskId}, status: ${taskStatus}).`,
                ``,
                `Comment from ${authorName}: ${body['content'] as string}`,
                ``,
                `**MANDATORY before replying**: You MUST first understand the full context:`,
                `1. Call \`task_get\` with task ID "${taskId}" to see the complete task state, description, and all comments`,
                `2. Read ALL previous comments on this task to understand the conversation thread`,
                `3. Only THEN formulate your response using \`task_comment\``,
                `Do NOT reply based solely on the comment above — you need the full picture.`,
              ].join('\n');
              agent.enqueueToMailbox('task_comment', {
                summary: `Comment on task "${taskTitle}" from ${authorName}`,
                content: notif,
                taskId,
              }, {
                metadata: { senderName: authorName, senderRole: 'user', taskId },
              });
            } catch { /* agent not found */ }
          };

          // 1. Notify @mentioned agents
          for (const mid of mentions) {
            notifyAgent(mid, `You were mentioned by ${authorName} in a comment`);
          }

          // 2. Always notify task assignee (even without @mention)
          if (task?.assignedAgentId) {
            notifyAgent(task.assignedAgentId, `New comment from ${authorName} on your assigned task`);
          }
          // 3. Notify creator only when task is NOT in_progress (assignee handles it during execution)
          if (task?.createdBy && task.status !== 'in_progress') {
            notifyAgent(task.createdBy, `New comment from ${authorName} on a task you created`);
          }
        }
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
        const nextStatus: TaskStatus = 'blocked';
        this.taskService.updateTaskStatus(taskId, nextStatus);
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

    // Task retry fresh — discard previous execution, start clean
    if (path.match(/^\/api\/tasks\/[^/]+\/retry$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = await this.taskService.retryTaskFresh(taskId);
        this.json(res, 202, { task });
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

    // Team export — read all team directory files
    if (path.match(/^\/api\/teams\/[^/]+\/export$/) && req.method === 'GET') {
      const teamId = path.split('/')[3]!;
      try {
        const team = this.orgService.getTeam(teamId);
        if (!team) { this.json(res, 404, { error: 'Team not found' }); return; }
        const teamDataDir = this.orgService.getTeamDataDir(teamId);
        const files: Record<string, string> = {};
        if (teamDataDir && existsSync(teamDataDir)) {
          for (const fname of readdirSync(teamDataDir)) {
            const fpath = join(teamDataDir, fname);
            try {
              files[fname] = readFileSync(fpath, 'utf-8');
            } catch { /* skip */ }
          }
        }

        // Include member agent role files under members/{slug}/
        const agentManager = this.orgService.getAgentManager();
        const roleFileNames = ['ROLE.md', 'POLICIES.md', 'CONTEXT.md', 'HEARTBEAT.md'];
        for (const agentId of team.memberAgentIds ?? []) {
          try {
            const agent = agentManager.getAgent(agentId);
            const roleDir = this.resolveAgentRoleDir(agent);
            if (!roleDir) continue;
            const slug = agent.config.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || agentId;
            for (const fname of roleFileNames) {
              const fpath = join(roleDir, fname);
              if (existsSync(fpath)) {
                try { files[`members/${slug}/${fname}`] = readFileSync(fpath, 'utf-8'); } catch { /* skip */ }
              }
            }
          } catch { /* agent may not exist */ }
        }

        this.json(res, 200, { files, team: { id: team.id, name: team.name, description: team.description } });
      } catch {
        this.json(res, 404, { error: `Team not found: ${teamId}` });
      }
      return;
    }

    // Skill files — read all files from a skill directory
    if (path.match(/^\/api\/skills\/[^/]+\/files$/) && req.method === 'GET') {
      const skillName = decodeURIComponent(path.split('/')[3]!);
      const skillDir = join(homedir(), '.markus', 'skills', skillName);
      const files: Record<string, string> = {};
      if (existsSync(skillDir)) {
        for (const fname of readdirSync(skillDir)) {
          const fpath = join(skillDir, fname);
          try {
            files[fname] = readFileSync(fpath, 'utf-8');
          } catch { /* skip */ }
        }
      }
      if (Object.keys(files).length === 0) {
        this.json(res, 404, { error: `Skill not found: ${skillName}` });
      } else {
        this.json(res, 200, { files });
      }
      return;
    }

    // Agent mind state — current attention, focus, mailbox snapshot
    if (path.match(/^\/api\/agents\/[^/]+\/mind$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        this.json(res, 200, agent.getMindState());
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent mailbox — queued items + enriched history (decisions + activity)
    if (path.match(/^\/api\/agents\/[^/]+\/mailbox$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const status = url.searchParams.get('status') ?? undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const sourceType = url.searchParams.get('sourceType') ?? undefined;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const queued = agent.getMailbox().getQueuedItems();

        let sourceTypes: string[] | undefined;
        if (sourceType) {
          sourceTypes = sourceType.split(',').map(s => s.trim()).filter(Boolean);
        } else if (category) {
          const { MAILBOX_CATEGORIES } = await import('@markus/shared');
          const cat = MAILBOX_CATEGORIES[category as keyof typeof MAILBOX_CATEGORIES];
          if (cat) sourceTypes = cat.types;
        }

        let history: Array<Record<string, unknown>> = [];
        if (this.storage?.mailboxRepo) {
          const raw = this.storage.mailboxRepo.getHistory(agentId, { limit, offset, sourceTypes, status });
          history = raw.map((item: { id: string; [k: string]: unknown }) => {
            const enriched: Record<string, unknown> = { ...item };
            if (this.storage?.decisionRepo) {
              enriched.decisions = this.storage.decisionRepo.getByMailboxItemId(item.id);
            }
            if (this.storage?.activityRepo) {
              const act = this.storage.activityRepo.getByMailboxItemId(item.id);
              enriched.activity = act ? {
                id: act.id,
                type: act.type,
                label: act.label,
                startedAt: act.startedAt,
                endedAt: act.endedAt,
                totalTokens: act.totalTokens,
                totalTools: act.totalTools,
                success: act.success,
              } : null;
            }
            return enriched;
          });
        }

        this.json(res, 200, {
          queued: queued.map(i => ({
            id: i.id,
            sourceType: i.sourceType,
            priority: i.priority,
            status: i.status,
            summary: i.payload.summary,
            queuedAt: i.queuedAt,
          })),
          queueDepth: queued.length,
          history,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent attention decisions — decision timeline
    if (path.match(/^\/api\/agents\/[^/]+\/decisions$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const recent = agent.getAttentionController().getRecentDecisions(limit);

        let persisted: unknown[] = [];
        if (this.storage?.decisionRepo) {
          persisted = this.storage.decisionRepo.getByAgent(agentId, limit);
        }

        this.json(res, 200, {
          recent,
          persisted,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
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
          dailyLog: dailyLog ?? null,
          recentDailyLogs: recentDailyLogs ?? null,
          longTermMemory: longTermMemory ?? null,
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
            content: getTextContent(m.content),
            ...(m.toolCalls?.length ? {
              toolCalls: m.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
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
        const filesMap: Record<string, string> = {};
        for (const name of allowedNames) {
          const filePath = join(roleDir, name);
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, 'utf-8');
            files.push({ name, content });
            filesMap[name] = content;
          }
        }
        this.json(res, 200, { files, filesMap });
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

    // ─── Role Template Versioning & Sync ──────────────────────────────────

    // Check role update status for a single agent
    if (path.match(/^\/api\/agents\/[^/]+\/role-status$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const status = this.orgService.getAgentManager().checkRoleUpdate(agentId);
        this.json(res, 200, status);
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Get file-level diff between agent's role and template
    if (path.match(/^\/api\/agents\/[^/]+\/role-diff$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const fileName = url.searchParams.get('file') || 'ROLE.md';
      try {
        const diff = this.orgService.getAgentManager().getRoleFileDiff(agentId, fileName);
        this.json(res, 200, diff);
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Sync agent's role files from template
    if (path.match(/^\/api\/agents\/[^/]+\/role-sync$/) && req.method === 'POST') {
      const agentId = path.split('/')[3]!;
      try {
        const body = await this.readBody(req);
        const files = Array.isArray(body['files']) ? (body['files'] as string[]) : undefined;
        const result = this.orgService.getAgentManager().syncRoleFromTemplate(agentId, files);
        this.json(res, result.success ? 200 : 400, result);
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Batch check: all agents' role update status
    if (path === '/api/agents/role-updates' && req.method === 'GET') {
      const results = this.orgService.getAgentManager().checkAllRoleUpdates();
      const stale = results.filter(r => r.hasTemplate && !r.isUpToDate);
      this.json(res, 200, { total: results.length, staleCount: stale.length, stale });
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
          // When a building skill is added, register builder dynamic context so the
          // agent can see available skills/roles, just like the seeded builder agents.
          if (OrganizationService.BUILDING_SKILLS.has(skillName)) {
            agent.addDynamicContextProvider(
              () => this.orgService.buildBuilderDynamicContext(this.skillRegistry),
              'builder-context'
            );
          }
        }
        if (this.storage) {
          try { await this.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill assignment', { agentId, error: String(e) }); }
        }
        this.json(res, 200, { ok: true, skills: agent.getActiveSkillNames() });
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
        agent.deactivateSkill(skillName);
        if (this.storage) {
          try { await this.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill removal', { agentId, error: String(e) }); }
        }
        this.json(res, 200, { ok: true, skills: agent.getActiveSkillNames() });
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

    // Agent activities — persistent history from SQLite (session-grouped)
    if (path.match(/^\/api\/agents\/[^/]+\/activities$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const typeFilter = url.searchParams.get('type') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
      const before = url.searchParams.get('before') ?? undefined;
      try {
        if (this.storage?.activityRepo) {
          const activities = this.storage.activityRepo.queryActivities(agentId, { type: typeFilter, limit, before });
          this.json(res, 200, { activities });
        } else {
          this.json(res, 200, { activities: [] });
        }
      } catch (err) {
        this.json(res, 500, { error: `Failed to query activities: ${String(err)}` });
      }
      return;
    }

    // Agent recent activities — list summary of in-memory activities (live)
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

    // Agent activity logs — in-memory for live activities, SQLite for historical
    if (path.match(/^\/api\/agents\/[^/]+\/activity-logs$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const activityId = url.searchParams.get('activityId');
      if (!activityId) {
        this.json(res, 400, { error: 'activityId query parameter is required' });
        return;
      }
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const currentActivity = agent.getCurrentActivity();
        if (currentActivity?.id === activityId) {
          const logs = agent.getActivityLogs(activityId);
          this.json(res, 200, { logs, activity: currentActivity });
          return;
        }
      } catch { /* agent not found, try SQLite */ }

      if (this.storage?.activityRepo) {
        const activity = this.storage.activityRepo.getActivity(activityId);
        const logs = this.storage.activityRepo.getActivityLogs(activityId);
        this.json(res, 200, { logs, activity });
      } else {
        this.json(res, 200, { logs: [], activity: undefined });
      }
      return;
    }

    // Agent heartbeat info — enriched with last summary, next run estimate
    if (path.match(/^\/api\/agents\/[^/]+\/heartbeat$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const hb = (
          agent as unknown as { heartbeat: { getStatus(): { running: boolean; uptimeMs: number; intervalMs: number; initialDelayMs: number } } }
        ).heartbeat;
        const status = hb.getStatus();

        // Get last heartbeat summary from agent memory
        let lastSummary: string | undefined;
        let lastSummaryAt: string | undefined;
        try {
          const mem = agent.getMemory();
          const results = mem.search('heartbeat:summary');
          if (results.length > 0) {
            const latest = results[results.length - 1];
            lastSummary = latest?.content;
            lastSummaryAt = latest?.timestamp;
          }
        } catch { /* ok */ }

        const state = agent.getState();
        const lastHeartbeat = state.lastHeartbeat;

        // Estimate next heartbeat time
        let nextRunAt: string | undefined;
        if (status.running && status.intervalMs > 0 && lastHeartbeat) {
          const next = new Date(new Date(lastHeartbeat).getTime() + status.intervalMs);
          if (next.getTime() > Date.now()) nextRunAt = next.toISOString();
        } else if (status.running && status.intervalMs > 0) {
          const next = new Date(Date.now() + status.intervalMs - status.uptimeMs % status.intervalMs);
          nextRunAt = next.toISOString();
        }

        this.json(res, 200, {
          ...status,
          lastHeartbeat,
          lastSummary,
          lastSummaryAt,
          nextRunAt,
        });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Manual heartbeat trigger
    if (path.match(/^\/api\/agents\/[^/]+\/heartbeat\/trigger$/) && req.method === 'POST') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const hb = (
          agent as unknown as { heartbeat: { trigger(): void; isRunning(): boolean } }
        ).heartbeat;
        if (!hb.isRunning()) {
          this.json(res, 400, { error: 'Heartbeat scheduler is not running' });
          return;
        }
        hb.trigger();
        this.json(res, 200, { status: 'triggered', message: 'Heartbeat triggered. Check activity logs for results.' });
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
          agent as unknown as { heartbeat: { getStatus(): { running: boolean; uptimeMs: number; intervalMs: number; initialDelayMs: number } } }
        ).heartbeat;
        let heartbeatSummary: Record<string, unknown> = {};
        try {
          heartbeatSummary = hb.getStatus() as unknown as Record<string, unknown>;
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
          skills: agent.getActiveSkillNames(),
          availableSkills: this.skillRegistry?.list().map(s => ({
            name: s.name,
            description: s.description,
            category: s.category,
            builtIn: !!s.builtIn,
            alwaysOn: !!s.alwaysOn,
          })) ?? [],
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
          platform: body['platform'] as string | undefined,
          platformConfig: body['platformConfig'] as string | undefined,
          agentCardUrl: body['agentCardUrl'] as string | undefined,
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
          ? this.projectService.listProjects(token.orgId).map(p => ({
              id: p.id, name: p.name,
            }))
          : [];

        const handbook = generateHandbook({
          baseUrl: `http://localhost:${this.port}`,
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
        const projects = this.projectService.listProjects(token.orgId).map(p => ({
          id: p.id, name: p.name, description: p.description, status: p.status,
          teamIds: p.teamIds,
        }));
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
          projectId: r.projectId,
          source: r.source, createdAt: r.createdAt,
        }));
        this.json(res, 200, { requirements: reqs });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Gateway: Deliverables ──────────────────────────────────────────────
    if (path === '/api/gateway/deliverables' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        this.gateway.verifyToken(authHeader.slice(7));
        if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
        const q = url.searchParams.get('q') ?? undefined;
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const type = url.searchParams.get('type') as any ?? undefined;
        const { results } = this.deliverableService.search({ query: q, projectId, type });
        this.json(res, 200, { results });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/deliverables' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
        const body = await this.readBody(req);
        const d = await this.deliverableService.create({
          type: body['type'] as any ?? 'text',
          title: body['title'] as string,
          summary: body['summary'] as string ?? body['content'] as string,
          reference: body['reference'] as string,
          tags: body['tags'] as string[],
          agentId: token.markusAgentId,
          projectId: body['projectId'] as string,
        });
        this.json(res, 201, { deliverable: d });
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/gateway\/deliverables\/[^/]+$/) && req.method === 'PUT') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        this.gateway.verifyToken(authHeader.slice(7));
        if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
        const delivId = path.split('/')[4]!;
        const body = await this.readBody(req);
        const d = await this.deliverableService.update(delivId, {
          title: body['title'] as string | undefined,
          summary: body['summary'] as string | undefined,
          status: body['status'] as any,
          tags: body['tags'] as string[] | undefined,
        });
        if (!d) { this.json(res, 404, { error: 'Deliverable not found' }); return; }
        this.json(res, 200, { deliverable: d });
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
            this.json(res, 400, { error: 'Delegation is not supported — tasks must always have an assigned agent' });
            break;
          }
          case 'subtasks': {
            const parentTask = this.taskService.getTask(taskId);
            if (!parentTask) { this.json(res, 404, { error: 'Parent task not found' }); break; }
            const subtask = this.taskService.addSubtask(taskId, body['title'] as string);
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

    // Message routing — route to the right agent
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

        const sseHandler = new SSEHandler({
          agentId: targetAgentId,
          agent,
          userText,
          images,
          senderId,
          senderInfo,
          executionStreamRepo: this.storage?.executionStreamRepo,
          onComplete: async (reply, segments, tokensUsed) => {
            const meta = segments.length > 0 ? { segments } : undefined;
            void this.persistChatTurn(targetAgentId, userText, reply, senderId, tokensUsed, meta);
          },
        });

        await sseHandler.handle(res);
      } else {
        const userText = body['text'] as string;
        const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
        let reply: string;
        try {
          reply = await agent.sendMessage(userText, senderId, senderInfo, { images, toolEventCollector: toolEvents });
        } catch (err) {
          throw err;
        }
        this.json(res, 200, { reply, agentId: targetAgentId });
        const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
        const segments: Array<Record<string, unknown>> = [];
        if (thinking.length > 0) segments.push({ type: 'text', content: '', thinking: thinking.join('\n\n') });
        for (const te of toolEvents) {
          segments.push({ type: 'tool', tool: te.tool, status: te.status, arguments: te.arguments, result: te.result, durationMs: te.durationMs });
        }
        if (segments.length > 0) segments.push({ type: 'text', content: cleanReply });
        const meta = segments.length > 0 ? { segments } : undefined;
        void this.persistChatTurn(targetAgentId, userText, reply, senderId, agent.getState().tokensUsedToday, meta);
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
          sourcePath: s.builtIn ? undefined : s.sourcePath,
          type: (s.builtIn ? 'builtin' : s.sourcePath ? 'filesystem' : 'registry') as string,
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

      const imported: Array<{ name: string; description: string; category: string; version: string; tags: string[]; hasInstructions: boolean; type: string }> = [];

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

    // Built-in skills — list templates/skills/
    if (path === '/api/skills/builtin' && req.method === 'GET') {
      const builtinDir = resolve(process.cwd(), 'templates', 'skills');
      const found = discoverSkillsInDir(builtinDir);
      const installedSkills = new Map(
        (this.skillRegistry?.list() ?? []).map(s => [s.name, s])
      );
      const skills = found.map(({ manifest, path: p }) => {
        const inst = installedSkills.get(manifest.name);
        return {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          category: manifest.category,
          tags: manifest.tags ?? [],
          hasMcpServers: !!manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0,
          hasInstructions: !!manifest.instructions,
          requiredPermissions: manifest.requiredPermissions ?? [],
          sourcePath: p,
          installed: !!inst,
          installedVersion: inst?.version ?? null,
        };
      });
      this.json(res, 200, { skills });
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
        const skills: Array<{ name: string; description: string; category: string; source: string; sourceUrl: string; author: string; addedAt?: string }> = [];

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
      if (!skillName) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }

      try {
        const result = await installSkill({
          name: skillName,
          source: body['source'] as string | undefined,
          slug: body['slug'] as string | undefined,
          sourceUrl: body['sourceUrl'] as string | undefined,
          description: body['description'] as string | undefined,
          category: body['category'] as string | undefined,
          version: body['version'] as string | undefined,
          githubRepo: body['githubRepo'] as string | undefined,
          githubSkillPath: body['githubSkillPath'] as string | undefined,
        }, this.skillRegistry);

        this.json(res, 201, result);
        return;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        const status = msg.includes('Download failed') ? 502 : 500;
        this.json(res, status, { error: msg });
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

      if (!deletedFs) {
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

      this.json(res, 200, { deleted: true, name: skillName, deletedFs, removedFromAgents: affectedAgents });
      return;
    }

    // ── Builder Artifacts: directory-based package management ──────────────

    // GET /api/builder/artifacts — scan all builder artifacts
    if (path === '/api/builder/artifacts' && req.method === 'GET') {
      try {
        const baseDir = join(homedir(), '.markus', 'builder-artifacts');
        const types = ['agents', 'teams', 'skills'] as const;
        const artifacts: Array<{ type: string; name: string; meta: Record<string, unknown>; path: string; updatedAt: string }> = [];
        const fsHelper = { existsSync, readFileSync: (p: string, _enc: 'utf-8') => readFileSync(p, 'utf-8'), join };

        for (const typeDir of types) {
          const dir = join(baseDir, typeDir);
          if (!existsSync(dir)) continue;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const artDir = join(dir, entry.name);
            const type = (typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill') as PackageType;
            const manifest = readManifest(artDir, type, fsHelper);
            const meta: Record<string, unknown> = manifest ? { ...manifest } : { name: entry.name };
            let updatedAt = new Date().toISOString();
            try { updatedAt = statSync(artDir).mtime.toISOString(); } catch { /* ignore */ }
            artifacts.push({ type, name: entry.name, meta, path: artDir, updatedAt });
          }
        }

        artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.json(res, 200, { artifacts });
      } catch (err) {
        this.json(res, 500, { error: `Scan failed: ${String(err)}` });
      }
      return;
    }

    // GET /api/builder/artifacts/:type/:name — read one artifact (all files)
    {
      const artMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)$/);
      if (artMatch && req.method === 'GET') {
        const rawType = artMatch[1]!;
        const name = decodeURIComponent(artMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        if (!existsSync(artDir)) {
          this.json(res, 404, { error: 'Artifact not found' });
          return;
        }
        try {
          const files: Record<string, string> = {};
          const readDir = (dir: string, prefix: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                readDir(join(dir, entry.name), relPath);
              } else {
                try { files[relPath] = readFileSync(join(dir, entry.name), 'utf-8'); } catch { /* skip binary */ }
              }
            }
          };
          readDir(artDir, '');
          const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill';
          this.json(res, 200, { type, name, path: artDir, files });
        } catch (err) {
          this.json(res, 500, { error: `Read failed: ${String(err)}` });
        }
        return;
      }
    }

    // GET /api/builder/artifacts/installed — detect which artifacts have been installed
    if (path === '/api/builder/artifacts/installed' && req.method === 'GET') {
      try {
        const installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> = {};
        const agentManager = this.orgService.getAgentManager();
        const dataDir = agentManager.getDataDir();

        // Scan agents for .role-origin.json markers
        for (const agentInfo of agentManager.listAgents()) {
          const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
          if (existsSync(originPath)) {
            try {
              const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
              if (origin.source === 'builder-artifact' && origin.artifact) {
                const artName = origin.artifact as string;
                let artType = origin.artifactType as string | undefined;
                if (!artType) {
                  try {
                    const agentObj = agentManager.getAgent(agentInfo.id);
                    artType = agentObj.config.teamId ? 'team' : 'agent';
                  } catch { artType = 'agent'; }
                }
                if (artType === 'team') {
                  const teamKey = `team/${artName}`;
                  if (!installed[teamKey]) installed[teamKey] = { agentIds: [] };
                  installed[teamKey].agentIds!.push(agentInfo.id);
                  if (!installed[teamKey].teamId) {
                    try {
                      const agentObj = agentManager.getAgent(agentInfo.id);
                      if (agentObj.config.teamId) installed[teamKey].teamId = agentObj.config.teamId;
                    } catch { /* skip */ }
                  }
                } else {
                  installed[`agent/${artName}`] = { agentId: agentInfo.id };
                }
              }
            } catch { /* skip invalid */ }
          }
        }

        // Scan skills: check builder-artifacts paired with installed skills
        const skillArtDir = join(homedir(), '.markus', 'builder-artifacts', 'skills');
        const skillsDir = join(homedir(), '.markus', 'skills');
        if (existsSync(skillArtDir)) {
          try {
            for (const entry of readdirSync(skillArtDir, { withFileTypes: true })) {
              if (entry.isDirectory() && existsSync(join(skillsDir, entry.name))) {
                installed[`skill/${entry.name}`] = {};
              }
            }
          } catch { /* ignore */ }
        }
        // Also detect skills installed directly (skillhub/skillssh/builtin) without builder-artifacts
        if (existsSync(skillsDir)) {
          try {
            for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
              const key = `skill/${entry.name}`;
              if (entry.isDirectory() && !installed[key]) {
                installed[key] = {};
              }
            }
          } catch { /* ignore */ }
        }

        this.json(res, 200, { installed });
      } catch (err) {
        this.json(res, 500, { error: `Scan failed: ${String(err)}` });
      }
      return;
    }

    // POST /api/builder/artifacts/save — save JSON artifact as directory-based package
    if (path === '/api/builder/artifacts/save' && req.method === 'POST') {
      const body = await this.readBody(req);
      const mode = body['mode'] as string;
      const artifact = body['artifact'] as Record<string, unknown>;
      if (!mode || !['agent', 'team', 'skill'].includes(mode) || !artifact) {
        this.json(res, 400, { error: 'mode must be agent|team|skill and artifact is required' });
        return;
      }

      try {
        const typeDir = mode === 'agent' ? 'agents' : mode === 'team' ? 'teams' : 'skills';
        const pkgType = mode as PackageType;
        const manifest = buildManifest(pkgType, artifact);
        if (!manifest.source) manifest.source = { type: 'local' };
        const mfName = manifestFilename(pkgType);
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, manifest.name);
        mkdirSync(artDir, { recursive: true });
        writeFileSync(join(artDir, mfName), JSON.stringify(manifest, null, 2), 'utf-8');

        // Write content files from `files` map
        const artFiles = artifact.files as Record<string, string> | undefined;
        if (artFiles) {
          for (const [fn, c] of Object.entries(artFiles)) {
            if (fn === mfName) continue;
            const filePath = join(artDir, fn);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, c, 'utf-8');
          }
        }

        // Team: extract announcement, norms, and member role files from config
        if (mode === 'team') {
          const fileSet = new Set(artFiles ? Object.keys(artFiles) : []);

          // Write ANNOUNCEMENT.md / NORMS.md from config fields if not already in files
          const announcement = artifact.announcement as string | undefined;
          if (announcement && !fileSet.has('ANNOUNCEMENT.md')) {
            writeFileSync(join(artDir, 'ANNOUNCEMENT.md'), announcement, 'utf-8');
          }
          const norms = artifact.norms as string | undefined;
          if (norms && !fileSet.has('NORMS.md')) {
            writeFileSync(join(artDir, 'NORMS.md'), norms, 'utf-8');
          }

          // Write member role files from config if not already written via files map
          const rawMembers = (Array.isArray((artifact.team as Record<string, unknown>)?.members)
            ? (artifact.team as Record<string, unknown>).members
            : Array.isArray(artifact.members) ? artifact.members : []) as Array<Record<string, unknown>>;
          for (const m of rawMembers) {
            const mName = (m.name as string) ?? 'Agent';
            const slug = mName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'agent';
            const memberDir = join(artDir, 'members', slug);
            const roleContent = (m.roleContent as string) || (m.role_md as string);
            const policiesContent = (m.policiesContent as string) || (m.policies_md as string);
            const contextContent = (m.contextContent as string) || (m.context_md as string);
            if (roleContent && !fileSet.has(`members/${slug}/ROLE.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'ROLE.md'), roleContent, 'utf-8');
            }
            if (policiesContent && !fileSet.has(`members/${slug}/POLICIES.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'POLICIES.md'), policiesContent, 'utf-8');
            }
            if (contextContent && !fileSet.has(`members/${slug}/CONTEXT.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'CONTEXT.md'), contextContent, 'utf-8');
            }
          }

          // Legacy: write explicit memberFiles if provided in JSON
          const memberFiles = artifact.memberFiles as Record<string, Record<string, string>> | undefined;
          if (memberFiles) {
            for (const [slug, files] of Object.entries(memberFiles)) {
              const memberDir = join(artDir, 'members', slug);
              mkdirSync(memberDir, { recursive: true });
              for (const [fn, c] of Object.entries(files)) writeFileSync(join(memberDir, fn), c, 'utf-8');
            }
          }
        }

        if (this.deliverableService) {
          this.deliverableService.create({
            type: 'file',
            title: `${mode.charAt(0).toUpperCase() + mode.slice(1)}: ${manifest.displayName}`,
            summary: (artifact.description as string) ?? manifest.description ?? `${mode} saved via Builder`,
            reference: artDir,
            artifactType: mode as 'agent' | 'team' | 'skill',
            artifactData: artifact,
            tags: ['builder', mode],
          }).catch(err => log.warn('Failed to create deliverable for builder artifact', { error: String(err) }));
        }

        this.json(res, 201, { type: mode, name: manifest.name, path: artDir });
      } catch (err) {
        this.json(res, 500, { error: `Save failed: ${String(err)}` });
      }
      return;
    }

    // POST /api/builder/artifacts/import — write a bundle of files directly to artifact directory
    if (path === '/api/builder/artifacts/import' && req.method === 'POST') {
      const body = await this.readBody(req);
      const type = body['type'] as string;
      const name = body['name'] as string;
      const files = body['files'] as Record<string, string> | undefined;
      const source = body['source'] as { type: string; hubItemId?: string; url?: string } | undefined;
      if (!type || !['agent', 'team', 'skill'].includes(type) || !name || !files) {
        this.json(res, 400, { error: 'type (agent|team|skill), name, and files are required' });
        return;
      }
      try {
        const typeDir = type === 'agent' ? 'agents' : type === 'team' ? 'teams' : 'skills';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        mkdirSync(artDir, { recursive: true });
        for (const [fn, content] of Object.entries(files)) {
          const filePath = join(artDir, fn);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf-8');
        }

        // Write source tracking into manifest if source provided
        if (source) {
          const mfName = manifestFilename(type as PackageType);
          const mfPath = join(artDir, mfName);
          if (existsSync(mfPath)) {
            try {
              const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
              mf.source = source;
              writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
            } catch { /* skip if manifest invalid */ }
          }
        }

        this.json(res, 201, { type, name, path: artDir });
      } catch (err) {
        this.json(res, 500, { error: `Import failed: ${String(err)}` });
      }
      return;
    }

    // POST /api/builder/artifacts/:type/:name/install — deploy from package to runtime
    {
      const installMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/install$/);
      if (installMatch && req.method === 'POST') {
        const rawType = installMatch[1]!;
        const name = decodeURIComponent(installMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);

        if (!existsSync(artDir)) {
          this.json(res, 404, { error: 'Artifact not found' });
          return;
        }

        try {
          const fsHelper = { existsSync, readFileSync: (p: string, _enc: 'utf-8') => readFileSync(p, 'utf-8'), join };
          const installType = type as PackageType;
          const manifest = readManifest(artDir, installType, fsHelper);
          if (!manifest) {
            this.json(res, 400, { error: `No ${manifestFilename(installType)} found in artifact package` });
            return;
          }

          const validationErrors = validateManifest(manifest);
          if (validationErrors.length > 0) {
            this.json(res, 400, { error: `Invalid manifest: ${validationErrors.join('; ')}` });
            return;
          }

          const mfName = manifestFilename(installType);

          if (type === 'agent') {
            const agentManager = this.orgService.getAgentManager();
            const agentName = manifest.displayName ?? manifest.name ?? name;
            const knownRoles = this.orgService.listAvailableRoles();
            const requestedRole = manifest.agent?.roleName ?? 'developer';
            const roleName = knownRoles.includes(requestedRole) ? requestedRole : 'developer';
            const skills = manifest.dependencies?.skills ?? [];
            const agentRole = manifest.agent?.agentRole ?? 'worker';

            const agent = await this.orgService.hireAgent({
              name: agentName,
              roleName,
              orgId: 'default',
              agentRole,
              skills,
            });

            const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
            mkdirSync(agentRoleDir, { recursive: true });
            for (const fname of readdirSync(artDir)) {
              if (fname === mfName) continue;
              const srcFile = join(artDir, fname);
              if (statSync(srcFile).isFile()) {
                copyFileSync(srcFile, join(agentRoleDir, fname));
              }
            }
            writeFileSync(join(agentRoleDir, '.role-origin.json'), JSON.stringify({ customRole: true, source: 'builder-artifact', artifact: name, artifactType: 'agent' }));
            agent.reloadRole();
            await agentManager.startAgent(agent.id);

            this.json(res, 201, { type: 'agent', agent: { id: agent.id, name: agent.config.name, role: agent.role.name, status: agent.getState().status } });

          } else if (type === 'team') {
            const agentManager = this.orgService.getAgentManager();
            const teamName = manifest.displayName ?? manifest.name ?? name;
            const team = await this.orgService.createTeam('default', teamName, manifest.description ?? '');
            this.ws?.broadcast({
              type: 'chat:group_created',
              payload: { chatId: `group:${team.id}`, name: teamName, creatorId: '', creatorName: '' },
              timestamp: new Date().toISOString(),
            });

            const announcementPath = join(artDir, 'ANNOUNCEMENT.md');
            const normsPath = join(artDir, 'NORMS.md');
            const announcements = existsSync(announcementPath) ? readFileSync(announcementPath, 'utf-8') : '';
            const norms = existsSync(normsPath) ? readFileSync(normsPath, 'utf-8') : '';
            this.orgService.ensureTeamDataDir(team.id, announcements, norms);

            const members = manifest.team?.members ?? [];
            const knownRoles = this.orgService.listAvailableRoles();
            const createdAgents: Array<{ id: string; name: string; role: string }> = [];

            for (const member of members) {
              const count = member.count ?? 1;
              const memberRole = member.role ?? 'worker';
              const memberName = member.name ?? 'Agent';
              const roleName = knownRoles.includes(member.roleName) ? member.roleName : 'developer';
              const memberSkills = member.skills ?? [];
              const memberSlug = memberName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
              const memberFilesDir = join(artDir, 'members', memberSlug);

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

                const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
                mkdirSync(agentRoleDir, { recursive: true });
                if (existsSync(memberFilesDir)) {
                  for (const fname of readdirSync(memberFilesDir)) {
                    const srcFile = join(memberFilesDir, fname);
                    if (statSync(srcFile).isFile()) {
                      copyFileSync(srcFile, join(agentRoleDir, fname));
                    }
                  }
                  agent.reloadRole();
                }
                writeFileSync(join(agentRoleDir, '.role-origin.json'), JSON.stringify({ customRole: true, source: 'builder-artifact', artifact: name, artifactType: 'team' }));

                if (memberRole === 'manager') {
                  await this.orgService.updateTeam(team.id, { managerId: agent.id, managerType: 'agent' });
                }
                await agentManager.startAgent(agent.id);
                createdAgents.push({ id: agent.id, name: agent.config.name, role: agent.role.name });
              }
            }

            this.json(res, 201, { type: 'team', team: { id: team.id, name: teamName }, agents: createdAgents });

          } else if (type === 'skill') {
            const skillDir = join(homedir(), '.markus', 'skills', name);
            mkdirSync(skillDir, { recursive: true });
            for (const fname of readdirSync(artDir)) {
              const srcFile = join(artDir, fname);
              if (statSync(srcFile).isFile()) {
                copyFileSync(srcFile, join(skillDir, fname));
              }
            }

            if (this.skillRegistry) {
              try {
                const skillFile = manifest.skill?.skillFile ?? 'SKILL.md';
                const instrPath = join(skillDir, skillFile);
                const instructions = existsSync(instrPath) ? readFileSync(instrPath, 'utf-8').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim() : undefined;
                this.skillRegistry.register({
                  manifest: {
                    name: manifest.name,
                    version: manifest.version,
                    description: manifest.description,
                    author: manifest.author ?? '',
                    category: (manifest.category ?? 'custom') as SkillCategory,
                    tags: manifest.tags,
                    instructions,
                    requiredPermissions: manifest.skill?.requiredPermissions,
                    mcpServers: manifest.skill?.mcpServers,
                    sourcePath: skillDir,
                    source: 'builder',
                  },
                });
              } catch (regErr) {
                log.warn('Failed to register skill into runtime registry', { error: String(regErr) });
              }
            }

            this.json(res, 201, { type: 'skill', skill: { name, path: skillDir, status: 'registered' } });
          }
        } catch (err) {
          this.json(res, 500, { error: `Install failed: ${String(err)}` });
        }
        return;
      }
    }

    // POST /api/builder/artifacts/:type/:name/uninstall — remove deployed artifact from runtime
    {
      const uninstallMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/uninstall$/);
      if (uninstallMatch && req.method === 'POST') {
        const rawType = uninstallMatch[1]!;
        const name = decodeURIComponent(uninstallMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill';

        try {
          const agentManager = this.orgService.getAgentManager();
          const dataDir = agentManager.getDataDir();
          const removedAgents: string[] = [];
          let removedTeamId: string | undefined;

          if (type === 'agent') {
            for (const agentInfo of agentManager.listAgents()) {
              const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
              if (existsSync(originPath)) {
                try {
                  const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
                  if (origin.artifact === name && (!origin.artifactType || origin.artifactType === 'agent')) {
                    await this.orgService.fireAgent(agentInfo.id);
                    removedAgents.push(agentInfo.id);
                  }
                } catch { /* skip */ }
              }
            }
          } else if (type === 'team') {
            const teamAgentIds: string[] = [];
            let teamId: string | undefined;
            for (const agentInfo of agentManager.listAgents()) {
              const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
              if (existsSync(originPath)) {
                try {
                  const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
                  if (origin.artifact === name && origin.artifactType === 'team') {
                    teamAgentIds.push(agentInfo.id);
                    if (!teamId) {
                      try {
                        const agentObj = agentManager.getAgent(agentInfo.id);
                        teamId = agentObj.config.teamId;
                      } catch { /* skip */ }
                    }
                  }
                } catch { /* skip */ }
              }
            }
            // Fallback: find team by matching member agent IDs
            if (!teamId && teamAgentIds.length > 0) {
              const teams = this.orgService.listTeams('default');
              for (const t of teams) {
                if (teamAgentIds.some(aid => t.memberAgentIds.includes(aid))) {
                  teamId = t.id;
                  break;
                }
              }
            }
            if (teamId) {
              await this.orgService.deleteTeam(teamId, true);
              removedTeamId = teamId;
            } else {
              for (const aid of teamAgentIds) {
                await this.orgService.fireAgent(aid);
              }
            }
            removedAgents.push(...teamAgentIds);
          } else if (type === 'skill') {
            const skillDir = join(homedir(), '.markus', 'skills', name);
            if (existsSync(skillDir)) {
              rmSync(skillDir, { recursive: true, force: true });
              if (this.skillRegistry) {
                try { this.skillRegistry.unregister(name); } catch { /* skip */ }
              }
            }
          }

          this.json(res, 200, { uninstalled: true, type, name, removedAgents, removedTeamId });
        } catch (err) {
          this.json(res, 500, { error: `Uninstall failed: ${String(err)}` });
        }
        return;
      }
    }

    // DELETE /api/builder/artifacts/:type/:name — remove artifact
    {
      const delMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)$/);
      if (delMatch && req.method === 'DELETE') {
        const rawType = delMatch[1]!;
        const name = decodeURIComponent(delMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        if (!existsSync(artDir)) {
          this.json(res, 404, { error: 'Artifact not found' });
          return;
        }
        try {
          rmSync(artDir, { recursive: true, force: true });
          this.json(res, 200, { deleted: true, type: typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill', name });
        } catch (err) {
          this.json(res, 500, { error: `Delete failed: ${String(err)}` });
        }
        return;
      }
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

        const agent = await agentManager.createAgentFromTemplate({
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
          platform: body['platform'] as string | undefined,
          platformConfig: body['platformConfig'] as string | undefined,
          agentCardUrl: body['agentCardUrl'] as string | undefined,
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
      const authUser = await this.getAuthUser(req);
      const approvalId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const result = this.hitlService.respondToApproval(
        approvalId,
        body['approved'] as boolean,
        (body['respondedBy'] as string) ?? authUser?.userId ?? 'anonymous'
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
      const userId = url.searchParams.get('userId') ?? 'default';
      const unread = url.searchParams.get('unread') === 'true';
      const type = url.searchParams.get('type') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const notifications = this.hitlService?.listNotifications(userId, unread, { type, limit, offset }) ?? [];
      const counts = this.hitlService?.countNotifications(userId) ?? { total: 0, unread: 0 };
      this.json(res, 200, {
        notifications,
        totalCount: counts.total,
        unreadCount: counts.unread,
      });
      return;
    }

    if (path === '/api/notifications/mark-all-read' && req.method === 'POST') {
      const body = await this.readBody(req);
      const userId = (body.userId as string) ?? 'default';
      const count = this.hitlService?.markAllNotificationsRead(userId) ?? 0;
      this.json(res, 200, { success: true, count });
      return;
    }

    if (path.startsWith('/api/notifications/') && path.endsWith('/read') && req.method === 'POST') {
      const notifId = path.split('/')[3]!;
      const read = this.hitlService?.markNotificationRead(notifId);
      this.json(res, 200, { success: read ?? false });
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

    // ── Hub Proxy ─────────────────────────────────────────────────────────────
    if (path === '/api/hub/publish' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const hubUrl = (body['hubUrl'] as string) ?? this.hubUrl;
      const hubToken = body['hubToken'] as string | undefined;
      if (!hubToken) {
        this.json(res, 401, { error: 'Hub token required. Please login to Markus Hub first.' });
        return;
      }
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hubToken}`,
        };
        const hubRes = await fetch(`${hubUrl}/api/items`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body['payload']),
        });
        const hubData = await hubRes.json();
        this.json(res, hubRes.status, hubData);
      } catch (err) {
        this.json(res, 502, { error: `Hub request failed: ${String(err)}` });
      }
      return;
    }

    // Settings — Hub URL (for web-ui to discover hub address)
    if (path === '/api/settings/hub' && req.method === 'GET') {
      this.json(res, 200, { hubUrl: this.hubUrl });
      return;
    }

    // Settings — Hub Token (frontend pushes token so MCP skill servers can read it)
    if (path === '/api/settings/hub-token' && req.method === 'POST') {
      const body = await this.readBody(req);
      const token = body['token'] as string | null;
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      try {
        if (token) {
          mkdirSync(join(homedir(), '.markus'), { recursive: true });
          writeFileSync(tokenPath, token, 'utf-8');
        } else if (existsSync(tokenPath)) {
          rmSync(tokenPath);
        }
        log.info(`Hub token ${token ? 'saved to' : 'cleared from'} ${tokenPath}`);
      } catch (err) {
        log.error('Failed to write hub token file', { error: String(err) });
      }
      this.json(res, 200, { ok: true });
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

    // Settings — Agent configuration (maxToolIterations etc.)
    if (path === '/api/settings/agent' && req.method === 'GET') {
      const am = this.orgService.getAgentManager();
      this.json(res, 200, { maxToolIterations: am.maxToolIterations });
      return;
    }

    if (path === '/api/settings/agent' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const am = this.orgService.getAgentManager();
      let changed = false;
      if (typeof body['maxToolIterations'] === 'number') {
        am.maxToolIterations = body['maxToolIterations'];
        changed = true;
      }
      if (changed) {
        try {
          saveConfig({ agent: { maxToolIterations: am.maxToolIterations } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist agent settings to config file', { error: String(e) });
        }
        for (const info of am.listAgents()) {
          const agent = am.getAgent(info.id);
          if (agent) agent.maxToolIterations = am.maxToolIterations;
        }
      }
      this.json(res, 200, { maxToolIterations: am.maxToolIterations });
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

    // Settings — Add new provider
    if (path === '/api/settings/llm/providers' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const body = await this.readBody(req);
      const { name, apiKey, baseUrl, model, enabled, contextWindow, maxOutputTokens, cost } = body as {
        name?: string; apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean;
        contextWindow?: number; maxOutputTokens?: number; cost?: { input: number; output: number };
      };
      if (!name || typeof name !== 'string') {
        this.json(res, 400, { error: 'name (string) is required' });
        return;
      }
      if (!model || typeof model !== 'string') {
        this.json(res, 400, { error: 'model (string) is required' });
        return;
      }
      if (name !== 'ollama' && (!apiKey || typeof apiKey !== 'string')) {
        this.json(res, 400, { error: 'apiKey (string) is required' });
        return;
      }
      try {
        this.llmRouter.registerProviderFromConfig(name, {
          provider: name as any,
          model,
          apiKey,
          baseUrl,
        });
        if (enabled === false) {
          this.llmRouter.setProviderEnabled(name, false);
        }
        if (contextWindow || maxOutputTokens || cost) {
          this.llmRouter.updateProviderModelConfig(name, {
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(cost ? { cost } : {}),
          });
        }
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          providers[name] = {
            ...providers[name],
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            enabled: enabled !== false,
          };
          saveConfig({ llm: { providers } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist new provider', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Update existing provider
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'PUT') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      const body = await this.readBody(req);
      const { apiKey, baseUrl, model, enabled, contextWindow, maxOutputTokens, cost } = body as {
        apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean;
        contextWindow?: number; maxOutputTokens?: number; cost?: { input: number; output: number };
      };
      try {
        const provider = this.llmRouter.getProvider(providerName);
        if (provider) {
          const configUpdate: any = { provider: providerName };
          if (model) configUpdate.model = model;
          if (apiKey) configUpdate.apiKey = apiKey;
          if (baseUrl !== undefined) configUpdate.baseUrl = baseUrl;
          provider.configure(configUpdate);
        } else if (model) {
          this.llmRouter.registerProviderFromConfig(providerName, {
            provider: providerName as any,
            model,
            apiKey,
            baseUrl,
          });
        }
        if (typeof enabled === 'boolean') {
          this.llmRouter.setProviderEnabled(providerName, enabled);
        }
        if (contextWindow || maxOutputTokens || cost) {
          this.llmRouter.updateProviderModelConfig(providerName, {
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(cost ? { cost } : {}),
          });
        }
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          const existing = providers[providerName] ?? {};
          providers[providerName] = {
            ...existing,
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            ...(baseUrl !== undefined ? { baseUrl: baseUrl || undefined } : {}),
            ...(typeof enabled === 'boolean' ? { enabled } : {}),
          };
          saveConfig({ llm: { providers } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider update', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Delete provider
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      try {
        this.llmRouter.unregisterProvider(providerName);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          delete providers[providerName];
          const configUpdates: any = { llm: { providers } };
          if (currentConfig.llm.defaultProvider === providerName) {
            const remaining = Object.keys(providers).filter(k => providers[k]?.enabled !== false);
            configUpdates.llm.defaultProvider = remaining[0] ?? 'anthropic';
          }
          saveConfig(configUpdates, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider deletion', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Add custom model to provider catalog
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/models$/) && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      const body = await this.readBody(req);
      const { id, name, contextWindow, maxOutputTokens, cost, reasoning, inputTypes } = body as {
        id?: string; name?: string; contextWindow?: number; maxOutputTokens?: number;
        cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
        reasoning?: boolean; inputTypes?: Array<'text' | 'image'>;
      };
      if (!id || !name || !contextWindow || !maxOutputTokens || !cost) {
        this.json(res, 400, { error: 'id, name, contextWindow, maxOutputTokens, and cost are required' });
        return;
      }
      try {
        const modelDef = {
          id, name, provider: providerName, contextWindow, maxOutputTokens, cost,
          ...(reasoning !== null && reasoning !== undefined ? { reasoning } : {}),
          ...(inputTypes ? { inputTypes } : {}),
        };
        this.llmRouter.addCustomModel(providerName, modelDef);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const customModels = { ...(currentConfig.llm.customModels ?? {}) };
          const existing = customModels[providerName] ?? [];
          customModels[providerName] = [...existing.filter(m => m.id !== id), modelDef];
          saveConfig({ llm: { customModels } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist custom model', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Delete custom model from provider catalog
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/models\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const parts = path.split('/');
      const providerName = parts[5]!;
      const modelId = decodeURIComponent(parts[7]!);
      try {
        this.llmRouter.removeCustomModel(providerName, modelId);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const customModels = { ...(currentConfig.llm.customModels ?? {}) };
          if (customModels[providerName]) {
            customModels[providerName] = customModels[providerName].filter(m => m.id !== modelId);
            if (customModels[providerName].length === 0) delete customModels[providerName];
          }
          saveConfig({ llm: { customModels } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist custom model removal', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Switch provider model
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/model$/) && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      const body = await this.readBody(req);
      const { model } = body as { model?: string };
      if (!model || typeof model !== 'string') {
        this.json(res, 400, { error: 'model (string) is required' });
        return;
      }
      try {
        this.llmRouter.setProviderModel(providerName, model);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          providers[providerName] = { ...providers[providerName], model };
          saveConfig({ llm: { providers } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider model change', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Toggle provider enabled/disabled
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/toggle$/) && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) {
        this.json(res, 503, { error: 'LLM router not available' });
        return;
      }
      const providerName = path.split('/')[5]!;
      const body = await this.readBody(req);
      const { enabled } = body as { enabled: boolean };
      if (typeof enabled !== 'boolean') {
        this.json(res, 400, { error: 'enabled (boolean) is required' });
        return;
      }
      try {
        this.llmRouter.setProviderEnabled(providerName, enabled);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(this.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          if (providers[providerName]) {
            providers[providerName] = { ...providers[providerName], enabled };
          } else {
            providers[providerName] = { enabled };
          }
          saveConfig({ llm: { providers } } as any, this.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider enabled state', { error: String(e) });
        }
        this.json(res, 200, this.llmRouter.getEnhancedSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Settings — Detect model configs from environment variables
    if (path === '/api/settings/env-models' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;

      const ENV_MODEL_MAP: Array<{
        provider: string;
        displayName: string;
        keyEnv: string;
        modelEnv?: string;
        baseUrlEnv?: string;
        defaultModel: string;
        defaultBaseUrl?: string;
      }> = [
        { provider: 'anthropic', displayName: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-4-6' },
        { provider: 'openai', displayName: 'OpenAI', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-5.4' },
        { provider: 'google', displayName: 'Google Gemini', keyEnv: 'GOOGLE_API_KEY', defaultModel: 'gemini-3-1-pro' },
        { provider: 'siliconflow', displayName: 'SiliconFlow', keyEnv: 'SILICONFLOW_API_KEY', modelEnv: 'SILICONFLOW_MODEL', baseUrlEnv: 'SILICONFLOW_BASE_URL', defaultModel: 'Qwen/Qwen3.5-35B-A3B', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
        { provider: 'minimax', displayName: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', modelEnv: 'MINIMAX_MODEL', baseUrlEnv: 'MINIMAX_BASE_URL', defaultModel: 'MiniMax-M2.7', defaultBaseUrl: 'https://api.minimax.io/v1' },
        { provider: 'openrouter', displayName: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', baseUrlEnv: 'OPENROUTER_BASE_URL', defaultModel: 'xiaomi/mimo-v2-pro', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
        { provider: 'zai', displayName: 'ZAI', keyEnv: 'ZAI_API_KEY', modelEnv: 'ZAI_MODEL', baseUrlEnv: 'ZAI_BASE_URL', defaultModel: 'glm-5.1', defaultBaseUrl: 'https://api.z.ai/api/paas/v4' },
      ];

      const detected: Array<{
        provider: string;
        displayName: string;
        apiKeySet: boolean;
        apiKeyPreview: string;
        model: string;
        baseUrl?: string;
        envVars: Record<string, string>;
      }> = [];

      for (const def of ENV_MODEL_MAP) {
        const apiKey = process.env[def.keyEnv];
        if (!apiKey) continue;

        const model = def.modelEnv ? (process.env[def.modelEnv] ?? def.defaultModel) : def.defaultModel;
        const baseUrl = def.baseUrlEnv ? (process.env[def.baseUrlEnv] ?? def.defaultBaseUrl) : def.defaultBaseUrl;
        const envVars: Record<string, string> = { [def.keyEnv]: '***' + apiKey.slice(-4) };
        if (def.modelEnv && process.env[def.modelEnv]) envVars[def.modelEnv] = process.env[def.modelEnv]!;
        if (def.baseUrlEnv && process.env[def.baseUrlEnv]) envVars[def.baseUrlEnv] = process.env[def.baseUrlEnv]!;

        detected.push({
          provider: def.provider,
          displayName: def.displayName,
          apiKeySet: true,
          apiKeyPreview: '***' + apiKey.slice(-4),
          model,
          baseUrl,
          envVars,
        });
      }

      const timeoutMs = process.env['LLM_TIMEOUT_MS'];
      this.json(res, 200, {
        detected,
        timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
      });
      return;
    }

    // Settings — Apply env model configs to markus.json
    if (path === '/api/settings/env-models' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { providers: providerUpdates } = body as {
        providers: Array<{
          provider: string;
          model: string;
          baseUrl?: string;
          enabled?: boolean;
        }>;
      };
      if (!Array.isArray(providerUpdates) || providerUpdates.length === 0) {
        this.json(res, 400, { error: 'providers array is required' });
        return;
      }
      try {
        const { loadConfig: loadCfg } = await import('@markus/shared');
        const currentConfig = loadCfg(this.markusConfigPath);
        const updatedProviders = { ...currentConfig.llm.providers };
        const applied: string[] = [];
        for (const pu of providerUpdates) {
          const envKeyMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            google: 'GOOGLE_API_KEY',
            siliconflow: 'SILICONFLOW_API_KEY',
            minimax: 'MINIMAX_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
          };
          const apiKey = process.env[envKeyMap[pu.provider] ?? ''];
          if (!apiKey) continue;
          updatedProviders[pu.provider] = {
            ...updatedProviders[pu.provider],
            apiKey,
            model: pu.model,
            ...(pu.baseUrl ? { baseUrl: pu.baseUrl } : {}),
            enabled: pu.enabled !== false,
          };
          applied.push(pu.provider);
        }
        saveConfig({ llm: { providers: updatedProviders } } as any, this.markusConfigPath);
        // Hot-register newly applied providers in the running router
        if (this.llmRouter) {
          for (const provName of applied) {
            if (!this.llmRouter.getProvider(provName)) {
              const cfg = updatedProviders[provName];
              if (cfg?.apiKey || provName === 'ollama') {
                try {
                  this.llmRouter.registerProviderFromConfig(provName, {
                    provider: provName as any,
                    model: cfg.model ?? '',
                    apiKey: cfg.apiKey,
                    baseUrl: cfg.baseUrl,
                  });
                } catch (e) {
                  log.warn(`Failed to hot-register provider ${provName}`, { error: String(e) });
                }
              }
            }
          }
        }
        this.json(res, 200, {
          applied,
          message: `Updated ${applied.length} provider(s) in markus.json`,
          ...(this.llmRouter ? { settings: this.llmRouter.getEnhancedSettings() } : {}),
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ─── OAuth Authentication ───

    // List available OAuth providers
    if (path === '/api/settings/oauth/providers' && req.method === 'GET') {
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 200, { providers: [] });
        return;
      }
      const supportedProviders = this.llmRouter.oauthManager.getSupportedProviders().map(name => ({
        name,
        displayName: name === 'openai-codex' ? 'OpenAI Codex (ChatGPT OAuth)' : name,
        config: this.llmRouter!.oauthManager!.getProviderConfig(name),
      }));
      this.json(res, 200, { providers: supportedProviders });
      return;
    }

    // List auth profiles
    if (path === '/api/settings/oauth/profiles' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.profileStore) {
        this.json(res, 200, { profiles: [] });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const provider = url.searchParams.get('provider') ?? undefined;
      this.json(res, 200, { profiles: this.llmRouter.profileStore.listProfilesSafe(provider) });
      return;
    }

    // Start OAuth login flow
    if (path === '/api/settings/oauth/login' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { provider } = body as { provider?: string };
      if (!provider) {
        this.json(res, 400, { error: 'provider is required' });
        return;
      }
      try {
        const { authorizeUrl, promise } = await this.llmRouter.oauthManager.startLogin(provider);
        // Don't await the promise — it resolves when the user completes the browser flow.
        // Instead, respond with the authorizeUrl and let the frontend poll for status.
        promise.then(profile => {
          log.info(`OAuth login completed for ${provider}`, { profileId: profile.id });
          // Auto-register the new OAuth provider in the router
          if (this.llmRouter && !this.llmRouter.getProvider(provider)) {
            try {
              this.llmRouter.registerOAuthProvider(provider, profile, {
                model: provider === 'openai-codex' ? 'gpt-5.4' : undefined,
              });
            } catch (err) {
              log.warn(`Failed to auto-register OAuth provider after login`, { error: String(err) });
            }
          }
        }).catch(err => {
          log.warn(`OAuth login failed for ${provider}`, { error: String(err) });
        });
        this.json(res, 200, { authorizeUrl, provider });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Handle manual OAuth callback (paste redirect URL for headless scenarios)
    if (path === '/api/settings/oauth/callback' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { callbackUrl } = body as { callbackUrl?: string };
      if (!callbackUrl) {
        this.json(res, 400, { error: 'callbackUrl is required' });
        return;
      }
      try {
        const profile = await this.llmRouter.oauthManager.handleManualCallback(callbackUrl);
        if (this.llmRouter && !this.llmRouter.getProvider(profile.provider)) {
          this.llmRouter.registerOAuthProvider(profile.provider, profile, {
            model: profile.provider === 'openai-codex' ? 'gpt-5.4' : undefined,
          });
        }
        this.json(res, 200, {
          profile: {
            id: profile.id,
            provider: profile.provider,
            authType: profile.authType,
            label: profile.label,
            oauthAccountId: profile.oauth?.accountId,
          },
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Check OAuth login status (polling endpoint)
    if (path === '/api/settings/oauth/status' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 200, { pending: false, profiles: [] });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const provider = url.searchParams.get('provider') ?? undefined;
      const pending = this.llmRouter.oauthManager.hasPendingLogin(provider);
      const profiles = this.llmRouter.profileStore?.listProfilesSafe(provider) ?? [];
      this.json(res, 200, { pending, profiles });
      return;
    }

    // Delete auth profile
    if (path.match(/^\/api\/settings\/oauth\/profiles\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.profileStore) {
        this.json(res, 404, { error: 'Profile store not available' });
        return;
      }
      const profileId = decodeURIComponent(path.split('/')[5]!);
      const deleted = this.llmRouter.profileStore.deleteProfile(profileId);
      if (deleted) {
        this.json(res, 200, { deleted: true, profileId });
      } else {
        this.json(res, 404, { error: 'Profile not found' });
      }
      return;
    }

    // Store setup token (e.g. Anthropic)
    if (path === '/api/settings/oauth/setup-token' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { provider, token } = body as { provider?: string; token?: string };
      if (!provider || !token) {
        this.json(res, 400, { error: 'provider and token are required' });
        return;
      }
      const profile = this.llmRouter.oauthManager.storeSetupToken(provider, token);
      this.json(res, 200, {
        profile: {
          id: profile.id,
          provider: profile.provider,
          authType: profile.authType,
          label: profile.label,
        },
      });
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

    // System: open a directory in the native file manager
    if (path === '/api/system/open-path' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const dirPath = body['path'] as string;
        if (!dirPath || !existsSync(dirPath)) {
          this.json(res, 400, { error: 'Invalid or non-existent path' });
          return;
        }
        const platform = process.platform;
        if (platform === 'darwin') execSync(`open ${JSON.stringify(dirPath)}`);
        else if (platform === 'win32') execSync(`explorer ${JSON.stringify(dirPath)}`);
        else execSync(`xdg-open ${JSON.stringify(dirPath)}`);
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 500, { error: 'Failed to open path' });
      }
      return;
    }

    // Health
    if (path === '/api/health') {
      this.json(res, 200, {
        status: 'ok',
        version: APP_VERSION,
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

    if (path === '/api/system/storage' && req.method === 'GET') {
      try {
        const dataDir = join(homedir(), '.markus');
        const result = this.collectStorageInfo(dataDir);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Storage scan failed: ${String(err)}` });
      }
      return;
    }

    if (path === '/api/system/storage/orphans' && req.method === 'GET') {
      try {
        const result = this.detectOrphans();
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Orphan detection failed: ${String(err)}` });
      }
      return;
    }

    if (path === '/api/system/storage/orphans' && req.method === 'DELETE') {
      try {
        const body = await this.readBody(req);
        const ids = Array.isArray(body?.ids) ? body.ids as string[] : undefined;
        const result = this.purgeOrphans(ids);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Orphan cleanup failed: ${String(err)}` });
      }
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

    if (path === '/api/files/reveal' && req.method === 'POST') {
      const body = await this.readBody(req);
      const filePath = body?.path as string | undefined;
      if (!filePath) {
        this.json(res, 400, { error: 'Missing "path" in request body' });
        return;
      }

      try {
        const { resolve, dirname } = await import('node:path');
        const { existsSync, statSync } = await import('node:fs');
        const { exec } = await import('node:child_process');
        const resolved = resolve(filePath);

        if (!existsSync(resolved)) {
          this.json(res, 404, { error: 'Path not found' });
          return;
        }

        const isDir = statSync(resolved).isDirectory();
        const platform = process.platform;

        let cmd: string;
        if (platform === 'darwin') {
          cmd = isDir ? `open "${resolved}"` : `open -R "${resolved}"`;
        } else if (platform === 'win32') {
          cmd = isDir ? `explorer "${resolved}"` : `explorer /select,"${resolved}"`;
        } else {
          cmd = `xdg-open "${isDir ? resolved : dirname(resolved)}"`;
        }

        exec(cmd, (err) => {
          if (err) {
            log.warn('Failed to reveal file in system browser', { path: resolved, error: String(err) });
          }
        });

        this.json(res, 200, { ok: true, path: resolved });
      } catch (err) {
        this.json(res, 500, { error: `Failed to reveal file: ${String(err)}` });
      }
      return;
    }

    // ── Requirements ─────────────────────────────────────────────────────

    if (path === '/api/requirements' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const status = url.searchParams.get('status') ?? undefined;
      const source = url.searchParams.get('source') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
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
      const title = (body['title'] as string | undefined)?.trim();
      const description = (body['description'] as string | undefined)?.trim();
      const projectId = body['projectId'] as string | undefined;
      if (!title) { this.json(res, 400, { error: 'Title is required' }); return; }
      if (!description) { this.json(res, 400, { error: 'Description is required' }); return; }
      if (!projectId) { this.json(res, 400, { error: 'Project is required' }); return; }
      if (!authUser?.userId) { this.json(res, 400, { error: 'Creator identity is required' }); return; }
      try {
        const requirement = this.requirementService.createRequirement({
          orgId: (body['orgId'] as string) ?? 'default',
          title,
          description,
          priority: body['priority'] as TaskPriority | undefined,
          projectId,
          source: 'user',
          createdBy: authUser.userId,
          tags: body['tags'] as string[] | undefined,
        });
        this.json(res, 201, { requirement });
      } catch (e) {
        this.json(res, 400, { error: String(e).replace('Error: ', '') });
      }
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
          body['status'] as string as RequirementStatus,
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

    if (path.match(/^\/api\/requirements\/[^/]+\/cancel$/) && req.method === 'POST') {
      const reqId = path.split('/')[3]!;
      if (!this.requirementService) {
        this.json(res, 503, { error: 'Requirement service not available' });
        return;
      }
      try {
        const requirement = this.requirementService.cancelRequirement(reqId);
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 404, { error: String(e) });
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
        const requirement = this.requirementService.cancelRequirement(reqId);
        this.json(res, 200, { requirement });
      } catch (e) {
        this.json(res, 404, { error: String(e) });
      }
      return;
    }

    // ── Requirement Comments ──────────────────────────────────────────────

    if (path.match(/^\/api\/requirements\/[^/]+\/comments$/) && req.method === 'POST') {
      const reqId = path.split('/')[3]!;
      if (!this.storage?.requirementCommentRepo) {
        this.json(res, 500, { error: 'Storage not available' });
        return;
      }
      try {
        const authUser = await this.getAuthUser(req);
        const body = await this.readBody(req);
        const mentions = (body['mentions'] as string[] | undefined) ?? [];
        let resolvedAuthorName = (body['authorName'] as string | undefined);
        if (!resolvedAuthorName && authUser?.userId && this.storage.userRepo) {
          const userRow = await this.storage.userRepo.findById(authUser.userId);
          resolvedAuthorName = userRow?.name;
        }
        const comment = await this.storage.requirementCommentRepo.add({
          requirementId: reqId,
          authorId: (body['authorId'] as string) ?? authUser?.userId ?? 'human',
          authorName: resolvedAuthorName ?? 'User',
          authorType: (body['authorType'] as string) ?? 'human',
          content: body['content'] as string,
          attachments: body['attachments'] as unknown[] | undefined,
          mentions,
        });
        this.ws?.broadcast({
          type: 'requirement:comment',
          payload: {
            requirementId: reqId,
            comment: {
              id: comment.id,
              requirementId: comment.requirementId,
              authorId: comment.authorId,
              authorName: comment.authorName,
              authorType: comment.authorType,
              content: comment.content,
              attachments: comment.attachments,
              mentions: comment.mentions,
              createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : comment.createdAt,
            },
          },
          timestamp: new Date().toISOString(),
        });
        // Notify agents about the comment
        {
          const authorName = resolvedAuthorName ?? 'User';
          const commenterId = (body['authorId'] as string) ?? authUser?.userId ?? 'human';
          const req_ = this.requirementService?.getRequirement(reqId);
          const reqTitle = req_?.title ?? reqId;
          const reqStatus = req_?.status ?? 'unknown';
          const agentMgr = this.orgService.getAgentManager();
          const notified = new Set<string>();

          const notifyAgent = (agentId: string, reason: string) => {
            if (notified.has(agentId) || agentId === commenterId) return;
            notified.add(agentId);
            try {
              const agent = agentMgr.getAgent(agentId);
              if (!agent) return;
              const notif = [
                `${reason} on requirement "${reqTitle}" (ID: ${reqId}, status: ${reqStatus}).`,
                ``,
                `Comment from ${authorName}: ${body['content'] as string}`,
                ``,
                `**MANDATORY before replying**: You MUST first understand the full context:`,
                `1. Call \`requirement_list\` to get the full requirement details and linked tasks`,
                `2. Read ALL previous comments to understand the conversation thread`,
                `3. Only THEN formulate your response using \`requirement_comment\``,
                `Do NOT reply based solely on the comment above — you need the full picture.`,
              ].join('\n');
              agent.enqueueToMailbox('requirement_update', {
                summary: `Comment on requirement "${reqTitle}" from ${authorName}`,
                content: notif,
                requirementId: reqId,
              }, {
                metadata: { senderName: authorName, senderRole: 'user' },
              });
            } catch { /* agent not found */ }
          };

          // 1. Notify @mentioned agents
          for (const mid of mentions) {
            notifyAgent(mid, `You were mentioned by ${authorName} in a comment`);
          }

          // 2. Always notify requirement creator (even without @mention)
          if (req_?.createdBy) {
            notifyAgent(req_.createdBy, `New comment from ${authorName} on a requirement you created`);
          }
        }
        this.json(res, 201, { comment });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/requirements\/[^/]+\/comments$/) && req.method === 'GET') {
      const reqId = path.split('/')[3]!;
      if (!this.storage?.requirementCommentRepo) {
        this.json(res, 200, { comments: [] });
        return;
      }
      try {
        const comments = await this.storage.requirementCommentRepo.getByRequirement(reqId);
        this.json(res, 200, { comments });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
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

    // ── Governance: Task Review ───────────────────────────────────────────

    if (path.match(/^\/api\/tasks\/[^/]+\/accept$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const authUser = await this.getAuthUser(req);
        const body = await this.readBody(req);
        const reviewerAgentId = (body['reviewerAgentId'] as string | undefined) ?? authUser?.userId ?? 'human';
        const task = this.taskService.acceptTask(taskId, reviewerAgentId);
        this.json(res, 200, { task });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/revision$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      const authUser = await this.getAuthUser(req);
      const body = await this.readBody(req);
      try {
        const task = await this.taskService.requestRevision(
          taskId,
          (body['reason'] as string) ?? 'Revisions needed',
          authUser?.userId
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

    // ── Governance: Schedule Control ──────────────────────────────────────

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/pause$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.getTask(taskId);
        if (!task) { this.json(res, 404, { error: 'Task not found' }); return; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          this.json(res, 400, { error: 'Task is not a scheduled task' }); return;
        }
        await this.taskService.updateScheduleConfig(taskId, { ...task.scheduleConfig, paused: true });
        this.json(res, 200, { task: { ...task, scheduleConfig: { ...task.scheduleConfig, paused: true } } });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/resume$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.getTask(taskId);
        if (!task) { this.json(res, 404, { error: 'Task not found' }); return; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          this.json(res, 400, { error: 'Task is not a scheduled task' }); return;
        }
        const updated = { ...task.scheduleConfig, paused: false };
        await this.taskService.updateScheduleConfig(taskId, updated);
        this.json(res, 200, { task: { ...task, scheduleConfig: updated } });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/tasks\/[^/]+\/schedule\/run-now$/) && req.method === 'POST') {
      const taskId = path.split('/')[3]!;
      try {
        const task = this.taskService.getTask(taskId);
        if (!task) { this.json(res, 404, { error: 'Task not found' }); return; }
        if (task.taskType !== 'scheduled' || !task.scheduleConfig) {
          this.json(res, 400, { error: 'Task is not a scheduled task' }); return;
        }
        if (task.status === 'in_progress') {
          this.json(res, 400, { error: 'Task is already running' }); return;
        }
        if (task.status === 'review') {
          this.json(res, 400, { error: 'Task is awaiting review. Accept or reject before running again.' }); return;
        }
        if (task.status === 'blocked') {
          this.json(res, 400, { error: 'Task is blocked by dependencies' }); return;
        }
        if (task.status === 'pending') {
          this.json(res, 400, { error: 'Task is awaiting approval' }); return;
        }
        await this.taskService.advanceScheduleConfig(taskId);
        const resettable = ['completed', 'cancelled', 'failed'];
        if (resettable.includes(task.status)) {
          await this.taskService.resetTaskForRerun(taskId);
        }
        await this.taskService.runTask(taskId);
        this.json(res, 202, { status: 'running', taskId });
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

    // ── Governance: Knowledge (legacy, redirected to /api/deliverables) ────

    if (path === '/api/knowledge/search' && req.method === 'GET') {
      if (!this.deliverableService) { this.json(res, 200, { results: [] }); return; }
      const query = url.searchParams.get('query') ?? undefined;
      const { results } = this.deliverableService.search({ query });
      this.json(res, 200, { results });
      return;
    }

    if (path === '/api/knowledge' && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.create({
          type: 'file',
          title: body['title'] as string,
          summary: body['content'] as string,
          tags: body['tags'] as string[],
          agentId: body['source'] as string,
        });
        this.json(res, 201, { entry: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/flag-outdated$/) && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.flagOutdated(knowledgeId);
      this.json(res, 200, { status: 'flagged' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/verify$/) && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.update(knowledgeId, { status: 'verified' });
      this.json(res, 200, { status: 'verified' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.remove(knowledgeId);
      this.json(res, 200, { status: 'deleted' });
      return;
    }

    // Serve pre-built Web UI static files as SPA fallback
    if (this.webUiDir) {
      const safePath = path.replace(/\.\./g, '').replace(/\/\//g, '/');
      const filePath = join(this.webUiDir, safePath === '/' ? 'index.html' : safePath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        this.serveStaticFile(res, filePath);
        return;
      }
      // SPA fallback: serve index.html for non-API routes
      const indexPath = join(this.webUiDir, 'index.html');
      if (existsSync(indexPath) && !path.startsWith('/api/')) {
        this.serveStaticFile(res, indexPath);
        return;
      }
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private serveStaticFile(res: ServerResponse, filePath: string): void {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const MIME: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
      mjs: 'application/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      map: 'application/json',
    };
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const body = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.byteLength,
      'Cache-Control': ext === 'html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  }

  private projectService?: ProjectService;
  private reportService?: ReportService;
  private knowledgeService?: KnowledgeService;
  private deliverableService?: DeliverableService;
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
  setDeliverableService(svc: DeliverableService): void {
    this.deliverableService = svc;
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

  private collectStorageInfo(dataDir: string) {
    const dirSize = (p: string, maxDepth = 3, depth = 0): number => {
      if (!existsSync(p)) return 0;
      try {
        const st = statSync(p);
        if (st.isFile()) return st.size;
        if (!st.isDirectory() || depth >= maxDepth) return 0;
        let total = 0;
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          total += dirSize(join(p, entry.name), maxDepth, depth + 1);
        }
        return total;
      } catch { return 0; }
    };

    const topLevelItems: Array<{ name: string; path: string; size: number; description: string }> = [
      { name: 'Database', path: join(dataDir, 'data.db'), size: 0, description: 'SQLite database (tasks, agents, chat, etc.)' },
      { name: 'Agents', path: join(dataDir, 'agents'), size: 0, description: 'Agent workspaces, memory, role files, sessions' },
      { name: 'Skills', path: join(dataDir, 'skills'), size: 0, description: 'Installed skill packages' },
      { name: 'LLM Logs', path: join(dataDir, 'llm-logs'), size: 0, description: 'Daily LLM request/response audit logs' },
      { name: 'Builder Artifacts', path: join(dataDir, 'builder-artifacts'), size: 0, description: 'Agent, team, and skill build outputs' },
      { name: 'Teams', path: join(dataDir, 'teams'), size: 0, description: 'Team announcements and norms' },
      { name: 'Shared', path: join(dataDir, 'shared'), size: 0, description: 'Cross-agent shared files and task deliverables' },
      { name: 'Knowledge', path: join(dataDir, 'knowledge'), size: 0, description: 'File-based knowledge base entries' },
    ];

    for (const item of topLevelItems) {
      if (item.name === 'Database') {
        for (const ext of ['', '-wal', '-shm']) {
          const f = item.path + ext;
          if (existsSync(f)) { try { item.size += statSync(f).size; } catch { /* */ } }
        }
      } else {
        item.size = dirSize(item.path);
      }
    }

    const agentsDir = join(dataDir, 'agents');
    const agentInfos: Array<{ id: string; name: string; size: number; subItems: Array<{ name: string; size: number }> }> = [];
    const am = this.orgService.getAgentManager();

    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'vector-store') continue;
        const agentDir = join(agentsDir, entry.name);
        const agent = (() => { try { return am.getAgent(entry.name); } catch { return null; } })();
        const subItems = [
          { name: 'workspace', size: dirSize(join(agentDir, 'workspace')) },
          { name: 'memory', size: dirSize(join(agentDir, 'sessions')) + (existsSync(join(agentDir, 'memories.json')) ? statSync(join(agentDir, 'memories.json')).size : 0) + (existsSync(join(agentDir, 'MEMORY.md')) ? statSync(join(agentDir, 'MEMORY.md')).size : 0) },
          { name: 'role', size: dirSize(join(agentDir, 'role')) },
          { name: 'tool-outputs', size: dirSize(join(agentDir, 'tool-outputs')) },
          { name: 'daily-logs', size: dirSize(join(agentDir, 'daily-logs')) },
        ];
        agentInfos.push({
          id: entry.name,
          name: agent?.config?.name ?? entry.name,
          size: subItems.reduce((s, i) => s + i.size, 0),
          subItems,
        });
      }
    }
    agentInfos.sort((a, b) => b.size - a.size);

    const totalSize = topLevelItems.reduce((s, i) => s + i.size, 0);
    const dbItem = topLevelItems.find(i => i.name === 'Database')!;

    return {
      dataDir,
      totalSize,
      breakdown: topLevelItems,
      agents: agentInfos,
      database: { path: dbItem.path, size: dbItem.size },
    };
  }

  private detectOrphans() {
    const dataDir = join(homedir(), '.markus');
    const am = this.orgService.getAgentManager();
    const knownAgentIds = new Set(am.listAgents().map(a => a.id));
    const teams = this.orgService.listTeams('default');
    const knownTeamIds = new Set(teams.map(t => t.id));

    const orphanAgents: Array<{ id: string; path: string; size: number }> = [];
    const orphanTeams: Array<{ id: string; path: string; size: number }> = [];

    const dirSize = (p: string, maxDepth = 3, depth = 0): number => {
      if (!existsSync(p)) return 0;
      try {
        const st = statSync(p);
        if (st.isFile()) return st.size;
        if (!st.isDirectory() || depth >= maxDepth) return 0;
        let total = 0;
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          total += dirSize(join(p, entry.name), maxDepth, depth + 1);
        }
        return total;
      } catch { return 0; }
    };

    const agentsDir = join(dataDir, 'agents');
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'vector-store') continue;
        if (!knownAgentIds.has(entry.name)) {
          const p = join(agentsDir, entry.name);
          orphanAgents.push({ id: entry.name, path: p, size: dirSize(p) });
        }
      }
    }

    const teamsDir = join(dataDir, 'teams');
    if (existsSync(teamsDir)) {
      for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!knownTeamIds.has(entry.name)) {
          const p = join(teamsDir, entry.name);
          orphanTeams.push({ id: entry.name, path: p, size: dirSize(p) });
        }
      }
    }

    return {
      orphanAgents: orphanAgents.sort((a, b) => b.size - a.size),
      orphanTeams: orphanTeams.sort((a, b) => b.size - a.size),
      totalOrphanSize: [...orphanAgents, ...orphanTeams].reduce((s, o) => s + o.size, 0),
    };
  }

  private purgeOrphans(ids?: string[]) {
    const orphans = this.detectOrphans();
    const filter = ids && ids.length > 0 ? new Set(ids) : null;
    const purgedAgents: string[] = [];
    const purgedTeams: string[] = [];
    const failures: string[] = [];

    for (const o of orphans.orphanAgents) {
      if (filter && !filter.has(o.id)) continue;
      try {
        rmSync(o.path, { recursive: true, force: true });
        purgedAgents.push(o.id);
      } catch { failures.push(o.id); }
    }

    for (const o of orphans.orphanTeams) {
      if (filter && !filter.has(o.id)) continue;
      try {
        rmSync(o.path, { recursive: true, force: true });
        purgedTeams.push(o.id);
      } catch { failures.push(o.id); }
    }

    return {
      purgedAgents,
      purgedTeams,
      freedBytes: orphans.totalOrphanSize,
      failures,
    };
  }
}
