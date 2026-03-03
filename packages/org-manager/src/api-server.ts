import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createLogger, generateId, type TaskStatus, type TaskPriority } from '@markus/shared';
import { GatewayError, WorkflowEngine, TeamTemplateRegistry, createDefaultTeamTemplates, createDefaultTemplateRegistry, type AgentToolHandler, type ExternalAgentGateway, type LLMRouter, type ReviewService, type SkillRegistry, type TemplateRegistry, type WorkflowExecutor, type WorkflowDefinition } from '@markus/core';
import type { ChannelMsg } from '@markus/storage';
import type { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import type { BillingService } from './billing-service.js';
import type { AuditService, AuditEventType } from './audit-service.js';
import type { StorageBridge } from './storage-bridge.js';
import { WSBroadcaster } from './ws-server.js';
import { SSEHandler } from './sse-handler.js';

const log = createLogger('api-server');

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Simple JWT-lite using HMAC-SHA256 (no external deps required)
async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${data}.${sigB64}`;
}

async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
    if (payload['exp'] && (payload['exp'] as number) < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

const PBKDF2_ITERATIONS = 10000;

async function hashPassword(password: string): Promise<string> {
  // Format: pbkdf2:<iterations>:<saltHex>:<hashHex>
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  private gateway?: ExternalAgentGateway;
  private reviewService?: ReviewService;
  private templateRegistry?: TemplateRegistry;
  private workflowEngine?: WorkflowEngine;
  private teamTemplateRegistry: TeamTemplateRegistry;
  private customGroupChats: Array<{ id: string; name: string; orgId: string; creatorId: string; creatorName: string; memberIds: string[]; createdAt: string }> = [];

  constructor(
    private orgService: OrganizationService,
    private taskService: TaskService,
    private port: number = 3001,
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
      sendGroupMessage: async (channelKey: string, message: string, senderId: string, senderName: string) => {
        if (this.storage) {
          await this.storage.channelMessageRepo.append({
            orgId: 'default', channel: channelKey,
            senderId, senderType: 'agent', senderName, text: message,
          });
        }
        this.ws.broadcast({
          type: 'chat:message',
          payload: { channel: channelKey, senderId, senderType: 'agent', senderName, text: message },
          timestamp: new Date().toISOString(),
        });
        return 'Message sent to group chat';
      },
      createGroupChat: async (name: string, creatorId: string, creatorName: string, memberIds: string[]) => {
        const chatId = `group:custom:${Date.now().toString(36)}`;
        this.customGroupChats.push({ id: chatId, name, orgId: 'default', creatorId, creatorName, memberIds, createdAt: new Date().toISOString() });
        this.ws.broadcast({
          type: 'chat:group_created',
          payload: { chatId, name, creatorId, creatorName },
          timestamp: new Date().toISOString(),
        });
        return { id: chatId, name };
      },
      listGroupChats: async () => {
        const teams = this.orgService.listTeamsWithMembers('default');
        const teamChats = teams.map(t => ({ id: `group:${t.id}`, name: t.name, type: 'team', channelKey: `group:${t.id}` }));
        const customChats = this.customGroupChats.map(c => ({ id: c.id, name: c.name, type: 'custom', channelKey: c.id }));
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
    service.onNotification((n) => {
      this.ws.broadcast({ type: 'notification', payload: { notification: n }, timestamp: new Date().toISOString() });
    });
  }

  setStorage(storage: StorageBridge): void {
    this.storage = storage;
  }

  setGateway(gateway: ExternalAgentGateway): void {
    this.gateway = gateway;
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

  initWorkflowEngine(): WorkflowEngine {
    const agentManager = this.orgService.getAgentManager();
    const executor: WorkflowExecutor = {
      executeStep: async (agentId: string, taskDescription: string, input: Record<string, unknown>) => {
        const agent = agentManager.getAgent(agentId);
        const reply = await agent.handleMessage(taskDescription, 'workflow-engine', { name: 'workflow', role: 'system' });
        return { reply, input };
      },
      findAgent: (skills: string[]) => {
        const agents = agentManager.listAgents();
        const found = agents.find(a =>
          skills.some(s => a.role?.toLowerCase().includes(s.toLowerCase()) || a.agentRole?.toLowerCase().includes(s.toLowerCase()))
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
    // Check for auth-capable users (those with a passwordHash) only.
    // Synthetic in-memory users (e.g. default owner without email) must not prevent admin creation.
    const allUsers = await this.storage.userRepo.listByOrg(orgId);
    const hasAuthUser = allUsers.some(u => u.passwordHash);
    if (hasAuthUser) return;
    const adminPassword = process.env['ADMIN_PASSWORD'] ?? 'markus123';
    const hash = await hashPassword(adminPassword);
    await this.storage.userRepo.create({
      id: generateId('usr'),
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
  private async getAuthUser(req: IncomingMessage): Promise<{ userId: string; orgId: string; role: string } | null> {
    if (!this.authEnabled) return { userId: 'anonymous', orgId: 'default', role: 'owner' };
    const cookies = parseCookies(req.headers['cookie']);
    const token = cookies['markus_token'];
    if (!token) return null;
    const payload = await verifyToken(token, this.jwtSecret);
    if (!payload) return null;
    return payload as { userId: string; orgId: string; role: string };
  }

  /** Returns user or sends 401 and returns null */
  private async requireAuth(req: IncomingMessage, res: ServerResponse): Promise<{ userId: string; orgId: string; role: string } | null> {
    const user = await this.getAuthUser(req);
    if (!user) { this.json(res, 401, { error: 'Unauthorized' }); return null; }
    return user;
  }

  /** Persist a chat turn (user + assistant) to DB if storage is available */
  private async persistChatTurn(
    agentId: string,
    userMessage: string,
    reply: string,
    senderId?: string,
    tokensUsed = 0,
    metadata?: unknown,
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
      await this.storage.chatSessionRepo.appendMessage(session.id, agentId, 'assistant', reply, tokensUsed, metadata);
      await this.storage.chatSessionRepo.updateLastMessage(session.id, title);
    } catch (err) {
      log.warn('Failed to persist chat turn', { error: String(err) });
    }
  }

  /** Persist the user message first (before LLM), returns session id for subsequent assistant persistence */
  private async persistUserMessage(agentId: string, userMessage: string, senderId?: string): Promise<string | null> {
    if (!this.storage) return null;
    try {
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, 1);
      let session = sessions[0];
      if (!session) {
        session = await this.storage.chatSessionRepo.createSession(agentId, senderId);
      }
      const title = !session.title ? userMessage.slice(0, 60) : undefined;
      await this.storage.chatSessionRepo.appendMessage(session.id, agentId, 'user', userMessage, 0);
      if (title) await this.storage.chatSessionRepo.updateLastMessage(session.id, title);
      return session.id;
    } catch (err) {
      log.warn('Failed to persist user message', { error: String(err) });
      return null;
    }
  }

  /** Persist the assistant reply after LLM completes */
  private async persistAssistantMessage(sessionId: string | null, agentId: string, reply: string, tokensUsed = 0, metadata?: unknown): Promise<void> {
    if (!this.storage || !sessionId) return;
    try {
      await this.storage.chatSessionRepo.appendMessage(sessionId, agentId, 'assistant', reply, tokensUsed, metadata);
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

    this.route(req, res, path, url).catch((error) => {
      log.error('Request handler error', { error: String(error), path });
      if (res.headersSent) {
        // SSE or chunked stream already started — send an error event and close gracefully
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`);
        } catch { /* ignore if write also fails */ }
        res.end();
      } else {
        this.json(res, 500, { error: 'Internal server error' });
      }
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    // ── Auth endpoints (no auth required) ──────────────────────────────────
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await this.readBody(req);
      const email = (body['email'] as string ?? '').trim().toLowerCase();
      const password = body['password'] as string ?? '';

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
      const token = await signToken({ userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp }, this.jwtSecret);
      res.setHeader('Set-Cookie', `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`);
      this.json(res, 200, { user: { id: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, orgId: userRow.orgId } });
      return;
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'markus_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/auth/me' && req.method === 'GET') {
      const authUser = await this.getAuthUser(req);
      if (!authUser) { this.json(res, 401, { error: 'Unauthorized' }); return; }
      if (!this.authEnabled) {
        this.json(res, 200, { user: { id: 'anonymous', name: 'Admin', role: 'owner', orgId: 'default' } });
        return;
      }
      const userRow = this.storage ? await this.storage.userRepo.findById(authUser.userId) : null;
      if (!userRow) { this.json(res, 401, { error: 'User not found' }); return; }
      this.json(res, 200, { user: { id: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, orgId: userRow.orgId } });
      return;
    }

    if (path === '/api/auth/change-password' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.storage) { this.json(res, 503, { error: 'Storage not available' }); return; }
      const body = await this.readBody(req);
      const currentPassword = body['currentPassword'] as string ?? '';
      const newPassword = body['newPassword'] as string ?? '';
      if (!newPassword || newPassword.length < 6) {
        this.json(res, 400, { error: 'New password must be at least 6 characters' });
        return;
      }
      const userRow = await this.storage.userRepo.findById(authUser.userId);
      if (!userRow) { this.json(res, 404, { error: 'User not found' }); return; }
      // If they already have a password, verify current one (skip for first-time setup where hash is null/empty)
      if (userRow.passwordHash && currentPassword) {
        const valid = await verifyPassword(currentPassword, userRow.passwordHash);
        if (!valid) { this.json(res, 401, { error: 'Current password is incorrect' }); return; }
      }
      const newHash = await hashPassword(newPassword);
      await this.storage.userRepo.updatePassword(authUser.userId, newHash);
      // Re-issue token so session stays valid
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken({ userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp }, this.jwtSecret);
      res.setHeader('Set-Cookie', `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`);
      this.json(res, 200, { ok: true });
      return;
    }

    // ── Chat sessions ──────────────────────────────────────────────────────
    if (path.match(/^\/api\/agents\/[^/]+\/sessions$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      if (!this.storage) { this.json(res, 200, { sessions: [] }); return; }
      const limit = parseInt(url.searchParams.get('limit') ?? '20');
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, limit);
      this.json(res, 200, { sessions });
      return;
    }

    if (path.match(/^\/api\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
      const sessionId = path.split('/')[3]!;
      if (!this.storage) { this.json(res, 200, { messages: [], hasMore: false }); return; }
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
      if (!this.storage) { this.json(res, 200, { messages: [], hasMore: false }); return; }
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
          orgId, channel, senderId, senderType: 'human', senderName, text, mentions,
        });
      }

      // DM / personal-notepad channels never route to agents
      const humanOnly = (body['humanOnly'] as boolean) === true;
      const isHumanChannel = humanOnly || channel.startsWith('notes:') || channel.startsWith('dm:');
      // Route to agent
      const routedAgentId = isHumanChannel ? null : (targetAgentId ?? this.orgService.routeMessage(orgId, { text }));
      if (!routedAgentId) {
        this.json(res, 200, { userMessage: userMsg ?? null, agentMessage: null });
        return;
      }
      const agent = this.orgService.getAgentManager().getAgent(routedAgentId);
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);
      const reply = await agent.handleMessage(text, senderId, senderInfo);

      // Persist agent reply
      let agentMsg: ChannelMsg | undefined;
      if (this.storage) {
        agentMsg = await this.storage.channelMessageRepo.append({
          orgId, channel, senderId: routedAgentId, senderType: 'agent',
          senderName: agent.config.name, text: reply, mentions: [],
        });
        void this.persistChatTurn(routedAgentId, text, reply, senderId);
      }

      this.ws.broadcastChat(routedAgentId, reply, 'agent');
      this.json(res, 200, { userMessage: userMsg ?? null, agentMessage: agentMsg ?? { id: `tmp_${Date.now()}`, channel, senderId: routedAgentId, senderType: 'agent', senderName: agent.config.name, text: reply, mentions: [], createdAt: new Date() } });
      return;
    }

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
        tools: body['tools'] as AgentToolHandler[] | undefined,
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
      if (action === 'a2a') {
        const body = await this.readBody(req);
        const fromAgentId = body['fromAgentId'] as string;
        const messageText = body['message'] as string;
        const targetAgent = this.orgService.getAgentManager().getAgent(agentId!);
        const fromAgent = this.orgService.getAgentManager().getAgent(fromAgentId);
        const reply = await targetAgent.handleMessage(messageText, fromAgentId, { name: fromAgent.config.name, role: fromAgent.config.agentRole ?? 'worker' });
        this.json(res, 200, { from: fromAgentId, to: agentId, reply });
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
          const userText = body['text'] as string;
          
          const sseHandler = new SSEHandler({
            agentId: agentId!,
            agent,
            userText,
            senderId,
            senderInfo,
            wsBroadcaster: this.ws,
            persistUserMessage: this.persistUserMessage.bind(this),
            persistAssistantMessage: this.persistAssistantMessage.bind(this),
          });
          
          await sseHandler.handle(res);
        } else {
          const userText = body['text'] as string;
          const userMsgPersisted = await this.persistUserMessage(agentId!, userText, senderId);
          const reply = await agent.handleMessage(userText, senderId, senderInfo);
          this.ws.broadcastChat(agentId!, reply, 'agent');
          this.json(res, 200, { reply });
          void this.persistAssistantMessage(userMsgPersisted, agentId!, reply, agent.getState().tokensUsedToday);
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
        chats: [...groupChats, ...customChats.map(c => ({
          id: c.id,
          name: c.name,
          type: 'custom' as const,
          creatorId: c.creatorId,
          creatorName: c.creatorName,
          memberCount: c.memberIds?.length ?? 0,
          channelKey: c.id,
        }))],
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
      if (!name) { this.json(res, 400, { error: 'name is required' }); return; }
      const chatId = `group:custom:${Date.now().toString(36)}`;
      const chat = { id: chatId, name, orgId, creatorId, creatorName, memberIds: memberIds ?? [], createdAt: new Date().toISOString() };
      this.customGroupChats.push(chat);
      this.ws?.broadcast({
        type: 'chat:group_created',
        payload: { chatId, name, creatorId, creatorName },
        timestamp: new Date().toISOString(),
      });
      this.json(res, 201, { chat: { id: chatId, name, type: 'custom', creatorId, creatorName, channelKey: chatId } });
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
        this.json(res, 403, { error: 'Insufficient permissions' }); return;
      }
      const body = await this.readBody(req);
      const orgId = (body['orgId'] as string) ?? authUser.orgId ?? 'default';
      const name = body['name'] as string;
      if (!name) { this.json(res, 400, { error: 'name is required' }); return; }
      const team = await this.orgService.createTeam(orgId, name, body['description'] as string | undefined);
      this.json(res, 201, { team });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+$/) && req.method === 'PATCH') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' }); return;
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
        this.json(res, 403, { error: 'Insufficient permissions' }); return;
      }
      const teamId = path.split('/')[3]!;
      await this.orgService.deleteTeam(teamId);
      this.json(res, 200, { deleted: true });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' }); return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const memberId = body['memberId'] as string;
      const memberType = body['memberType'] as 'human' | 'agent';
      if (!memberId || !memberType) { this.json(res, 400, { error: 'memberId and memberType are required' }); return; }
      this.orgService.addMemberToTeam(teamId, memberId, memberType);
      this.json(res, 200, { ok: true });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' }); return;
      }
      const parts = path.split('/');
      const teamId = parts[3]!;
      const memberId = parts[5]!;
      this.orgService.removeMemberFromTeam(teamId, memberId);
      this.json(res, 200, { ok: true });
      return;
    }

    // Roles
    if (path === '/api/roles' && req.method === 'GET') {
      const roleNames = this.orgService.listAvailableRoles();
      const roles = roleNames.map(name => {
        try {
          const details = this.orgService.getRoleDetails(name);
          return { id: name, name, description: details.description ?? '', category: details.category ?? 'custom' };
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
      const tasks = this.taskService.listTasks({ orgId, status, assignedAgentId });
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
      if (!task) { this.json(res, 404, { error: `Task not found: ${taskId}` }); return; }
      this.json(res, 200, { task });
      return;
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const body = await this.readBody(req);
      const task = this.taskService.createTask({
        orgId: (body['orgId'] as string) ?? 'default',
        title: body['title'] as string,
        description: body['description'] as string,
        priority: body['priority'] as TaskPriority | undefined,
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
        const task = this.taskService.updateTaskStatus(taskId, body['status'] as TaskStatus);
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

      // General field update (title/description/priority)
      if (body['title'] !== undefined || body['description'] !== undefined || body['priority'] !== undefined) {
        const task = this.taskService.updateTask(taskId, {
          title: body['title'] as string | undefined,
          description: body['description'] as string | undefined,
          priority: body['priority'] as TaskPriority | undefined,
        });
        this.json(res, 200, { task });
        return;
      }

      this.json(res, 400, { error: 'Provide status, assignedAgentId, or task fields to update' });
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
      if (!parent) { this.json(res, 404, { error: 'Parent task not found' }); return; }
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
      const board = this.taskService.getTaskBoard(orgId);
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
      if (!this.storage) { this.json(res, 200, { logs: [] }); return; }
      try {
        const logs = await this.storage.taskLogRepo.getByTask(taskId);
        this.json(res, 200, { logs });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
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
      const org = await this.orgService.createOrganization(body['name'] as string, (body['ownerId'] as string) ?? 'default');
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
        if (body['heartbeatIntervalMs'] !== undefined) cfg.heartbeatIntervalMs = body['heartbeatIntervalMs'];
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
          entries: entries.map(e => ({ type: e.type, content: e.content.slice(0, 500), timestamp: e.timestamp, importance: (e as unknown as Record<string, unknown>).importance })),
          sessions: sessions.map(s => ({ id: s.id, agentId: s.agentId, messageCount: s.messages.length, createdAt: (s as unknown as Record<string, unknown>).createdAt as string ?? new Date().toISOString(), updatedAt: (s as unknown as Record<string, unknown>).updatedAt as string ?? new Date().toISOString() })),
          dailyLog: dailyLog?.slice(0, 2000) ?? null,
          recentDailyLogs: recentDailyLogs?.slice(0, 5000) ?? null,
          longTermMemory: longTermMemory?.slice(0, 3000) ?? null,
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
        const content = body['content'] as string ?? '';
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
        const key = body['key'] as string ?? '';
        const content = body['content'] as string ?? '';
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
        const allowedNames = ['ROLE.md', 'SKILLS.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
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
        const allowedNames = ['ROLE.md', 'SKILLS.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
        if (!allowedNames.includes(filename)) {
          this.json(res, 400, { error: `Invalid filename. Allowed: ${allowedNames.join(', ')}` });
          return;
        }
        const body = await this.readBody(req);
        const content = body['content'] as string ?? '';
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
        const systemPrompt = body['systemPrompt'] as string ?? '';
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
        const skillName = body['skillName'] as string ?? '';
        if (skillName && !agent.config.skills.includes(skillName)) {
          agent.config.skills.push(skillName);
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
        const enabled = body['enabled'] as boolean ?? true;
        void toolName;
        void enabled;
        this.json(res, 200, { ok: true });
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
        const hb = (agent as unknown as { heartbeat: { getHealthMetrics(): unknown; isRunning(): boolean } }).heartbeat;
        this.json(res, 200, { running: hb.isRunning(), ...(hb.getHealthMetrics() as Record<string, unknown>) });
      } catch {
        this.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return;
    }

    // Agent detail (GET) — enriched with config, tools, heartbeat summary
    if (path.startsWith('/api/agents/') && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = this.orgService.getAgentManager().getAgent(agentId);
        const state = agent.getState();
        const tools = (agent as unknown as { tools: Map<string, { name: string; description: string }> }).tools;
        const toolList = [...tools.values()].map(t => ({ name: t.name, description: t.description }));
        const hb = (agent as unknown as { heartbeat: { getHealthMetrics(): unknown; isRunning(): boolean } }).heartbeat;
        let heartbeatSummary: Record<string, unknown> = {};
        try { heartbeatSummary = { running: hb.isRunning(), ...(hb.getHealthMetrics() as Record<string, unknown>) }; } catch { /* ok */ }
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
            computeConfig: agent.config.computeConfig,
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
      if (!this.reviewService) { this.json(res, 503, { error: 'Review service not configured' }); return; }
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
      if (!this.reviewService) { this.json(res, 503, { error: 'Review service not configured' }); return; }
      const taskId = url.searchParams.get('taskId');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const reports = taskId
        ? this.reviewService.getReportsByTask(taskId)
        : this.reviewService.getRecentReports(limit);
      this.json(res, 200, { reports });
      return;
    }

    if (path.match(/^\/api\/reviews\/[^/]+$/) && req.method === 'GET') {
      if (!this.reviewService) { this.json(res, 503, { error: 'Review service not configured' }); return; }
      const reviewId = path.split('/')[3]!;
      const report = this.reviewService.getReport(reviewId);
      if (!report) { this.json(res, 404, { error: 'Review not found' }); return; }
      this.json(res, 200, report);
      return;
    }

    // ── External Agent Gateway ──────────────────────────────────────────────
    if (path === '/api/gateway/register' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
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
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/auth' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const body = await this.readBody(req);
      try {
        const result = this.gateway.authenticate({
          externalAgentId: body['agentId'] as string,
          orgId: body['orgId'] as string,
          secret: body['secret'] as string,
        });
        this.json(res, 200, result);
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/message' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
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
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path === '/api/gateway/status' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 503, { error: 'Gateway not configured' }); return; }
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) { this.json(res, 401, { error: 'Missing Bearer token' }); return; }
      try {
        const token = this.gateway.verifyToken(authHeader.slice(7));
        const status = this.gateway.getStatus(token);
        this.json(res, 200, status);
      } catch (err) {
        if (err instanceof GatewayError) { this.json(res, err.statusCode, { error: err.message }); return; }
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
        try { this.orgService.addMemberToTeam(teamId, userId, 'human'); } catch { /* ok */ }
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
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);
      const agent = this.orgService.getAgentManager().getAgent(targetAgentId);
      this.ws.broadcastAgentUpdate(targetAgentId, 'working');

      const stream = body['stream'] as boolean | undefined;
      if (stream) {
        const userText = body['text'] as string;
        
        // Persist user message to smart channel before LLM call so it's never lost
        if (this.storage) {
          void this.storage.channelMessageRepo.append({
            orgId: targetOrgId, channel: 'smart:default',
            senderId: senderId ?? 'anonymous', senderType: 'human',
            senderName: senderInfo?.name ?? 'You', text: userText, mentions: [],
          }).catch(err => log.warn('Failed to persist smart user message', { error: String(err) }));
        }
        
        const sseHandler = new SSEHandler({
          agentId: targetAgentId,
          agent,
          userText,
          senderId,
          senderInfo,
          onTextDelta: (_text) => {
            // Smart channels don't need WebSocket broadcast
          },
          onToolEvent: (_event) => {
            // Tool event handling hook
          },
          onComplete: async (reply, segments, tokensUsed) => {
            // 持久化助手消息
            const smartMeta = segments.length > 0 ? { segments } : undefined;
            void this.persistChatTurn(targetAgentId, userText, reply, senderId, tokensUsed, smartMeta);
            
            // Persist agent reply to smart channel
            if (this.storage) {
              void this.storage.channelMessageRepo.append({
                orgId: targetOrgId, channel: 'smart:default',
                senderId: targetAgentId, senderType: 'agent',
                senderName: agent.config.name, text: reply, mentions: [],
              }).catch(err => log.warn('Failed to persist smart agent reply', { error: String(err) }));
            }
          },
        });
        
        await sseHandler.handle(res);
      } else {
        const userText = body['text'] as string;
        // Persist user message before LLM call
        if (this.storage) {
          void this.storage.channelMessageRepo.append({
            orgId: targetOrgId, channel: 'smart:default',
            senderId: senderId ?? 'anonymous', senderType: 'human',
            senderName: senderInfo?.name ?? 'You', text: userText, mentions: [],
          }).catch(err => log.warn('Failed to persist smart user message', { error: String(err) }));
        }
        const reply = await agent.handleMessage(userText, senderId, senderInfo);
        this.json(res, 200, { reply, agentId: targetAgentId });
        void this.persistChatTurn(targetAgentId, userText, reply, senderId, agent.getState().tokensUsedToday);
        // Persist agent reply to smart channel
        if (this.storage) {
          void this.storage.channelMessageRepo.append({
            orgId: targetOrgId, channel: 'smart:default',
            senderId: targetAgentId, senderType: 'agent',
            senderName: agent.config.name, text: reply, mentions: [],
          }).catch(err => log.warn('Failed to persist smart agent reply', { error: String(err) }));
        }
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

    if (path.match(/^\/api\/skills\/[^/]+$/) && req.method === 'GET') {
      const skillName = decodeURIComponent(path.split('/')[3]!);
      if (!this.skillRegistry) { this.json(res, 404, { error: 'Skill registry not configured' }); return; }
      const skill = this.skillRegistry.get(skillName);
      if (!skill) { this.json(res, 404, { error: `Skill not found: ${skillName}` }); return; }
      const manifest = skill.manifest;
      const toolDetails = skill.tools.map(t => ({
        name: t.name, description: t.description,
        inputSchema: (t as unknown as { inputSchema?: unknown }).inputSchema,
      }));
      this.json(res, 200, { skill: { ...manifest, toolDetails } });
      return;
    }

    // Agent Templates
    if (path === '/api/templates' && req.method === 'GET') {
      if (!this.templateRegistry) { this.json(res, 200, { templates: [] }); return; }
      const source = url.searchParams.get('source') as 'official' | 'community' | 'custom' | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const text = url.searchParams.get('q') ?? undefined;
      const result = (source || category || text)
        ? this.templateRegistry.search({ source: source ?? undefined, category, text })
        : { templates: this.templateRegistry.list(), total: this.templateRegistry.list().length };
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/templates\/[^/]+$/) && req.method === 'GET') {
      if (!this.templateRegistry) { this.json(res, 404, { error: 'Template registry not configured' }); return; }
      const templateId = path.split('/')[3]!;
      const template = this.templateRegistry.get(templateId);
      if (!template) { this.json(res, 404, { error: `Template not found: ${templateId}` }); return; }
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
      if (!templateId || !name) { this.json(res, 400, { error: 'templateId and name are required' }); return; }
      try {
        const agentManager = this.orgService.getAgentManager();
        const agent = await agentManager.createAgentFromTemplate({
          templateId, name, orgId, teamId,
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
              computeConfig: agent.config.computeConfig,
              heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
            });
          } catch (persistErr) {
            log.warn('Failed to persist instantiated agent to DB', { error: String(persistErr) });
          }
        }

        await agentManager.startAgent(agent.id);
        this.json(res, 201, {
          agent: { id: agent.id, name: agent.config.name, role: agent.role.name, agentRole: agent.config.agentRole, status: agent.getState().status },
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── External Agents ─────────────────────────────────────────────────────
    if (path === '/api/external-agents' && req.method === 'GET') {
      if (!this.gateway) { this.json(res, 200, { agents: [] }); return; }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { agents: this.gateway.listRegistrations(orgId) });
      return;
    }

    if (path === '/api/external-agents/register' && req.method === 'POST') {
      if (!this.gateway) { this.json(res, 503, { error: 'External agent gateway not configured' }); return; }
      const body = await this.readBody(req);
      try {
        const reg = await this.gateway.register({
          externalAgentId: body['externalAgentId'] as string,
          agentName: body['agentName'] as string,
          orgId: (body['orgId'] as string) ?? 'default',
          capabilities: body['capabilities'] as string[] | undefined,
          openClawConfig: body['openClawConfig'] as string | undefined,
        });
        this.json(res, 201, { registration: reg });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 400;
        this.json(res, code, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/external-agents\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.gateway) { this.json(res, 503, { error: 'External agent gateway not configured' }); return; }
      const externalId = path.split('/')[3]!;
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const deleted = this.gateway.unregister(externalId, orgId);
      this.json(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'Not found' });
      return;
    }

    // ── Marketplace: Templates ────────────────────────────────────────────────
    if (path === '/api/marketplace/templates' && req.method === 'GET') {
      if (!this.storage) { this.json(res, 200, { templates: [], total: 0 }); return; }
      const source = url.searchParams.get('source') as 'official' | 'community' | 'custom' | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status') ?? 'published';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);

      const templates = q
        ? await this.storage.marketplaceTemplateRepo.search(q, { source: source ?? undefined, category, limit })
        : await this.storage.marketplaceTemplateRepo.list({ source: source ?? undefined, status, category, limit, offset });
      this.json(res, 200, { templates, total: templates.length });
      return;
    }

    if (path === '/api/marketplace/templates' && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
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
        starterTasks: body['starterTasks'] as Array<{ title: string; description: string; priority: string }> | undefined,
        config: body['config'] as Record<string, unknown> | undefined,
      });
      this.json(res, 201, { template });
      return;
    }

    if (path.match(/^\/api\/marketplace\/templates\/[^/]+$/) && !path.includes('/rate') && !path.includes('/reviews')) {
      const templateId = path.split('/')[4]!;

      if (req.method === 'GET') {
        if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
        const template = await this.storage.marketplaceTemplateRepo.findById(templateId);
        if (!template) { this.json(res, 404, { error: 'Template not found' }); return; }
        this.json(res, 200, { template });
        return;
      }

      if (req.method === 'PUT') {
        if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
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
        if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
        await this.storage.marketplaceTemplateRepo.delete(templateId);
        this.json(res, 200, { deleted: true });
        return;
      }
    }

    if (path.match(/^\/api\/marketplace\/templates\/[^/]+\/publish$/) && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
      const templateId = path.split('/')[4]!;
      await this.storage.marketplaceTemplateRepo.updateStatus(templateId, 'published');
      this.json(res, 200, { published: true });
      return;
    }

    if (path.match(/^\/api\/marketplace\/templates\/[^/]+\/install$/) && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
      const templateId = path.split('/')[4]!;
      const mktTemplate = await this.storage.marketplaceTemplateRepo.findById(templateId);
      if (!mktTemplate) { this.json(res, 404, { error: 'Template not found' }); return; }

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
          category: mktTemplate.category as 'development' | 'devops' | 'productivity' | 'management' | 'general',
          heartbeatIntervalMs: mktTemplate.heartbeatIntervalMs ?? undefined,
          starterTasks: mktTemplate.starterTasks as Array<{ title: string; description: string; priority: 'low' | 'medium' | 'high' }>,
          icon: mktTemplate.icon ?? undefined,
        });
      }
      this.json(res, 200, { installed: true, templateId });
      return;
    }

    // ── Marketplace: Skills ──────────────────────────────────────────────────
    if (path === '/api/marketplace/skills' && req.method === 'GET') {
      if (!this.storage) { this.json(res, 200, { skills: [], total: 0 }); return; }
      const source = url.searchParams.get('source') as 'official' | 'community' | 'custom' | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status') ?? 'published';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);

      const skills = q
        ? await this.storage.marketplaceSkillRepo.search(q, { source: source ?? undefined, category, limit })
        : await this.storage.marketplaceSkillRepo.list({ source: source ?? undefined, status, category, limit, offset });
      this.json(res, 200, { skills, total: skills.length });
      return;
    }

    if (path === '/api/marketplace/skills' && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
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
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
      const skillId = path.split('/')[4]!;
      const skill = await this.storage.marketplaceSkillRepo.findById(skillId);
      if (!skill) { this.json(res, 404, { error: 'Skill not found' }); return; }
      this.json(res, 200, { skill });
      return;
    }

    if (path.match(/^\/api\/marketplace\/skills\/[^/]+\/publish$/) && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
      const skillId = path.split('/')[4]!;
      await this.storage.marketplaceSkillRepo.updateStatus(skillId, 'published');
      this.json(res, 200, { published: true });
      return;
    }

    if (path.match(/^\/api\/marketplace\/skills\/[^/]+\/install$/) && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
      const skillId = path.split('/')[4]!;
      await this.storage.marketplaceSkillRepo.incrementDownloads(skillId);
      this.json(res, 200, { installed: true, skillId });
      return;
    }

    // ── Marketplace: Ratings ──────────────────────────────────────────────────
    if (path === '/api/marketplace/ratings' && req.method === 'POST') {
      if (!this.storage) { this.json(res, 503, { error: 'Database not configured' }); return; }
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

      const existing = await this.storage.marketplaceRatingRepo.findUserRating(userId, targetType, targetId);
      if (existing) {
        await this.storage.marketplaceRatingRepo.update(existing.id, { rating, review });
      } else {
        const id = generateId('rating');
        await this.storage.marketplaceRatingRepo.create({ id, targetType, targetId, userId, rating, review });
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
      if (!this.storage) { this.json(res, 200, { ratings: [] }); return; }
      const targetId = path.split('/')[4]!;
      const targetType = (url.searchParams.get('type') as 'template' | 'skill') ?? 'template';
      const ratings = await this.storage.marketplaceRatingRepo.findByTarget(targetType, targetId);
      const agg = await this.storage.marketplaceRatingRepo.getAggregation(targetType, targetId);
      this.json(res, 200, { ratings, aggregation: agg });
      return;
    }

    // ── Marketplace: Stats ────────────────────────────────────────────────────
    if (path === '/api/marketplace/stats' && req.method === 'GET') {
      if (!this.storage) { this.json(res, 200, { templates: {}, skills: {} }); return; }
      const templateCounts = await this.storage.marketplaceTemplateRepo.countBySource();
      this.json(res, 200, { templates: templateCounts });
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

    // Audit log
    if (path === '/api/audit' && req.method === 'GET') {
      if (!this.auditService) { this.json(res, 200, { entries: [] }); return; }
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
      if (!this.auditService) { this.json(res, 200, { summary: null }); return; }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const summary = this.auditService.summary(orgId);
      this.json(res, 200, { summary });
      return;
    }

    if (path === '/api/audit/tokens' && req.method === 'GET') {
      if (!this.auditService) { this.json(res, 200, { usage: [] }); return; }
      const usage = this.auditService.getTokenUsage(
        url.searchParams.get('orgId') ?? undefined,
        url.searchParams.get('agentId') ?? undefined,
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
      this.json(res, 200, this.llmRouter.getSettings());
      return;
    }

    if (path === '/api/settings/llm' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter) { this.json(res, 503, { error: 'LLM router not available' }); return; }
      const body = await this.readBody(req);
      const { defaultProvider } = body as { defaultProvider?: string };
      if (!defaultProvider) { this.json(res, 400, { error: 'defaultProvider is required' }); return; }
      try {
        this.llmRouter.setDefaultProvider(defaultProvider);
        this.json(res, 200, this.llmRouter.getSettings());
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── Workflow Engine ────────────────────────────────────────────────────
    if (path === '/api/workflows' && req.method === 'GET') {
      if (!this.workflowEngine) { this.json(res, 200, { executions: [] }); return; }
      const executions = this.workflowEngine.listExecutions().map(e => ({
        id: e.id, workflowId: e.workflowId, status: e.status,
        startedAt: e.startedAt, completedAt: e.completedAt, error: e.error,
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
          (body['inputs'] as Record<string, unknown>) ?? {},
        );
        this.json(res, 201, {
          executionId: execution.id, status: execution.status,
          outputs: execution.outputs, error: execution.error,
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'GET') {
      if (!this.workflowEngine) { this.json(res, 404, { error: 'No workflow engine' }); return; }
      const executionId = path.split('/')[3]!;
      const execution = this.workflowEngine.getExecution(executionId);
      if (!execution) { this.json(res, 404, { error: 'Execution not found' }); return; }
      const steps = [...execution.steps.entries()].map(([id, s]) => ({
        id, status: s.status, agentId: s.agentId,
        startedAt: s.startedAt, completedAt: s.completedAt,
        error: s.error, retryCount: s.retryCount,
        output: s.output,
      }));
      this.json(res, 200, { execution: { ...execution, steps } });
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'DELETE') {
      if (!this.workflowEngine) { this.json(res, 404, { error: 'No workflow engine' }); return; }
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
      const tpl = body as unknown as { id: string; name: string; description: string; version: string; author: string; members: Array<{ templateId: string; name?: string; count?: number; role?: 'manager' | 'worker' }>; tags?: string[]; category?: string };
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
      if (!tpl) { this.json(res, 404, { error: 'Team template not found' }); return; }
      this.json(res, 200, { template: tpl });
      return;
    }

    if (path.startsWith('/api/team-templates/') && req.method === 'DELETE') {
      const id = path.split('/')[3]!;
      this.teamTemplateRegistry.unregister(id);
      this.json(res, 200, { deleted: true });
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

    this.json(res, 404, { error: 'Not found' });
  }

  private buildOpsDashboard(orgId: string | undefined, period: '1h' | '24h' | '7d') {
    const taskDashboard = this.taskService.getDashboard(orgId);

    // Agent efficiency ranking with health scores
    const agentManager = this.orgService.getAgentManager();
    const allAgents = agentManager.listAgents();
    const agentRanking = allAgents.map(a => {
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
    }).sort((a, b) => b.healthScore - a.healthScore);

    // System health summary
    const healthScores = agentRanking.map(a => a.healthScore);
    const avgHealth = healthScores.length > 0
      ? Math.round(healthScores.reduce((s, h) => s + h, 0) / healthScores.length)
      : 0;
    const criticalAgents = agentRanking.filter(a => a.healthScore < 50);
    const totalTokenCost = agentRanking.reduce((s, a) => s + a.tokenUsage.cost, 0);
    const totalInteractions = agentRanking.reduce((s, a) => s + a.totalInteractions, 0);

    const taskSuccessRate = taskDashboard.totalTasks > 0
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
        criticalAgents: criticalAgents.map(a => ({ id: a.agentId, name: a.agentName, score: a.healthScore })),
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
  private resolveAgentRoleDir(agent: { config: { roleId?: string }; role: { name: string } }): string | null {
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
