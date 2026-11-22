/**
 * C10-B Part E —— api-server 的外部信号源路由（薄搬运 + fail-closed）。
 *
 * 判据（这组只锁「路由层不成立第二个决策点」）：
 *   · webhook 入口**免会话**：带 AUTH_ENABLED=true、无 cookie 也必须进到服务层
 *     （不是 401）。未接线 ⇒ 503 unavailable（fail-closed，不假装收下）。
 *   · token 从 'x-webhook-token' 取；没有则从 Authorization: Bearer 剥。
 *   · 自助面 GET/POST /api/external-sources、POST /:id/toggle 受会话门槛保护
 *     （无 cookie ⇒ 401），orgId 取会话身份，agentId 是主体。
 *   · 归属/存在/kind 的判决全在 ExternalSourceService —— 这里用替身证明路由
 *     只是把入参搬过去，并把 service 的 http/body 原样回吐。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExternalSourceService } from '../src/external-source-service.js';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

let ctx: TestContext;

function fakeService(overrides: Partial<Record<keyof ExternalSourceService, unknown>> = {}) {
  const svc = {
    receiveWebhook: vi.fn(() => ({ http: 200, body: { status: 'ingested', itemId: 'mbx_1' } })),
    listSources: vi.fn(() => [{ id: 'src_1', kind: 'webhook', address: 'hook.acme@markus.global', enabled: true }]),
    registerSource: vi.fn(() => ({ status: 'registered', source: { id: 'src_1' } })),
    setSourceEnabled: vi.fn(() => ({ status: 'toggled', enabled: false })),
    ...overrides,
  };
  return svc as unknown as ExternalSourceService & typeof svc;
}

beforeEach(() => {
  // 会话门槛仍生效（用来证明 webhook 是公开路径、自助面不是）。
  process.env['AUTH_ENABLED'] = 'true';
  delete process.env['MARKUS_HOST'];
  ctx = createTestServer();
});

afterEach(() => {
  process.env['AUTH_ENABLED'] = 'false';
});

describe('C10-B：POST /api/webhooks/:sourceId（公开入口，判决在服务层）', () => {
  it('未接线服务 ⇒ 503 unavailable（而不是 401，也不是假装收下的 200）', async () => {
    const res = await request(ctx.server, 'POST', '/api/webhooks/src_1', { content: 'hi' });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ status: 'unavailable' });
  });

  it('无 session 也能进到服务层（公开前缀），并把 sourceId/body/token 原样搬运', async () => {
    const svc = fakeService();
    ctx.server.setExternalSourceService(svc);

    const res = await request(
      ctx.server, 'POST', '/api/webhooks/src_42?x=1',
      { content: 'payload', messageId: 'wh-1' },
      { 'x-webhook-token': 's3cret' },
    );

    expect(svc.receiveWebhook).toHaveBeenCalledWith('src_42', { content: 'payload', messageId: 'wh-1' }, 's3cret');
    // 服务的 http/body 原样回吐 —— 路由不加工状态码。
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ingested', itemId: 'mbx_1' });
  });

  it('没有 x-webhook-token 时从 Authorization: Bearer 剥出 token', async () => {
    const svc = fakeService();
    ctx.server.setExternalSourceService(svc);

    await request(ctx.server, 'POST', '/api/webhooks/src_9', { content: 'x' }, { authorization: 'Bearer tok-9' });

    expect(svc.receiveWebhook).toHaveBeenCalledWith('src_9', { content: 'x' }, 'tok-9');
  });

  it('服务的 404/401 判决原样透出（路由不二次判定源存在或 token）', async () => {
    ctx.server.setExternalSourceService(fakeService({
      receiveWebhook: vi.fn(() => ({ http: 401, body: { status: 'unauthorized' } })),
    }));

    const res = await request(ctx.server, 'POST', '/api/webhooks/src_1', { content: 'x' });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({ status: 'unauthorized' });
  });

  it('非 POST 不吞掉 webhook 路径（只有 POST 是入口）', async () => {
    const svc = fakeService();
    ctx.server.setExternalSourceService(svc);
    const res = await request(ctx.server, 'GET', '/api/webhooks/src_1');
    expect(svc.receiveWebhook).not.toHaveBeenCalled();
    // 公开前缀是按路径的（不按方法）：GET 不进服务层，落到兜底路由 ⇒ 404，
    // 且仍然**不**是「没会话 401」—— 否则说明前缀没生效。
    expect(res.status).toBe(404);
  });
});

describe('C10-B：/api/external-sources 自助面（member 门槛 + 会话身份）', () => {
  it('无会话 ⇒ 401（不在公开前缀里：自助面必须带身份）', async () => {
    ctx.server.setExternalSourceService(fakeService());

    const list = await request(ctx.server, 'GET', '/api/external-sources?agentId=agent-a');
    const reg = await request(ctx.server, 'POST', '/api/external-sources', { agentId: 'agent-a', kind: 'webhook', address: 'hook.acme@markus.global' });
    const toggle = await request(ctx.server, 'POST', '/api/external-sources/src_1/toggle', { agentId: 'agent-a', enabled: false });

    expect(list.status).toBe(401);
    expect(reg.status).toBe(401);
    expect(toggle.status).toBe(401);
  });

  describe('会话可用时（AUTH_ENABLED=false → 本机 owner 会话）', () => {
    beforeEach(() => {
      process.env['AUTH_ENABLED'] = 'false';
      ctx = createTestServer();
    });

    it('GET 列表：orgId 取会话身份、agentId 取 query，服务回吐 {sources}', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const res = await request(ctx.server, 'GET', '/api/external-sources?agentId=agent-a');

      expect(svc.listSources).toHaveBeenCalledWith('default', 'agent-a');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ sources: [{ id: 'src_1', kind: 'webhook', address: 'hook.acme@markus.global', enabled: true }] });
    });

    it('GET 缺 agentId ⇒ 400（不静默回一个空列表）', async () => {
      ctx.server.setExternalSourceService(fakeService());
      const res = await request(ctx.server, 'GET', '/api/external-sources');
      expect(res.status).toBe(400);
    });

    it('GET 未接线 ⇒ 503（空列表会撒谎：看起来像「你没有源」）', async () => {
      const res = await request(ctx.server, 'GET', '/api/external-sources?agentId=agent-a');
      expect(res.status).toBe(503);
    });

    it('POST 注册：入参搬运给服务；registered ⇒ 201', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const res = await request(ctx.server, 'POST', '/api/external-sources', {
        agentId: 'agent-a', kind: 'rss', address: 'feed.acme@markus.global', config: { feedUrl: 'https://example.com/f' },
        orgId: 'org_impostor',
      });

      // orgId 来自会话，不采信 body 里的冒充值。
      expect(svc.registerSource).toHaveBeenCalledWith({
        orgId: 'default', agentId: 'agent-a', kind: 'rss', address: 'feed.acme@markus.global',
        config: { feedUrl: 'https://example.com/f' },
      });
      expect(res.status).toBe(201);
      expect(res.json).toEqual({ status: 'registered', source: { id: 'src_1' } });
    });

    it('POST 注册服务判 forbidden ⇒ 403（判决仍只在服务：路由只映射）', async () => {
      ctx.server.setExternalSourceService(fakeService({
        registerSource: vi.fn(() => ({ status: 'forbidden', reason: 'address_not_bound_to_you', hint: 'bind first' })),
      }));

      const res = await request(ctx.server, 'POST', '/api/external-sources', {
        agentId: 'agent-a', kind: 'webhook', address: 'taken.acme@markus.global',
      });

      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 'forbidden', reason: 'address_not_bound_to_you' });
    });

    it('POST toggle：enabled 必须是布尔（"false" 不得被静默当成 true）', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const bad = await request(ctx.server, 'POST', '/api/external-sources/src_1/toggle', { agentId: 'agent-a', enabled: 'false' });
      expect(bad.status).toBe(400);
      expect(svc.setSourceEnabled).not.toHaveBeenCalled();

      const ok = await request(ctx.server, 'POST', '/api/external-sources/src_1/toggle', { agentId: 'agent-a', enabled: false });
      expect(svc.setSourceEnabled).toHaveBeenCalledWith({ orgId: 'default', agentId: 'agent-a', sourceId: 'src_1', enabled: false });
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ status: 'toggled', enabled: false });
    });
  });
});
