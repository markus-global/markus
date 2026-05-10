/**
 * External Mode API Routes.
 *
 * These route handlers are designed to be registered in the main API server.
 * All routes are under /api/external/*.
 */
import { createLogger, type ExternalContext, type ExternalSession, type IncomingExternalMessage } from '@markus/shared';
import type { ShareManager } from '../share-manager.js';
import type { ExternalService } from '../external-service.js';

const log = createLogger('external-api');

export interface ExternalRouteContext {
  shareManager: ShareManager;
  externalService: ExternalService;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

type RouteHandler = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * Creates all external route handlers.
 */
export function createExternalRoutes(ctx: ExternalRouteContext): Map<string, { method: string; handler: RouteHandler }> {
  const routes = new Map<string, { method: string; handler: RouteHandler }>();

  // POST /api/external/share - Generate share link
  routes.set('/api/external/share', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as {
        agentId: string;
        userId: string;
        permissions?: Record<string, unknown>;
        maxUses?: number;
        expiryMs?: number;
      };

      if (!body.agentId || !body.userId) {
        return { status: 400, body: { error: 'agentId and userId are required' } };
      }

      const service = ctx.externalService.getActiveService(body.agentId);
      if (!service) {
        return { status: 404, body: { error: 'No active external service for this agent' } };
      }

      const token = ctx.shareManager.generate({
        serviceId: service.id,
        agentId: body.agentId,
        createdBy: body.userId,
        permissions: body.permissions as any,
        maxUses: body.maxUses,
        expiryMs: body.expiryMs,
      });

      return { status: 201, body: { token: token.token, id: token.id, expiresAt: token.expiresAt, shareUrl: `/ext/${token.token}` } };
    },
  });

  // GET /api/external/share/:token/info - Get agent info for UI rendering
  routes.set('/api/external/share/info', {
    method: 'GET',
    handler: async (req) => {
      const url = new URL(req.url, 'http://localhost');
      const tokenString = url.searchParams.get('token');
      if (!tokenString) {
        return { status: 400, body: { error: 'token query parameter required' } };
      }

      const validation = ctx.shareManager.validate(tokenString);
      if (!validation.valid || !validation.token) {
        return { status: 401, body: { error: validation.error ?? 'Invalid token' } };
      }

      const service = ctx.externalService.getService(validation.token.serviceId);
      if (!service) {
        return { status: 404, body: { error: 'Service not found' } };
      }

      return {
        status: 200,
        body: {
          agentId: service.agentId,
          name: service.name,
          description: service.description,
          avatarUrl: service.avatarUrl,
          welcomeMessage: service.welcomeMessage,
          inputPlaceholder: service.inputPlaceholder,
          uiMode: service.uiMode,
          uiConfig: service.uiConfig,
          permissions: validation.token.permissions,
        },
      };
    },
  });

  // POST /api/external/share/:token/session - Create new session
  routes.set('/api/external/session/create', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as {
        token: string;
        participantName?: string;
        participantMetadata?: Record<string, unknown>;
      };

      if (!body.token) {
        return { status: 400, body: { error: 'token is required' } };
      }

      const validation = ctx.shareManager.validate(body.token);
      if (!validation.valid || !validation.token) {
        return { status: 401, body: { error: validation.error ?? 'Invalid token' } };
      }

      if (!validation.token.permissions.canChat) {
        return { status: 403, body: { error: 'Token does not have chat permission' } };
      }

      try {
        const session = await ctx.externalService.createSession({
          serviceId: validation.token.serviceId,
          agentId: validation.token.agentId,
          participantId: `guest_${Date.now().toString(36)}`,
          participantType: 'human',
          participantName: body.participantName,
          participantMetadata: body.participantMetadata,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] as string | undefined,
        });

        ctx.shareManager.recordUsage(body.token);

        return { status: 201, body: { sessionId: session.id, welcomeMessage: ctx.externalService.getService(validation.token.serviceId)?.welcomeMessage } };
      } catch (err) {
        log.error('Failed to create session', { error: String(err) });
        return { status: 503, body: { error: String(err) } };
      }
    },
  });

  // POST /api/external/session/:sessionId/message - Send message
  routes.set('/api/external/session/message', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as {
        sessionId: string;
        content: string;
        token: string;
      };

      if (!body.sessionId || !body.content || !body.token) {
        return { status: 400, body: { error: 'sessionId, content, and token are required' } };
      }

      const validation = ctx.shareManager.validate(body.token);
      if (!validation.valid) {
        return { status: 401, body: { error: validation.error ?? 'Invalid token' } };
      }

      try {
        const result = await ctx.externalService.handleMessage(body.sessionId, body.content);
        return { status: 200, body: { response: result.response, tokensUsed: result.tokensUsed } };
      } catch (err) {
        if ((err as Error).message?.includes('not found')) {
          return { status: 404, body: { error: 'Session not found' } };
        }
        if ((err as Error).message?.includes('busy') || (err as Error).message?.includes('limit')) {
          return { status: 429, body: { error: String(err) } };
        }
        log.error('Message handling failed', { sessionId: body.sessionId, error: String(err) });
        return { status: 500, body: { error: 'Internal error processing message' } };
      }
    },
  });

  // GET /api/external/session/:sessionId/history - Get conversation history
  routes.set('/api/external/session/history', {
    method: 'GET',
    handler: async (req) => {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const token = url.searchParams.get('token');

      if (!sessionId || !token) {
        return { status: 400, body: { error: 'sessionId and token query parameters required' } };
      }

      const validation = ctx.shareManager.validate(token);
      if (!validation.valid) {
        return { status: 401, body: { error: validation.error ?? 'Invalid token' } };
      }

      const messages = ctx.externalService.getSessionHistory(sessionId);
      return { status: 200, body: { messages } };
    },
  });

  // POST /api/external/session/:sessionId/end - End session
  routes.set('/api/external/session/end', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as { sessionId: string; token: string };

      if (!body.sessionId || !body.token) {
        return { status: 400, body: { error: 'sessionId and token are required' } };
      }

      const validation = ctx.shareManager.validate(body.token);
      if (!validation.valid) {
        return { status: 401, body: { error: validation.error ?? 'Invalid token' } };
      }

      ctx.externalService.closeSession(body.sessionId, 'user_ended');
      return { status: 200, body: { success: true } };
    },
  });

  // --- Admin routes (require internal auth) ---

  // POST /api/external/services - Create/publish external service
  routes.set('/api/external/services', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as { agentId: string; config: Record<string, unknown> };
      if (!body.agentId) {
        return { status: 400, body: { error: 'agentId is required' } };
      }

      try {
        const service = await ctx.externalService.publishService(body.agentId, body.config);
        return { status: 201, body: service };
      } catch (err) {
        return { status: 500, body: { error: String(err) } };
      }
    },
  });

  // GET /api/external/services/:agentId - Get service config
  routes.set('/api/external/services/get', {
    method: 'GET',
    handler: async (req) => {
      const url = new URL(req.url, 'http://localhost');
      const agentId = url.searchParams.get('agentId');
      if (!agentId) {
        return { status: 400, body: { error: 'agentId required' } };
      }

      const service = ctx.externalService.getActiveService(agentId);
      if (!service) {
        return { status: 404, body: { error: 'No active external service' } };
      }

      return { status: 200, body: service };
    },
  });

  // PATCH /api/external/services/:id/status - Update service status
  routes.set('/api/external/services/status', {
    method: 'POST',
    handler: async (req) => {
      const body = req.body as { serviceId: string; status: string };
      if (!body.serviceId || !body.status) {
        return { status: 400, body: { error: 'serviceId and status are required' } };
      }

      try {
        ctx.externalService.updateServiceStatus(body.serviceId, body.status as any);
        return { status: 200, body: { success: true } };
      } catch (err) {
        return { status: 500, body: { error: String(err) } };
      }
    },
  });

  // GET /api/external/services/:id/stats - Get service stats
  routes.set('/api/external/services/stats', {
    method: 'GET',
    handler: async (req) => {
      const url = new URL(req.url, 'http://localhost');
      const serviceId = url.searchParams.get('serviceId');
      if (!serviceId) {
        return { status: 400, body: { error: 'serviceId required' } };
      }

      const stats = ctx.externalService.getServiceStats(serviceId);
      return { status: 200, body: stats };
    },
  });

  return routes;
}
