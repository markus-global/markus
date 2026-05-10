/**
 * Feedback Middleware - Post-session rating and evaluation collection.
 *
 * Captures user satisfaction data at session end for analytics
 * and agent improvement.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:feedback');

export interface FeedbackEntry {
  sessionId: string;
  serviceId: string;
  agentId: string;
  participantId: string;
  rating?: number;
  comment?: string;
  tags?: string[];
  createdAt: string;
}

export interface FeedbackStore {
  saveFeedback(entry: FeedbackEntry): void;
  getAverageRating(serviceId: string, days?: number): Promise<number>;
}

export interface FeedbackConfig {
  store: FeedbackStore;
  /** Whether feedback is mandatory before session end */
  required: boolean;
  /** Rating scale (default 5) */
  scale: number;
}

export function createFeedbackMiddleware(config: FeedbackConfig): MiddlewareHandler {
  return async (ctx: ExternalContext, next) => {
    await next();

    const feedback = ctx.state['feedback'] as { rating?: number; comment?: string; tags?: string[] } | undefined;
    if (feedback) {
      const entry: FeedbackEntry = {
        sessionId: ctx.session.id,
        serviceId: ctx.session.serviceId,
        agentId: ctx.session.agentId,
        participantId: ctx.session.participantId,
        rating: feedback.rating,
        comment: feedback.comment,
        tags: feedback.tags,
        createdAt: new Date().toISOString(),
      };

      try {
        config.store.saveFeedback(entry);
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'custom', action: 'feedback_saved', success: true, metadata: { rating: feedback.rating } });
        log.debug('Feedback saved', { sessionId: ctx.session.id, rating: feedback.rating });
      } catch (err) {
        log.error('Failed to save feedback', { sessionId: ctx.session.id, error: String(err) });
      }
    }
  };
}
