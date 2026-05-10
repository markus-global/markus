/**
 * ExternalService - Main orchestrator for external mode.
 *
 * Manages the lifecycle of external services: publishing, session creation,
 * message handling, and session cleanup.
 */
import { createLogger, type ExternalServiceConfig, type ExternalSession, type ExternalMessage, type ExternalServiceStatus, type ExternalContext, type IncomingExternalMessage } from '@markus/shared';
import { SessionPool, type SessionPoolConfig } from './session-pool.js';
import { MiddlewarePipeline, createSecurityGateMiddleware, createRateLimiterMiddleware, createAuditLoggerMiddleware, createContentFilterMiddleware, createTokenBudgetMiddleware, createAuthCheckerMiddleware, createPaymentMiddleware, createFileUploadMiddleware, createFeedbackMiddleware, LLMModerationService, createInputModerationHook, createOutputModerationHook } from './middleware/index.js';
import type { LLMRouterLike, ContextEngineLike, ToolHandler } from './session-worker.js';
import type { StreamCallback } from './types.js';

const log = createLogger('external-service');

export interface ExternalServiceStore {
  create(data: Omit<ExternalServiceConfig, 'id' | 'createdAt' | 'updatedAt'>): ExternalServiceConfig;
  findById(id: string): ExternalServiceConfig | undefined;
  findActiveByAgentId(agentId: string): ExternalServiceConfig | undefined;
  findByAgentId(agentId: string): ExternalServiceConfig | undefined;
  listAll(): ExternalServiceConfig[];
  updateStatus(id: string, status: ExternalServiceStatus): void;
  update(id: string, patch: Partial<ExternalServiceConfig>): void;
}

export interface ExternalSessionStore {
  create(data: { serviceId: string; agentId: string; participantId: string; participantType: 'human' | 'agent'; participantName?: string; participantMetadata?: Record<string, unknown>; ipAddress?: string; userAgent?: string }): ExternalSession;
  findById(id: string): ExternalSession | undefined;
  countActive(serviceId: string): number;
  updateActivity(id: string, messageCount: number, tokensUsed: number): void;
  close(id: string, reason: ExternalSession['closeReason']): void;
  expireInactive(serviceId: string, timeoutMs: number): number;
  totalTokensByService(serviceId: string): number;
}

export interface ExternalMessageStore {
  create(data: { sessionId: string; role: string; content: string; tokens?: number; metadata?: Record<string, unknown> }): ExternalMessage;
  listBySession(sessionId: string, limit?: number): ExternalMessage[];
  countBySession(sessionId: string): number;
  tokensBySession(sessionId: string): number;
}

export interface SnapshotProvider {
  /** Get the agent's base persona data */
  getPersona(agentId: string, snapshotId: string): PersonaSnapshot | undefined;
  /** Get domain knowledge context for the agent */
  getKnowledgeContext(agentId: string, snapshotId: string): string | undefined;
  /** Get custom service instructions (set by the agent creator) */
  getCustomInstructions(agentId: string, snapshotId: string): string | undefined;
}

import { buildExternalSystemPrompt, buildFallbackExternalPrompt, type PersonaSnapshot } from './prompt-builder.js';

export interface ExternalServiceDeps {
  serviceStore: ExternalServiceStore;
  sessionStore: ExternalSessionStore;
  messageStore: ExternalMessageStore;
  llmRouter: LLMRouterLike;
  contextEngine: ContextEngineLike;
  toolsFactory: (serviceConfig: ExternalServiceConfig) => Map<string, ToolHandler>;
  snapshotProvider: SnapshotProvider;
  migrateShareTokens?: (oldServiceId: string, newServiceId: string) => number;
}

export class ExternalService {
  private pools = new Map<string, SessionPool>();
  private middleware: MiddlewarePipeline;
  private deps: ExternalServiceDeps;
  private moderationService: LLMModerationService;

