import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger } from '@markus/shared';

const log = createLogger('external-gateway');

export interface GatewayConfig {
  /** Secret used to sign tokens. Should be set via environment variable. */
  signingSecret: string;
  /** Token expiry in milliseconds. Default: 24 hours */
  tokenExpiryMs?: number;
  /** Maximum external agents per org. Default: 50 */
  maxAgentsPerOrg?: number;
}

export interface ExternalAgentRegistration {
  externalAgentId: string;
  agentName: string;
  orgId: string;
  capabilities: string[];
  openClawConfig?: string;
  registeredAt: string;
  markusAgentId?: string;
  lastHeartbeat?: string;
  connected: boolean;
}

export interface GatewayToken {
  externalAgentId: string;
  orgId: string;
  markusAgentId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface GatewayMessage {
  type: 'task' | 'status' | 'heartbeat';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayMessageResult {
  success: boolean;
  messageId: string;
  response?: string;
  error?: string;
}

/** Persistence layer for external agent registrations. */
export interface GatewayStore {
  saveRegistration(reg: ExternalAgentRegistration): Promise<void>;
  deleteRegistration(externalAgentId: string, orgId: string): Promise<boolean>;
  updateRegistration(externalAgentId: string, orgId: string, patch: Partial<Pick<ExternalAgentRegistration, 'connected' | 'lastHeartbeat'>>): Promise<void>;
  loadAll(): Promise<ExternalAgentRegistration[]>;
}

type AgentCreator = (opts: {
  name: string;
  orgId: string;
  capabilities: string[];
}) => Promise<{ id: string }>;

type MessageRouter = (
  markusAgentId: string,
  message: string,
  senderId: string,
) => Promise<string>;

type TasksFetcher = (agentId: string) => Array<{
  id: string;
  title: string;
  status: string;
  priority: string;
}>;

/**
 * External Agent Gateway v1
 *
 * Manages lifecycle of externally-registered agents:
 *   register → authenticate → send messages → get status → disconnect
 *
 * Token format: base64(payload) + "." + HMAC-SHA256(payload, secret)
 */
export class ExternalAgentGateway {
  private config: Required<GatewayConfig>;
  private registrations = new Map<string, ExternalAgentRegistration>();
  private orgAgentCounts = new Map<string, number>();

  private agentCreator?: AgentCreator;
  private messageRouter?: MessageRouter;
  private tasksFetcher?: TasksFetcher;
  private store?: GatewayStore;

  constructor(config: GatewayConfig) {
    this.config = {
      signingSecret: config.signingSecret,
      tokenExpiryMs: config.tokenExpiryMs ?? 24 * 60 * 60 * 1000,
      maxAgentsPerOrg: config.maxAgentsPerOrg ?? 50,
    };
  }

  setAgentCreator(creator: AgentCreator): void {
    this.agentCreator = creator;
  }

  setMessageRouter(router: MessageRouter): void {
    this.messageRouter = router;
  }

  setTasksFetcher(fetcher: TasksFetcher): void {
    this.tasksFetcher = fetcher;
  }

  setStore(store: GatewayStore): void {
    this.store = store;
  }

  /** Load persisted registrations from the store into memory. Call once at startup. */
  async loadFromStore(agentExists?: (markusAgentId: string) => boolean): Promise<number> {
    if (!this.store) return 0;
    const rows = await this.store.loadAll();
    for (const reg of rows) {
      const key = this.registrationKey(reg.externalAgentId, reg.orgId);
      reg.connected = false;
      this.registrations.set(key, reg);
      const count = this.orgAgentCounts.get(reg.orgId) ?? 0;
      this.orgAgentCounts.set(reg.orgId, count + 1);

      // Recreate internal Markus agent if it was lost (e.g. not in DB restore)
      if (reg.markusAgentId && agentExists && !agentExists(reg.markusAgentId) && this.agentCreator) {
        try {
          const created = await this.agentCreator({ name: reg.agentName, orgId: reg.orgId, capabilities: reg.capabilities });
          reg.markusAgentId = created.id;
          if (this.store) {
            await this.store.saveRegistration(reg);
          }
          log.info('Recreated Markus agent for external registration', { externalAgentId: reg.externalAgentId, markusAgentId: created.id });
        } catch (err) {
          log.error('Failed to recreate Markus agent for external registration', { externalAgentId: reg.externalAgentId, error: String(err) });
        }
      }
    }
    if (rows.length > 0) {
      log.info('Loaded external agent registrations from store', { count: rows.length });
    }
    return rows.length;
  }

  async register(request: {
    externalAgentId: string;
    agentName: string;
    orgId: string;
    capabilities?: string[];
    openClawConfig?: string;
  }): Promise<ExternalAgentRegistration> {
    const { externalAgentId, agentName, orgId, capabilities = [], openClawConfig } = request;

    if (!externalAgentId || !agentName || !orgId) {
      throw new GatewayError('Missing required fields: externalAgentId, agentName, orgId', 400);
    }

    const key = this.registrationKey(externalAgentId, orgId);
    if (this.registrations.has(key)) {
      throw new GatewayError(`Agent ${externalAgentId} already registered in org ${orgId}`, 409);
    }

    const orgCount = this.orgAgentCounts.get(orgId) ?? 0;
    if (orgCount >= this.config.maxAgentsPerOrg) {
      throw new GatewayError(`Org ${orgId} has reached the maximum of ${this.config.maxAgentsPerOrg} external agents`, 429);
    }

    let markusAgentId: string | undefined;
    if (this.agentCreator) {
      try {
        const created = await this.agentCreator({ name: agentName, orgId, capabilities });
        markusAgentId = created.id;
      } catch (err) {
        log.error('Failed to create Markus agent for external registration', { externalAgentId, error: String(err) });
        throw new GatewayError(`Failed to create internal agent: ${String(err)}`, 500);
      }
    }

    const registration: ExternalAgentRegistration = {
      externalAgentId,
      agentName,
      orgId,
      capabilities,
      openClawConfig,
      registeredAt: new Date().toISOString(),
      markusAgentId,
      connected: false,
    };

    this.registrations.set(key, registration);
    this.orgAgentCounts.set(orgId, orgCount + 1);

    if (this.store) {
      await this.store.saveRegistration(registration).catch(err =>
        log.error('Failed to persist registration', { externalAgentId, error: String(err) })
      );
    }

    log.info('External agent registered', { externalAgentId, orgId, markusAgentId });
    return registration;
  }

  authenticate(request: {
    externalAgentId: string;
    orgId: string;
    secret: string;
  }): { token: string; externalAgentId: string; markusAgentId: string } {
    const { externalAgentId, orgId, secret } = request;

    const key = this.registrationKey(externalAgentId, orgId);
    const registration = this.registrations.get(key);
    if (!registration) {
      throw new GatewayError(`Agent ${externalAgentId} not registered in org ${orgId}`, 404);
    }

    if (!this.verifyOrgSecret(orgId, secret)) {
      throw new GatewayError('Invalid organization secret', 401);
    }

    if (!registration.markusAgentId) {
      throw new GatewayError('Agent has no associated Markus agent ID', 500);
    }

    registration.connected = true;
    registration.lastHeartbeat = new Date().toISOString();

    if (this.store) {
      this.store.updateRegistration(externalAgentId, orgId, { connected: true, lastHeartbeat: registration.lastHeartbeat }).catch(() => {});
    }

    const tokenPayload: GatewayToken = {
      externalAgentId,
      orgId,
      markusAgentId: registration.markusAgentId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + this.config.tokenExpiryMs,
    };

    const token = this.signToken(tokenPayload);

    log.info('External agent authenticated', { externalAgentId, orgId, markusAgentId: registration.markusAgentId });
    return {
      token,
      externalAgentId,
      markusAgentId: registration.markusAgentId,
    };
  }

  resetConnectionStatus(externalAgentId: string, orgId: string): void {
    const key = this.registrationKey(externalAgentId, orgId);
    const reg = this.registrations.get(key);
    if (reg) {
      reg.connected = false;
      reg.lastHeartbeat = undefined;
      if (this.store) {
        this.store.updateRegistration(externalAgentId, orgId, { connected: false, lastHeartbeat: undefined }).catch(() => {});
      }
    }
  }

  verifyToken(token: string): GatewayToken {
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new GatewayError('Invalid token format', 401);
    }

    const [payloadB64, signature] = parts;
    const expectedSig = this.hmac(payloadB64!);

    if (!timingSafeEqual(Buffer.from(signature!, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      throw new GatewayError('Invalid token signature', 401);
    }

    let payload: GatewayToken;
    try {
      payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf-8'));
    } catch {
      throw new GatewayError('Malformed token payload', 401);
    }

    if (Date.now() > payload.expiresAt) {
      throw new GatewayError('Token expired', 401);
    }

    const key = this.registrationKey(payload.externalAgentId, payload.orgId);
    if (!this.registrations.has(key)) {
      throw new GatewayError('Agent no longer registered', 401);
    }

    return payload;
  }

  async routeMessage(
    token: GatewayToken,
    message: GatewayMessage,
  ): Promise<GatewayMessageResult> {
    const messageId = `gwmsg_${Date.now()}_${randomBytes(4).toString('hex')}`;

    const key = this.registrationKey(token.externalAgentId, token.orgId);
    const registration = this.registrations.get(key);
    if (registration) {
      registration.lastHeartbeat = new Date().toISOString();
      if (this.store) {
        this.store.updateRegistration(token.externalAgentId, token.orgId, { lastHeartbeat: registration.lastHeartbeat }).catch(() => {});
      }
    }

    if (message.type === 'heartbeat') {
      return { success: true, messageId, response: 'heartbeat_ack' };
    }

    if (!this.messageRouter) {
      throw new GatewayError('Message routing not configured', 503);
    }

    try {
      const response = await this.messageRouter(
        token.markusAgentId,
        `[${message.type.toUpperCase()}] ${message.content}`,
        token.externalAgentId,
      );
      return { success: true, messageId, response };
    } catch (err) {
      log.error('Message routing failed', { messageId, error: String(err) });
      return { success: false, messageId, error: String(err) };
    }
  }

  getStatus(token: GatewayToken): {
    connected: boolean;
    assignedTasks: Array<{ id: string; title: string; status: string; priority: string }>;
    lastHeartbeat: string;
  } {
    const key = this.registrationKey(token.externalAgentId, token.orgId);
    const registration = this.registrations.get(key);

    if (!registration) {
      throw new GatewayError('Agent not found', 404);
    }

    const tasks = this.tasksFetcher
      ? this.tasksFetcher(token.markusAgentId)
      : [];

    return {
      connected: registration.connected,
      assignedTasks: tasks,
      lastHeartbeat: registration.lastHeartbeat ?? registration.registeredAt,
    };
  }

  disconnect(externalAgentId: string, orgId: string): void {
    const key = this.registrationKey(externalAgentId, orgId);
    const registration = this.registrations.get(key);
    if (registration) {
      registration.connected = false;
      if (this.store) {
        this.store.updateRegistration(externalAgentId, orgId, { connected: false }).catch(() => {});
      }
      log.info('External agent disconnected', { externalAgentId, orgId });
    }
  }

  async unregister(externalAgentId: string, orgId: string): Promise<ExternalAgentRegistration | null> {
    const key = this.registrationKey(externalAgentId, orgId);
    const reg = this.registrations.get(key);
    if (!reg) return null;
    this.registrations.delete(key);
    const count = this.orgAgentCounts.get(orgId) ?? 1;
    this.orgAgentCounts.set(orgId, Math.max(0, count - 1));
    if (this.store) {
      await this.store.deleteRegistration(externalAgentId, orgId).catch(err =>
        log.error('Failed to delete registration from store', { externalAgentId, error: String(err) })
      );
    }
    log.info('External agent unregistered', { externalAgentId, orgId });
    return reg;
  }

  listRegistrations(orgId?: string): ExternalAgentRegistration[] {
    const all = [...this.registrations.values()];
    return orgId ? all.filter(r => r.orgId === orgId) : all;
  }

  // --- Org secret verification (pluggable, v1 uses signing secret) ---

  private orgSecrets = new Map<string, string>();

  setOrgSecret(orgId: string, secret: string): void {
    this.orgSecrets.set(orgId, secret);
  }

  private verifyOrgSecret(orgId: string, secret: string): boolean {
    const expected = this.orgSecrets.get(orgId);
    if (!expected) {
      // Fallback: accept the global signing secret for any org (v1 simplicity)
      return secret === this.config.signingSecret;
    }
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(secret));
    } catch {
      return false;
    }
  }

  // --- Token helpers ---

  private signToken(payload: GatewayToken): string {
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = this.hmac(payloadB64);
    return `${payloadB64}.${sig}`;
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.config.signingSecret).update(data).digest('hex');
  }

  private registrationKey(externalAgentId: string, orgId: string): string {
    return `${orgId}::${externalAgentId}`;
  }
}

export class GatewayError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'GatewayError';
  }
}
