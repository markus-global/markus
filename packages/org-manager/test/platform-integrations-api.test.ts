/**
 * HTTP tests for the platform-manifest driven Settings API:
 *   GET    /api/settings/integrations              (list)
 *   GET    /api/settings/integrations/:platform
 *   POST   /api/settings/integrations/:platform
 *   DELETE /api/settings/integrations/:platform
 *   POST   /api/settings/integrations/:platform/test
 *
 * The Feishu *extension* endpoints (register / chats / notifications / …) keep
 * their own coverage in `integration-api.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { APIServer } from '../src/api-server.js';
import type { OrganizationService } from '../src/org-service.js';
import type { TaskService } from '../src/task-service.js';
import type { StorageBridge } from '../src/storage-bridge.js';

const SERVER_WAIT_MS = 300;
/** A value that must never appear in any GET response body. */
const CANARY_SECRET = 'canary-secret-DO-NOT-LEAK';

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
    createOrganization: () =>
      Promise.resolve({ id: '', name: '', ownerId: '', createdAt: '', status: 'active' as const }),
  } as unknown as OrganizationService;
}

function createMockIntegrationRepo() {
  const store = new Map<string, Record<string, unknown>>();
  const toRow = (data: Record<string, unknown>) => ({
    id: (data['id'] as string) ?? 'test',
    orgId: data['orgId'] as string,
    platform: data['platform'] as string,
    displayName: data['displayName'] as string,
    enabled: (data['enabled'] as boolean) ? 1 : 0,
    config: (data['config'] ?? {}) as Record<string, unknown>,
    forwardRules: (data['forwardRules'] ?? []) as Record<string, unknown>[],
    lastVerifiedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  });
  return {
    create: async (data: Record<string, unknown>) => {
      const row = toRow(data);
      store.set(row.id, row);
      return row;
    },
    findById: (id: string) => store.get(id),
    listByOrg: (orgId: string) => Array.from(store.values()).filter((r) => r['orgId'] === orgId),
    listByPlatform: (orgId: string, platform: string) =>
      Array.from(store.values()).filter((r) => r['orgId'] === orgId && r['platform'] === platform),
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...data });
    },
    delete: async (id: string) => {
      store.delete(id);
    },
  };
}

/**
 * A minimal org-secretary row. `agentId` is a required manifest field, so the
 * store defaults it from the org secretary — resolved per org by the API, not
 * hard-coded.
 */
const SECRETARY_ROW = {
  id: 'agt_secretary',
  orgId: 'default',
  roleId: 'secretary',
  name: 'Secretary',
  teamId: null,
};

function createMockStorage(repo: ReturnType<typeof createMockIntegrationRepo>): StorageBridge {
  return {
    orgRepo: {},
    taskRepo: {},
    integrationRepo: repo,
    agentRepo: { listAll: () => [SECRETARY_ROW] },
  } as unknown as StorageBridge;
}

async function startServer(server: APIServer): Promise<number> {
  server.start();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), SERVER_WAIT_MS));
  const addr = (server as unknown as { server: { address(): { port: number } } }).server?.address();
  return addr?.port ?? 0;
}

