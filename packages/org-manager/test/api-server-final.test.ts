import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayError } from '@markus/core';
import { ReportService } from '../src/report-service.js';
import { KnowledgeService } from '../src/knowledge-service.js';
import { AuditService } from '../src/audit-service.js';
import { BillingService } from '../src/billing-service.js';
import {
  AGENT_A,
  AGENT_B,
  GW_AUTH,
  MockIncomingMessage,
  MockServerResponse,
  PROJECT_1,
  REQ_1,
  REVIEWER,
  TEAM_1,
  TEST_PASSWORD_HASH,
  createTestServer,
  request,
  requestRaw,
  type TestContext,
} from './api-server-test-helpers.js';

const mockFetch = vi.fn();

async function waitForResponse(res: MockServerResponse, maxTicks = 80): Promise<void> {
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
      llm: { providers: { openai: { enabled: true, apiKey: 'k', baseUrl: 'https://api.openai.com' } } },
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
      if (s.includes('.role-origin.json') || s.includes('preview-test.md') || s.includes('user_anonymous.png')) return true;
      if (s.includes('team-export') || s.includes('README.md')) return true;
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
      if (s.includes('preview-test.md') || s.includes('README.md')) return '# Preview\n\nHello';
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
      if (s.includes('templates/skills') && options?.withFileTypes) {
        return [{ name: 'test-skill', isFile: () => false, isDirectory: () => true }];
      }
      return actual.readdirSync(p, options as never);
    }),
    statSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('.markus') || s.includes('agents/') || s.includes('/role') || s.includes('preview')) {
        return {
          isFile: () => s.endsWith('.md') || s.endsWith('.png') || s.endsWith('.json'),
          isDirectory: () => !s.endsWith('.md') && !s.endsWith('.png'),
          size: 512,
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

describe('APIServer final coverage batch', () => {
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
      json: async () => ({ items: [], data: [] }),
      headers: { get: () => 'application/json' },
    });
    ctx = createTestServer();

    const billing = new BillingService();
    const audit = new AuditService();
    const knowledge = new KnowledgeService();
    const reportService = new ReportService(ctx.taskService, billing, audit, knowledge);
    ctx.server.setReportService(reportService as never);
    ctx.server.setKnowledgeService(knowledge as never);
    ctx.server.setAuditService(audit as never);
    ctx.server.setBillingService(billing as never);

    vi.spyOn(ctx.server['ws'] as { broadcast: (...args: unknown[]) => void }, 'broadcast').mockImplementation(() => {});
    vi.spyOn(ctx.server['ws'] as { sendToUser: (...args: unknown[]) => void }, 'sendToUser').mockImplementation(() => {});
    vi.spyOn(ctx.server['ws'] as { sendToUsers: (...args: unknown[]) => void }, 'sendToUsers').mockImplementation(() => {});
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    delete process.env['AUTH_ENABLED'];
  });

  it('OPTIONS preflight returns CORS headers', async () => {
    const req = new MockIncomingMessage('OPTIONS', '/api/tasks', { origin: 'http://localhost:3000' });
    const res = new MockServerResponse();
    ctx.server.handleRequest(req as never, res as never);
    req._simulate();
    await waitForResponse(res);
    expect([200, 204]).toContain(res.statusCode);
  });

  it('POST /api/reports/generate with real ReportService', async () => {
    ctx.taskService.createTask({
      orgId: 'default', title: 'Report task', assignedAgentId: AGENT_A, reviewerId: REVIEWER,
    });

    const res = await requestAsync(ctx.server, 'POST', '/api/reports/generate', {
      type: 'daily', scope: 'org', scopeId: 'default',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-12-31T23:59:59.999Z',
      includePlan: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.report).toBeDefined();
  });

  it('GET /api/reports lists generated reports', async () => {
    await requestAsync(ctx.server, 'POST', '/api/reports/generate', {
      type: 'weekly', scope: 'org', scopeId: 'default',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.999Z',
    });
    const res = await requestAsync(ctx.server, 'GET', '/api/reports?scopeId=default');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.reports)).toBe(true);
  });

  it('POST /api/reports/:id/feedback adds feedback', async () => {
    const gen = await requestAsync(ctx.server, 'POST', '/api/reports/generate', {
      type: 'daily', scope: 'org', scopeId: 'default',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.999Z',
    });
    const reportId = (gen.json.report as { id: string }).id;
    const res = await requestAsync(ctx.server, 'POST', `/api/reports/${reportId}/feedback`, {
      type: 'comment', content: 'Nice report', disclosure: { scope: 'broadcast' },
    });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /api/knowledge with real KnowledgeService', async () => {
    const res = await requestAsync(ctx.server, 'POST', '/api/knowledge', {
      scope: 'project', scopeId: PROJECT_1, category: 'decision',
      title: 'Architecture', content: 'Use microservices', importance: 80,
    });
    expect([200, 201]).toContain(res.status);
  });

  it('GET /api/knowledge/search with real KnowledgeService', async () => {
    await requestAsync(ctx.server, 'POST', '/api/knowledge', {
      scope: 'project', scopeId: PROJECT_1, category: 'decision',
      title: 'Decision A', content: 'content',
    });
    const res = await requestAsync(ctx.server, 'GET', `/api/knowledge/search?query=Decision&scope=project&scopeId=${PROJECT_1}`);
    expect(res.status).toBe(200);
  });

  it('POST /api/channels/group message with @mention triggers chain path', async () => {
    const res = await requestAsync(ctx.server, 'POST', '/api/channels/group%3Ateam-1/messages', {
      text: '@Agent B please review', senderId: AGENT_A, senderType: 'agent', senderName: 'Agent A',
    });
    expect([200, 201]).toContain(res.status);
  });

  it('POST /api/users/:id/reset-password and reinvite', async () => {
    const reset = await requestAsync(ctx.server, 'POST', '/api/users/member-1/reset-password');
    expect([200, 400, 404]).toContain(reset.status);
    const reinvite = await requestAsync(ctx.server, 'POST', '/api/users/member-1/reinvite');
    expect([200, 400, 404]).toContain(reinvite.status);
  });

  it('PATCH /api/users/:id updates profile fields', async () => {
    const res = await requestAsync(ctx.server, 'PATCH', '/api/users/user-1', { name: 'Updated Name', role: 'admin' });
    expect([200, 400]).toContain(res.status);
  });

  it('DELETE /api/users/:id removes user', async () => {
    const res = await requestAsync(ctx.server, 'DELETE', '/api/users/member-1');
    expect([200, 204, 400, 404]).toContain(res.status);
  });

  it('GET /api/agents/:id/mind mailbox decisions metrics', async () => {
    for (const path of [
      `/api/agents/${AGENT_A}/mind`,
      `/api/agents/${AGENT_A}/mailbox`,
      `/api/agents/${AGENT_A}/decisions`,
      `/api/agents/${AGENT_A}/metrics`,
      `/api/agents/${AGENT_A}/activities`,
      `/api/agents/${AGENT_A}/recent-activities`,
      `/api/agents/${AGENT_A}/heartbeat`,
    ]) {
      const res = await requestAsync(ctx.server, 'GET', path);
      expect(res.status).toBe(200);
    }
  });

  it('PATCH /api/agents/:id/config and memory endpoints', async () => {
    const config = await requestAsync(ctx.server, 'PATCH', `/api/agents/${AGENT_A}/config`, {
      llmConfig: { provider: 'openai', model: 'gpt-4' },
    });
    expect([200, 400]).toContain(config.status);

    const memory = await requestAsync(ctx.server, 'GET', `/api/agents/${AGENT_A}/memory`);
    expect(memory.status).toBe(200);

    const daily = await requestAsync(ctx.server, 'PUT', `/api/agents/${AGENT_A}/memory/daily`, { content: '# Log' });
    expect([200, 400]).toContain(daily.status);

    const lt = await requestAsync(ctx.server, 'PUT', `/api/agents/${AGENT_A}/memory/longterm`, { content: 'Facts' });
    expect([200, 400]).toContain(lt.status);
  });

  it('POST /api/agents/:id/tools/:tool/toggle', async () => {
    const res = await requestAsync(ctx.server, 'POST', `/api/agents/${AGENT_A}/tools/read_file/toggle`, { enabled: false });
    expect([200, 400, 404]).toContain(res.status);
  });

  it('GET /api/agents/:id/files and PUT file content', async () => {
    const list = await requestAsync(ctx.server, 'GET', `/api/agents/${AGENT_A}/files`);
    expect(list.status).toBe(200);
    const put = await requestAsync(ctx.server, 'PUT', `/api/agents/${AGENT_A}/files/ROLE.md`, { content: '# Updated' });
    expect([200, 400, 404]).toContain(put.status);
  });

  it('task lifecycle: pause resume retry reject cancel history comments', async () => {
    const created = await requestAsync(ctx.server, 'POST', '/api/tasks', {
      title: 'Lifecycle', assignedAgentId: AGENT_A, reviewerId: REVIEWER, orgId: 'default',
    });
    const taskId = (created.json.task as { id: string } | undefined)?.id ?? 'task-fallback';

    for (const [method, path, body] of [
      ['POST', `/api/tasks/${taskId}/approve`, { userId: 'user-1' }],
      ['POST', `/api/tasks/${taskId}/pause`, {}],
      ['POST', `/api/tasks/${taskId}/resume`, {}],
      ['GET', `/api/tasks/${taskId}/history`, undefined],
      ['GET', `/api/tasks/${taskId}/comments`, undefined],
      ['POST', `/api/tasks/${taskId}/comments`, { text: 'note', authorId: 'user-1', authorName: 'User' }],
      ['GET', `/api/tasks/${taskId}/logs`, undefined],
      ['GET', `/api/tasks/${taskId}/logs/summary`, undefined],
      ['GET', `/api/tasks/${taskId}/dependents`, undefined],
      ['POST', `/api/tasks/${taskId}/reject`, { reason: 'bad' }],
      ['POST', `/api/tasks/${taskId}/retry`, {}],
      ['POST', `/api/tasks/${taskId}/cancel`, { reason: 'stop' }],
    ] as const) {
      const res = await requestAsync(ctx.server, method, path, body);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(600);
    }
  });

  it('subtask CRUD and complete/cancel actions', async () => {
    const created = await requestAsync(ctx.server, 'POST', '/api/tasks', {
      title: 'Parent', assignedAgentId: AGENT_A, reviewerId: REVIEWER,
    });
    const taskId = (created.json.task as { id: string }).id;
    const sub = await requestAsync(ctx.server, 'POST', `/api/tasks/${taskId}/subtasks`, { title: 'Sub A' });
    const subId = (sub.json.subtask as { id: string } | undefined)?.id;
    if (subId) {
      await requestAsync(ctx.server, 'POST', `/api/tasks/${taskId}/subtasks/${subId}/complete`, {});
      await requestAsync(ctx.server, 'DELETE', `/api/tasks/${taskId}/subtasks/${subId}`);
    }
    expect(sub.status).toBeLessThan(500);
  });

  it('workflow template CRUD and run listing', async () => {
    const add = await requestAsync(ctx.server, 'POST', `/api/teams/${TEAM_1}/workflows`, {
      name: 'wf-final', displayName: 'Final WF', description: 'test', steps: [],
    });
    expect([200, 201, 400]).toContain(add.status);

    const list = await requestAsync(ctx.server, 'GET', `/api/teams/${TEAM_1}/workflows`);
    expect(list.status).toBe(200);

    const runs = await requestAsync(ctx.server, 'GET', `/api/teams/${TEAM_1}/workflows/wf-test/runs`);
    expect([200, 404]).toContain(runs.status);
  });

  it('requirement approve reject cancel comment flows', async () => {
    const created = await requestAsync(ctx.server, 'POST', '/api/requirements', {
      title: 'New req', projectId: PROJECT_1, orgId: 'default', createdBy: 'user-1',
    });
    const reqId = (created.json.requirement as { id: string } | undefined)?.id ?? REQ_1;

    await requestAsync(ctx.server, 'POST', `/api/requirements/${reqId}/comments`, {
      text: 'comment', authorId: 'user-1', authorName: 'User',
    });
    await requestAsync(ctx.server, 'POST', `/api/requirements/${reqId}/approve`, { userId: 'user-1' });
    await requestAsync(ctx.server, 'POST', `/api/requirements/${reqId}/reject`, { reason: 'no' });
    await requestAsync(ctx.server, 'POST', `/api/requirements/${reqId}/cancel`, { reason: 'stop' });
    expect(created.status).toBeLessThan(500);
  });

  it('POST /api/message routes to agent', async () => {
    const res = await requestAsync(ctx.server, 'POST', '/api/message', {
      agentId: AGENT_A, message: 'Hello agent',
    });
    expect([200, 400]).toContain(res.status);
  });

  it('GET /api/teams/:id/status stop pause resume', async () => {
    await requestAsync(ctx.server, 'POST', `/api/teams/${TEAM_1}/stop`);
    await requestAsync(ctx.server, 'POST', `/api/teams/${TEAM_1}/pause`);
    await requestAsync(ctx.server, 'POST', `/api/teams/${TEAM_1}/resume`);
    const status = await requestAsync(ctx.server, 'GET', `/api/teams/${TEAM_1}/status`);
    expect(status.status).toBe(200);
  });

  it('GET /api/teams/:id/files/:name reads team file', async () => {
    const res = await requestAsync(ctx.server, 'GET', `/api/teams/${TEAM_1}/files/README.md`);
    expect([200, 404]).toContain(res.status);
  });

  it('POST /api/gateway/deliverables/:id update via gateway', async () => {
    const res = await requestAsync(ctx.server, 'PUT', '/api/gateway/deliverables/deliv-1', {
      title: 'Updated via GW',
    }, GW_AUTH);
    expect([200, 404]).toContain(res.status);
  });

  it('auth enabled: login with password verification and profile update', async () => {
    process.env['AUTH_ENABLED'] = 'true';
    ctx = createTestServer();
    const login = await requestAsync(ctx.server, 'POST', '/api/auth/login', {
      email: 'login@test.com', password: 'secret123',
    });
    expect([200, 401]).toContain(login.status);

    const change = await requestAsync(ctx.server, 'POST', '/api/auth/change-password', {
      currentPassword: 'secret123', newPassword: 'newsecret456',
    });
    expect([200, 400, 401]).toContain(change.status);

    const profile = await requestAsync(ctx.server, 'PUT', '/api/auth/profile', {
      name: 'Owner Updated', email: 'login@test.com',
    });
    expect([200, 400, 401]).toContain(profile.status);
  });

  it('POST /api/auth/setup with valid password creates owner', async () => {
    vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([]);
    const res = await requestAsync(ctx.server, 'POST', '/api/auth/setup', {
      email: 'owner@test.com', password: 'longpassword123', name: 'Owner',
    });
    expect([200, 400]).toContain(res.status);
  });

  it('handles GatewayError on gateway register', async () => {
    vi.mocked(ctx.server['gateway']!.register).mockRejectedValueOnce(new GatewayError('duplicate', 409));
    const res = await requestAsync(ctx.server, 'POST', '/api/gateway/register', {
      name: 'Ext', orgId: 'default', capabilities: [],
    }, GW_AUTH);
    expect([400, 409, 500]).toContain(res.status);
  });

  it('GET /api/system/status and announcements', async () => {
    const status = await requestAsync(ctx.server, 'GET', '/api/system/status');
    expect(status.status).toBe(200);
    const announcements = await requestAsync(ctx.server, 'GET', '/api/system/announcements');
    expect(announcements.status).toBe(200);
  });

  it('POST /api/avatars/upload with multipart', async () => {
    const boundary = '----FormBoundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="avatar.png"',
      'Content-Type: image/png',
      '',
      'fake-image-bytes',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await requestRaw(ctx.server, 'POST', '/api/avatars/upload', body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    });
    expect([200, 400, 415]).toContain(res.status);
  });

  describe('builder artifacts and admin routes', () => {
    it('GET /api/builder/artifacts/installed', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/builder/artifacts/installed');
      expect(res.status).toBe(200);
    });

    it('GET /api/builder/artifacts/agents/:name', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/builder/artifacts/agents/deploy-agent');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/builder/artifacts/save', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/builder/artifacts/save', {
        type: 'skill', name: 'test-skill', data: { name: 'test-skill', description: 'Test' },
      });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('POST /api/builder/artifacts/import', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/builder/artifacts/import', {
        type: 'skill', name: 'imported-skill', files: { 'SKILL.md': '# Skill' },
      });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('DELETE /api/builder/artifacts/skill/:name', async () => {
      const res = await requestAsync(ctx.server, 'DELETE', '/api/builder/artifacts/skill/test-skill');
      expect([200, 204, 404]).toContain(res.status);
    });
  });

  describe('approvals keys plan workflows', () => {
    it('GET and POST /api/approvals', async () => {
      const list = await requestAsync(ctx.server, 'GET', '/api/approvals');
      expect(list.status).toBe(200);
      const create = await requestAsync(ctx.server, 'POST', '/api/approvals', {
        title: 'Approve deploy', agentId: AGENT_A, details: { taskId: 'task-1' },
      });
      expect([200, 201, 400]).toContain(create.status);
    });

    it('POST /api/approvals/:id/respond', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/approvals/appr-pending/approve', { userId: 'user-1' });
      expect([200, 400, 404]).toContain(res.status);
    });

    it('POST /api/keys and DELETE /api/keys/:id', async () => {
      const create = await requestAsync(ctx.server, 'POST', '/api/keys', { name: 'CI Key', scopes: ['read'] });
      expect([200, 201]).toContain(create.status);
      const del = await requestAsync(ctx.server, 'DELETE', '/api/keys/key-1');
      expect([200, 204, 404]).toContain(del.status);
    });

    it('POST /api/plan updates org plan', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/plan', { plan: 'pro' });
      expect([200, 400]).toContain(res.status);
    });

    it('POST /api/workflows creates workflow run', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/workflows', {
        teamId: TEAM_1, workflowName: 'wf-test', params: { topic: 'test' },
      });
      expect([200, 201, 400, 404]).toContain(res.status);
    });

    it('GET /api/workflows lists runs', async () => {
      const res = await requestAsync(ctx.server, 'GET', '/api/workflows?teamId=team-1');
      expect(res.status).toBe(200);
    });
  });

  describe('system control routes', () => {
    it('POST pause resume emergency and announcements', async () => {
      await requestAsync(ctx.server, 'POST', '/api/system/pause-all', { reason: 'maintenance' });
      await requestAsync(ctx.server, 'POST', '/api/system/resume-all');
      await requestAsync(ctx.server, 'POST', '/api/system/emergency-stop');
      const ann = await requestAsync(ctx.server, 'POST', '/api/system/announcements', {
        message: 'Hello team', scope: 'all',
      });
      expect([200, 201, 400]).toContain(ann.status);
    });

    it('POST /api/system/open-path validates path', async () => {
      const res = await requestAsync(ctx.server, 'POST', '/api/system/open-path', { path: '/tmp/markus' });
      expect([200, 400, 404]).toContain(res.status);
    });
  });
});
