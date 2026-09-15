import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestServer,
  request,
  type TestContext,
} from './api-server-test-helpers.js';
import { signToken } from '../src/middleware/auth.js';

const mockFetch = vi.fn();

// ── T7 登录多用户修复：hub-token per-user 隔离 + 多用户许可路径 ───────────
// 根因（T6）：/api/settings/hub-token GET 无鉴权返回实例全局 token，前端自动
// 恢复 + ensureHubAuth 短路 → 局域网设备以电脑身份进入。
// P0 修复：GET 必须鉴权且只返回当前用户自己的 per-user token；hub-login 校验
// 失败拒绝；第二个 Hub 用户受 multi_user 许可控制（许可内创建 member，否则
// 403 MULTI_USER_REQUIRED 明确拒绝而非静默继承）。

describe('T7 hub-token per-user auth & multi-user path', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 钉住默认 JWT secret —— 避免全量跑时被其他测试文件污染的
    // process.env['JWT_SECRET'] 导致验签不一致（cookie 401）。
    // 用 vi.stubEnv（vitest 官方 env 隔离）替代裸 process.env 赋值，
    // afterEach 里配合 vi.unstubAllEnvs() 彻底恢复，消除跨文件串扰。
    vi.stubEnv('JWT_SECRET', 'markus-dev-secret-change-in-prod');
    vi.stubEnv('AUTH_ENABLED', 'true');
    mockFetch.mockResolvedValue({
      status: 200, ok: true,
      text: async () => 'ok',
      json: async () => ({ user: { id: 'hub-me', username: 'me', email: 'me@test.com' } }),
      headers: { get: () => null },
    } as never);
    ctx = createTestServer();
    // 预置 user-1 的 per-user hub token（模拟已在 DB 中存储）
    ctx.storage.userRepo.setHubToken('user-1', 'token-user-1');
  });

  afterEach(() => {
    ctx?.taskService?.stopTimeoutChecker();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const authCookie = async (userId: string, role = 'owner', orgId = 'default') => {
    const token = await signToken(
      { userId, orgId, role, exp: Math.floor(Date.now() / 1000) + 3600 },
      process.env['JWT_SECRET'] ?? 'markus-dev-secret-change-in-prod'
    );
    return { cookie: `markus_token=${token}` };
  };

  describe('GET /api/settings/hub-token', () => {
    it('returns 401 when unauthenticated (P0-1)', async () => {
      const res = await request(ctx.server, 'GET', '/api/settings/hub-token');
      expect(res.status).toBe(401);
    });

    it('returns null when authenticated but user has no per-user token', async () => {
      const { cookie } = await authCookie('member-1', 'member');
      const res = await request(ctx.server, 'GET', '/api/settings/hub-token', undefined, { cookie });
      expect(res.status).toBe(200);
      expect(res.json.token).toBeNull();
    });

    it("returns ONLY the current user's own token (per-user isolation)", async () => {
      const { cookie } = await authCookie('user-1', 'owner');
      const res = await request(ctx.server, 'GET', '/api/settings/hub-token', undefined, { cookie });
      expect(res.status).toBe(200);
      expect(res.json.token).toBe('token-user-1');
    });

    it("does NOT expose another user's token to a different authenticated user", async () => {
      const { cookie } = await authCookie('member-1', 'member');
      const res = await request(ctx.server, 'GET', '/api/settings/hub-token', undefined, { cookie });
      expect(res.status).toBe(200);
      expect(res.json.token).not.toBe('token-user-1');
    });
  });

  describe('POST /api/settings/hub-token', () => {
    it('requires authentication (P0-1)', async () => {
      const res = await request(ctx.server, 'POST', '/api/settings/hub-token', { token: 'abc' });
      expect(res.status).toBe(401);
    });

    it('stores the token per-user for the authenticated user', async () => {
      const { cookie } = await authCookie('member-1', 'member');
      const res = await request(ctx.server, 'POST', '/api/settings/hub-token', { token: 'member-tok' }, { cookie });
      expect(res.status).toBe(200);
      expect(ctx.storage.userRepo.getHubToken('member-1')).toBe('member-tok');
      // must NOT overwrite another user's token
      expect(ctx.storage.userRepo.getHubToken('user-1')).toBe('token-user-1');
    });
  });

  describe('hub-login rejection & multi-user path', () => {
    it('rejects when Hub /auth/me verification fails (P0-4) — no trust fallback', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'));
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'bad-token',
        hubUser: { id: 'hub-user-evil', username: 'evil', email: 'evil@test.com' },
      });
      expect(res.status).toBe(401);
      expect(res.json.code).toBe('HUB_VERIFY_FAILED');
    });

    it('verifies the token BEFORE trusting the user — id mismatch is rejected', async () => {
      // Hub /auth/me returns a DIFFERENT user than the client claims
      mockFetch.mockResolvedValue({
        status: 200, ok: true,
        text: async () => 'ok',
        json: async () => ({ user: { id: 'hub-real', username: 'real', email: 'real@test.com' } }),
        headers: { get: () => null },
      } as never);
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'some-token',
        hubUser: { id: 'hub-claimed', username: 'claimed', email: 'claimed@test.com' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects a second DIFFERENT Hub user with MULTI_USER_REQUIRED when no multi_user license', async () => {
      // Instance already has an owner bound to Hub (hub-owner) — simulate the
      // real deployment where a second Hub user tries to log in.
      vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([
        { id: 'user-1', orgId: 'default', name: 'Owner', email: 'owner@test.com', role: 'owner', passwordHash: 'x', hubUserId: 'hub-owner', avatarUrl: null, createdAt: new Date(), lastLoginAt: null } as never,
      ] as never);
      mockFetch.mockResolvedValue({
        status: 200, ok: true,
        text: async () => 'ok',
        json: async () => ({ user: { id: 'hub-new', username: 'newbie', email: 'newbie@test.com' } }),
        headers: { get: () => null },
      } as never);
      // No MULTI_USER_LICENSE_TEST → canUse('multi_user') false
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'tok',
        hubUser: { id: 'hub-new', username: 'newbie', email: 'newbie@test.com' },
      });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('MULTI_USER_REQUIRED');
    });

    it('creates a member user for a second Hub user when multi_user license is enabled', async () => {
      vi.mocked(ctx.storage.userRepo.listByOrg).mockResolvedValue([
        { id: 'user-1', orgId: 'default', name: 'Owner', email: 'owner@test.com', role: 'owner', passwordHash: 'x', hubUserId: 'hub-owner', avatarUrl: null, createdAt: new Date(), lastLoginAt: null } as never,
      ] as never);
      mockFetch.mockResolvedValue({
        status: 200, ok: true,
        text: async () => 'ok',
        json: async () => ({ user: { id: 'hub-new', username: 'newbie', email: 'newbie@test.com' } }),
        headers: { get: () => null },
      } as never);
      // license mock defaults canUse→false; enable multi_user for this case
      // by mocking the method directly (fully parallel-safe, no env leakage).
      (ctx.server['licenseService'] as { canUse: ReturnType<typeof vi.fn> }).canUse.mockReturnValue(true);
      const res = await request(ctx.server, 'POST', '/api/auth/hub-login', {
        hubToken: 'tok',
        hubUser: { id: 'hub-new', username: 'newbie', email: 'newbie@test.com' },
      });
      expect(res.status).toBe(200);
      expect(res.json.user?.role).toBe('member');
      expect(res.json.user?.id).toBeDefined();
    });
  });
});