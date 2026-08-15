/**
 * DeliverableShareService 单元测试。
 * 覆盖：Hub 登录校验、字段补全（visibility/producerAgent）、上传（publish）、
 * 轮询（status）、revoke、大小限制、结果回写、错误处理。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DeliverableShareService,
  DeliverableShareError,
  NotLoggedIntoHubError,
  DeliverableTooLargeError,
  HubApiError,
  HUB_DELIVERABLE_MAX_BYTES,
  base64ByteLength,
  type DeliverableShareDeps,
  type ShareDeliverableInput,
  type DeliverableShareWriteBack,
} from '../src/deliverable-share.js';

function makeInput(overrides: Partial<ShareDeliverableInput> = {}): ShareDeliverableInput {
  return {
    localId: 'dlv_1',
    title: '行业调研报告：AI Agent 2026',
    summary: '对 AI Agent 市场的深入分析。',
    tags: ['ai', 'agent', '调研'],
    visibility: 'public',
    filename: 'report.md',
    format: 'markdown',
    content: '# 调研报告\n正文内容……',
    producerAgent: { id: 'agt_agent1', name: '首席研究员', source: 'hub_asset' },
    ...overrides,
  };
}

interface MockFetchCtx {
  (url: string, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
}

function makeFetchMock(status: number, body: unknown): MockFetchCtx {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as MockFetchCtx;
  fn.calls = calls;
  return fn;
}

function makeService(
  opts: {
    auth?: { hubUrl: string; token: string } | null;
    fetchMock?: MockFetchCtx;
    writeBack?: (f: DeliverableShareWriteBack) => Promise<void>;
    proxyBaseUrl?: string;
  } = {},
): { svc: DeliverableShareService; fetchMock: MockFetchCtx; written: DeliverableShareWriteBack[]; deps: DeliverableShareDeps } {
  // 默认 fetch 响应对齐 Hub 真实契约（publish 平铺返回 shareId/shareUrl/slug）
  const fetchMock = opts.fetchMock ?? makeFetchMock(201, {
    ok: true, alreadyShared: false, shareId: 'dlv_share_1',
    slug: 'industry-report-ai-2026', status: 'pending_review',
    shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
  });
  const written: DeliverableShareWriteBack[] = [];
  const deps: DeliverableShareDeps = {
    getHubAuth: () => (opts.auth === undefined ? { hubUrl: 'https://hub.example', token: 'tok' } : opts.auth),
    proxyBaseUrl: opts.proxyBaseUrl ?? 'http://localhost:8787',
    fetch: fetchMock,
    writeBack: opts.writeBack ?? (async (f) => { written.push(f); }),
  };
  const svc = new DeliverableShareService(deps);
  return { svc, fetchMock, written, deps };
}

describe('base64ByteLength', () => {
  it('computes decoded byte length of a base64 string', () => {
    const text = 'hello world'; // 11 bytes -> base64 "aGVsbG8gd29ybGQ="
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    expect(base64ByteLength(b64)).toBe(11);
  });
  it('returns 0 for empty string', () => {
    expect(base64ByteLength('')).toBe(0);
  });
});

describe('DeliverableShareService — Hub 登录校验', () => {
  it('isHubLoggedIn returns false when no hub auth', () => {
    const { svc } = makeService({ auth: null });
    expect(svc.isHubLoggedIn()).toBe(false);
  });
  it('isHubLoggedIn returns true when hub auth present', () => {
    const { svc } = makeService();
    expect(svc.isHubLoggedIn()).toBe(true);
  });
  it('assertHubLoggedIn throws NotLoggedIntoHubError when not logged in', () => {
    const { svc } = makeService({ auth: null });
    expect(() => svc.assertHubLoggedIn()).toThrow(NotLoggedIntoHubError);
  });
  it('share throws NotLoggedIntoHubError when not logged in and does not call fetch', async () => {
    const { svc, fetchMock } = makeService({ auth: null });
    await expect(svc.share(makeInput())).rejects.toBeInstanceOf(NotLoggedIntoHubError);
    expect(fetchMock.calls.length).toBe(0);
  });
});

describe('DeliverableShareService — publish', () => {
  it('posts to local org-manager hub proxy with JSON + auth and returns record', async () => {
    const { svc, fetchMock, written } = makeService();
    const rec = await svc.share(makeInput());
    expect(rec.id).toBe('dlv_share_1');
    expect(rec.status).toBe('pending_review');

    // 通过本地代理 /api/hub/deliverables/publish 透传（避免 CORS）
    expect(fetchMock.calls.length).toBe(1);
    const call = fetchMock.calls[0];
    expect(call.url).toBe('http://localhost:8787/api/hub/deliverables/publish');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toContain('application/json');

    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body['localDeliverableId']).toBe('dlv_1');
    expect(body['localId']).toBeUndefined();
    expect(body['visibility']).toBe('public');
    expect(body['content']).toContain('# 调研报告');
    expect(body['producerAgent']).toEqual({ id: 'agt_agent1', name: '首席研究员', source: 'hub_asset' });

    // 回写本地 DeliverableRow
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: 'dlv_1',
      hubShareId: 'dlv_share_1',
      shareStatus: 'pending_review',
      shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
      shareVisibility: 'public',
    });
  });

  it('throws DeliverableTooLargeError above 50MB limit', async () => {
    const { svc, fetchMock } = makeService();
    const big = Buffer.alloc(HUB_DELIVERABLE_MAX_BYTES + 1).toString('base64');
    await expect(svc.share(makeInput({ fileBase64: big }))).rejects.toBeInstanceOf(DeliverableTooLargeError);
    expect(fetchMock.calls.length).toBe(0);
  });

  it('throws HubApiError when proxy returns non-ok with error message', async () => {
    const fetchMock = makeFetchMock(400, { error: '审核超限' });
    const { svc } = makeService({ fetchMock });
    await expect(svc.share(makeInput())).rejects.toBeInstanceOf(HubApiError);
    await expect(svc.share(makeInput())).rejects.toThrow(/400/);
    await expect(svc.share(makeInput())).rejects.toThrow(/审核超限/);
  });

  it('uses fileSizeBytes for size validation when provided', async () => {
    const { svc, fetchMock } = makeService();
    await expect(
      svc.share(makeInput({ fileSizeBytes: HUB_DELIVERABLE_MAX_BYTES + 5 })),
    ).rejects.toBeInstanceOf(DeliverableTooLargeError);
    expect(fetchMock.calls.length).toBe(0);
  });
});

describe('DeliverableShareService — pollStatus', () => {
  it('GETs status via proxy with localId and parses {share:publicDto} to build url from slug', async () => {
    const fetchMock = makeFetchMock(200, {
      share: {
        id: 'dlv_share_1', slug: 'industry-report-ai-2026',
        status: 'published', visibility: 'public',
        // publicDto 无 url 字段（Hub 真实契约），由 slug + hubUrl 兜底
      },
    });
    const { svc, written } = makeService({ fetchMock });
    const rec = await svc.pollStatus('dlv_1');
    expect(rec.status).toBe('published');
    expect(rec.id).toBe('dlv_share_1');
    expect(rec.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
    expect(fetchMock.calls[0].url).toBe('http://localhost:8787/api/hub/deliverables/status?localId=dlv_1');
    expect(written[0]).toMatchObject({
      id: 'dlv_1',
      shareStatus: 'published',
      shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
    });
  });

  it('throws NotLoggedIntoHubError when not logged in', async () => {
    const { svc } = makeService({ auth: null });
    await expect(svc.pollStatus('dlv_1')).rejects.toBeInstanceOf(NotLoggedIntoHubError);
  });
});

describe('DeliverableShareService — revoke', () => {
  it('POSTs revoke and writes back shareStatus=revoked', async () => {
    const fetchMock = makeFetchMock(200, { ok: true, id: 'dlv_share_1', status: 'revoked' });
    const { svc, written } = makeService({ fetchMock });
    const rec = await svc.revoke('dlv_1');
    expect(rec.status).toBe('revoked');
    expect(fetchMock.calls[0].url).toBe('http://localhost:8787/api/hub/deliverables/revoke');
    expect(fetchMock.calls[0].init.method).toBe('POST');
    expect(JSON.parse(fetchMock.calls[0].init.body as string)).toEqual({ localId: 'dlv_1' });
    const wb = written.find((w) => w.id === 'dlv_1');
    expect(wb?.shareStatus).toBe('revoked');
    expect(wb?.shareUrl).toBeNull();
  });

  it('throws NotLoggedIntoHubError when not logged in', async () => {
    const { svc } = makeService({ auth: null });
    await expect(svc.revoke('dlv_1')).rejects.toBeInstanceOf(NotLoggedIntoHubError);
  });
});

describe('DeliverableShareService — 回写容错', () => {
  it('does not throw when writeBack callback fails', async () => {
    const { svc } = makeService({ writeBack: async () => { throw new Error('db error'); } });
    const rec = await svc.share(makeInput());
    expect(rec.id).toBe('dlv_share_1');
  });
});

describe('DeliverableShareService — 可见性 link', () => {
  it('sends visibility=link in payload', async () => {
    const { svc, fetchMock } = makeService();
    await svc.share(makeInput({ visibility: 'link' }));
    const body = JSON.parse(fetchMock.calls[0].init.body as string) as Record<string, unknown>;
    expect(body['visibility']).toBe('link');
  });
});
