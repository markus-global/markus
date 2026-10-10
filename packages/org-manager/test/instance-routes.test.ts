/**
 * HTTP tests for the bot-instance endpoints:
 *   GET    /api/settings/integrations/instances
 *   POST   /api/settings/integrations/instances
 *   GET    /api/settings/integrations/instances/:id
 *   POST   /api/settings/integrations/instances/:id
 *   DELETE /api/settings/integrations/instances/:id
 *   GET    /api/settings/integrations/instances/:id/channels
 *   PUT    /api/settings/integrations/instances/:id/channels
 *
 * These follow the pattern established by `platform-integrations-api.test.ts`
 * (a real APIServer on an ephemeral port + hand-written in-memory repos), which
 * is the closest existing harness: the routes need real `fetch` round-trips to
 * prove the `/instances…` paths do not fall into the `:platform` handler.
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

function createMockInstanceRepo() {
  const store = new Map<string, Record<string, unknown>>();
  const toRow = (data: Record<string, unknown>) => ({
    id: data['id'] as string,
    orgId: data['orgId'] as string,
    platform: data['platform'] as string,
    label: (data['label'] as string) ?? 'default',
    config: (data['config'] ?? {}) as Record<string, unknown>,
    capabilities: null,
    enabled: data['enabled'] !== false,
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
    listByOrg: (orgId: string) => [...store.values()].filter((r) => r['orgId'] === orgId),
    listByPlatform: (orgId: string, platform: string) =>
      [...store.values()].filter((r) => r['orgId'] === orgId && r['platform'] === platform),
    update: async (id: string, data: Record<string, unknown>) => {
      const existing = store.get(id);
      if (existing) store.set(id, { ...existing, ...data });
    },
    delete: async (id: string) => {
      store.delete(id);
    },
    all: () => [...store.values()],
  };
}

function createMockBindingRepo() {
  const store = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    create: async (data: Record<string, unknown>) => {
      const id = (data['id'] as string) ?? `cb_mock_${++seq}`;
      const row = {
        id,
        orgId: data['orgId'] as string,
        scope: data['scope'] as string,
        instanceId: (data['instanceId'] as string | null) ?? null,
        nativeId: (data['nativeId'] as string | null) ?? null,
        kind: (data['kind'] as string | null) ?? null,
        agentId: data['agentId'] as string,
        createdAt: '',
      };
      store.set(id, row);
      return row;
    },
    findById: (id: string) => store.get(id),
    listByOrg: (orgId: string) => [...store.values()].filter((r) => r['orgId'] === orgId),
    listByScope: (orgId: string, scope: string) =>
      [...store.values()].filter((r) => r['orgId'] === orgId && r['scope'] === scope),
    delete: async (id: string) => {
      store.delete(id);
    },
    all: () => [...store.values()],
  };
}

/**
 * A minimal org-secretary row, so the now-required `agentId` has its default
 * (the API resolves the secretary per org rather than hard-coding an id).
 */
const SECRETARY_ROW = {
  id: 'agt_secretary',
  orgId: 'default',
  roleId: 'secretary',
  name: 'Secretary',
  teamId: null,
};

function createMockStorage(
  instanceRepo: ReturnType<typeof createMockInstanceRepo>,
  bindingRepo: ReturnType<typeof createMockBindingRepo>,
): StorageBridge {
  return {
    orgRepo: {},
    taskRepo: {},
    integrationRepo: { listByPlatform: () => [], listByOrg: () => [] },
    platformInstanceRepo: instanceRepo,
    channelBindingRepo: bindingRepo,
    agentRepo: { listAll: () => [SECRETARY_ROW] },
  } as unknown as StorageBridge;
}

async function startServer(server: APIServer): Promise<number> {
  server.start();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), SERVER_WAIT_MS));
  const addr = (server as unknown as { server: { address(): { port: number } } }).server?.address();
  return addr?.port ?? 0;
}

