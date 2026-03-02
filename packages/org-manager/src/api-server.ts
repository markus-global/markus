import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, generateId } from '@markus/shared';
import type { SkillRegistry } from '@markus/core';
import type { OrganizationService } from './org-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import type { BillingService } from './billing-service.js';
import type { AuditService } from './audit-service.js';
import type { StorageBridge } from './storage-bridge.js';
import { WSBroadcaster } from './ws-server.js';
import { SSEBuffer } from './sse-buffer.js';
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
  private llmRouter?: import('@markus/core').LLMRouter;

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

  setLLMRouter(router: import('@markus/core').LLMRouter): void {
    this.llmRouter = router;
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
      let userMsg: import('@markus/storage').ChannelMsg | undefined;
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
      let agentMsg: import('@markus/storage').ChannelMsg | undefined;
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
      const status = url.searchParams.get('status') as import('@markus/shared').TaskStatus | undefined;
      const assignedAgentId = url.searchParams.get('assignedAgentId') ?? undefined;
      const tasks = this.taskService.listTasks({ orgId, status, assignedAgentId });
      this.json(res, 200, { tasks });
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
          priority: body['priority'] as import('@markus/shared').TaskPriority | undefined,
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
        priority: (body['priority'] as import('@markus/shared').TaskPriority) ?? 'medium',
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
          activeTaskCount: state.activeTaskCount,
          activeTaskIds: state.activeTaskIds,
          skills: agent.config.skills,
          proficiency: agent.getSkillProficiency(),
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
          onTextDelta: (text) => {
            // 智能频道不需要WebSocket广播，但可以在这里添加其他处理
          },
          onToolEvent: (event) => {
            // 处理工具事件
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
        type: (url.searchParams.get('type') as import('./audit-service.js').AuditEventType) ?? undefined,
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
