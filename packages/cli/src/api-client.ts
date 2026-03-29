/**
 * Lightweight HTTP client for talking to a running Markus API server.
 * Used by all CLI commands except `start`, `init`, and `db:init`.
 */

export interface ApiClientOptions {
  server: string;
  apiKey?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const msg = typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: string }).error
      : JSON.stringify(body);
    super(`API ${status}: ${msg}`);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.server.replace(/\/+$/, '');
    this.headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) {
      this.headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
  }

  async get<T = unknown>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    return this.request<T>(url, { method: 'GET' });
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(this.buildUrl(path), {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(this.buildUrl(path), {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(this.buildUrl(path), {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T = unknown>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>(this.buildUrl(path, query), { method: 'DELETE' });
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`/api${path}`, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const headers = { ...this.headers };
    if (!init.body) delete headers['Content-Type'];

    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err) {
      throw new Error(`Cannot connect to Markus server at ${this.baseUrl}. Is it running? (${err})`);
    }

    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = await res.text(); }
      throw new ApiError(res.status, body);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

/** Resolve ApiClient from commander global opts */
export function createClient(opts: { server?: string; apiKey?: string }): ApiClient {
  const server = opts.server || process.env['MARKUS_API_URL'] || 'http://localhost:8056';
  const apiKey = opts.apiKey || process.env['MARKUS_API_KEY'];
  return new ApiClient({ server, apiKey });
}
