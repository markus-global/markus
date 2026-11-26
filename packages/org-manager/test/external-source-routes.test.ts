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
import { DEFAULT_MAX_BODY_BYTES, WEBHOOK_MAX_BODY_BYTES, maxBodyBytesForPath } from '../src/api-server.js';
import { createTestServer, request, type TestContext } from './api-server-test-helpers.js';

let ctx: TestContext;

function fakeService(overrides: Partial<Record<keyof ExternalSourceService, unknown>> = {}) {
  const svc = {
    receiveWebhook: vi.fn(() => ({ http: 200, body: { status: 'ingested', itemId: 'mbx_1' } })),
    listSources: vi.fn(() => [{ id: 'src_1', kind: 'webhook', address: 'hook.acme@markus.global', enabled: true }]),
    // C10-F: the list route answers with the policy and the sources in one
    // response, so the stub has to answer both — a stub missing this would make
    // the route look broken rather than the fixture stale.
    policyOf: vi.fn(() => 'accept'),
    registerSource: vi.fn(() => ({ status: 'registered', source: { id: 'src_1' } })),
    setSourceEnabled: vi.fn(() => ({ status: 'toggled', enabled: false })),
    deliverAsOperator: vi.fn(() => ({ status: 'ingested', itemId: 'mbx_9', workUnitRef: 'external:src_1:op-1' })),
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
    // B 运营投递口同样不在公开前缀里：能指定目标地址的能力必须带身份。
    const deliver = await request(ctx.server, 'POST', '/api/external-sources/src_1/deliver', {
      agentId: 'agent-a', address: 'nobody.acme@markus.global', payload: { content: 'x' },
    });

    expect(list.status).toBe(401);
    expect(reg.status).toBe(401);
    expect(toggle.status).toBe(401);
    expect(deliver.status).toBe(401);
  });

  describe('会话可用时（AUTH_ENABLED=false → 本机 owner 会话）', () => {
    beforeEach(() => {
      process.env['AUTH_ENABLED'] = 'false';
      ctx = createTestServer();
    });

    it('GET 列表：orgId 取会话身份、agentId 取 query，服务回吐 {policy, sources}', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const res = await request(ctx.server, 'GET', '/api/external-sources?agentId=agent-a');

      expect(svc.listSources).toHaveBeenCalledWith('default', 'agent-a');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        policy: 'accept',
        sources: [{ id: 'src_1', kind: 'webhook', address: 'hook.acme@markus.global', enabled: true }],
      });
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

    it('B POST deliver：orgId 取会话身份（不采信 body 冒充值），payload 原样搬运', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const res = await request(ctx.server, 'POST', '/api/external-sources/src_1/deliver', {
        agentId: 'agent-a', address: 'nobody.acme@markus.global',
        payload: { messageId: 'op-1', content: 'unclaimed' },
        orgId: 'org_impostor',
      });

      expect(svc.deliverAsOperator).toHaveBeenCalledWith({
        orgId: 'default', agentId: 'agent-a', sourceId: 'src_1',
        address: 'nobody.acme@markus.global',
        body: { messageId: 'op-1', content: 'unclaimed' },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ status: 'ingested', itemId: 'mbx_9' });
    });

    it('B POST deliver 服务判 forbidden ⇒ 403（归属裁决只在服务，路由只映射）', async () => {
      ctx.server.setExternalSourceService(fakeService({
        deliverAsOperator: vi.fn(() => ({ status: 'forbidden', reason: 'not_your_source' })),
      }));

      const res = await request(ctx.server, 'POST', '/api/external-sources/src_1/deliver', {
        agentId: 'agent-a', address: 'nobody.acme@markus.global', payload: { content: 'x' },
      });

      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ status: 'forbidden', reason: 'not_your_source' });
    });

    it('B POST deliver 缺 payload ⇒ 400（不从「剩下的字段」推断载荷）', async () => {
      const svc = fakeService();
      ctx.server.setExternalSourceService(svc);

      const res = await request(ctx.server, 'POST', '/api/external-sources/src_1/deliver', {
        agentId: 'agent-a', address: 'nobody.acme@markus.global', content: 'x',
      });

      expect(res.status).toBe(400);
      expect(svc.deliverAsOperator).not.toHaveBeenCalled();
    });

    it('B POST deliver 未接线 ⇒ 503（不假装收下了）', async () => {
      const res = await request(ctx.server, 'POST', '/api/external-sources/src_1/deliver', {
        agentId: 'agent-a', address: 'nobody.acme@markus.global', payload: { content: 'x' },
      });
      expect(res.status).toBe(503);
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

/**
 * C10 开源默认：请求体必须有硬上限。
 *
 * 为什么这是安全项而不是优化：`readBody` 是不可信请求体进入内存的唯一关口，
 * 而 `/api/webhooks/*` 是**公开**前缀 —— 没有上限时，一个未知调用者不需要任何凭据
 * 就能用一次 POST 把进程内存吃满。开源用户不可能自己加反向代理，默认值就是实际配置。
 */
describe('C10 开源默认：对外请求体硬上限', () => {
  it('按路径分派：对外 webhook 64 KB，平台内 10 MB（分派点唯一）', () => {
    expect(maxBodyBytesForPath('/api/webhooks/src_1')).toBe(WEBHOOK_MAX_BODY_BYTES);
    expect(maxBodyBytesForPath('/api/external-sources')).toBe(DEFAULT_MAX_BODY_BYTES);
    // 对外入口必须显著小于平台内，否则这条限制对外部攻击面没有意义
    expect(WEBHOOK_MAX_BODY_BYTES).toBeLessThan(DEFAULT_MAX_BODY_BYTES / 10);
  });

  it('超过上限的 webhook body ⇒ 413，且服务层根本没被调用（未入内存即未入决策）', async () => {
    const svc = fakeService();
    ctx.server.setExternalSourceService(svc);

    const res = await request(ctx.server, 'POST', '/api/webhooks/src_1', {
      content: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 4096),
    });

    expect(res.status).toBe(413);
    expect(svc.receiveWebhook).not.toHaveBeenCalled();
  });
});
