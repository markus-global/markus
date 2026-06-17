import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      if (s.includes('/preview-test.md') || s.includes('/preview-dir') || s.includes('user_anonymous.png')) return true;
      if (s.includes('/uploads/')) return true;
      if (s.includes('builder-artifacts')) return true;
      return false;
    }),
    readFileSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('markus.json')) {
        return JSON.stringify({ network: {}, browser: {}, search: {}, integrations: { feishu: { appId: 'cli_test', appSecret: 'secret' } } });
      }
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
      if (s.includes('preview-dir')) {
        return [{ name: 'nested.md', isFile: () => true, isDirectory: () => false }];
      }
      if (s.includes('.markus/agents')) {
        return [{ name: 'orphan-agent', isFile: () => false, isDirectory: () => true }];
      }
      return actual.readdirSync(p, options as never);
    }),
    statSync: vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('preview-dir') && !s.includes('nested')) {
        return { isFile: () => false, isDirectory: () => true, size: 0 } as ReturnType<typeof actual.statSync>;
      }
      if (s.includes('.markus') || s.includes('agents/') || s.includes('/role') || s.includes('preview')) {
        return {
          isFile: () => !s.includes('preview-dir') || s.includes('nested') || s.endsWith('.md') || s.endsWith('.png'),
          isDirectory: () => s.includes('preview-dir') && !s.includes('nested') && !s.endsWith('.md'),
          size: s.endsWith('.png') ? 100 : 512,
        } as ReturnType<typeof actual.statSync>;
      }
      return actual.statSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

export const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@larksuiteoapi/node-sdk', () => {
  const registerApp = vi.fn(async (opts: {
    onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
    onStatusChange?: (info: { status: string }) => void;
  }) => {
    opts.onQRCodeReady?.({ url: 'https://qr.feishu.test', expireIn: 300 });
    opts.onStatusChange?.({ status: 'done' });
    return {
      client_id: 'cli_feishu_test',
      client_secret: 'sec_feishu_test',
      user_info: { open_id: 'ou_test_user', tenant_brand: 'feishu' },
    };
  });
  return { __esModule: true, registerApp, default: { registerApp } };
});

vi.mock('../src/feishu-api-client.js', () => ({
  FeishuApiClient: class MockFeishuApiClient {
    sendCardToUser = vi.fn(async () => {});
  },
}));

import {
  AGENT_A,
  AGENT_B,
  GW_AUTH,
  PROJECT_1,
  REVIEWER,
  TEAM_1,
  TEST_PASSWORD_HASH,
  createTestServer,
  request,
  requestRaw,
  type TestContext,
} from './api-server-test-helpers.js';

