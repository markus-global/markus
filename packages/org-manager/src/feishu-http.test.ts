import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFeishuHttpInstance } from './feishu-http.js';

/** Capture what the instance handed to fetch, and control the reply. */
type Captured = { url: string; init: RequestInit };

function stubFetch(reply: () => Response | Promise<Response>): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }));
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createFeishuHttpInstance', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Bites: if the instance ever returns a Response object instead of the body,
  // every SDK caller (which reads `resp.data.message_id`) silently breaks.
  it('resolves to the parsed response body, not a Response object', async () => {
    stubFetch(() => jsonResponse({ code: 0, data: { message_id: 'om_x' } }));
    const http = createFeishuHttpInstance();

    const result = await http.request<{ code: number; data: { message_id: string } }>({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages',
      data: { receive_id: 'oc_x' },
    });

    expect(result).toEqual({ code: 0, data: { message_id: 'om_x' } });
  });

  // Bites: dropping `params` serialisation would send receive_id_type in the
  // body path instead of the query, which Feishu rejects.
  it('serialises params into the query string, repeating array members', async () => {
    const calls = stubFetch(() => jsonResponse({ code: 0 }));
    const http = createFeishuHttpInstance();

    await http.request({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages',
      params: { page_size: 50, ids: ['a', 'b'], skipped: undefined },
    });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.getAll('ids')).toEqual(['a', 'b']);
    expect(url.searchParams.has('skipped')).toBe(false);
  });

  it('honours a caller-supplied paramsSerializer', async () => {
    const calls = stubFetch(() => jsonResponse({ code: 0 }));
    const http = createFeishuHttpInstance();

    await http.request({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/x',
      params: { a: 1 },
      paramsSerializer: (p) => `custom=${String((p as { a: number }).a)}`,
    });

    expect(calls[0]!.url).toContain('custom=1');
  });

  // Bites: token auth lives in headers.Authorization, set by the SDK before the
  // call. Rewriting/dropping headers breaks every authenticated request.
  it('forwards headers untouched (Authorization survives)', async () => {
    const calls = stubFetch(() => jsonResponse({ code: 0 }));
    const http = createFeishuHttpInstance();

    await http.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages',
      headers: { Authorization: 'Bearer t-abc', 'X-Custom': 'v' },
      data: { a: 1 },
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t-abc');
    expect(headers['X-Custom']).toBe('v');
  });

  it('JSON-encodes object data and sets Content-Type, passes strings through', async () => {
    const calls = stubFetch(() => jsonResponse({ code: 0 }));
    const http = createFeishuHttpInstance();

    await http.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/x',
      data: { msg_type: 'text' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ msg_type: 'text' });
    expect(headers['Content-Type']).toBe('application/json');

    await http.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/x',
      data: '{"already":"encoded"}',
    });
    expect(calls[1]!.init.body).toBe('{"already":"encoded"}');
  });

  // THE regression guard for the original bug: the gateway's real 400 must be
  // surfaced (status + body in the error), never swallowed into a bare TypeError.
  it('surfaces the gateway error with status and body instead of swallowing it', async () => {
    stubFetch(() => new Response('The plain HTTP request was sent to HTTPS port', { status: 400 }));
    const http = createFeishuHttpInstance();

    await expect(http.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      data: { app_id: 'cli_x' },
    })).rejects.toMatchObject({
      status: 400,
      response: { status: 400 },
    });

    try {
      await http.request({ method: 'GET', url: 'https://open.feishu.cn/open-apis/x' });
      throw new Error('expected a rejection');
    } catch (err) {
      const e = err as { message: string; status: number; response: { data: unknown } };
      expect(e.message).toContain('Feishu HTTP 400');
      expect(String(e.response.data)).toContain('plain HTTP request');
    }
  });

  it('wraps network failures with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const http = createFeishuHttpInstance();

    await expect(http.request({ method: 'GET', url: 'https://open.feishu.cn/x' }))
      .rejects.toMatchObject({ status: 0 });
  });

  it('returns { data, headers } when $return_headers is set', async () => {
    stubFetch(() => new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'rid' },
    }));
    const http = createFeishuHttpInstance();

    const result = await http.request<{ data: unknown; headers: Record<string, string> }>({
      method: 'GET',
      url: 'https://open.feishu.cn/x',
      $return_headers: true,
    });

    expect(result.data).toEqual({ code: 0 });
    expect(result.headers['x-request-id']).toBe('rid');
  });

  it('attaches a timeout AbortSignal when a timeout is given', async () => {
    const calls = stubFetch(() => jsonResponse({ code: 0 }));
    const http = createFeishuHttpInstance();

    await http.request({ method: 'GET', url: 'https://open.feishu.cn/x', timeout: 15000 });

    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('FeishuApiClient egress wiring', () => {
  it('gives the SDK a fetch-backed instance (no axios defaults) for REST and WS', async () => {
    const { FeishuApiClient } = await import('./feishu-api-client.js');
    const client = new FeishuApiClient({ appId: 'cli_x', appSecret: 's' });

    // TS `private` is not a runtime boundary; the SDK stores what we passed.
    const wired = (client as unknown as { client: { httpInstance: { request?: unknown; defaults?: unknown } } }).client
      .httpInstance;
    expect(typeof wired.request).toBe('function');
    // axios instances always carry `defaults`; our fetch instance never does.
    // If someone reverts to the SDK default this assertion fails.
    expect(wired.defaults).toBeUndefined();
  });
});