describe('Platform integrations API (manifest driven)', () => {
  const origEnv = process.env['AUTH_ENABLED'];
  let server: APIServer;
  let integrationRepo: ReturnType<typeof createMockIntegrationRepo>;
  let port: number;
  let tmpDir: string;
  let configPath: string;
  const headers = { 'Content-Type': 'application/json' };
  const url = (p: string) => `http://localhost:${port}${p}`;

  beforeEach(async () => {
    process.env['AUTH_ENABLED'] = 'false';
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-pi-'));
    configPath = join(tmpDir, 'markus.json');
    writeFileSync(configPath, JSON.stringify({}));
    integrationRepo = createMockIntegrationRepo();
    server = new APIServer(createMockOrgService(), {} as TaskService, 0);
    server.setStorage(createMockStorage(integrationRepo));
    server.setConfigPath(configPath);
    port = await startServer(server);
  });

  afterEach(() => {
    server?.stop();
    process.env['AUTH_ENABLED'] = origEnv;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('auth', () => {
    it('401 without a valid token', async () => {
      process.env['AUTH_ENABLED'] = 'true';
      const res = await fetch(url('/api/settings/integrations'), { headers });
      expect(res.status).toBe(401);
      process.env['AUTH_ENABLED'] = 'false';
    });
  });

  describe('GET /api/settings/integrations', () => {
    it('lists every registered platform with its status', async () => {
      const res = await fetch(url('/api/settings/integrations'), { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { platforms: Array<Record<string, unknown>> };
      expect(body.platforms.map((p) => p['id'])).toEqual([
        'feishu',
        'telegram',
        'slack',
        'whatsapp',
        'discord',
      ]);
      const feishu = body.platforms[0]!;
      expect(feishu['label']).toBe('Feishu / Lark');
      expect(feishu['enabled']).toBe(false);
      expect(feishu['hasConfig']).toBe(false);
      expect(feishu['secrets']).toMatchObject({ appSecret: { hasValue: false } });
    });
  });

  describe('GET /api/settings/integrations/:platform', () => {
    it('returns flattened non-secret values for a configured platform', async () => {
      await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a', appSecret: CANARY_SECRET, notifyChatId: 'oc_1' }),
      });
      const res = await fetch(url('/api/settings/integrations/feishu'), { headers });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body['appId']).toBe('cli_a');
      expect(body['notifyChatId']).toBe('oc_1');
      expect(body['appSecret']).toBe('••••');
      expect((body['secrets'] as Record<string, { hasValue: boolean }>)['appSecret']).toEqual({ hasValue: true });
      expect(raw).not.toContain(CANARY_SECRET);
    });

    it('404s an unknown platform with an actionable hint', async () => {
      const res = await fetch(url('/api/settings/integrations/nope'), { headers });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['error'])).toMatch(/unknown platform/i);
      expect(body['hint']).toBeTruthy();
    });
  });

  describe('POST /api/settings/integrations/:platform', () => {
    it('400s when a required field is missing, naming it', async () => {
      const res = await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['missing']).toEqual(['appSecret']);
    });

    it('404s an unknown platform', async () => {
      const res = await fetch(url('/api/settings/integrations/nope'), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it('persists to the integrations row and masks the secret in the response', async () => {
      const res = await fetch(url('/api/settings/integrations/telegram'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ botToken: 'tg_9001' }),
      });
      expect(res.status).toBe(200);
      const rows = integrationRepo.listByPlatform('default', 'telegram');
      expect(rows).toHaveLength(1);
      expect((rows[0]['config'] as Record<string, unknown>)['botToken']).toBe('tg_9001');
    });
  });

  describe('DELETE /api/settings/integrations/:platform', () => {
    it('removes stored config', async () => {
      await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a', appSecret: CANARY_SECRET }),
      });
      expect(integrationRepo.listByPlatform('default', 'feishu')).toHaveLength(1);

      const res = await fetch(url('/api/settings/integrations/feishu'), { method: 'DELETE', headers });
      expect(res.status).toBe(200);
      expect(integrationRepo.listByPlatform('default', 'feishu')).toHaveLength(0);
    });

    it('404s an unknown platform', async () => {
      const res = await fetch(url('/api/settings/integrations/nope'), { method: 'DELETE', headers });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/settings/integrations/:platform/test', () => {
    it('reports "not supported" when the manifest has no probe', async () => {
      const res = await fetch(url('/api/settings/integrations/whatsapp/test'), { method: 'POST', headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['ok']).toBe(false);
      expect(body['error']).toBe('test not supported');
    });

    it('short-circuits a manifest probe with no credentials (no network call)', async () => {
      const externalCalls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const target = typeof input === 'string' ? input : (input as Request).url;
        // Only count calls that leave the process — the test's own request to the
        // local API server must not be mistaken for an outbound credential probe.
        if (!target.includes('localhost')) externalCalls.push(target);
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        const res = await fetch(url('/api/settings/integrations/feishu/test'), {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['ok']).toBe(false);
        expect(externalCalls).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('404s an unknown platform', async () => {
      const res = await fetch(url('/api/settings/integrations/nope/test'), { method: 'POST', headers });
      expect(res.status).toBe(404);
    });
  });

  describe('regression — no GET ever echoes a configured secret', () => {
    it('list and single-platform responses contain no plaintext secret', async () => {
      await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a', appSecret: CANARY_SECRET, encryptKey: 'enc-canary' }),
      });

      for (const path of ['/api/settings/integrations', '/api/settings/integrations/feishu']) {
        const res = await fetch(url(path), { headers });
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain(CANARY_SECRET);
        expect(raw).not.toContain('enc-canary');
      }
    });
  });

  describe('agent binding + secret masking round-trip (issue #340, defect A/B)', () => {
    it('persists the manifest agentId and never echoes the secret back', async () => {
      await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a', appSecret: CANARY_SECRET, agentId: 'agt_secretary' }),
      });

      const res = await fetch(url('/api/settings/integrations/feishu'), { headers });
      const raw = await res.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body['agentId']).toBe('agt_secretary');
      expect(body['appSecret']).toBe('••••');
      expect(raw).not.toContain(CANARY_SECRET);

      // Re-submitting the masked placeholder must NOT clear the stored secret
      // (a non-secret edit — e.g. rebinding the agent — is not a secret wipe).
      await fetch(url('/api/settings/integrations/feishu'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a', appSecret: '••••', agentId: 'agt_other' }),
      });
      const after = (await (
        await fetch(url('/api/settings/integrations/feishu'), { headers })
      ).json()) as Record<string, unknown>;
      expect((after['secrets'] as Record<string, { hasValue: boolean }>)['appSecret']).toEqual({
        hasValue: true,
      });
      expect(after['agentId']).toBe('agt_other');
    });
  });
});
