import { createLogger } from '@markus/shared';

const log = createLogger('feishu-http');

/**
 * A `fetch`-backed `httpInstance` for the official Lark/Feishu SDK.
 *
 * Why this exists (do not delete without reading)
 * ----------------------------------------------
 * The SDK's default `httpInstance` is `axios.create()`. Axios reads
 * `HTTP(S)_PROXY` from the process environment (via proxy-from-env) and runs its
 * own https-over-proxy handling, which — against Feishu's gateway — sends a
 * plaintext HTTP request to the TLS port and gets a `400 The plain HTTP request
 * was sent to HTTPS port`. Meanwhile the rest of the platform talks to the
 * network through undici's global dispatcher (installed by
 * `@markus/shared` net/egress, which *also* exports the proxy env vars for child
 * processes). So the process ends up with two egress paths: fetch/undici (correct
 * CONNECT tunnel) and axios (broken) — and the SDK's REST calls took the broken one
 * while its WebSocket client took the correct one. Symptom: "Feishu connected but
 * cards never arrive".
 *
 * Passing this fetch-backed instance makes the SDK ride the *single* egress path
 * (undici), so Feishu traffic is correctly tunnelled whether or not a proxy is
 * configured. It also surfaces the gateway's real error instead of letting the
 * SDK's `catch(e => logger.error(e))` swallow it into a misleading
 * `Cannot destructure property 'tenant_access_token'` TypeError.
 *
 * Contract notes (verified against the installed SDK, see its generated methods):
 * - The SDK calls `httpInstance.request({ url, method, data, params, headers,
 *   paramsSerializer, timeout })`; `url` is already absolute and `:path` params
 *   are already substituted.
 * - Token auth is added by the SDK *before* the call (`headers.Authorization`),
 *   so headers must be forwarded untouched — this instance never rewrites them.
 * - The default instance's response interceptor resolves to the response *body*;
 *   `config.$return_headers` resolves to `{ data, headers }`.
 * - On failure the default throws an AxiosError carrying `.response.{status,data}`;
 *   callers (e.g. `updateCard`) read `err.response.data.code/msg`, so we keep that
 *   shape.
 */

interface FeishuRequestConfig {
  url: string;
  method?: string;
  data?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  paramsSerializer?: (params: Record<string, unknown>) => string;
  timeout?: number;
  responseType?: string;
  $return_headers?: boolean;
  [key: string]: unknown;
}

/** The subset of `HttpInstance` the SDK actually uses. */
export interface FeishuHttpInstance {
  request<T = unknown>(config: FeishuRequestConfig): Promise<T>;
  get<T = unknown>(url: string, config?: FeishuRequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: FeishuRequestConfig): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, config?: FeishuRequestConfig): Promise<T>;
  put<T = unknown>(url: string, data?: unknown, config?: FeishuRequestConfig): Promise<T>;
  patch<T = unknown>(url: string, data?: unknown, config?: FeishuRequestConfig): Promise<T>;
}

interface HttpError extends Error {
  status: number;
  response: { status: number; data: unknown; headers?: Record<string, string> };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === target);
}

/**
 * Abort signal for a request timeout. Guarded so the module still type-checks on
 * lib targets that do not declare `AbortSignal.timeout` (Node < 17.3).
 */
function timeoutSignal(ms: number | undefined): AbortSignal | undefined {
  if (!ms || ms <= 0) return undefined;
  const make = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  return typeof make === 'function' ? make(ms) : undefined;
}

/** Default query serialisation: repeat array members, skip nil values. */
function serializeParams(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) usp.append(key, String(item));
      }
    } else {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

function summarize(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function makeHttpError(
  status: number,
  data: unknown,
  headers?: Record<string, string>,
  cause?: unknown,
): HttpError {
  const detail = data === undefined ? '' : `: ${summarize(data)}`;
  const err = new Error(`Feishu HTTP ${status}${detail}`) as HttpError;
  err.name = 'FeishuHttpError';
  err.status = status;
  err.response = { status, data, headers };
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

async function execute(config: FeishuRequestConfig): Promise<unknown> {
  const method = (config.method ?? 'GET').toUpperCase();

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`Feishu request received a non-absolute url: ${config.url}`);
  }

  if (config.params && Object.keys(config.params).length > 0) {
    const query = config.paramsSerializer
      ? config.paramsSerializer(config.params)
      : serializeParams(config.params);
    if (query) url.search = url.search ? `${url.search}&${query}` : `?${query}`;
  }

  const headers: Record<string, string> = { ...(config.headers ?? {}) };

  let body: string | URLSearchParams | FormData | undefined;
  if (config.data !== undefined && method !== 'GET' && method !== 'HEAD') {
    const data = config.data;
    if (typeof data === 'string' || data instanceof URLSearchParams || data instanceof FormData) {
      body = data as string | URLSearchParams | FormData;
    } else {
      body = JSON.stringify(data);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    }
  }

  const signal = timeoutSignal(config.timeout);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal });
  } catch (err) {
    log.error('Feishu request failed (network)', {
      method,
      url: url.toString(),
      timeoutMs: config.timeout,
      error: String(err),
    });
    throw makeHttpError(0, { error: String(err) }, undefined, err);
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  if (config.responseType === 'stream') {
    if (!res.ok) {
      log.error('Feishu HTTP error (stream)', { method, url: url.toString(), status: res.status });
      throw makeHttpError(res.status, undefined, responseHeaders);
    }
    return res.body;
  }

  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body (e.g. gateway HTML error page) — keep the raw text.
    }
  }

  if (!res.ok) {
    // The whole point of this instance: log the gateway's real answer so a
    // failure is diagnosable here, rather than being swallowed upstream into a
    // bare destructuring TypeError.
    log.error('Feishu HTTP error', {
      method,
      url: url.toString(),
      status: res.status,
      durationMs: Date.now() - startedAt,
      body: summarize(parsed),
    });
    throw makeHttpError(res.status, parsed, responseHeaders);
  }

  return config.$return_headers ? { data: parsed, headers: responseHeaders } : parsed;
}

/**
 * Build a `fetch`-backed `HttpInstance` for `Lark.Client` / `Lark.WSClient`.
 * Stateless; safe to create once per client.
 */
export function createFeishuHttpInstance(): FeishuHttpInstance {
  return {
    request: <T>(config: FeishuRequestConfig) => execute(config) as Promise<T>,
    get: <T>(url: string, config?: FeishuRequestConfig) =>
      execute({ ...(config ?? {}), method: 'GET', url }) as Promise<T>,
    delete: <T>(url: string, config?: FeishuRequestConfig) =>
      execute({ ...(config ?? {}), method: 'DELETE', url }) as Promise<T>,
    post: <T>(url: string, data?: unknown, config?: FeishuRequestConfig) =>
      execute({ ...(config ?? {}), method: 'POST', url, data }) as Promise<T>,
    put: <T>(url: string, data?: unknown, config?: FeishuRequestConfig) =>
      execute({ ...(config ?? {}), method: 'PUT', url, data }) as Promise<T>,
    patch: <T>(url: string, data?: unknown, config?: FeishuRequestConfig) =>
      execute({ ...(config ?? {}), method: 'PATCH', url, data }) as Promise<T>,
  };
}
