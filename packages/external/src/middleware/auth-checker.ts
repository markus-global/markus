/**
 * Auth Checker Middleware - Validates token and session state.
 *
 * Ensures the share token is still valid and the session is active
 * before allowing the request to proceed.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:auth-checker');

export interface AuthValidator {
  isTokenValid(token: string): boolean;
  isSessionActive(sessionId: string): boolean;
  getSessionServiceId(sessionId: string): string | undefined;
}

export function createAuthCheckerMiddleware(validator: AuthValidator): MiddlewareHandler {
  return async (ctx: ExternalContext, next) => {
    if (!ctx.session.id) {
      ctx.aborted = true;
      ctx.abortReason = 'No session provided';
      ctx.audit.push({ timestamp: new Date().toISOString(), type: 'auth', action: 'reject_no_session', success: false });
      return;
    }

    if (!validator.isSessionActive(ctx.session.id)) {
      ctx.aborted = true;
      ctx.abortReason = 'Session expired or closed';
      ctx.audit.push({ timestamp: new Date().toISOString(), type: 'auth', action: 'reject_session_inactive', success: false });
      log.debug('Auth rejected: inactive session', { sessionId: ctx.session.id });
      return;
    }

    const serviceId = validator.getSessionServiceId(ctx.session.id);
    if (serviceId && serviceId !== ctx.session.serviceId) {
      ctx.aborted = true;
      ctx.abortReason = 'Session-service mismatch';
      ctx.audit.push({ timestamp: new Date().toISOString(), type: 'auth', action: 'reject_service_mismatch', success: false });
      log.warn('Auth rejected: service mismatch', { sessionId: ctx.session.id });
      return;
    }

    ctx.audit.push({ timestamp: new Date().toISOString(), type: 'auth', action: 'pass', success: true });
    await next();
  };
}
