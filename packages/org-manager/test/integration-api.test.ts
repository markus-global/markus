/**
 * Integration API: /api/settings/integrations/feishu endpoints
 *
 * Tests the 6 route handlers for Feishu integration configuration:
 * - GET  /api/settings/integrations/feishu              — read config
 * - POST /api/settings/integrations/feishu              — save config
 * - DELETE /api/settings/integrations/feishu            — delete config
 * - POST /api/settings/integrations/feishu/test         — test credentials
 * - GET  /api/settings/integrations/feishu/notifications  — read rules
 * - PUT  /api/settings/integrations/feishu/notifications  — update rules
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { APIServer } from '../src/api-server.js';
import type { OrganizationService } from '../src/org-service.js';
import type { TaskService } from '../src/task-service.js';
import type { StorageBridge } from '../src/storage-bridge.js';

/** Number of milliseconds to wait for the server to be ready */
const SERVER_WAIT_MS = 300;

/** Create a mock OrganizationService with minimal stubs */
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

/** Create a minimal mock TaskService */
function createMockTaskService(): TaskService {
  return {} as unknown as TaskService;
}

/** Create a mock in-memory IntegrationRepo */
function createMockIntegrationRepo() {
  const store = new Map<string, Record<string, unknown>>();

  return {
    create: async (data: Record<string, unknown>) => {
      const id = (data['id'] as string) ?? 'test';
      const now = new Date().toISOString();
      const row = {
        id,
        orgId: data['orgId'] as string,
        platform: data['platform'] as string,
        displayName: data['displayName'] as string,
        enabled: (data['enabled'] as boolean) ? 1 : 0,
        config: data['config'] as Record<string, unknown>,
        forwardRules: (data['forwardRules'] ?? []) as Record<string, unknown>[],
        lastVerifiedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, row);
      return row;
    },
    findById: (id: string) => store.get(id),
    listByOrg: (orgId: string) =>
      Array.from(store.values()).filter(r => r['orgId'] === orgId),
    listByPlatform: (orgId: string, platform: string) =>
      Array.from(store.values()).filter(r => r['orgId'] === orgId && r['platform'] === platform),
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) {
        store.set(id, { ...existing, ...data, updatedAt: new Date().toISOString() });
      }
    },
    delete: async (id: string) => {
      store.delete(id);
    },
  };
}

/** Create a mock StorageBridge with integrationRepo */
function createMockStorage(repo?: ReturnType<typeof createMockIntegrationRepo>): StorageBridge {
  const integrationRepo = repo ?? createMockIntegrationRepo();
  return {
    orgRepo: {},
    taskRepo: {},
    integrationRepo,
  } as unknown as StorageBridge;
}

/** Start server and return the port it's listening on */
async function startServer(server: APIServer): Promise<number> {
  server.start();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), SERVER_WAIT_MS));
  const addr = (server as unknown as { server: { address(): { port: number } } }).server?.address();
  return addr?.port ?? 0;
}

