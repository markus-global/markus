import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeliverableShareService,
  NotLoggedIntoHubError,
  DeliverableTooLargeError,
  HubApiError,
  base64ByteLength,
  normalizeShareRecord,
  HUB_DELIVERABLE_MAX_BYTES,
  DELIVERABLE_SHARE_FORMATS,
  effectiveShareFormat,
  canShareDeliverableFormat,
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

// ── 分享格式白名单门禁 ─────────────────────────────────────────────────────
// 客户端侧门控：分享参数实际值按 `item.format || 'markdown'` 兜底，只有命中
// 白名单（markdown / html）才允许分享（与服务端 DELIVERABLE_SHARE_FORMATS 一致）。
// 这些测试保障：即使 UI 入口漏放行，门禁函数本身也能拒绝非文本格式，且不会把
// 未知/缺省格式错误地拦掉（缺省 → 'markdown'，应放行）。
describe('DELIVERABLE_SHARE_FORMATS / effectiveShareFormat / canShareDeliverableFormat', () => {
  it('白名单只允许 markdown 与 html', () => {
    expect([...DELIVERABLE_SHARE_FORMATS].sort()).toEqual(['html', 'markdown']);
  });

  it('effectiveShareFormat 对缺省/空格式兜底为 markdown（与 doShare 一致）', () => {
    expect(effectiveShareFormat(undefined)).toBe('markdown');
    expect(effectiveShareFormat(null)).toBe('markdown');
    expect(effectiveShareFormat('')).toBe('markdown');
    expect(effectiveShareFormat('markdown')).toBe('markdown');
    expect(effectiveShareFormat('html')).toBe('html');
  });

  it('放行 markdown 与 html', () => {
    expect(canShareDeliverableFormat('markdown')).toBe(true);
    expect(canShareDeliverableFormat('html')).toBe(true);
    // 大写在白名单内（DELIVERABLE_SHARE_FORMATS.has 严格匹配，与服务端一致拒绝大写）
    expect(canShareDeliverableFormat('Markdown')).toBe(false);
  });

  it('缺省/空格式放行（因兜底为 markdown）', () => {
    expect(canShareDeliverableFormat(undefined)).toBe(true);
    expect(canShareDeliverableFormat(null)).toBe(true);
    expect(canShareDeliverableFormat('')).toBe(true);
  });

  it('拒绝非白名单文本与二进制格式（text/json/pdf/zip）', () => {
    expect(canShareDeliverableFormat('text')).toBe(false);
    expect(canShareDeliverableFormat('json')).toBe(false);
    expect(canShareDeliverableFormat('pdf')).toBe(false);
    expect(canShareDeliverableFormat('zip')).toBe(false);
    expect(canShareDeliverableFormat('binary')).toBe(false);
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
  it('parses localDeliverableId for mapping back to local record', () => {
    const r = normalizeShareRecord({ id: 'dlv_share_x', status: 'published', localDeliverableId: 'dlv_local_1' });
    expect(r.localId).toBe('dlv_local_1');
    const r2 = normalizeShareRecord({ share: { id: 'dlv_share_y', status: 'pending_review', localId: 'dlv_local_2' } });
    expect(r2.localId).toBe('dlv_local_2');
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
  it('reads Hub publish response fields shareId/shareUrl (real contract)', () => {
    const r = normalizeShareRecord({
      ok: true, alreadyShared: false, shareId: 'dlv_share_1',
      slug: 'industry-report-ai-2026', status: 'pending_review',
      shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
    });
    expect(r.id).toBe('dlv_share_1');
    expect(r.slug).toBe('industry-report-ai-2026');
    expect(r.status).toBe('pending_review');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
  });
  it('builds url from slug + hubOrigin when Hub status omits url (real contract)', () => {
    const r = normalizeShareRecord(
      { share: { id: 'dlv_share_1', slug: 'industry-report-ai-2026', status: 'published', visibility: 'public' } },
      'https://hub.example/',
    );
    expect(r.id).toBe('dlv_share_1');
    expect(r.status).toBe('published');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
  });
  it('keeps url null when no url and no hubOrigin/slug', () => {
    const r = normalizeShareRecord({ share: { id: 'n1', status: 'published' } });
    expect(r.url).toBeNull();
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
  it('posts to /api/hub/deliverables/publish with Bearer token and full payload (Hub contract: localDeliverableId)', async () => {
    const { fn, calls } = mockFetch(() => ({
      status: 201,
      body: {
        ok: true, alreadyShared: false, shareId: 'dlv_share_1',
        slug: 'industry-report-ai-2026', status: 'pending_review',
        shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
      },
    }));
    const s = new DeliverableShareService({ getHubToken: () => 'hub-token', hubUrl: 'https://hub.example', fetch: fn });
    const record = await s.publish(baseInput);
    expect(record.id).toBe('dlv_share_1');
    expect(record.status).toBe('pending_review');
    expect(record.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
    expect(calls).toHaveLength(1);
    const [url, init] = [calls[0].url, calls[0].init];
    expect(url).toBe('/api/hub/deliverables/publish');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer hub-token');
    const body = JSON.parse(String(init.body));
    expect(body.localDeliverableId).toBe('dlv_local_1');
    expect(body.localId).toBeUndefined();
    expect(body.visibility).toBe('public');
    expect(body.producerAgent).toEqual({ id: 'agt_1', name: 'agt_1', source: 'local' });
    expect(body.filename).toBe('report.md');
  });

  it('returns alreadyShared record without re-publishing', async () => {
    const { fn } = mockFetch(() => ({
      status: 200,
      body: { ok: true, alreadyShared: true, shareId: 'dlv_share_1', slug: 'industry-report-ai-2026', status: 'published', shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026' },
    }));
    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: 'https://hub.example', fetch: fn });
    const r = await s.publish(baseInput);
    expect(r.id).toBe('dlv_share_1');
    expect(r.status).toBe('published');
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
  it('GETs status with localId query and builds url from slug (Hub real contract)', async () => {
    const { fn, calls } = mockFetch(() => ({
      status: 200,
      body: { share: { id: 'dlv_share_1', slug: 'industry-report-ai-2026', status: 'published', visibility: 'public' } },
    }));
    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: 'https://hub.example', fetch: fn });
    const r = await s.pollStatus('dlv_local_1');
    expect(r.status).toBe('published');
    expect(r.id).toBe('dlv_share_1');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
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