describe('Bot instance API', () => {
  const origEnv = process.env['AUTH_ENABLED'];
  let server: APIServer;
  let instanceRepo: ReturnType<typeof createMockInstanceRepo>;
  let bindingRepo: ReturnType<typeof createMockBindingRepo>;
  let port: number;
  let tmpDir: string;
  let configPath: string;
  const headers = { 'Content-Type': 'application/json' };
  const url = (p: string) => `http://localhost:${port}${p}`;

  async function createInstance(platform = 'feishu', label = 'sales'): Promise<string> {
    const res = await fetch(url('/api/settings/integrations/instances'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ platform, label }),
    });
    const body = (await res.json()) as { instance?: { id?: string } };
    return body.instance!.id!;
  }

  beforeEach(async () => {
    process.env['AUTH_ENABLED'] = 'false';
    tmpDir = mkdtempSync(join(tmpdir(), 'markus-bi-'));
    configPath = join(tmpDir, 'markus.json');
    writeFileSync(configPath, JSON.stringify({}));
    instanceRepo = createMockInstanceRepo();
    bindingRepo = createMockBindingRepo();
    server = new APIServer(createMockOrgService(), {} as TaskService, 0);
    server.setStorage(createMockStorage(instanceRepo, bindingRepo));
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
      const res = await fetch(url('/api/settings/integrations/instances'), { headers });
      expect(res.status).toBe(401);
      process.env['AUTH_ENABLED'] = 'false';
    });
  });

  describe('storage gate', () => {
    it('501 when the instance repos are not wired', async () => {
      const bare = new APIServer(createMockOrgService(), {} as TaskService, 0);
      bare.setStorage({ orgRepo: {}, taskRepo: {} } as unknown as StorageBridge);
      const barePort = await startServer(bare);
      try {
        const res = await fetch(`http://localhost:${barePort}/api/settings/integrations/instances`, { headers });
        expect(res.status).toBe(501);
      } finally {
        bare.stop();
      }
    });
  });

  describe('GET /api/settings/integrations/instances', () => {
    it('is routed as a collection, NOT swallowed by the :platform handler', async () => {
      const res = await fetch(url('/api/settings/integrations/instances'), { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['instances']).toEqual([]);
      // The platform handler would answer `flattenStatus` (top-level `fields` /
      // `capabilities`) or 404 "unknown platform"; neither may happen here.
      expect(body['platforms']).toBeUndefined();
      expect(body['fields']).toBeUndefined();
      expect(body['error']).toBeUndefined();
    });

    it('lists created instances', async () => {
      await createInstance('feishu', 'sales');
      const res = await fetch(url('/api/settings/integrations/instances'), { headers });
      const body = (await res.json()) as { instances: Array<Record<string, unknown>> };
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0]!['platform']).toBe('feishu');
      expect(body.instances[0]!['label']).toBe('sales');
      expect(body.instances[0]!['canListChannels']).toBe(true);
    });
  });

  describe('POST /api/settings/integrations/instances', () => {
    it('201s a new instance', async () => {
      const res = await fetch(url('/api/settings/integrations/instances'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'feishu', label: 'sales' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { instance: Record<string, unknown> };
      expect(body.instance['id']).toMatch(/^bi_feishu_[0-9a-f]{12}$/);
      expect(body.instance['enabled']).toBe(true);
    });

    it('400s a blank platform or label', async () => {
      for (const payload of [{ platform: '', label: 'x' }, { platform: 'feishu', label: '  ' }, {}]) {
        const res = await fetch(url('/api/settings/integrations/instances'), {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }
    });

    it('404s an unknown platform with the shared hint', async () => {
      const res = await fetch(url('/api/settings/integrations/instances'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'nope', label: 'x' }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(String(body['error'])).toMatch(/unknown platform/i);
      expect(body['hint']).toBeTruthy();
    });

    it('409s a duplicate (platform, label)', async () => {
      await createInstance('feishu', 'sales');
      const res = await fetch(url('/api/settings/integrations/instances'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'feishu', label: 'sales' }),
      });
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as Record<string, unknown>)['error'])).toMatch(/already exists/);
    });
  });

  describe('GET /api/settings/integrations/instances/:id', () => {
    it('returns the instance', async () => {
      const id = await createInstance();
      const res = await fetch(url(`/api/settings/integrations/instances/${id}`), { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['id']).toBe(id);
      expect(body['secrets']).toMatchObject({ appSecret: { hasValue: false } });
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead'), { headers });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/settings/integrations/instances/:id', () => {
    it('saves config and returns the instance with the secret masked', async () => {
      const id = await createInstance();
      const res = await fetch(url(`/api/settings/integrations/instances/${id}`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          appId: 'cli_a',
          appSecret: CANARY_SECRET,
          agentId: 'agt_1',
          notifyAgentId: 'agt_notify',
        }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      const instance = body['instance'] as Record<string, unknown>;
      expect((instance['values'] as Record<string, unknown>)['appId']).toBe('cli_a');
      expect(instance['agentId']).toBe('agt_1');
      expect(instance['notifyAgentId']).toBe('agt_notify');
      expect((instance['secrets'] as Record<string, { hasValue: boolean }>)['appSecret']).toEqual({
        hasValue: true,
      });
      expect(raw).not.toContain(CANARY_SECRET);
    });

    it('400s a missing required field, naming it', async () => {
      const id = await createInstance();
      const res = await fetch(url(`/api/settings/integrations/instances/${id}`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ appId: 'cli_a' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['missing']).toEqual(['appSecret']);
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead'), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/settings/integrations/instances/:id', () => {
    it('removes the instance and its bindings', async () => {
      const id = await createInstance();
      await fetch(url(`/api/settings/integrations/instances/${id}/channels`), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ channels: [{ nativeId: 'oc_1', agentId: 'agt_1' }] }),
      });

      const res = await fetch(url(`/api/settings/integrations/instances/${id}`), {
        method: 'DELETE',
        headers,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Record<string, unknown>)['success']).toBe(true);
      expect(instanceRepo.all()).toHaveLength(0);
      expect(bindingRepo.all()).toHaveLength(0);
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead'), {
        method: 'DELETE',
        headers,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/settings/integrations/instances/:id/channels', () => {
    it('reports unsupported for a platform whose manifest has no listChannels', async () => {
      const id = await createInstance('telegram', 'ui');
      const res = await fetch(url(`/api/settings/integrations/instances/${id}/channels`), { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ supported: false, channels: [] });
    });

    it('never 500s when the platform call fails — reports the error instead', async () => {
      const id = await createInstance('feishu', 'unconfigured');
      const res = await fetch(url(`/api/settings/integrations/instances/${id}/channels`), { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['supported']).toBe(true);
      expect(body['channels']).toEqual([]);
      expect(String(body['error'])).toMatch(/appId and appSecret are required/);
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead/channels'), {
        headers,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/settings/integrations/instances/:id/channels', () => {
    it('replaces the channel routes of this instance', async () => {
      const a = await createInstance('feishu', 'a');
      const b = await createInstance('feishu', 'b');
      const put = (id: string, channels: unknown) =>
        fetch(url(`/api/settings/integrations/instances/${id}/channels`), {
          method: 'PUT',
          headers,
          body: JSON.stringify({ channels }),
        });

      await put(b, [{ nativeId: 'oc_b', agentId: 'agt_b' }]);
      const res = await put(a, [
        { nativeId: 'oc_1', kind: 'group', agentId: 'agt_1' },
        { nativeId: 'oc_2', agentId: 'agt_2' },
      ]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instance: Record<string, unknown> };
      expect(body.instance['channels']).toEqual([
        { nativeId: 'oc_1', kind: 'group', agentId: 'agt_1' },
        { nativeId: 'oc_2', kind: null, agentId: 'agt_2' },
      ]);
      expect(bindingRepo.all().filter((r) => r['instanceId'] === b)).toHaveLength(1);
    });

    it('400s a malformed body, a blank nativeId or a blank agentId', async () => {
      const id = await createInstance();
      const bad = [
        { channels: 'nope' },
        {},
        { channels: [{ agentId: 'agt_1' }] },
        { channels: [{ nativeId: '  ', agentId: 'agt_1' }] },
        { channels: [{ nativeId: 'oc_1', agentId: '' }] },
      ];
      for (const payload of bad) {
        const res = await fetch(url(`/api/settings/integrations/instances/${id}/channels`), {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload),
        });
        expect(res.status, JSON.stringify(payload)).toBe(400);
      }
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead/channels'), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ channels: [] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/settings/integrations/instances/:id/test', () => {
    // Regression: this route was absent from the route table, so the UI's
    // "Test connection" answered `{"error":"Not found"}` — the button looked
    // broken because the request never reached a handler.
    it('is routed (200, never "Not found") and reports a failed probe as data', async () => {
      const id = await createInstance('feishu', 'unconfigured');
      const res = await fetch(url(`/api/settings/integrations/instances/${id}/test`), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).not.toBe('Not found');
      expect(body['success']).toBe(false);
      expect(body['ok']).toBe(false);
      // The probe really ran against this instance's (empty) config.
      expect(String(body['message'])).toMatch(/appId and appSecret are required/i);
    });

    it('answers "test not supported" for a manifest without a probe', async () => {
      const id = await createInstance('whatsapp', 'ui');
      const res = await fetch(url(`/api/settings/integrations/instances/${id}/test`), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['ok']).toBe(false);
      expect(String(body['error'])).toMatch(/not supported/i);
    });

    it('404s an unknown id', async () => {
      const res = await fetch(url('/api/settings/integrations/instances/bi_feishu_dead/test'), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });
});
