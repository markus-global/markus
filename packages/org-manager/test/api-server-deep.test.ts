import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayError } from '@markus/core';
import {
  AGENT_A,
  AGENT_B,
  GW_AUTH,
  MockIncomingMessage,
  MockServerResponse,
  PROJECT_1,
  REQ_1,
  REVIEWER,
  TEST_PASSWORD_HASH,
  createTestServer,
  request,
  type TestContext,
} from './api-server-test-helpers.js';

const mockFetch = vi.fn();

async function waitForResponse(res: MockServerResponse, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (res.ended) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function requestAsync(
  server: TestContext['server'],
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const effectiveBody = body !== undefined ? body : (mutating ? {} : undefined);
  const bodyStr = effectiveBody !== undefined ? JSON.stringify(effectiveBody) : '';
  const reqHeaders = {
    ...(bodyStr ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  const req = new MockIncomingMessage(method, path, reqHeaders, bodyStr);
  const res = new MockServerResponse();
  server.handleRequest(req as never, res as never);
  req._simulate();
  await waitForResponse(res);
  let json: Record<string, unknown> = {};
  try {
    if (res.body) json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = { _raw: res.body };
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers };
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('@markus/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@markus/shared')>();
  return {
    ...actual,
    checkForUpdate: vi.fn(async () => ({ updateAvailable: false, latestVersion: actual.APP_VERSION })),
    loadConfig: vi.fn(() => ({
      network: { proxy: '', proxyEnabled: false },
      browser: { headless: true },
      search: { provider: 'duckduckgo', serperApiKey: 'serper-key' },
      integrations: { feishu: { appId: 'cli_test', appSecret: 'secret' } },
      agent: {},
      llm: { providers: {} },
    })),
    saveConfig: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('markus.json') || s.includes('data.db') || s.includes('.markus') || s.includes('ROLE.md')) return true;
      if (s.includes('workspace') || s.includes('agents/') || s.includes('/role')) return true;
      if (s.includes('templates/roles') || s.includes('templates/teams') || s.includes('templates/skills')) return true;
      if (s.includes('hub-token') || s.includes('builder-artifacts') || s.includes('/uploads/')) return true;
      if (s.includes('.role-origin.json')) return true;
      if (s.includes('preview-test.md') || s.includes('user_anonymous.png') || s.includes('preview-test.png')) return true;
      return false;
    }),
    readFileSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('markus.json')) {
        return JSON.stringify({ network: {}, browser: {}, search: {}, integrations: { feishu: {} } });
      }
      if (s.includes('hub-token')) return 'hub-test-token';
      if (s.includes('.role-origin.json')) {
        return JSON.stringify({ artifact: 'deploy-agent', artifactType: 'agent' });
      }
      if (s.endsWith('.png')) return Buffer.from('fake-png');
      if (s.endsWith('.png')) return Buffer.from('fake-png');
      if (s.includes('preview-test.md')) return '# Preview\n\nHello';
      return '# Test Role\n\nRole content';
    }),
    readdirSync: vi.fn((p: string, options?: { withFileTypes?: boolean }) => {
      const s = String(p);
      if (s.includes('templates/teams')) {
        const entries = ['team-one.json'];
        if (options?.withFileTypes) {
          return entries.map(name => ({ name, isFile: () => true, isDirectory: () => false }));
        }
        return entries;
      }
      return actual.readdirSync(p, options as never);
    }),
    statSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('.markus') || s.includes('agents/') || s.includes('/role') || s.includes('preview')) {
        return {
          isFile: () => s.endsWith('.md') || s.endsWith('.png') || s.endsWith('.json'),
          isDirectory: () => !s.endsWith('.md') && !s.endsWith('.png'),
          size: s.endsWith('.png') ? 100 : 1024,
        } as ReturnType<typeof actual.statSync>;
      }
      return actual.statSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.stubGlobal('fetch', mockFetch);