  constructor(deps: ExternalServiceDeps) {
    this.deps = deps;
    this.middleware = new MiddlewarePipeline();

    // LLM moderation service — independent from agent's LLM, used for both input and output checks
    this.moderationService = new LLMModerationService(deps.llmRouter, {
      failMode: 'open',
      timeoutMs: 5000,
      safetyThreshold: 0.7,
    });

    // Register built-in middlewares with LLM moderation wired in
    this.middleware.register('security-gate', createSecurityGateMiddleware({
      maxMessageLength: 4000,
      blockedPatterns: [],
      allowFileUpload: false,
      moderationHook: createInputModerationHook(this.moderationService),
      moderationMode: 'sync',
      configResolver: (serviceId) => {
        const svc = this.deps.serviceStore.findById(serviceId);
        return svc?.inputValidation;
      },
    }));
    this.middleware.register('rate-limiter', createRateLimiterMiddleware());
    this.middleware.register('audit-logger', createAuditLoggerMiddleware({
      recordInteraction: (data) => {
        this.deps.messageStore.create({
          sessionId: data.sessionId,
          role: 'system',
          content: JSON.stringify({
            type: 'audit',
            latencyMs: data.latencyMs,
            tokensUsed: data.tokensUsed,
            toolCalls: data.toolCalls.length,
            aborted: data.metadata?.aborted,
            abortReason: data.metadata?.abortReason,
            auditEntries: data.auditEntries,
          }),
          metadata: { type: 'audit', latencyMs: data.latencyMs },
        });
      },
    }));
    this.middleware.register('content-filter', createContentFilterMiddleware({
      enabled: true,
      outputModerationHook: createOutputModerationHook(this.moderationService),
    }));
    this.middleware.register('token-budget', createTokenBudgetMiddleware(
      (serviceId) => {
        const svc = this.deps.serviceStore.findById(serviceId);
        return {
          perSession: svc?.tokenBudgetPerSession ?? 50000,
          perDay: svc?.tokenBudgetPerDay ?? 500000,
        };
      },
      {
        getSessionTokens: (sessionId) => {
          const session = this.deps.sessionStore.findById(sessionId);
          return session?.tokensUsed ?? 0;
        },
        getDailyTokens: (serviceId) => {
          return this.deps.sessionStore.totalTokensByService(serviceId);
        },
      },
    ));
    this.middleware.register('auth-checker', createAuthCheckerMiddleware({
      isTokenValid: () => true,
      isSessionActive: (sessionId) => {
        const s = this.deps.sessionStore.findById(sessionId);
        return s?.status === 'active';
      },
      getSessionServiceId: (sessionId) => {
        const s = this.deps.sessionStore.findById(sessionId);
        return s?.serviceId;
      },
    }));
    this.middleware.register('payment', createPaymentMiddleware({
      mode: 'per_message',
      currency: 'USD',
      amountPerMessage: 0,
      provider: { checkBalance: async () => ({ sufficient: true, balance: 0 }), charge: async () => ({ success: true }), refund: async () => true },
    }));
    this.middleware.register('file-upload', createFileUploadMiddleware({
      maxFileSizeBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/*', 'application/pdf', 'text/*'],
      maxFilesPerMessage: 5,
      storageProvider: { generateUploadUrl: async () => ({ uploadUrl: '', downloadUrl: '', fileId: '' }), deleteFile: async () => {} },
    }));
    this.middleware.register('feedback', createFeedbackMiddleware({
      store: { saveFeedback: () => {}, getAverageRating: async () => 0 },
      required: false,
      scale: 5,
    }));
  }

  /**
   * Publish a new external service version for an agent.
   */
  async publishService(agentId: string, overrides?: Record<string, unknown>): Promise<ExternalServiceConfig> {
    const existing = this.deps.serviceStore.findByAgentId(agentId);
    const version = existing ? existing.version + 1 : 1;

    const config: Omit<ExternalServiceConfig, 'id' | 'createdAt' | 'updatedAt'> = {
      agentId,
      snapshotId: `snap_${agentId}_v${version}`,
      version,
      status: 'active',
      name: (overrides?.['name'] as string) ?? `Agent Service v${version}`,
      description: overrides?.['description'] as string | undefined,
      avatarUrl: overrides?.['avatarUrl'] as string | undefined,
      maxConcurrentSessions: (overrides?.['maxConcurrentSessions'] as number) ?? 10,
      sessionTimeoutMs: (overrides?.['sessionTimeoutMs'] as number) ?? 1800000,
      maxMessagesPerSession: (overrides?.['maxMessagesPerSession'] as number) ?? 100,
      toolPolicy: (overrides?.['toolPolicy'] as any) ?? { profile: 'external', deny: [] },
      inputValidation: (overrides?.['inputValidation'] as any) ?? { maxMessageLength: 4000, blockedPatterns: [], allowFileUpload: false },
      contentFilter: (overrides?.['contentFilter'] as any) ?? { enabled: true },
      tokenBudgetPerSession: (overrides?.['tokenBudgetPerSession'] as number) ?? 50000,
      tokenBudgetPerDay: (overrides?.['tokenBudgetPerDay'] as number) ?? 500000,
      uiMode: (overrides?.['uiMode'] as 'default' | 'custom') ?? 'default',
      uiConfig: overrides?.['uiConfig'] as any,
      middlewares: (overrides?.['middlewares'] as any) ?? [
        { name: 'auth-checker', enabled: true, phase: 'pre', priority: 5, config: {} },
        { name: 'security-gate', enabled: true, phase: 'pre', priority: 0, config: {} },
        { name: 'rate-limiter', enabled: true, phase: 'pre', priority: 10, config: {} },
        { name: 'token-budget', enabled: true, phase: 'pre', priority: 20, config: {} },
        { name: 'audit-logger', enabled: true, phase: 'both', priority: 100, config: {} },
        { name: 'content-filter', enabled: true, phase: 'post', priority: 90, config: {} },
      ],
      welcomeMessage: overrides?.['welcomeMessage'] as string | undefined,
      inputPlaceholder: overrides?.['inputPlaceholder'] as string | undefined,
      publishedAt: new Date().toISOString(),
    };

    if (existing) {
      this.deps.serviceStore.updateStatus(existing.id, 'archived');
      this.destroyPool(existing.id);
    }

    const service = this.deps.serviceStore.create(config);

    if (existing && this.deps.migrateShareTokens) {
      const migrated = this.deps.migrateShareTokens(existing.id, service.id);
      if (migrated > 0) {
        log.info('Migrated share tokens to new service', { oldServiceId: existing.id, newServiceId: service.id, count: migrated });
      }
    }

    this.ensurePool(service);

    log.info('External service published', { agentId, serviceId: service.id, version });
    return service;
  }

  /**
   * Get the active service for an agent.
   */
  getActiveService(agentId: string): ExternalServiceConfig | undefined {
    return this.deps.serviceStore.findActiveByAgentId(agentId);
  }

  /**
   * Get a service by ID.
   */
  getService(serviceId: string): ExternalServiceConfig | undefined {
    return this.deps.serviceStore.findById(serviceId);
  }

  /**
   * Update a service's status.
   */
  updateServiceStatus(serviceId: string, status: ExternalServiceStatus): void {
    this.deps.serviceStore.updateStatus(serviceId, status);
    if (status === 'paused' || status === 'archived') {
      this.destroyPool(serviceId);
    }
  }

  /**
   * Create a new external session.
   */
  async createSession(data: {
    serviceId: string;
    agentId: string;
    participantId: string;
    participantType: 'human' | 'agent';
    participantName?: string;
    participantMetadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<ExternalSession> {
    const service = this.deps.serviceStore.findById(data.serviceId);
    if (!service || service.status !== 'active') {
      throw new Error('Service not found or not active');
    }

    const pool = this.ensurePool(service);
    if (!pool.canAcceptSession(service.maxConcurrentSessions)) {
      throw new Error('Service is at maximum capacity. Please try again later.');
    }

    const session = this.deps.sessionStore.create(data);

    const systemPrompt = this.buildSystemPrompt(service);
    pool.createSession(session, service, systemPrompt);

    log.debug('External session created', { sessionId: session.id, serviceId: service.id });
    return session;
  }

  /**
   * Handle an incoming message in an external session.
   */
  async handleMessage(sessionId: string, content: string, onStream?: StreamCallback, signal?: AbortSignal): Promise<{
    response: string;
    tokensUsed: number;
  }> {
    const session = this.deps.sessionStore.findById(sessionId);
    if (!session || session.status !== 'active') {
      throw new Error('Session not found or not active');
    }

    const service = this.deps.serviceStore.findById(session.serviceId);
    if (!service || service.status !== 'active') {
      throw new Error('Service not available');
    }

    if (session.messageCount >= service.maxMessagesPerSession) {
      this.closeSession(sessionId, 'message_limit');
      throw new Error('Session message limit reached');
    }

    if (session.tokensUsed >= service.tokenBudgetPerSession) {
      this.closeSession(sessionId, 'token_limit');
      throw new Error('Session token budget exhausted');
    }

    const pool = this.ensurePool(service);
    const worker = pool.getWorker(sessionId);
    if (!worker) {
      throw new Error('Session worker not found');
    }

    const ctx: ExternalContext = {
      session,
      message: { content },
      state: {},
      audit: [],
      startedAt: Date.now(),
      aborted: false,
    };

    if (signal?.aborted) {
      throw new Error('Request aborted by client');
    }

    const composedMiddleware = this.middleware.compose(service.middlewares);

    let result = { response: '', tokensUsed: 0 };

    await composedMiddleware(ctx, async () => {
      if (ctx.aborted || signal?.aborted) return;

      await pool.acquireSlot();
      try {
        const wrappedStream: StreamCallback | undefined = onStream
          ? (event) => { if (!signal?.aborted) onStream(event); }
          : undefined;
        const workerResult = await worker.handleMessage(content, wrappedStream);
        result = { response: workerResult.response, tokensUsed: workerResult.tokensUsed };
        ctx.response = {
          content: workerResult.response,
          streaming: false,
          toolCalls: workerResult.toolCalls,
          tokensUsed: workerResult.tokensUsed,
          latencyMs: Date.now() - ctx.startedAt,
        };
      } finally {
        pool.releaseSlot();
      }
    });

    if (ctx.aborted) {
      throw new Error(ctx.abortReason ?? 'Request blocked by middleware');
    }

    if (signal?.aborted) {
      throw new Error('Request aborted by client');
    }

    // SessionWorker already persists user + assistant messages via SessionMessageStore.
    // Use the actual counts from the store to avoid drift.
    const actualCount = this.deps.messageStore.countBySession(sessionId);
    const actualTokens = this.deps.messageStore.tokensBySession(sessionId);
    this.deps.sessionStore.updateActivity(sessionId, actualCount, actualTokens);

    return { response: ctx.response?.content ?? result.response, tokensUsed: result.tokensUsed };
  }

  /**
   * Close a session.
   */
  closeSession(sessionId: string, reason: ExternalSession['closeReason']): void {
    const session = this.deps.sessionStore.findById(sessionId);
    if (!session) return;

    this.deps.sessionStore.close(sessionId, reason);

    const pool = this.pools.get(session.serviceId);
    pool?.removeSession(sessionId);

    log.debug('External session closed', { sessionId, reason });
  }

  /**
   * Get session history.
   */
  getSessionHistory(sessionId: string): ExternalMessage[] {
    return this.deps.messageStore.listBySession(sessionId);
  }

  /**
   * Get service stats.
   */
  getServiceStats(serviceId: string) {
    const pool = this.pools.get(serviceId);
    return {
      poolStats: pool?.stats ?? null,
      activeSessions: this.deps.sessionStore.countActive(serviceId),
    };
  }

  /**
   * Get the middleware pipeline for external registration.
   */
  getMiddlewarePipeline(): MiddlewarePipeline {
    return this.middleware;
  }

  /**
   * Stop all pools (graceful shutdown).
   */
  stop(): void {
    for (const pool of this.pools.values()) {
      pool.stop();
    }
    this.pools.clear();
    log.info('External service stopped');
  }

  private ensurePool(service: ExternalServiceConfig): SessionPool {
    let pool = this.pools.get(service.id);
    if (!pool) {
      const poolConfig: SessionPoolConfig = {
        maxConcurrentActive: service.maxConcurrentSessions,
        sessionTimeoutMs: service.sessionTimeoutMs,
        cleanupIntervalMs: 60_000,
      };

      pool = new SessionPool(
        poolConfig,
        this.deps.llmRouter,
        this.deps.contextEngine,
        this.deps.toolsFactory,
        {
          loadMessages: async (sessionId) => {
            const msgs = this.deps.messageStore.listBySession(sessionId);
            return msgs.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));
          },
          appendMessage: async (sessionId, message, tokens) => {
            this.deps.messageStore.create({ sessionId, role: message.role, content: typeof message.content === 'string' ? message.content : '', tokens });
          },
          getMessageCount: async (sessionId) => this.deps.messageStore.countBySession(sessionId),
          getTokensUsed: async (sessionId) => this.deps.messageStore.tokensBySession(sessionId),
        },
        (sessionId) => {
          this.deps.sessionStore.close(sessionId, 'timeout');
          log.debug('Session expired by pool', { sessionId });
        },
      );

      this.pools.set(service.id, pool);
    }
    return pool;
  }

  private destroyPool(serviceId: string): void {
    const pool = this.pools.get(serviceId);
    if (pool) {
      pool.stop();
      this.pools.delete(serviceId);
    }
  }

  /**
   * Build the system prompt for an external session.
   * Uses the PromptBuilder to wrap the agent's persona with external-mode
   * awareness, safety constraints, and knowledge context.
   */
  private buildSystemPrompt(service: ExternalServiceConfig): string {
    const persona = this.deps.snapshotProvider.getPersona(service.agentId, service.snapshotId);
    if (!persona) {
      log.warn('No persona snapshot found, using fallback prompt', { agentId: service.agentId });
      return buildFallbackExternalPrompt(service.name);
    }

    const knowledgeContext = this.deps.snapshotProvider.getKnowledgeContext(service.agentId, service.snapshotId);
    const customInstructions = this.deps.snapshotProvider.getCustomInstructions(service.agentId, service.snapshotId)
      ?? service.description;

    return buildExternalSystemPrompt({
      persona,
      service,
      knowledgeContext,
      customInstructions,
    });
  }
}