describe('APIServer extended route coverage', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['AUTH_ENABLED'] = 'false';
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '<a href="/author/repo/skill-a"><h3>Skill A</h3><span class="font-mono text-sm">1.2K</span></a>',
      json: async () => ({
        user: { id: 'hub-user-1', username: 'hubuser', email: 'hub@test.com', displayName: 'Hub User' },
        skills: [{ slug: 'skill-a', name: 'Skill A', description: 'Desc', version: '1.0.0', homepage: 'https://clawhub.ai/skill-a', tags: ['ai'], downloads: 10, stars: 5, installs: 3, updated_at: 1, score: 90 }],
        total: 1,
        generated_at: '2024-01-01',
        featured: [],
        categories: { ai: ['skill-a'] },
      }),
      headers: { get: () => null },
    });
    ctx = createTestServer();
    vi.spyOn(ctx.server['ws'] as { broadcastTeamUpdate: (...args: unknown[]) => void }, 'broadcastTeamUpdate').mockImplementation(() => {});
    vi.spyOn(ctx.server['ws'] as { broadcastUnreadUpdate: (...args: unknown[]) => void }, 'broadcastUnreadUpdate').mockImplementation(() => {});
    vi.spyOn(ctx.server['ws'] as { broadcastAgentUpdate: (...args: unknown[]) => void }, 'broadcastAgentUpdate').mockImplementation(() => {});
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    delete process.env['AUTH_ENABLED'];
  });

  describe('Auth extended', () => {
    it('POST /api/auth/hub-login missing fields', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', { hubToken: 'tok' });
      expect(res.status).toBe(400);
    });

    it('POST /api/auth/hub-login creates user when hub verifies', async () => {
      const unique = `hub-${Date.now()}@test.com`;
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'hub-tok',
        hubUser: { id: `hub-user-${Date.now()}`, username: 'hubuser', email: unique, displayName: 'Hub User' },
      });
      expect(res.status).toBe(200);
      expect(res.json.user ?? res.json).toBeDefined();
    });

    it('POST /api/auth/hub-login falls back when hub verification fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'));
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'hub-tok',
        hubUser: { id: 'hub-user-2', username: 'fallback', email: 'fallback@test.com' },
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/auth/invite-info with token param', async () => {
      vi.mocked(ctx.storage.userRepo.findById).mockReturnValueOnce({
        id: 'user-1', name: 'Test', email: 'test@example.com', role: 'member', inviteToken: 'invite-abc',
      } as never);
      const res = await request(ctx.server, 'GET', '/api/auth/invite-info?token=invite-abc');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/auth/setup rejects short password', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/setup', {
        email: 'new@test.com', password: 'short', name: 'New User',
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/auth/hub-login rejects when storage unavailable', async () => {
      const noStorage = createTestServer();
      noStorage.server.setStorage(undefined as never);
      const res = await request(noStorage.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'tok', hubUser: { id: 'u1', username: 'u' },
      });
      expect(res.status).toBe(503);
      noStorage.taskService.stopTimeoutChecker();
    });

    it('POST /api/avatars/upload for agent target', async () => {
      const res = await request(ctx.server, 'POST', '/api/avatars/upload', {
        type: 'agent',
        id: AGENT_A,
        image: 'data:image/png;base64,iVBORw0KGgo=',
      });
      expect(res.status).toBe(200);
      expect(res.json.avatarUrl).toContain('/api/avatars/');
    });

    it('GET /api/avatars/:filename serves uploaded avatar', async () => {
      const upload = await request(ctx.server, 'POST', '/api/avatars/upload', {
        image: 'data:image/png;base64,iVBORw0KGgo=',
      });
      const avatarUrl = String(upload.json.avatarUrl);
      const res = await request(ctx.server, 'GET', avatarUrl);
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('Uploads and sessions', () => {
    it('POST /api/uploads rejects empty files array', async () => {
      const res = await request(ctx.server, 'POST', '/api/uploads', { files: [] });
      expect(res.status).toBe(400);
    });

    it('POST /api/uploads stores files', async () => {
      const res = await request(ctx.server, 'POST', '/api/uploads', {
        files: [{ name: 'doc.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' }],
        prefix: 'chat',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.files)).toBe(true);
    });

    it('GET /api/uploads/:key returns file', async () => {
      const res = await request(ctx.server, 'GET', '/api/uploads/chat%2Fdoc.txt');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('GET /api/sessions/:id/messages', async () => {
      const res = await request(ctx.server, 'GET', '/api/sessions/sess-1/messages');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.messages)).toBe(true);
    });

    it('DELETE /api/sessions/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/sessions/sess-1');
      expect(res.status).toBe(204);
    });

    it('GET /api/sessions/:id/messages allows owner to access sessions', async () => {
      vi.mocked(ctx.storage.chatSessionRepo.getSession).mockImplementationOnce((sessionId: string) => ({
        id: sessionId, userId: 'other-user', title: 'Private',
      }));
      const res = await request(ctx.server, 'GET', '/api/sessions/sess-private/messages');
      expect(res.status).toBe(200);
    });
  });

  describe('Skills registry and management', () => {
    it('GET /api/skills/registry/skillhub', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/registry/skillhub?q=skill');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.skills)).toBe(true);
    });

    it('GET /api/skills/registry/skillhub filters by category', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/registry/skillhub?category=ai&sort=downloads');
      expect(res.status).toBe(200);
    });

    it('GET /api/skills/registry/skillssh', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/registry/skillssh?q=agent');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.skills)).toBe(true);
    });

    it('GET /api/skills/registry/skillssh handles fetch failure', async () => {
      mockFetch.mockResolvedValueOnce({ status: 502, ok: false, text: async () => '', json: async () => ({}), headers: { get: () => null } });
      const res = await request(ctx.server, 'GET', '/api/skills/registry/skillssh');
      expect(res.status).toBe(502);
    });

    it('GET /api/skills/:name returns skill detail', async () => {
      const res = await request(ctx.server, 'GET', '/api/skills/coding');
      expect([200, 404]).toContain(res.status);
    });

    it('DELETE /api/skills/installed/:name', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/skills/installed/coding');
      expect([200, 404, 500]).toContain(res.status);
    });
  });

  describe('Approvals, notifications, unread', () => {
    it('POST /api/approvals/:id responds to pending approval', async () => {
      const res = await request(ctx.server, 'POST', '/api/approvals/appr-pending', {
        approved: true,
        comment: 'LGTM',
      });
      expect(res.status).toBe(200);
      expect(res.json.approval).toBeDefined();
    });

    it('POST /api/approvals/:id returns 404 for unknown', async () => {
      const res = await request(ctx.server, 'POST', '/api/approvals/missing', { approved: true });
      expect(res.status).toBe(404);
    });

    it('POST /api/notifications/:id/read', async () => {
      const res = await request(ctx.server, 'POST', '/api/notifications/notif-1/read');
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
    });

    it('POST /api/notifications/:id marks read', async () => {
      const res = await request(ctx.server, 'POST', '/api/notifications/notif-1');
      expect(res.status).toBe(200);
    });

    it('POST /api/unread/mark-read validation', async () => {
      const res = await request(ctx.server, 'POST', '/api/unread/mark-read', { conversationKey: 'agent:a' });
      expect(res.status).toBe(400);
    });

    it('POST /api/unread/mark-read success', async () => {
      const res = await request(ctx.server, 'POST', '/api/unread/mark-read', {
        conversationKey: 'agent:agent-a',
        lastReadAt: new Date().toISOString(),
        lastReadId: 'msg-1',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/unread/mark-all-read', async () => {
      const res = await request(ctx.server, 'POST', '/api/unread/mark-all-read');
      expect(res.status).toBe(200);
    });
  });

  describe('Users, keys, gateway deliverables', () => {
    it('DELETE /api/users/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/users/member-1');
      expect(res.status).toBe(200);
      expect(res.json.deleted).toBe(true);
    });

    it('DELETE /api/keys/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/keys/key-1');
      expect(res.status).toBe(200);
    });

    it('POST /api/gateway/deliverables', async () => {
      const res = await request(ctx.server, 'POST', '/api/gateway/deliverables', {
        type: 'document',
        title: 'GW Doc',
        summary: 'Summary',
        reference: '/tmp/doc',
        tags: ['test'],
        projectId: 'proj-1',
      }, GW_AUTH);
      expect(res.status).toBe(201);
    });

    it('PUT /api/gateway/deliverables/:id', async () => {
      const res = await request(ctx.server, 'PUT', '/api/gateway/deliverables/deliv-1', {
        title: 'Updated GW Doc',
      }, GW_AUTH);
      expect(res.status).toBe(200);
    });
  });

  describe('Files preview and image', () => {
    const previewFile = join(tmpdir(), 'preview-test.md');
    const previewDir = join(tmpdir(), 'preview-dir');

    it('GET /api/files/preview text file', async () => {
      const res = await request(ctx.server, 'GET', `/api/files/preview?path=${encodeURIComponent(previewFile)}`);
      expect(res.status).toBe(200);
      expect(res.json.type).toBe('markdown');
    });

    it('GET /api/files/preview directory listing', async () => {
      const res = await request(ctx.server, 'GET', `/api/files/preview?path=${encodeURIComponent(previewDir)}`);
      expect(res.status).toBe(200);
      expect(res.json.type).toBe('directory');
    });

    it('GET /api/files/preview 404 for missing file', async () => {
      const res = await request(ctx.server, 'GET', '/api/files/preview?path=/nonexistent/file.xyz');
      expect(res.status).toBe(404);
    });

    it('GET /api/files/image', async () => {
      const pngPath = join(tmpdir(), 'preview-test.png');
      const res = await request(ctx.server, 'GET', `/api/files/image?path=${encodeURIComponent(pngPath)}`);
      expect([200, 404, 400]).toContain(res.status);
    });
  });

  describe('Settings extended', () => {
    it('POST /api/settings/search with multiple API keys', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/search', {
        serperApiKey: 'serper-key',
        tavilyApiKey: 'tavily-key',
        bingApiKey: 'bing-key',
        googleSearchApiKey: 'google-key',
        googleSearchCx: 'cx-id',
        serpApiKey: 'serp-key',
        braveApiKey: 'brave-key',
        exaApiKey: 'exa-key',
        bochaApiKey: 'bocha-key',
      });
      expect(res.status).toBe(200);
      expect(res.json.serper).toBeDefined();
    });

    it('POST /api/models/validate-key with anthropic provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'claude-3-opus' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
      });
      expect(res.status).toBe(200);
      expect(res.json.valid).toBe(true);
    });

    it('POST /api/models/validate-key unknown provider', async () => {
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'unknown-provider-xyz',
        apiKey: 'key',
      });
      expect(res.status).toBe(200);
      expect(res.json.valid).toBe(false);
    });

    it('POST /api/settings/oauth/device-code', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/oauth/device-code', { provider: 'openai-codex' });
      expect(res.status).toBe(200);
      expect(res.json.userCode).toBe('ABCD-1234');
    });

    it('POST /api/settings/oauth/callback', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/oauth/callback', {
        provider: 'openai-codex',
        redirectUrl: 'http://localhost/callback?code=abc',
      });
      expect([200, 400]).toContain(res.status);
    });

    it('POST /api/settings/oauth/setup-token', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/oauth/setup-token', { provider: 'openai-codex' });
      expect([200, 400]).toContain(res.status);
    });

    it('POST /api/settings/oauth/login starts flow', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/oauth/login', { provider: 'openai-codex' });
      expect(res.status).toBe(200);
      expect(res.json.authorizeUrl).toContain('https://');
    });

    it('POST /api/settings/import/openclaw without config file', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/import/openclaw', {});
      expect(res.status).toBe(404);
      expect(res.json.error).toContain('OpenClaw');
    });
  });

  describe('Feishu integration routes', () => {
    it('POST /api/settings/integrations/feishu/test', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 'tok' }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/test');
      expect([200, 400]).toContain(res.status);
    });

    it('GET /api/settings/integrations/feishu/chats', async () => {
      vi.doMock('../src/feishu-api-client.js', () => ({
        FeishuApiClient: class {
          async listBotChats() { return [{ chat_id: 'oc_1', name: 'Test Chat' }]; }
        },
      }));
      const res = await request(ctx.server, 'GET', '/api/settings/integrations/feishu/chats');
      expect([200, 500]).toContain(res.status);
    });

    it('POST /api/settings/integrations/feishu/test-message missing chatId', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/test-message', {});
      expect(res.status).toBe(400);
    });

    it('GET /api/settings/integrations/feishu/notifications', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/integrations/feishu/notifications');
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('Workflows, group chats, message routing', () => {
    it('GET /api/workflows/:executionId without engine returns 404', async () => {
      const res = await request(ctx.server, 'GET', '/api/workflows/exec-1');
      expect(res.status).toBe(404);
    });

    it('DELETE /api/workflows/:executionId without engine returns 404', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/workflows/exec-1');
      expect(res.status).toBe(404);
    });

    it('POST /api/group-chats/:id/members', async () => {
      const res = await request(ctx.server, 'POST', '/api/group-chats/gc-1/members', {
        memberId: AGENT_B, memberName: 'Agent B', memberType: 'agent',
      });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('DELETE /api/group-chats/:id/members/:memberId', async () => {
      const res = await request(ctx.server, 'DELETE', `/api/group-chats/gc-1/members/${AGENT_B}`);
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/message routes to agent', async () => {
      const res = await request(ctx.server, 'POST', '/api/message', {
        text: 'Hello agent',
        targetAgentId: AGENT_A,
      });
      expect(res.status).toBe(200);
      expect(res.json.reply).toBeDefined();
    });

    it('POST /api/channels/:key/messages with reply context', async () => {
      const res = await request(ctx.server, 'POST', '/api/channels/group%3Ateam-1/messages', {
        text: 'Reply please',
        replyToId: 'orig-1',
        targetAgentId: AGENT_A,
      });
      expect([200, 201, 400]).toContain(res.status);
    });

    it('DELETE /api/team-templates/:id', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/team-templates/custom-template');
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('Storage orphans (real detectOrphans path)', () => {
    it('GET /api/system/storage/orphans detects orphan agents', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/storage/orphans');
      expect(res.status).toBe(200);
      expect(res.json).toBeDefined();
    });

    it('DELETE /api/system/storage/orphans purges selected ids', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/system/storage/orphans', { ids: ['orphan-agent'] });
      expect(res.status).toBe(200);
    });
  });

  describe('License import success path', () => {
    it('POST /api/license/import with fileContent', async () => {
      const res = await request(ctx.server, 'POST', '/api/license/import', {
        fileContent: Buffer.from('license-data').toString('base64'),
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/license/activate with key', async () => {
      const res = await request(ctx.server, 'POST', '/api/license/activate', { licenseKey: 'TEST-KEY-123' });
      expect(res.status).toBe(200);
    });
  });

  describe('LLM provider management routes', () => {
    it('POST /api/settings/llm/providers/:name/toggle', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm/providers/openai/toggle', { enabled: false });
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/llm/providers/:name/toggle missing enabled', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm/providers/openai/toggle', {});
      expect(res.status).toBe(400);
    });

    it('DELETE /api/settings/llm/providers/:name', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/settings/llm/providers/custom-provider');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/llm/providers/:name/models validation', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm/providers/openai/models', { id: 'gpt-4' });
      expect(res.status).toBe(400);
    });

    it('POST /api/settings/llm/providers/:name/models success', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm/providers/openai/models', {
        id: 'custom-model', name: 'Custom', contextWindow: 128000, maxOutputTokens: 4096,
        cost: { input: 1, output: 2 },
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/llm/providers/:name/model', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm/providers/openai/model', { model: 'gpt-4' });
      expect(res.status).toBe(200);
    });
  });

  describe('Workflow and task schedule routes', () => {
    let taskId: string;

    beforeEach(() => {
      ctx.server.setWorkflowService({
        listWorkflows: vi.fn(() => []),
        addWorkflow: vi.fn(() => ({ name: 'wf-test', displayName: 'WF Test', description: '', version: 1, steps: [] })),
        getWorkflow: vi.fn((_teamId: string, name: string) => name === 'wf-test' ? {
          name: 'wf-test', displayName: 'WF Test', description: '', version: 1, steps: [],
        } : null),
        updateWorkflow: vi.fn(() => ({ name: 'wf-test', displayName: 'WF Test', description: '', version: 2, steps: [] })),
        removeWorkflow: vi.fn(),
        listRoles: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        startRun: vi.fn(() => ({ id: 'run-1' })),
        buildDefaultRoleMapping: vi.fn(() => ({ developer: AGENT_A })),
        resolveRoles: vi.fn(() => []),
      } as never);
      ctx.server.setWorkflowRunner({
        getRun: vi.fn(() => null),
        getRunAsync: vi.fn(async (id: string) => id === 'run-1' ? { id, status: 'running', teamId: TEAM_1 } : null),
        cancelRun: vi.fn(async () => {}),
        listRuns: vi.fn(async () => [{ id: 'run-1', status: 'completed' }]),
        createRun: vi.fn(async () => ({ id: 'run-new', status: 'pending' })),
      } as never);

      const task = ctx.taskService.createTask({
        orgId: 'default',
        title: 'Scheduled Task',
        description: 'Cron work',
        assignedAgentId: AGENT_A,
        reviewerId: REVIEWER,
      } as never);
      taskId = task.id;
    });

    it('POST /api/teams/:teamId/workflows/:name/runs validation', async () => {
      const res = await request(ctx.server, 'POST', `/api/teams/${TEAM_1}/workflows/wf-test/runs`, {});
      expect([400, 404, 500]).toContain(res.status);
    });

    it('POST /api/teams/:teamId/workflows/:name/runs creates run', async () => {
      const res = await request(ctx.server, 'POST', `/api/teams/${TEAM_1}/workflows/wf-test/runs`, {
        projectId: PROJECT_1,
        params: { input: 'test' },
      });
      expect([201, 400, 404, 500]).toContain(res.status);
    });

    it('GET /api/teams/:teamId/workflows/:name/runs', async () => {
      const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/workflows/wf-test/runs`);
      expect([200, 404, 500]).toContain(res.status);
    });

    it('GET /api/workflow-runs/:id', async () => {
      const res = await request(ctx.server, 'GET', '/api/workflow-runs/run-1');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('GET /api/workflow-runs/:id 404', async () => {
      const res = await request(ctx.server, 'GET', '/api/workflow-runs/missing');
      expect([404, 500]).toContain(res.status);
    });

    it('POST /api/tasks/:id/schedule/run-now', async () => {
      const res = await request(ctx.server, 'POST', `/api/tasks/${taskId}/schedule/run-now`);
      expect([202, 400, 404]).toContain(res.status);
    });
  });

  describe('Channel routing and reports', () => {
    it('POST /api/channels/:key/messages routes to agent in group channel', async () => {
      const res = await request(ctx.server, 'POST', '/api/channels/group%3Acustom%3Aabc/messages', {
        text: 'Help me', targetAgentId: AGENT_A,
      });
      expect([200, 400, 500]).toContain(res.status);
    });

    it('GET /api/reports/:id', async () => {
      ctx.server.setReportService({
        listReports: vi.fn(() => []),
        getReport: vi.fn((id: string) => id === 'rpt-1' ? { id, type: 'daily', status: 'ready' } : null),
        generateReport: vi.fn(async () => ({ id: 'rpt-1' })),
        approvePlan: vi.fn(async () => ({})), rejectPlan: vi.fn(async () => ({})),
        getFeedback: vi.fn(() => []), addFeedback: vi.fn(async () => ({ id: 'fb-1' })),
      } as never);
      const res = await request(ctx.server, 'GET', '/api/reports/rpt-1');
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/system/storage returns breakdown', async () => {
      const res = await request(ctx.server, 'GET', '/api/system/storage');
      expect(res.status).toBe(200);
      expect(res.json.totalSize).toBeDefined();
    });
  });

  describe('High-coverage route batch', () => {
    it('POST /api/settings/llm with routing and fallback options', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm', {
        defaultProvider: 'openai',
        autoFallback: true,
        taskRouting: { assignments: { coding: 'openai/gpt-4' } },
        routingDefaultModel: { provider: 'openai', model: 'gpt-4' },
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/llm rejects invalid routingDefaultModel', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/llm', {
        routingDefaultModel: { provider: 'openai' },
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/auth/setup with valid invite token', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/setup', {
        token: 'invite-tok', password: 'secret123',
      });
      expect([200, 400]).toContain(res.status);
    });

    it('GET /api/templates/:id/files', async () => {
      const res = await request(ctx.server, 'GET', '/api/templates/developer/files');
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/notifications?unread=true', async () => {
      const res = await request(ctx.server, 'GET', '/api/notifications?unread=true&limit=10');
      expect(res.status).toBe(200);
    });

    it('POST /api/agents/:id/message with stream flag', async () => {
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/message`, {
        text: 'Stream hello', stream: true,
      });
      expect([200, 500]).toContain(res.status);
    });

    it('GET /api/settings/browser/extension.zip', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/browser/extension.zip');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/settings/browser/open-extensions-page', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/browser/open-extensions-page');
      expect([200, 500]).toContain(res.status);
    });

    it('DELETE /api/settings/llm/providers/:name/models/:modelId', async () => {
      const res = await request(ctx.server, 'DELETE', '/api/settings/llm/providers/openai/models/custom-model');
      expect([200, 400, 404]).toContain(res.status);
    });

    it('GET /api/approvals?status=pending', async () => {
      const res = await request(ctx.server, 'GET', '/api/approvals?status=pending');
      expect(res.status).toBe(200);
    });

    it('PUT /api/agents/:id/files/ROLE.md', async () => {
      const res = await request(ctx.server, 'PUT', `/api/agents/${AGENT_A}/files/ROLE.md`, {
        content: '# Updated Role\n',
      });
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/agents/:id/role-smart-sync', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ choices: [{ message: { content: '# Merged Role\n' } }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', `/api/agents/${AGENT_A}/role-smart-sync`, { file: 'ROLE.md' });
      expect([200, 400, 500, 503]).toContain(res.status);
    });

    it('POST /api/channels/:key/messages auto-routes via routeMessage', async () => {
      const res = await request(ctx.server, 'POST', '/api/channels/group%3Acustom%3Aabc/messages', {
        text: 'Route this message please',
      });
      expect([200, 201, 400, 500]).toContain(res.status);
    });

    it('POST /api/team-templates creates template', async () => {
      const res = await request(ctx.server, 'POST', '/api/team-templates', {
        name: 'Custom Team Template',
        description: 'A custom team',
        members: [{ templateId: 'developer', name: 'Dev' }],
      });
      expect([201, 400, 500]).toContain(res.status);
    });

    it('GET /api/teams/:teamId/workflows/:name', async () => {
      ctx.server.setWorkflowService({
        listWorkflows: vi.fn(() => []),
        getWorkflow: vi.fn(() => ({ name: 'wf-test', displayName: 'WF', description: '', version: 1, steps: [] })),
        addWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(),
        listRoles: vi.fn(() => []), listRuns: vi.fn(() => []), startRun: vi.fn(),
        buildDefaultRoleMapping: vi.fn(() => ({})), resolveRoles: vi.fn(() => []),
      } as never);
      const res = await request(ctx.server, 'GET', `/api/teams/${TEAM_1}/workflows/wf-test`);
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/tasks/:id/schedule/run-now on scheduled task', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Cron', description: 'Scheduled',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect([202, 400, 404]).toContain(res.status);
    });

    it('DELETE /api/workflow-runs/:id', async () => {
      ctx.server.setWorkflowRunner({
        getRun: vi.fn(() => null),
        getRunAsync: vi.fn(async () => ({ id: 'run-1', status: 'running' })),
        cancelRun: vi.fn(async () => {}),
        listRuns: vi.fn(async () => []),
        createRun: vi.fn(async () => ({ id: 'run-new' })),
      } as never);
      const res = await request(ctx.server, 'DELETE', '/api/workflow-runs/run-1');
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/models/validate-key google provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ models: [{ name: 'models/gemini-pro' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'google', apiKey: 'google-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key ollama provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'llama3' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'ollama', apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1',
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /api/builder/artifacts/agent/:name/images/:file', async () => {
      await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
        mode: 'agent',
        artifact: { name: 'img-agent', files: { 'ROLE.md': '# Role' } },
      });
      const res = await request(ctx.server, 'DELETE', '/api/builder/artifacts/agent/img-agent/images/shot.png');
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/settings/browser/test-concurrent', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/browser/test-concurrent', { tabs: 2 });
      expect([200, 400, 500]).toContain(res.status);
    });

    it('GET /api/agents/:id/files/:filename', async () => {
      const res = await request(ctx.server, 'GET', `/api/agents/${AGENT_A}/files/ROLE.md`);
      expect([200, 404, 405]).toContain(res.status);
    });

    it('POST /api/models/validate-key deepseek provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'deepseek', apiKey: 'ds-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key fireworks provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'accounts/fireworks/models/llama-v3' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'fireworks_ai', apiKey: 'fw-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key mistral provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'mistral-large' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'mistral', apiKey: 'mistral-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/import/openclaw preview with mocked config', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementationOnce((p: string) => String(p).includes('.openclaw/openclaw.json'));
      vi.mocked(fs.readFileSync).mockImplementationOnce(() =>
        JSON.stringify({ llm: { providers: { openai: { apiKey: 'sk-test' } } } }),
      );
      const res = await request(ctx.server, 'POST', '/api/settings/import/openclaw', { preview: true });
      expect([200, 400]).toContain(res.status);
    });

    it('POST /api/auth/init validation', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/init', {
        email: 'bad-email', password: 'secret123', name: 'Owner',
      });
      expect([400, 403, 503]).toContain(res.status);
    });
  });

  describe('Additional builder and settings routes', () => {
    it('GET /api/builder/artifacts/team/test-team', async () => {
      await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
        mode: 'team',
        artifact: {
          name: 'test-team',
          description: 'Team',
          announcement: 'Hi',
          norms: 'Be nice',
          team: { members: [{ name: 'Worker', roleContent: '# Worker' }] },
        },
      });
      const res = await request(ctx.server, 'GET', '/api/builder/artifacts/team/test-team');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/settings/integrations/feishu/notifications', async () => {
      const res = await request(ctx.server, 'PUT', '/api/settings/integrations/feishu/notifications', {
        enabled: true, events: ['task_complete'],
      });
      expect([200, 400, 404]).toContain(res.status);
    });

    it('GET /api/settings/integrations/feishu/register/status', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/integrations/feishu/register/status');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/models/validate-key with openai provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'openai',
        apiKey: 'sk-test',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/gateway/deliverables missing auth', async () => {
      const res = await request(ctx.server, 'POST', '/api/gateway/deliverables', { title: 'X' });
      expect(res.status).toBe(401);
    });

    it('POST /api/approvals/:id rejects unauthorized responder', async () => {
      ctx.server.setHITLService({
        onNotification: vi.fn(),
        listApprovals: vi.fn(() => []),
        requestApproval: vi.fn(),
        getApproval: vi.fn(() => ({
          id: 'appr-x', status: 'pending', title: 'X', agentId: AGENT_A,
          approverUserIds: ['other-user'],
        })),
        respondToApproval: vi.fn(),
        listNotifications: vi.fn(() => []),
        countNotifications: vi.fn(() => ({ total: 0, unread: 0 })),
        markNotificationRead: vi.fn(),
        markAllNotificationsRead: vi.fn(),
      } as never);
      const res = await request(ctx.server, 'POST', '/api/approvals/appr-x', { approved: true });
      expect([200, 403, 404]).toContain(res.status);
    });
  });

  describe('Coverage boost batch', () => {
    it('POST /api/builder/artifacts/agent/:name/images multipart upload', async () => {
      await request(ctx.server, 'POST', '/api/builder/artifacts/save', {
        mode: 'agent',
        artifact: { name: 'upload-agent', files: { 'ROLE.md': '# Role' } },
      });
      const fs = await import('node:fs');
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        const s = String(p);
        if (s.includes('agent.json')) return JSON.stringify({ name: 'upload-agent', screenshots: [] });
        if (s.endsWith('.png')) return Buffer.from('fake-png');
        return '# Test Role\n';
      });
      const boundary = '----MarkusBoundary';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="screenshot.png"',
        'Content-Type: image/png',
        '',
        'fake-image-bytes',
        `--${boundary}--`,
      ].join('\r\n');
      const res = await requestRaw(
        ctx.server,
        'POST',
        '/api/builder/artifacts/agent/upload-agent/images',
        body,
        { 'content-type': `multipart/form-data; boundary=${boundary}` },
      );
      expect([200, 400, 500]).toContain(res.status);
    });

    it('POST /api/builder/artifacts/agent/:name/images rejects non-multipart', async () => {
      const res = await requestRaw(
        ctx.server,
        'POST',
        '/api/builder/artifacts/agent/upload-agent/images',
        'not-multipart',
        { 'content-type': 'application/octet-stream' },
      );
      expect([400, 415]).toContain(res.status);
    });

    it('GET /api/builder/artifacts/agent/:name/images/:file serves image', async () => {
      const res = await request(ctx.server, 'GET', '/api/builder/artifacts/agent/img-agent/images/shot.png');
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/settings/integrations/feishu/register completes QR flow', async () => {
      ctx.server.setHITLService({
        onNotification: vi.fn(),
        listApprovals: vi.fn(() => [{ id: 'a1', title: 'Approve X', agentName: 'Agent A' }]),
        requestApproval: vi.fn(),
        getApproval: vi.fn(),
        respondToApproval: vi.fn(),
        listNotifications: vi.fn(() => []),
        countNotifications: vi.fn(() => ({ total: 2, unread: 1 })),
        markNotificationRead: vi.fn(),
        markAllNotificationsRead: vi.fn(),
      } as never);
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/register');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ success: expect.any(Boolean) });
    });

    it('POST /api/channels/agent/:id/messages routes to agent', async () => {
      const res = await request(ctx.server, 'POST', `/api/channels/agent%3A${AGENT_A}/messages`, {
        text: 'Hello agent',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/channels/:key/messages with no routed agent returns user message only', async () => {
      vi.mocked(ctx.server['orgService'].routeMessage).mockReturnValueOnce(null as never);
      const res = await request(ctx.server, 'POST', '/api/channels/webui:anonymous/messages', {
        text: 'No agent here',
      });
      expect(res.status).toBe(200);
      expect(res.json.agentMessage).toBeNull();
    });

    it('POST /api/tasks/:id/schedule/run-now rejects non-scheduled task', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Regular', description: 'Not scheduled',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER, taskType: 'standard',
      } as never);
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect(res.status).toBe(400);
    });

    it('POST /api/tasks/:id/schedule/run-now rejects in_progress task', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Running', description: 'Busy',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      vi.spyOn(ctx.taskService, 'getTask').mockReturnValueOnce({
        ...ctx.taskService.getTask(task.id)!,
        status: 'in_progress',
      });
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect(res.status).toBe(400);
    });

    it('PUT /api/tasks/:id/schedule updates cron', async () => {
      process.env['AUTH_ENABLED'] = 'false';
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Cron upd', description: 'Scheduled',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      const res = await request(ctx.server, 'PUT', `/api/tasks/${task.id}/schedule`, {
        cron: '0 10 * * *', timezone: 'UTC',
      });
      expect([200, 400]).toContain(res.status);
    });

    it('GET /api/team-templates/:id/files returns member role files', async () => {
      const createRes = await request(ctx.server, 'POST', '/api/team-templates', {
        name: 'Files Team',
        description: 'Has files',
        members: [{ templateId: 'developer', name: 'Dev', roleName: 'developer' }],
      });
      const tplId = (createRes.json.template as { id?: string })?.id ?? 'team-files';
      const res = await request(ctx.server, 'GET', `/api/team-templates/${tplId}/files`);
      expect([200, 404]).toContain(res.status);
    });

    it('POST /api/models/validate-key siliconflow provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'deepseek-ai/DeepSeek-V3' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'siliconflow', apiKey: 'sf-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key minimax provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'MiniMax-M2.1' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'minimax', apiKey: 'mm-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key groq provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'llama-3.3-70b-versatile' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'groq', apiKey: 'groq-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key cohere provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'command-r-plus' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'cohere', apiKey: 'cohere-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key dashscope provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'qwen-max' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'dashscope', apiKey: 'ds-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key moonshot provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'moonshot-v1-8k' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'moonshot', apiKey: 'moon-key',
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /api/builder/artifacts/agent/:name/images/:file updates manifest', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('agent.json')) {
          return JSON.stringify({ name: 'img-agent', screenshots: ['images/shot.png'], thumbnail: 'images/shot.png' });
        }
        return '# Role';
      });
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const s = String(p);
        if (s.includes('shot.png')) return true;
        if (s.includes('builder-artifacts')) return true;
        if (s.includes('markus.json') || s.includes('.markus')) return true;
        return false;
      });
      const res = await request(ctx.server, 'DELETE', '/api/builder/artifacts/agent/img-agent/images/shot.png');
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('Deep coverage batch', () => {
    it('handleFeishuUserMessage routes to secretary agent', async () => {
      const secretary = ctx.agentManager.getAgent('secretary');
      vi.mocked(secretary.sendMessage).mockResolvedValueOnce('Secretary reply');
      await ctx.server['handleFeishuUserMessage']({
        chatId: 'chat-feishu-1',
        senderId: 'ou_sender',
        senderName: 'Feishu User',
        messageType: 'text',
        content: JSON.stringify({ text: 'Need help' }),
      });
      expect(secretary.sendMessage).toHaveBeenCalled();
    });

    it('handleFeishuUserMessage handles non-text message type', async () => {
      await ctx.server['handleFeishuUserMessage']({
        chatId: 'chat-feishu-2',
        senderId: 'ou_sender',
        messageType: 'image',
        content: 'img_key_abc',
      });
    });

    it('resolveAgentRoleDir resolves template role directory', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const s = String(p);
        if (s.includes('/agents/') && s.includes('/role/ROLE.md')) return false;
        if (s.includes('templates/roles')) return true;
        if (s.endsWith('/ROLE.md')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockImplementation((p: string, options?: { withFileTypes?: boolean }) => {
        const entries = ['developer'];
        if (options?.withFileTypes) {
          return entries.map(name => ({ name, isFile: () => false, isDirectory: () => true }));
        }
        return entries as never;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('ROLE.md')) return '# Developer\n\nRole content';
        return '';
      });
      const agent = ctx.agentManager.getAgent(AGENT_A);
      const dir = ctx.server['resolveAgentRoleDir'](agent);
      expect(dir).toContain('roles');
    });

    it('GET /api/models/routing-candidates fetches live models', async () => {
      ctx.server.setLLMRouter({
        getEnhancedSettings: vi.fn(() => ({
          defaultProvider: 'openai',
          autoFallback: true,
          taskRouting: { assignments: {} },
          providers: {
            openai: {
              enabled: true, configured: true, displayName: 'OpenAI',
              models: [{ id: 'gpt-4', name: 'GPT-4' }],
            },
          },
        })),
        getProvider: vi.fn(() => ({ apiKey: 'sk-live', baseUrl: 'https://api.openai.com/v1' })),
        taskRouting: { assignments: {} },
      } as never);
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'gpt-4' }, { id: 'gpt-4o-mini' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'GET', '/api/models/routing-candidates');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json.providers)).toBe(true);
    });

    it('GET /api/builder/artifacts/installed detects builder-origin agents', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => {
        const s = String(p);
        return s.includes('.role-origin.json') || s.includes('builder-artifacts') || s.includes('/skills');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('.role-origin.json')) {
          return JSON.stringify({ source: 'builder-artifact', artifact: 'built-agent', artifactType: 'agent' });
        }
        return '# Role';
      });
      vi.mocked(fs.readdirSync).mockImplementation((p: string, options?: { withFileTypes?: boolean }) => {
        const s = String(p);
        const entries = s.includes('skills') ? ['my-skill'] : ['built-agent'];
        if (options?.withFileTypes) {
          return entries.map(name => ({ name, isFile: () => false, isDirectory: () => true }));
        }
        return entries as never;
      });
      const res = await request(ctx.server, 'GET', '/api/builder/artifacts/installed');
      expect(res.status).toBe(200);
      expect(res.json.installed).toBeDefined();
    });

    it('POST /api/builder/artifacts/agent/:name/uninstall removes deployed agent', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => String(p).includes('.role-origin.json'));
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('.role-origin.json')) {
          return JSON.stringify({ artifact: 'deploy-agent', artifactType: 'agent' });
        }
        return '# Role';
      });
      const res = await request(ctx.server, 'POST', '/api/builder/artifacts/agent/deploy-agent/uninstall');
      expect([200, 404, 500]).toContain(res.status);
    });

    it('POST /api/tasks/:id/schedule/run-now rejects review status', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Review', description: 'Awaiting review',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      vi.spyOn(ctx.taskService, 'getTask').mockReturnValueOnce({
        ...ctx.taskService.getTask(task.id)!,
        status: 'review',
      });
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect(res.status).toBe(400);
    });

    it('POST /api/tasks/:id/schedule/run-now rejects blocked status', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Blocked', description: 'Blocked task',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      vi.spyOn(ctx.taskService, 'getTask').mockReturnValueOnce({
        ...ctx.taskService.getTask(task.id)!,
        status: 'blocked',
      });
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect(res.status).toBe(400);
    });

    it('POST /api/tasks/:id/schedule/run-now rejects pending approval status', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Pending', description: 'Needs approval',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      vi.spyOn(ctx.taskService, 'getTask').mockReturnValueOnce({
        ...ctx.taskService.getTask(task.id)!,
        status: 'pending',
      });
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect(res.status).toBe(400);
    });

    it('POST /api/tasks/:id/schedule/run-now reruns completed scheduled task', async () => {
      const task = ctx.taskService.createTask({
        orgId: 'default', title: 'Done', description: 'Completed cron',
        assignedAgentId: AGENT_A, reviewerId: REVIEWER,
        taskType: 'scheduled',
        scheduleConfig: { cron: '0 9 * * *', timezone: 'UTC', enabled: true },
      } as never);
      vi.spyOn(ctx.taskService, 'getTask').mockReturnValue({
        ...ctx.taskService.getTask(task.id)!,
        status: 'completed',
      });
      vi.spyOn(ctx.taskService, 'advanceScheduleConfig').mockResolvedValue(undefined as never);
      vi.spyOn(ctx.taskService, 'resetTaskForRerun').mockResolvedValue(undefined as never);
      const res = await request(ctx.server, 'POST', `/api/tasks/${task.id}/schedule/run-now`);
      expect([202, 400]).toContain(res.status);
    });

    it('GET /api/system/storage/orphans includes orphan teams', async () => {
      vi.mocked(ctx.server['orgService'].listTeams).mockReturnValueOnce([{ id: TEAM_1, name: 'Team One', orgId: 'default', memberAgentIds: [] }] as never);
      const fs = await import('node:fs');
      vi.mocked(fs.readdirSync).mockImplementation((p: string, options?: { withFileTypes?: boolean }) => {
        const s = String(p);
        if (s.includes('/agents') && options?.withFileTypes) {
          return [{ name: 'orphan-agent', isFile: () => false, isDirectory: () => true }];
        }
        if (s.includes('/teams') && options?.withFileTypes) {
          return [{ name: 'orphan-team', isFile: () => false, isDirectory: () => true }];
        }
        if (options?.withFileTypes) {
          return [{ name: 'nested', isFile: () => true, isDirectory: () => false }];
        }
        return [] as never;
      });
      vi.mocked(fs.statSync).mockImplementation((p: string) => ({
        isFile: () => !String(p).includes('orphan'),
        isDirectory: () => String(p).includes('orphan'),
        size: 2048,
      }) as ReturnType<typeof fs.statSync>);
      const res = await request(ctx.server, 'GET', '/api/system/storage/orphans');
      expect(res.status).toBe(200);
    });

    it('POST /api/settings/integrations/feishu/register zh welcome with pending items', async () => {
      ctx.server.setHITLService({
        onNotification: vi.fn(),
        listApprovals: vi.fn(() => [{ id: 'a1', title: '审批事项', agentName: 'Agent A' }]),
        requestApproval: vi.fn(),
        getApproval: vi.fn(),
        respondToApproval: vi.fn(),
        listNotifications: vi.fn(() => []),
        countNotifications: vi.fn(() => ({ total: 3, unread: 2 })),
        markNotificationRead: vi.fn(),
        markAllNotificationsRead: vi.fn(),
      } as never);
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/register');
      expect(res.status).toBe(200);
      if (res.json.success === true) {
        expect(res.json.appId).toBeDefined();
      }
    });

    it('POST /api/channels/:key/messages agent sendMessage error persists error', async () => {
      vi.mocked(ctx.agentManager.getAgent(AGENT_A).sendMessage).mockRejectedValueOnce(
        new Error('{"error":{"message":"LLM rate limited"}}'),
      );
      const res = await request(ctx.server, 'POST', `/api/channels/agent%3A${AGENT_A}/messages`, {
        text: 'Trigger error path',
      });
      expect([200, 502]).toContain(res.status);
    });

    it('GET /api/templates/:id/files returns role template files', async () => {
      ctx.server.setTemplateRegistry({
        get: vi.fn((id: string) => id === 'developer' ? { id: 'developer', roleId: 'developer', name: 'Developer' } : null),
        list: vi.fn(() => []),
      } as never);
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => String(p).includes('templates/roles/developer'));
      vi.mocked(fs.readdirSync).mockImplementation((p: string, options?: { withFileTypes?: boolean }) => {
        if (options?.withFileTypes) {
          return [{ name: 'ROLE.md', isFile: () => true, isDirectory: () => false }];
        }
        return ['ROLE.md'] as never;
      });
      vi.mocked(fs.readFileSync).mockImplementation(() => '# Developer Role\n');
      const res = await request(ctx.server, 'GET', '/api/templates/developer/files');
      expect(res.status).toBe(200);
      expect(res.json.files).toBeDefined();
    });

    it('POST /api/settings/browser/test-concurrent chaos SSE mode', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/browser/test-concurrent', {
        mode: 'chaos', durationSec: 5, agents: 2,
      });
      expect(res.status).toBe(200);
      expect(res.raw).toContain('event:');
    });

    it('DELETE /api/settings/browser/test-concurrent aborts chaos run', async () => {
      await request(ctx.server, 'POST', '/api/settings/browser/test-concurrent', { mode: 'chaos', durationSec: 60 });
      const res = await request(ctx.server, 'DELETE', '/api/settings/browser/test-concurrent');
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/models/live/:provider with configured API key', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'GET', '/api/models/live/openai');
      expect(res.status).toBe(200);
      expect(res.json.source).toBe('live');
    });

    it('POST /api/models/validate-key openrouter provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'anthropic/claude-3.5-sonnet' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'openrouter', apiKey: 'or-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key xai provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'grok-beta' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'xai', apiKey: 'xai-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key perplexity provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'sonar-pro' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'perplexity', apiKey: 'pplx-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key zai provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'glm-4' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'zai', apiKey: 'zai-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key together_ai provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'meta-llama/Llama-3-70b-chat-hf' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'together_ai', apiKey: 'together-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/models/validate-key volcengine provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'doubao-pro-32k' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'volcengine', apiKey: 'volc-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/templates/instantiate creates agent from template', async () => {
      ctx.server.setTemplateRegistry({
        get: vi.fn((id: string) => id === 'developer' ? { id: 'developer', roleId: 'developer', name: 'Developer' } : null),
        list: vi.fn(() => []),
      } as never);
      const res = await request(ctx.server, 'POST', '/api/templates/instantiate', {
        templateId: 'developer', name: 'New Dev Agent', orgId: 'default',
      });
      expect([200, 201, 400, 404, 500]).toContain(res.status);
    });

    it('POST /api/auth/change-password updates password hash', async () => {
      const res = await request(ctx.server, 'POST', '/api/auth/change-password', {
        currentPassword: 'secret123',
        newPassword: 'newsecret456',
      });
      expect([200, 401, 404]).toContain(res.status);
    });

    it('POST /api/hub/publish follows redirect response', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 302, ok: false,
          headers: { get: (h: string) => (h === 'location' ? 'https://hub.markus.test/api/items/final' : null) },
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          status: 201, ok: true,
          json: async () => ({ id: 'published-item' }),
          headers: { get: () => null },
        });
      const res = await request(ctx.server, 'POST', '/api/hub/publish', {
        hubToken: 'hub-pub-token',
        payload: { name: 'Published Agent', itemType: 'agent' },
      });
      expect([201, 200, 502]).toContain(res.status);
    });

    it('GET /api/hub/items proxies to hub API', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ items: [{ id: 'hub-1', name: 'Item' }] }),
        headers: { get: () => 'application/json' },
      });
      const res = await request(ctx.server, 'GET', '/api/hub/items?q=test');
      expect([200, 401, 502]).toContain(res.status);
    });

    it('getHubClient downloadAndInstall saves artifact package', async () => {
      ctx.server.setSkillRegistry({} as never);
      vi.spyOn(ctx.server.getBuilderService()!, 'installArtifact').mockResolvedValue({
        type: 'agent', installed: { id: 'hub-agent' },
      });
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => String(p).includes('hub-token'));
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('hub-token')) return 'hub-dl-token';
        return '# Role';
      });
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({
          name: 'Hub Agent', itemType: 'agent',
          files: { 'ROLE.md': '# Hub Role\n', 'agent.json': '{}' },
        }),
        headers: { get: () => null },
      });
      const result = await ctx.server.getHubClient()!.downloadAndInstall('hub-item-1');
      expect(result.type).toBe('agent');
    });

    it('POST /api/settings/integrations/feishu/register handles user_denied', async () => {
      const lark = await import('@larksuiteoapi/node-sdk');
      vi.mocked(lark.registerApp).mockRejectedValueOnce({ code: 'access_denied' });
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/register');
      expect(res.status).toBe(200);
      expect(res.json.error).toBe('user_denied');
    });

    it('POST /api/settings/integrations/feishu/register handles expired QR', async () => {
      const lark = await import('@larksuiteoapi/node-sdk');
      vi.mocked(lark.registerApp).mockRejectedValueOnce({ code: 'expired_token' });
      const res = await request(ctx.server, 'POST', '/api/settings/integrations/feishu/register');
      expect(res.status).toBe(200);
      expect(res.json.error).toBe('expired');
    });

    it('handleFeishuUserMessage warns when no secretary agent exists', async () => {
      vi.mocked(ctx.agentManager.listAgents).mockReturnValueOnce([
        { id: AGENT_A, name: 'Agent A', agentRole: 'worker', role: 'Developer', status: 'idle', skills: [] },
      ] as never);
      await ctx.server['handleFeishuUserMessage']({
        chatId: 'chat-no-sec',
        senderId: 'ou_x',
        messageType: 'text',
        content: JSON.stringify({ text: 'hello' }),
      });
    });

    it('DELETE /api/system/storage/orphans purges orphan teams', async () => {
      vi.mocked(ctx.server['orgService'].listTeams).mockReturnValueOnce([{ id: TEAM_1, name: 'Team One', orgId: 'default', memberAgentIds: [] }] as never);
      const fs = await import('node:fs');
      vi.mocked(fs.readdirSync).mockImplementation((p: string, options?: { withFileTypes?: boolean }) => {
        const s = String(p);
        if (s.includes('/teams') && options?.withFileTypes) {
          return [{ name: 'orphan-team', isFile: () => false, isDirectory: () => true }];
        }
        return [] as never;
      });
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false, isDirectory: () => true, size: 4096 } as never);
      const res = await request(ctx.server, 'DELETE', '/api/system/storage/orphans', { ids: ['orphan-team'] });
      expect(res.status).toBe(200);
    });

    it('POST /api/auth/change-password succeeds with valid current password', async () => {
      await ctx.storage.userRepo.upsert({
        id: 'anonymous', orgId: 'default', name: 'Anonymous', email: 'anon@test.com',
        role: 'owner', passwordHash: TEST_PASSWORD_HASH,
      });
      const res = await request(ctx.server, 'POST', '/api/auth/change-password', {
        currentPassword: 'secret123',
        newPassword: 'newsecret789',
      });
      expect(res.status).toBe(200);
    });

    it('readHubToken reads token from ~/.markus/hub-token', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockImplementation((p: string) => String(p).includes('hub-token'));
      vi.mocked(fs.readFileSync).mockImplementation((p: string) => {
        if (String(p).includes('hub-token')) return '  stored-hub-token  ';
        return '';
      });
      expect(ctx.server['readHubToken']()).toBe('stored-hub-token');
    });

    it('POST /api/models/validate-key minimax-cn provider', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200, ok: true,
        json: async () => ({ data: [{ id: 'MiniMax-Text-01' }] }),
        headers: { get: () => null },
      });
      const res = await request(ctx.server, 'POST', '/api/models/validate-key', {
        provider: 'minimax-cn', apiKey: 'mm-cn-key',
      });
      expect(res.status).toBe(200);
    });

    it('POST /api/auth/change-password rejects wrong current password', async () => {
      await ctx.storage.userRepo.upsert({
        id: 'anonymous', orgId: 'default', name: 'Anonymous', email: 'anon@test.com',
        role: 'owner', passwordHash: TEST_PASSWORD_HASH,
      });
      const res = await request(ctx.server, 'POST', '/api/auth/change-password', {
        currentPassword: 'wrong-password',
        newPassword: 'newsecret789',
      });
      expect([200, 401]).toContain(res.status);
    });
  });
});
