/**
 * SessionPool - Manages concurrent external sessions with semaphore control.
 *
 * Limits active LLM calls (not just session count), handles session lifecycle,
 * and auto-expires idle sessions.
 */
import { createLogger, type ExternalServiceConfig, type ExternalSession } from '@markus/shared';
import { SessionWorker, type LLMRouterLike, type ContextEngineLike, type ToolHandler, type SessionMessageStore } from './session-worker.js';
import type { SessionWorkerConfig } from './types.js';

const log = createLogger('session-pool');

export interface SessionPoolConfig {
  maxConcurrentActive: number;
  sessionTimeoutMs: number;
  cleanupIntervalMs: number;
}

interface ManagedSession {
  worker: SessionWorker;
  session: ExternalSession;
  lastActivity: number;
}

export class SessionPool {
  private sessions = new Map<string, ManagedSession>();
  private activeCount = 0;
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private poolConfig: SessionPoolConfig,
    private llmRouter: LLMRouterLike,
    private contextEngine: ContextEngineLike,
    private toolsFactory: (serviceConfig: ExternalServiceConfig) => Map<string, ToolHandler>,
    private messageStore: SessionMessageStore,
    private onSessionExpired?: (sessionId: string) => void,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), poolConfig.cleanupIntervalMs);
  }

  get stats() {
    return {
      totalSessions: this.sessions.size,
      activeCalls: this.activeCount,
      maxConcurrent: this.poolConfig.maxConcurrentActive,
      waitQueueLength: this.waitQueue.length,
    };
  }

  /**
   * Create a new session and its worker.
   */
  createSession(
    session: ExternalSession,
    serviceConfig: ExternalServiceConfig,
    systemPrompt: string,
  ): SessionWorker {
    if (this.stopped) {
      throw new Error('Session pool is stopped');
    }

    const workerConfig: SessionWorkerConfig = {
      serviceId: serviceConfig.id,
      sessionId: session.id,
      systemPrompt,
      maxIterations: 20,
      tokenBudget: serviceConfig.tokenBudgetPerSession,
      toolNames: this.getToolNames(serviceConfig),
    };

    const tools = this.toolsFactory(serviceConfig);
    const worker = new SessionWorker(workerConfig, this.llmRouter, this.contextEngine, tools, this.messageStore);

    this.sessions.set(session.id, {
      worker,
      session,
      lastActivity: Date.now(),
    });

    log.debug('Session created in pool', { sessionId: session.id, totalSessions: this.sessions.size });
    return worker;
  }

  /**
   * Get an existing session's worker.
   */
  getWorker(sessionId: string): SessionWorker | undefined {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.lastActivity = Date.now();
    }
    return managed?.worker;
  }

  /**
   * Acquire a concurrency slot before processing a message.
   * Returns when a slot is available; throws if pool is stopped.
   */
  async acquireSlot(): Promise<void> {
    if (this.stopped) throw new Error('Session pool is stopped');

    if (this.activeCount < this.poolConfig.maxConcurrentActive) {
      this.activeCount++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  /**
   * Release a concurrency slot after processing completes.
   */
  releaseSlot(): void {
    this.activeCount--;

    if (this.waitQueue.length > 0 && this.activeCount < this.poolConfig.maxConcurrentActive) {
      const next = this.waitQueue.shift()!;
      this.activeCount++;
      next.resolve();
    }
  }

  /**
   * Check if a new session can be created (under max concurrent limit for total sessions).
   */
  canAcceptSession(maxSessions: number): boolean {
    return this.sessions.size < maxSessions && !this.stopped;
  }

  /**
   * Remove a session from the pool.
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.debug('Session removed from pool', { sessionId, totalSessions: this.sessions.size });
  }

  /**
   * Stop the pool and reject all waiting requests.
   */
  stop(): void {
    this.stopped = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const waiter of this.waitQueue) {
      waiter.reject(new Error('Session pool stopped'));
    }
    this.waitQueue = [];

    log.info('Session pool stopped', { remainingSessions: this.sessions.size });
  }

  private cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, managed] of this.sessions) {
      if (now - managed.lastActivity > this.poolConfig.sessionTimeoutMs) {
        if (!managed.worker.isActive) {
          expired.push(sessionId);
        }
      }
    }

    for (const sessionId of expired) {
      this.sessions.delete(sessionId);
      this.onSessionExpired?.(sessionId);
      log.debug('Session expired and removed', { sessionId });
    }

    if (expired.length > 0) {
      log.info('Cleanup: expired sessions removed', { count: expired.length, remaining: this.sessions.size });
    }
  }

  private getToolNames(config: ExternalServiceConfig): string[] {
    if (config.toolPolicy.allow) return config.toolPolicy.allow;
    return [];
  }
}
