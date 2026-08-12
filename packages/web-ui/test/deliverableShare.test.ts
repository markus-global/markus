import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeliverableShareService,
  NotLoggedIntoHubError,
  DeliverableTooLargeError,
  HubApiError,
  base64ByteLength,
  normalizeShareRecord,
  HUB_DELIVERABLE_MAX_BYTES,
  DeliverableShareRecord,
} from '../src/lib/deliverableShare.ts';

/** 构造一个记录 fetch 调用的 mock fetch。 */
function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      json: async () => body,
    } as Response;
  });
  return { fn, calls };
}

const baseInput = {
  localId: 'dlv_local_1',
  title: '行业调研报告',
  summary: '关于 AI Agent 行业趋势的深度调研',
  tags: ['AI', '调研'],
  visibility: 'public' as const,
  filename: 'report.md',
  format: 'markdown',
  producerAgent: { id: 'agt_1', name: 'agt_1', source: 'local' as const },
};

describe('base64ByteLength', () => {
  it('computes decoded byte length from base64', () => {
    // "hello" → base64 "aGVsbG8=" (5 bytes)
    expect(base64ByteLength('aGVsbG8=')).toBe(5);
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('AA==')).toBe(1);
    expect(base64ByteLength(' A A = = ')).toBe(1); // 忽略空白
  });
});

describe('normalizeShareRecord', () => {
  it('parses flat record', () => {
    const r = normalizeShareRecord({ id: 'dlv_share_x', status: 'published', visibility: 'link', url: 'https://hub/x' });
    expect(r.id).toBe('dlv_share_x');
    expect(r.status).toBe('published');
    expect(r.visibility).toBe('link');
    expect(r.url).toBe('https://hub/x');
  });
  it('parses nested share/deliverable structures defensively', () => {
    const r = normalizeShareRecord({ share: { id: 'n1', status: 'rejected', reason: 'bad' } });
    expect(r.id).toBe('n1');
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe('bad');
    const r2 = normalizeShareRecord({ deliverable: { id: 'n2', visibility: 'public' } });
    expect(r2.id).toBe('n2');
    expect(r2.visibility).toBe('public');
  });
  it('returns defaults for empty/malformed input', () => {
    const r = normalizeShareRecord(null);
    expect(r.id).toBe('');
    expect(r.status).toBe('pending_review');
    expect(r.visibility).toBe('public');
  });
});

describe('DeliverableShareService — auth', () => {
  it('isHubLoggedIn reflects token presence', () => {
    const s = new DeliverableShareService({ getHubToken: () => 'tok' });
    expect(s.isHubLoggedIn()).toBe(true);
    const s2 = new DeliverableShareService({ getHubToken: () => null });
    expect(s2.isHubLoggedIn()).toBe(false);
    expect(() => s2.assertHubLoggedIn()).toThrow(NotLoggedIntoHubError);
  });
});

describe('DeliverableShareService — publish', () => {
  it('posts to /api/hub/deliverables/publish with Bearer token and full payload', async () => {
    const { fn, calls } = mockFetch(() => ({ status: 200, body: { id: 'dlv_share_1', status: 'pending_review', visibility: 'public' } }));
    const s = new DeliverableShareService({ getHubToken: () => 'hub-token', fetch: fn });
    const record = await s.publish(baseInput);
    expect(record.id).toBe('dlv_share_1');
    expect(record.status).toBe('pending_review');
    expect(calls).toHaveLength(1);
    const [url, init] = [calls[0].url, calls[0].init];
    expect(url).toBe('/api/hub/deliverables/publish');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer hub-token');
    const body = JSON.parse(String(init.body));
    expect(body.localId).toBe('dlv_local_1');
    expect(body.visibility).toBe('public');
    expect(body.producerAgent).toEqual({ id: 'agt_1', name: 'agt_1', source: 'local' });
    expect(body.filename).toBe('report.md');
  });

  it('throws NotLoggedIntoHubError when not logged in', async () => {
    const s = new DeliverableShareService({ getHubToken: () => null });
    await expect(s.publish(baseInput)).rejects.toThrow(NotLoggedIntoHubError);
  });

  it('throws DeliverableTooLargeError when fileBase64 exceeds limit', async () => {
    // base64 解码后字节数需 > 50MB，即 base64 字符串长度 > 50MB*4/3
    const huge = 'A'.repeat(Math.ceil(HUB_DELIVERABLE_MAX_BYTES * 4 / 3) + 64);
    const s = new DeliverableShareService({ getHubToken: () => 'tok', fetch: vi.fn() });
    await expect(s.publish({ ...baseInput, fileBase64: huge }))
      .rejects.toThrow(DeliverableTooLargeError);
  });

  it('throws DeliverableTooLargeError when explicit fileSizeBytes exceeds limit', async () => {
    const s = new DeliverableShareService({ getHubToken: () => 'tok', fetch: vi.fn() });
    await expect(s.publish({ ...baseInput, fileSizeBytes: HUB_DELIVERABLE_MAX_BYTES + 1 }))
      .rejects.toThrow(DeliverableTooLargeError);
  });

  it('throws HubApiError with server error message on non-2xx', async () => {
    const { fn } = mockFetch(() => ({ status: 400, body: { error: '审核不通过' } }));
    const s = new DeliverableShareService({ getHubToken: () => 'tok', fetch: fn });
    await expect(s.publish(baseInput)).rejects.toThrow(/审核不通过/);
  });
});

describe('DeliverableShareService — pollStatus', () => {
  it('GETs status with localId query', async () => {
    const { fn, calls } = mockFetch(() => ({ status: 200, body: { id: 'dlv_share_1', status: 'published', url: 'https://hub/deliverable/x' } }));
    const s = new DeliverableShareService({ getHubToken: () => 'tok', fetch: fn });
    const r = await s.pollStatus('dlv_local_1');
    expect(r.status).toBe('published');
    expect(r.url).toBe('https://hub/deliverable/x');
    expect(calls[0].url).toBe('/api/hub/deliverables/status?localId=dlv_local_1');
  });
});

describe('DeliverableShareService — revoke', () => {
  it('POSTs revoke and returns revoked status with null url', async () => {
    const { fn, calls } = mockFetch(() => ({ status: 200, body: { id: 'dlv_share_1', visibility: 'public' } }));
    const s = new DeliverableShareService({ getHubToken: () => 'tok', fetch: fn });
    const r = await s.revoke('dlv_local_1');
    expect(r.status).toBe('revoked');
    expect(r.url).toBeNull();
    expect(calls[0].url).toBe('/api/hub/deliverables/revoke');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ localId: 'dlv_local_1' });
  });
});
