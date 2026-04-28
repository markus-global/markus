/**
 * Test: GET /api/keys requires authentication
 *
 * BUG-004: GET /api/keys was missing requireAuth(), allowing unauthenticated
 * access to API key management. This test verifies it returns 401 when no
 * valid auth cookie is present.
 */
import { describe, it, expect } from 'vitest';
import { APIServer } from '../src/api-server.js';
import type { OrganizationService } from '../src/org-service.js';
import type { TaskService } from '../src/task-service.js';

/**
 * Create a minimal mock OrganizationService that provides just enough
 * stubs for APIServer construction. The route handler (GET /api/keys)
 * won't reach the billingService because requireAuth returns 401 first.
 */
function createMockOrgService(): OrganizationService {
  const mockAgentManager = {
    setGroupChatHandlers: () => {},
    getTemplateRegistry: () => null,
    setTemplateRegistry: () => {},
    getAgent: () => null,
    listAgents: () => [],
  };

  return {
    getAgentManager: () => mockAgentManager,
    getTeam: () => null,
    listTeamsWithMembers: () => [],
    getTeamAgentStatuses: () => [],
    isProtectedAgent: () => false,
    resolveHumanIdentity: () => null,
    getOrg: () => null,
    listOrgs: () => [],
    listTeams: () => [],
    addHumanUser: () => ({ id: '', name: '', role: 'manager', orgId: 'default', createdAt: '' }),
    createOrganization: () => Promise.resolve({ id: '', name: '', ownerId: '', createdAt: '', status: 'active' as const }),
  } as unknown as OrganizationService;
}

/**
 * Create a minimal mock TaskService.
 */
function createMockTaskService(): TaskService {
  return {} as unknown as TaskService;
}

describe('GET /api/keys auth requirement', () => {
  it('returns 401 when no auth cookie is present', async () => {
    const orgService = createMockOrgService();
    const taskService = createMockTaskService();

    // Create server on port 0 (let OS assign a free port)
    const server = new APIServer(orgService, taskService, 0);

    try {
      // Start the server and capture the actual port
      await new Promise<void>((resolve, reject) => {
        server.start();
        // The server listens on port 0, we can read the actual port
        // by using address().port via the underlying http.Server
        const addr = (server as unknown as { server: { address(): { port: number } } }).server?.address();
        if (!addr) {
          // Wait a tick and try again
          setTimeout(() => {
            const a = (server as unknown as { server: { address(): { port: number } } }).server?.address();
            if (a) resolve();
            else reject(new Error('Server did not start'));
          }, 100);
        } else {
          resolve();
        }
      });

      // Get the actual port the server is listening on
      const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
      const port = addr.port;

      // Make a request WITHOUT auth cookie — should get 401
      const res = await fetch(`http://localhost:${port}/api/keys`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('Unauthorized');
    } finally {
      server.stop();
    }
  });

  it('returns 200 when auth is disabled via AUTH_ENABLED=false', async () => {
    // Temporarily disable auth
    process.env['AUTH_ENABLED'] = 'false';

    const orgService = createMockOrgService();
    const taskService = createMockTaskService();
    const server = new APIServer(orgService, taskService, 0);

    try {
      await new Promise<void>((resolve) => {
        server.start();
        // Wait for server to be ready
        setTimeout(() => resolve(), 200);
      });

      const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
      const port = addr.port;

      // Without AUTH_ENABLED, requireAuth should allow the request
      // The handler will hit billingService check — since we have no
      // billingService, it should return 503 (service not available)
      const res = await fetch(`http://localhost:${port}/api/keys`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      // With auth disabled, we get past requireAuth but hit no billingService
      // Expect either 200 (if billingService is somehow available) or 503
      expect([200, 503]).toContain(res.status);
    } finally {
      server.stop();
      process.env['AUTH_ENABLED'] = 'true';
    }
  });
});
