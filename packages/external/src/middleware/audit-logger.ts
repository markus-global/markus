/**
 * Audit Logger Middleware - Records all interactions for compliance and analytics.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:audit-logger');

export interface AuditStore {
  recordInteraction(data: {
    sessionId: string;
    serviceId: string;
    agentId: string;
    participantId: string;
    inputContent: string;
    outputContent?: string;
    tokensUsed: number;
    latencyMs: number;
    toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
    auditEntries: Array<{ type: string; action: string; success: boolean; detail?: string }>;
    metadata?: Record<string, unknown>;
  }): void;
}

export function createAuditLoggerMiddleware(store?: AuditStore): MiddlewareHandler {
  return async (ctx: ExternalContext, next) => {
    const startTime = Date.now();

    await next();

    const latencyMs = Date.now() - startTime;
    const output = ctx.response;

    if (store) {
      try {
        store.recordInteraction({
          sessionId: ctx.session.id,
          serviceId: ctx.session.serviceId,
          agentId: ctx.session.agentId,
          participantId: ctx.session.participantId,
          inputContent: ctx.message.content,
          outputContent: output?.content,
          tokensUsed: output?.tokensUsed ?? 0,
          latencyMs,
          toolCalls: output?.toolCalls ?? [],
          auditEntries: ctx.audit.map(a => ({ type: a.type, action: a.action, success: a.success, detail: a.detail })),
          metadata: {
            ip: ctx.session.ipAddress,
            userAgent: ctx.session.userAgent,
            aborted: ctx.aborted,
            abortReason: ctx.abortReason,
          },
        });
      } catch (err) {
        log.error('Failed to record audit', { sessionId: ctx.session.id, error: String(err) });
      }
    }

    log.debug('Request audited', {
      sessionId: ctx.session.id,
      latencyMs,
      tokensUsed: output?.tokensUsed ?? 0,
      aborted: ctx.aborted,
    });
  };
}