describe('Integration Config API (Feishu)', () => {
  // ── Auth Bypass — set AUTH_ENABLED=false so route logic is testable ─────────
  // When AUTH_ENABLED is not 'false', getAuthUser checks JWT token cookie.
  // We disable it here so tests can exercise the actual route handlers.
  const origEnv = process.env['AUTH_ENABLED'];

  let server: APIServer;
  let integrationRepo: ReturnType<typeof createMockIntegrationRepo>;
  let port: number;
  const baseHeaders = { 'Content-Type': 'application/json' };

  beforeEach(() => {
    process.env['AUTH_ENABLED'] = 'false';
  });

  afterEach(() => {
    server?.stop();
    process.env['AUTH_ENABLED'] = origEnv;
  });

  // ── 401 auth check tests (auth enabled) ──────────────────────────────────────
  describe('auth — 401 without valid token', () => {
    beforeEach(() => {
      // Restore env so auth is enforced
      if (origEnv === undefined) {
        delete process.env['AUTH_ENABLED'];
      } else {
        process.env['AUTH_ENABLED'] = origEnv;
      }
    });

    beforeEach(async () => {
      integrationRepo = createMockIntegrationRepo();
      const mockStorage = createMockStorage(integrationRepo);
      const orgService = createMockOrgService();
      const taskService = createMockTaskService();
      server = new APIServer(orgService, taskService, 0);
      server.setStorage(mockStorage);
      port = await startServer(server);
    });

    it('GET returns 401 without auth', async () => {
      const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
        method: 'GET',
        headers: baseHeaders,
      });
      expect(res.status).toBe(401);
    });

    it('POST returns 401 without auth', async () => {
      const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ appId: 'a', appSecret: 'b' }),
      });
      expect(res.status).toBe(401);
    });

    it('DELETE returns 401 without auth', async () => {
      const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
        method: 'DELETE',
        headers: baseHeaders,
      });
      expect(res.status).toBe(401);
    });
  });

  // ── Actual route handler tests (auth bypassed) ──────────────────────────────
  describe('route handlers', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'markus-test-'));
      configPath = join(tmpDir, 'markus.json');
      writeFileSync(configPath, JSON.stringify({}));

      integrationRepo = createMockIntegrationRepo();
      const mockStorage = createMockStorage(integrationRepo);
      const orgService = createMockOrgService();
      const taskService = createMockTaskService();
      server = new APIServer(orgService, taskService, 0);
      server.setStorage(mockStorage);
      server.setConfigPath(configPath);
      port = await startServer(server);
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    });

    describe('GET /api/settings/integrations/feishu', () => {
      it('returns config when one exists', async () => {
        // Credentials in markus.json (single source of truth)
        writeFileSync(configPath, JSON.stringify({ integrations: { feishu: { appId: 'cli_a1111', appSecret: 'xxx' } } }));
        // Runtime prefs in SQLite
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { notifyChatId: 'oc_123' },
        });

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'GET',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['appId']).toBe('cli_a1111');
        expect(body['appSecret']).toBe('xxx');
        expect(body['enabled']).toBe(true);
        expect(body['notifyChatId']).toBe('oc_123');
      });

      it('returns null config when none exists', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'GET',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['appId']).toBe('');
        expect(body['enabled']).toBe(false);
      });
    });

    describe('POST /api/settings/integrations/feishu', () => {
      it('returns 400 when appId or appSecret missing', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({ appId: '' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as Record<string, unknown>;
        expect(body['error']).toContain('required');
      });

      it('creates a new config when none exists', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({ appId: 'cli_a2222', appSecret: 'secret123' }),
        });
        expect(res.status).toBe(200);
        // Runtime prefs stored in SQLite (no credentials)
        const rows = integrationRepo.listByPlatform('default', 'feishu');
        expect(rows).toHaveLength(1);
        expect((rows[0]['config'] as Record<string, unknown>)['appId']).toBeUndefined();
        // Credentials stored in markus.json
        const { readFileSync } = await import('fs');
        const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(saved.integrations.feishu.appId).toBe('cli_a2222');
        expect(saved.integrations.feishu.appSecret).toBe('secret123');
      });

      it('updates existing config when already present', async () => {
        writeFileSync(configPath, JSON.stringify({ integrations: { feishu: { appId: 'old_id', appSecret: 'old_secret' } } }));
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { connectionMode: 'long_connection' },
        });

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify({ appId: 'new_id', appSecret: 'new_secret', displayName: '飞书新版' }),
        });
        expect(res.status).toBe(200);
        // SQLite should not have credentials
        const rows = integrationRepo.listByPlatform('default', 'feishu');
        expect(rows).toHaveLength(1);
        expect((rows[0]['config'] as Record<string, unknown>)['appId']).toBeUndefined();
        // markus.json should have updated credentials
        const { readFileSync } = await import('fs');
        const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(saved.integrations.feishu.appId).toBe('new_id');
        expect(saved.integrations.feishu.appSecret).toBe('new_secret');
      });
    });

    describe('DELETE /api/settings/integrations/feishu', () => {
      it('deletes an existing config', async () => {
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { appId: 'cli_a3333', appSecret: 'xxx' },
        });

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'DELETE',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
        expect(integrationRepo.listByPlatform('default', 'feishu')).toHaveLength(0);
      });

      it('succeeds even when no config exists', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu`, {
          method: 'DELETE',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
      });
    });

    describe('GET /api/settings/integrations/feishu/notifications', () => {
      it('returns empty rules when no config exists', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'GET',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['rules']).toEqual([]);
      });

      it('returns rules from existing config', async () => {
        const rules = [{ id: 'rule1', name: 'Test Rule', type: 'all', enabled: true, priorityFilter: 'all', targets: [{ channelId: 'chat_123', enabled: true }] }];
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { appId: 'cli_a4444', appSecret: 'xxx' },
          forwardRules: rules,
        });

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'GET',
          headers: baseHeaders,
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['rules']).toHaveLength(1);
      });
    });

    describe('PUT /api/settings/integrations/feishu/notifications', () => {
      it('returns 404 when feishu not configured', async () => {
        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'PUT',
          headers: baseHeaders,
          body: JSON.stringify({ rules: [] }),
        });
        expect(res.status).toBe(404);
      });

      it('returns 400 when rules is not an array', async () => {
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { appId: 'cli_x', appSecret: 'x' },
        });

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'PUT',
          headers: baseHeaders,
          body: JSON.stringify({ rules: 'not-an-array' }),
        });
        expect(res.status).toBe(400);
      });

      it('updates rules on existing config', async () => {
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { appId: 'cli_a5555', appSecret: 'xxx' },
        });

        const newRules = [
          { id: 'rule_a', name: 'Urgent Alerts', type: 'all', enabled: true, priorityFilter: 'urgent', targets: [{ channelId: 'chat_999', enabled: true }] },
        ];

        const res = await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'PUT',
          headers: baseHeaders,
          body: JSON.stringify({ rules: newRules }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body['rules']).toHaveLength(1);
      });

      it('persists rules in storage', async () => {
        await integrationRepo.create({
          id: 'feishu_default',
          orgId: 'default',
          platform: 'feishu',
          displayName: '飞书',
          enabled: true,
          config: { appId: 'cli_a6666', appSecret: 'xxx' },
        });

        const newRules = [
          { id: 'rule_a', name: 'Alert Rule', type: 'all', enabled: true, priorityFilter: 'high', targets: [{ channelId: 'chat_777', enabled: true }] },
        ];

        await fetch(`http://localhost:${port}/api/settings/integrations/feishu/notifications`, {
          method: 'PUT',
          headers: baseHeaders,
          body: JSON.stringify({ rules: newRules }),
        });

        const row = integrationRepo.findById('feishu_default');
        const storedRules = row?.['forwardRules'] as Array<Record<string, unknown>> | undefined;
        expect(storedRules).toHaveLength(1);
        expect(storedRules![0]['name']).toBe('Alert Rule');
      });
    });
  });
});
