/**
 * Token Budget Middleware - Enforces per-session and daily token limits.
 *
 * Runs before the LLM call to check remaining budget.
 * Rejects requests that would exceed limits.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:token-budget');

export interface TokenBudgetConfig {
  perSession: number;
  perDay: number;
}

export interface TokenUsageTracker {
  getSessionTokens(sessionId: string): number;
  getDailyTokens(serviceId: string): number;
}

export interface TokenBudgetLimitsResolver {
  (serviceId: string): TokenBudgetConfig;
}

export function createTokenBudgetMiddleware(
  budgetConfig: TokenBudgetConfig | TokenBudgetLimitsResolver,
  tracker: TokenUsageTracker,
): MiddlewareHandler {
  return async (ctx: ExternalContext, next) => {
    const limits = typeof budgetConfig === 'function'
      ? budgetConfig(ctx.session.serviceId)
      : budgetConfig;

    const sessionTokens = tracker.getSessionTokens(ctx.session.id);
    if (sessionTokens >= limits.perSession) {
      ctx.aborted = true;
      ctx.abortReason = 'Session token budget exhausted. Please start a new conversation.';
      ctx.audit.push({
        timestamp: new Date().toISOString(),
        type: 'rate_limit',
        action: 'reject_token_budget_session',
        success: false,
        detail: `${sessionTokens}/${limits.perSession}`,
      });
      log.info('Session token budget exceeded', { sessionId: ctx.session.id, used: sessionTokens, limit: limits.perSession });
      return;
    }

    const dailyTokens = tracker.getDailyTokens(ctx.session.serviceId);
    if (dailyTokens >= limits.perDay) {
      ctx.aborted = true;
      ctx.abortReason = 'Service daily token limit reached. Please try again tomorrow.';
      ctx.audit.push({
        timestamp: new Date().toISOString(),
        type: 'rate_limit',
        action: 'reject_token_budget_daily',
        success: false,
        detail: `${dailyTokens}/${limits.perDay}`,
      });
      log.info('Daily token budget exceeded', { serviceId: ctx.session.serviceId, used: dailyTokens, limit: limits.perDay });
      return;
    }

    ctx.audit.push({
      timestamp: new Date().toISOString(),
      type: 'rate_limit',
      action: 'token_budget_pass',
      success: true,
      metadata: { sessionTokens, dailyTokens, sessionLimit: limits.perSession, dailyLimit: limits.perDay },
    });

    await next();
  };
}