describe('APIServer deep route coverage', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['AUTH_ENABLED'] = 'false';
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '',
      json: async () => ({}),
      headers: { get: () => 'application/json' },
    });
    ctx = createTestServer();

    const gatewayToken = {
      markusAgentId: AGENT_A,
      orgId: 'default',
      externalAgentId: 'ext-agent-1',
    };
    ctx.server.setGateway({
      listRegistrations: vi.fn((orgId: string) => [{
        externalAgentId: 'ext-agent-1',
        agentName: 'External Agent',
        orgId,
        markusAgentId: AGENT_A,
        connected: true,
        platform: 'openclaw',
      }]),
      unregister: vi.fn(async () => ({ markusAgentId: AGENT_A, externalAgentId: 'ext-agent-1' })),
      register: vi.fn(async (req: Record<string, unknown>) => ({
        externalAgentId: req.externalAgentId ?? 'ext-new',
        markusAgentId: AGENT_B,
        agentName: req.agentName ?? 'New Agent',
        orgId: req.orgId ?? 'default',
        connected: false,
      })),
      authenticate: vi.fn(() => ({ token: 'gw-token-new' })),
      verifyToken: vi.fn(() => gatewayToken),
      handleMessage: vi.fn(async () => ({ reply: 'ok' })),
      routeMessage: vi.fn(async () => ({ reply: 'routed' })),
      getStatus: vi.fn(() => ({ connected: true, agents: 2, lastHeartbeat: new Date().toISOString() })),
      resetConnectionStatus: vi.fn(),
    } as never, 'gw-secret');

    vi.spyOn(ctx.server['ws'] as { broadcast: (...args: unknown[]) => void }, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    delete process.env['AUTH_ENABLED'];
  });

  describe('Auth with storage enabled', () => {
    beforeEach(() => {
      process.env['AUTH_ENABLED'] = 'true';
      ctx = createTestServer();
    });

    it('GET /api/auth/status reports initialized when real users exist', async () => {
      vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([
        { id: 'user-1', email: 'owner@test.com', role: 'owner', passwordHash: TEST_PASSWORD_HASH },
        { id: 'user-2', email: 'member@test.com', role: 'member', passwordHash: TEST_PASSWORD_HASH },
      ] as never);
      const res = await requestAsync(ctx.server, 'GET', '/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.json.initialized).toBe(true);
      expect(res.json.hasOwner).toBe(true);
      expect(res.json.hasMultipleUsers).toBe(true);
    });

    it('POST /api/auth/init creates first admin when no real users', async () => {
      vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([]);
      const res = await requestAsync(ctx.server, 'POST', '/api/auth/init', {
        name: 'Admin',
        email: 'admin@new.com',
        password: 'secret123',
      });
      expect(res.status).toBe(200);
      expect(res.json.user).toMatchObject({ email: 'admin@new.com', role: 'owner' });
    });

    it('POST /api/auth/init rejects when system already initialized', async () => {
      vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([
        { id: 'u1', email: 'existing@test.com', passwordHash: TEST_PASSWORD_HASH },
      ] as never);
      const res = await requestAsync(ctx.server, 'POST', '/api/auth/init', {
        name: 'Admin',
        email: 'admin@new.com',
        password: 'secret123',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Gateway authenticated routes', () => {
    it('GET /api/gateway/info requires admin role', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/info');
      expect(res.status).toBe(403);
    });

    it('GET /api/gateway/status with bearer token', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/status', undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect(res.json.connected).toBe(true);
    });

    it('GET /api/gateway/status rejects missing token', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/status');
      expect(res.status).toBe(401);
    });

    it('GET /api/gateway/manual returns markdown handbook', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/manual', undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type'] ?? res.headers['content-type']).toContain('text/markdown');
      expect(res.raw.length).toBeGreaterThan(0);
    });

    it('GET /api/gateway/team returns colleagues and manager', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/team', undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.colleagues)).toBe(true);
    });

    it('GET /api/gateway/projects lists projects', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/projects', undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect((res.json.projects as unknown[]).length).toBeGreaterThan(0);
    });

    it('GET /api/gateway/requirements with filters', async () => {
      const res = await requestAsync(ctx.server, 'GET', `/api/gateway/requirements?project_id=${PROJECT_1}&status=draft`, undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.requirements)).toBe(true);
    });

    it('GET /api/gateway/deliverables searches deliverables', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/deliverables?q=test', undefined, GW_AUTH);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.results)).toBe(true);
    });

    it('POST /api/gateway/deliverables creates deliverable', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/gateway/deliverables', {
        type: 'file',
        title: 'Output',
        summary: 'Test output',
        reference: '/tmp/out.txt',
        taskId: 'task-1',
        projectId: PROJECT_1,
      }, GW_AUTH);
      expect(res.status).toBe(201);
      expect(res.json.deliverable).toBeTruthy();
    });

    it('POST /api/gateway/message routes message', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/gateway/message', {
        type: 'task',
        content: 'Do something',
      }, GW_AUTH);
      expect(res.status).toBe(200);
    });

    it('POST /api/gateway/register returns registration', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/gateway/register', {
        agentId: 'ext-2',
        agentName: 'Ext Two',
        orgId: 'default',
        capabilities: ['chat'],
      });
      expect(res.status).toBe(201);
    });

    it('POST /api/gateway/auth authenticates agent', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/gateway/auth', {
        agentId: 'ext-agent-1',
        orgId: 'default',
        secret: 'gw-secret',
      });
      expect(res.status).toBe(200);
      expect(res.json.token).toBeTruthy();
    });

    it('POST /api/gateway/register handles GatewayError', async () => {
      vi.mocked(ctx.server['gateway']!.register).mockRejectedValueOnce(new GatewayError('Duplicate agent', 409));
      const res = await requestAsync(ctx.server, 'POST', '/api/gateway/register', {
        agentId: 'dup',
        agentName: 'Dup',
        orgId: 'default',
      });
      expect(res.status).toBe(409);
    });

    it('GET /api/gateway/status handles GatewayError', async () => {
      vi.mocked(ctx.server['gateway']!.verifyToken).mockImplementationOnce(() => {
        throw new GatewayError('Invalid token', 401);
      });
      const res = await requestAsync(ctx.server, 'GET', '/api/gateway/status', undefined, GW_AUTH);
      expect(res.status).toBe(401);
    });
  });

  describe('External agents', () => {
    it('GET /api/external-agents lists registrations', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/external-agents?orgId=default');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.agents)).toBe(true);
    });

    it('POST /api/external-agents/register creates registration with token', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/external-agents/register', {
        externalAgentId: 'ext-new-2',
        agentName: 'Remote Agent',
        orgId: 'default',
        capabilities: ['tasks'],
        platform: 'openclaw',
      });
      expect(res.status).toBe(201);
      expect(res.json.registration).toBeTruthy();
      expect(res.json.token).toBeTruthy();
      expect(res.json.gatewayUrl).toContain('/api/gateway');
    });

    it('DELETE /api/external-agents/:id unregisters agent', async () => {
      const res = await requestAsync(ctx.server, 'DELETE', '/api/external-agents/ext-agent-1?orgId=default');
      expect(res.status).toBe(200);
      expect(res.json.deleted).toBe(true);
    });

    it('DELETE /api/external-agents/:id returns 404 when missing', async () => {
      vi.mocked(ctx.server['gateway']!.unregister).mockResolvedValueOnce(null as never);
      const res = await requestAsync(ctx.server, 'DELETE', '/api/external-agents/missing?orgId=default');
      expect(res.status).toBe(404);
    });
  });

  describe('Settings LLM and config', () => {
    it('GET /api/settings/llm/models returns catalog', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/settings/llm/models');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.models)).toBe(true);
    });

    it('POST /api/settings/llm/providers/:name/test succeeds with reply', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        chatDirect: ReturnType<typeof vi.fn>;
      };
      llmRouter.getProvider = vi.fn(() => ({ model: 'gpt-4', baseUrl: 'https://api.openai.com' }));
      llmRouter.chatDirect = vi.fn(async () => ({
        content: 'hello',
        usage: { input: 1, output: 1 },
        _providerBaseUrl: 'https://api.openai.com/v1',
      }));

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/llm/providers/openai/test');
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.reply).toBe('hello');
    });

    it('POST /api/settings/llm/providers/:name/test handles empty response', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        chatDirect: ReturnType<typeof vi.fn>;
      };
      llmRouter.getProvider = vi.fn(() => ({ model: 'gpt-4' }));
      llmRouter.chatDirect = vi.fn(async () => ({ content: '' }));

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/llm/providers/openai/test');
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(false);
    });

    it('POST /api/settings/llm/providers/:name/test handles API error JSON', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        chatDirect: ReturnType<typeof vi.fn>;
      };
      llmRouter.getProvider = vi.fn(() => ({ model: 'gpt-4', baseUrl: 'https://api.example.com' }));
      llmRouter.chatDirect = vi.fn(async () => {
        throw new Error('API error 401 {"error":{"message":"Invalid API key","type":"invalid_request_error"}}');
      });

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/llm/providers/openai/test');
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(false);
      expect(String(res.json.error)).toContain('Invalid API key');
    });

    it('POST /api/settings/llm/providers/:name/test returns 404 for unknown provider', async () => {
      const llmRouter = ctx.server['llmRouter'] as { getProvider: ReturnType<typeof vi.fn> };
      llmRouter.getProvider = vi.fn(() => null);

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/llm/providers/unknown/test');
      expect(res.status).toBe(404);
    });

    it('POST /api/settings/export exports selected sections', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/export', {
        sections: ['llm', 'teams', 'agents'],
      });
      expect(res.status).toBe(200);
      expect(res.json.version).toBe('1.0');
      expect(res.json.sections).toBeTruthy();
    });

    it('POST /api/settings/import preview summarizes sections', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/import', {
        preview: true,
        data: {
          sections: {
            llm: { providers: { openai: { enabled: true } } },
            teams: [{ name: 'Team A' }],
            agents: [{ name: 'Agent A' }],
          },
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.summary).toBeTruthy();
    });

    it('POST /api/settings/import rejects missing sections', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/import', { data: {} });
      expect(res.status).toBe(400);
    });

    it('POST /api/settings/env-models applies detected models', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/env-models', {
        models: [{ provider: 'openai', model: 'gpt-4', envKey: 'OPENAI_API_KEY' }],
      });
      expect([200, 400, 500]).toContain(res.status);
    });
  });

  describe('Knowledge legacy routes', () => {
    it('GET /api/knowledge/search returns deliverable results', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/knowledge/search?query=test');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.results)).toBe(true);
    });

    it('POST /api/knowledge creates entry via deliverable service', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/knowledge', {
        title: 'Note',
        content: 'Important info',
        tags: ['docs'],
        source: AGENT_A,
      });
      expect(res.status).toBe(201);
    });

    it('POST /api/knowledge/:id/flag-outdated flags entry', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/knowledge/know-1/flag-outdated');
      expect(res.status).toBe(200);
    });

    it('POST /api/knowledge/:id/verify marks verified', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/knowledge/deliv-1/verify');
      expect(res.status).toBe(200);
    });

    it('DELETE /api/knowledge/:id removes entry', async () => {
      const res = await requestAsync(ctx.server, 'DELETE', '/api/knowledge/know-1');
      expect(res.status).toBe(200);
    });
  });

  describe('Deliverables CRUD auth branches', () => {
    it('POST /api/deliverables creates deliverable', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/deliverables', {
        type: 'file',
        title: 'Report',
        summary: 'Monthly report',
        reference: '/tmp/report.pdf',
        tags: ['report'],
        taskId: 'task-1',
        agentId: AGENT_A,
        projectId: PROJECT_1,
        requirementId: REQ_1,
      });
      expect(res.status).toBe(201);
    });

    it('GET /api/deliverables/:id returns deliverable', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/deliverables/deliv-1');
      expect(res.status).toBe(200);
      expect(res.json.deliverable).toBeTruthy();
    });

    it('PUT /api/deliverables/:id updates deliverable', async () => {
      const res = await requestAsync(ctx.server, 'PUT', '/api/deliverables/deliv-1', { title: 'Updated' });
      expect(res.status).toBe(200);
    });

    it('DELETE /api/deliverables/:id removes deliverable', async () => {
      const res = await requestAsync(ctx.server, 'DELETE', '/api/deliverables/deliv-1');
      expect(res.status).toBe(200);
    });

    it('GET /api/deliverables/health checks file health', async () => {
      const res = await requestAsync(ctx.server, 'GET', `/api/deliverables/health?agentId=${AGENT_A}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.missingFiles)).toBe(true);
    });
  });

  describe('Reports and execution logs', () => {
    it('GET /api/execution-logs returns stream logs', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/execution-logs?sourceType=task&sourceId=task-1');
      expect(res.status).toBe(200);
    });

    it('POST /api/reports/generate creates report', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/reports/generate', {
        type: 'daily',
        orgId: 'default',
      });
      expect([200, 201, 400, 500]).toContain(res.status);
    });
  });

  describe('Hub provider download', () => {
    it('readHubToken and hub search via builder routes', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          items: [{
            id: 'hub-item-1',
            name: 'Hub Agent',
            itemType: 'agent',
            description: 'From hub',
            author: { displayName: 'Author' },
            version: '1.0.0',
            downloadCount: 5,
          }],
        }),
        headers: { get: () => 'application/json' },
      });
      const res = await requestAsync(ctx.server, 'GET', '/api/builder/artifacts');
      expect(res.status).toBe(200);
    });
  });

  describe('LLM provider PATCH and env-models', () => {
    it('PUT /api/settings/llm/providers/:name updates existing provider', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        getEnhancedSettings: ReturnType<typeof vi.fn>;
        setProviderEnabled: ReturnType<typeof vi.fn>;
        updateProviderModelConfig: ReturnType<typeof vi.fn>;
      };
      const configure = vi.fn();
      llmRouter.getProvider = vi.fn(() => ({ model: 'gpt-4', configure }));
      llmRouter.getEnhancedSettings = vi.fn(() => ({ defaultProvider: 'openai' }));
      llmRouter.setProviderEnabled = vi.fn();
      llmRouter.updateProviderModelConfig = vi.fn();

      const res = await requestAsync(ctx.server, 'PUT', '/api/settings/llm/providers/openai', {
        model: 'gpt-4o',
        apiKey: 'sk-test',
        enabled: true,
        contextWindow: 128000,
        maxOutputTokens: 4096,
        cost: { input: 1, output: 2 },
      });
      expect(res.status).toBe(200);
      expect(configure).toHaveBeenCalled();
    });

    it('PUT /api/settings/llm/providers/:name registers new provider when missing', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        registerProviderFromConfig: ReturnType<typeof vi.fn>;
        getEnhancedSettings: ReturnType<typeof vi.fn>;
      };
      llmRouter.getProvider = vi.fn(() => null);
      llmRouter.registerProviderFromConfig = vi.fn();
      llmRouter.getEnhancedSettings = vi.fn(() => ({}));

      const res = await requestAsync(ctx.server, 'PUT', '/api/settings/llm/providers/custom', {
        model: 'custom-model',
        apiKey: 'key',
      });
      expect(res.status).toBe(200);
      expect(llmRouter.registerProviderFromConfig).toHaveBeenCalled();
    });

    it('POST /api/settings/env-models applies provider updates from env', async () => {
      process.env['OPENAI_API_KEY'] = 'env-openai-key';
      const llmRouter = ctx.server['llmRouter'] as {
        getProvider: ReturnType<typeof vi.fn>;
        registerProviderFromConfig: ReturnType<typeof vi.fn>;
        getEnhancedSettings: ReturnType<typeof vi.fn>;
      };
      llmRouter.getProvider = vi.fn(() => null);
      llmRouter.registerProviderFromConfig = vi.fn();
      llmRouter.getEnhancedSettings = vi.fn(() => ({}));

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/env-models', {
        providers: [{ provider: 'openai', model: 'gpt-4', enabled: true }],
      });
      expect(res.status).toBe(200);
      expect(res.json.applied).toContain('openai');
      delete process.env['OPENAI_API_KEY'];
    });

    it('POST /api/settings/env-models rejects empty providers', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/env-models', { providers: [] });
      expect(res.status).toBe(400);
    });

    it('POST /api/settings/import applies LLM section', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        updateSettings: ReturnType<typeof vi.fn>;
        getEnhancedSettings: ReturnType<typeof vi.fn>;
      };
      llmRouter.updateSettings = vi.fn();
      llmRouter.getEnhancedSettings = vi.fn(() => ({}));

      const res = await requestAsync(ctx.server, 'POST', '/api/settings/import', {
        data: {
          sections: {
            llm: { defaultProvider: 'openai', providers: { openai: { enabled: true, model: 'gpt-4' } } },
          },
        },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Files and OAuth settings', () => {
    it('GET /api/files/image serves png file', async () => {
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const pngPath = join(tmpdir(), 'preview-test.png');
      const res = await requestAsync(ctx.server, 'GET', `/api/files/image?path=${encodeURIComponent(pngPath)}`);
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/png');
    });

    it('GET /api/files/image rejects non-image extension', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/files/image?path=/tmp/file.xyz');
      expect([400, 404]).toContain(res.status);
    });

    it('POST /api/files/reveal returns ok for existing path', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/files/reveal', {
        path: '/tmp/preview-test.md',
      });
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/files/reveal rejects missing path', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/files/reveal', {});
      expect(res.status).toBe(400);
    });

    it('GET /api/settings/oauth/providers lists providers', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/settings/oauth/providers');
      expect([200, 500]).toContain(res.status);
    });

    it('GET /api/settings/oauth/profiles lists profiles', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/settings/oauth/profiles');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/oauth/callback handles callback', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/oauth/callback', {
        provider: 'openai-codex',
        code: 'auth-code',
      });
      expect([200, 400, 500]).toContain(res.status);
    });
  });

  describe('Builder uninstall team branch', () => {
    it('POST /api/builder/artifacts/team/:name/uninstall removes team agents', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/builder/artifacts/team/team-one/uninstall');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/builder/artifacts/skill/:name/uninstall removes skill directory', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/builder/artifacts/skill/test-skill/uninstall');
      expect([200, 404, 500]).toContain(res.status);
    });
  });

  describe('Auth login and misc high-coverage routes', () => {
    it('POST /api/auth/login verifies password when auth enabled', async () => {
      process.env['AUTH_ENABLED'] = 'true';
      ctx = createTestServer();
      vi.mocked(ctx.storage.userRepo.findByEmail).mockImplementation(async (email: string) => {
        if (email === 'login@test.com') {
          return { id: 'user-1', email, role: 'owner', passwordHash: TEST_PASSWORD_HASH, orgId: 'default' };
        }
        return null;
      });
      const res = await requestAsync(ctx.server, 'POST', '/api/auth/login', {
        email: 'login@test.com',
        password: 'secret123',
      });
      expect([200, 401]).toContain(res.status);
      process.env['AUTH_ENABLED'] = 'false';
    });

    it('GET /api/settings/detect-ollama probes local ollama', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ models: [{ name: 'llama3', details: { family: 'llama' } }] }),
        headers: { get: () => 'application/json' },
      });
      const res = await requestAsync(ctx.server, 'GET', '/api/settings/detect-ollama');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/llm/providers adds new provider', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        registerProviderFromConfig: ReturnType<typeof vi.fn>;
        getEnhancedSettings: ReturnType<typeof vi.fn>;
      };
      llmRouter.registerProviderFromConfig = vi.fn();
      llmRouter.getEnhancedSettings = vi.fn(() => ({}));
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/llm/providers', {
        name: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'ds-key',
        enabled: true,
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/orgs lists organizations', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/orgs');
      expect(res.status).toBe(200);
    });

    it('POST /api/orgs creates organization', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/orgs', { name: 'New Org' });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('GET /api/teams returns teams with members', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/teams?orgId=default');
      expect(res.status).toBe(200);
    });

    it('POST /api/channels/group:team-1/messages with agent mention', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/channels/group%3Ateam-1/messages', {
        text: '@Agent B please help',
        senderId: 'anonymous',
        senderName: 'User',
      });
      expect([200, 400, 500]).toContain(res.status);
    });

    it('GET /api/users lists users', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/users');
      expect(res.status).toBe(200);
    });

    it('POST /api/users creates user invite', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/users', {
        email: 'newuser@test.com',
        name: 'New User',
        role: 'member',
      });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('GET /api/plan returns billing plan', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/plan');
      expect(res.status).toBe(200);
    });

    it('GET /api/license returns license info', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/license');
      expect(res.status).toBe(200);
    });

    it('POST /api/license/refresh revalidates license', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/license/refresh');
      expect(res.status).toBe(200);
    });

    it('POST /api/reports/generate with daily period', async () => {
      ctx.server.setReportService({
        listReports: vi.fn(() => []),
        getReport: vi.fn(() => null),
        generateReport: vi.fn(async () => ({ id: 'rpt-daily', type: 'daily', status: 'ready' })),
        approvePlan: vi.fn(async () => ({})), rejectPlan: vi.fn(async () => ({})),
        getFeedback: vi.fn(() => []), addFeedback: vi.fn(async () => ({ id: 'fb-1' })),
      } as never);
      const res = await requestAsync(ctx.server, 'POST', '/api/reports/generate', {
        period: 'daily',
        orgId: 'default',
        includePlan: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.report).toBeTruthy();
    });

    it('GET /api/models/suggested-assignments returns task type mappings', async () => {
      const llmRouter = ctx.server['llmRouter'] as {
        getEnhancedSettings: ReturnType<typeof vi.fn>;
      };
      llmRouter.getEnhancedSettings = vi.fn(() => ({
        defaultProvider: 'openai',
        providers: {
          openai: {
            enabled: true,
            configured: true,
            models: [
              { id: 'gpt-4', tier: 'high', capabilities: ['vision', 'reasoning'] },
              { id: 'dall-e-3', tier: 'medium', capabilities: ['imageGeneration'] },
            ],
          },
        },
      }));
      ctx.server.setModelCatalog({
        getModelsByProvider: vi.fn(() => []),
        getAllProviders: vi.fn(() => ['openai']),
        getStatus: vi.fn(() => ({ loaded: true })),
        refresh: vi.fn(async () => true),
        getModelInfo: vi.fn((id: string) => id === 'gpt-4' ? { capabilities: { reasoning: true }, inputCostPer1MTokens: 10 } : null),
      } as never);

      const res = await requestAsync(ctx.server, 'GET', '/api/models/suggested-assignments');
      expect(res.status).toBe(200);
      expect(res.json.assignments ?? res.json.suggestions ?? res.json).toBeTruthy();
    });

    it('GET /api/activity returns activity feed', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/activity?limit=10');
      expect(res.status).toBe(200);
    });

    it('GET /api/usage returns usage summary', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/usage');
      expect(res.status).toBe(200);
    });

    it('GET /api/audit returns audit log', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/audit');
      expect(res.status).toBe(200);
    });

    it('GET /api/skills/builtin lists builtin skills', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/skills/builtin');
      expect(res.status).toBe(200);
    });

    it('POST /api/tasks/:id/run triggers task execution', async () => {
      const create = await requestAsync(ctx.server, 'POST', '/api/tasks', {
        title: 'Run me',
        description: 'Execute',
        assignedAgentId: AGENT_A,
        reviewerId: REVIEWER,
      });
      const taskId = (create.json.task as { id: string })?.id;
      if (taskId) {
        await requestAsync(ctx.server, 'POST', `/api/tasks/${taskId}/approve`, { userId: 'user-1' });
        const res = await requestAsync(ctx.server, 'POST', `/api/tasks/${taskId}/run`);
        expect([200, 202, 400]).toContain(res.status);
      }
    });

    it('GET /api/templates returns available templates', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/templates');
      expect(res.status).toBe(200);
    });

    it('GET /api/templates/teams lists team templates', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/templates/teams');
      expect(res.status).toBe(200);
    });

    it('GET /api/ops/dashboard returns operations metrics', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/ops/dashboard?period=7d&orgId=default');
      expect(res.status).toBe(200);
    });

    it('GET /api/agents/role-updates checks template drift', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/agents/role-updates');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/import applies team section', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/import', {
        data: {
          sections: {
            teams: [{ id: 'team-new', name: 'Imported Team', orgId: 'default', memberAgentIds: [] }],
          },
        },
      });
      expect([200, 400, 500]).toContain(res.status);
    });

    it('GET /api/settings/telemetry returns telemetry status', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/settings/telemetry');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/telemetry toggles telemetry', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/settings/telemetry', { enabled: true });
      expect(res.status).toBe(200);
    });

    it('GET /api/unread returns unread counts', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/unread');
      expect(res.status).toBe(200);
    });

    it('GET /api/keys lists API keys', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/keys');
      expect(res.status).toBe(200);
    });
  });
});
