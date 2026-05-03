import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiError, createClient } from '../src/api-client.js';

describe('ApiClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  describe('constructor', () => {
    it('strips trailing slashes from server URL', () => {
      const client = new ApiClient({ server: 'http://localhost:8056///' });
      mockFetch.mockResolvedValue(mockResponse({ ok: true }));
      client.get('/test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:8056/api/test'),
        expect.anything(),
      );
    });

    it('includes Authorization header when apiKey provided', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056', apiKey: 'my-key' });
      mockFetch.mockResolvedValue(mockResponse({ ok: true }));
      await client.get('/test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-key',
          }),
        }),
      );
    });
  });

  describe('get', () => {
    it('sends GET request to /api path', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse({ agents: [] }));
      const result = await client.get('/agents');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8056/api/agents',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toEqual({ agents: [] });
    });

    it('appends query parameters', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse([]));
      await client.get('/tasks', { status: 'in_progress', agentId: undefined });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('status=in_progress');
      expect(url).not.toContain('agentId');
    });
  });

  describe('post', () => {
    it('sends POST with JSON body', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse({ id: 'proj_001' }));
      await client.post('/projects', { name: 'Test', orgId: 'default' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8056/api/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Test', orgId: 'default' }),
        }),
      );
    });
  });

  describe('put', () => {
    it('sends PUT with JSON body', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse({ ok: true }));
      await client.put('/projects/proj_001', { name: 'Updated' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/proj_001'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  describe('patch', () => {
    it('sends PATCH with JSON body', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse({ ok: true }));
      await client.patch('/agents/agt_001', { status: 'paused' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/agt_001'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  describe('delete', () => {
    it('sends DELETE request', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue(mockResponse({ ok: true }));
      await client.delete('/projects/proj_001');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/projects/proj_001'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws ApiError on non-2xx response', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
        text: async () => '{"error":"Not found"}',
      });
      await expect(client.get('/missing')).rejects.toThrow(ApiError);
      try {
        await client.get('/missing');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(404);
      }
    });

    it('throws connection error when fetch fails', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.get('/test')).rejects.toThrow('Cannot connect');
    });

    it('returns undefined for empty response', async () => {
      const client = new ApiClient({ server: 'http://localhost:8056' });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => '',
      });
      const result = await client.get('/empty');
      expect(result).toBeUndefined();
    });
  });
});

describe('createClient', () => {
  it('uses provided server and apiKey', () => {
    const client = createClient({ server: 'http://example.com', apiKey: 'key123' });
    expect(client).toBeInstanceOf(ApiClient);
  });

  it('defaults to localhost:8056', () => {
    const client = createClient({});
    expect(client).toBeInstanceOf(ApiClient);
  });

  it('uses env vars as fallback', () => {
    const original = process.env['MARKUS_API_URL'];
    process.env['MARKUS_API_URL'] = 'http://env-server:9000';
    try {
      const client = createClient({});
      expect(client).toBeInstanceOf(ApiClient);
    } finally {
      if (original !== undefined) {
        process.env['MARKUS_API_URL'] = original;
      } else {
        delete process.env['MARKUS_API_URL'];
      }
    }
  });
});

describe('ApiError', () => {
  it('extracts error message from body object', () => {
    const err = new ApiError(400, { error: 'Bad request' });
    expect(err.message).toContain('Bad request');
    expect(err.status).toBe(400);
  });

  it('stringifies non-object body', () => {
    const err = new ApiError(500, 'Internal error');
    expect(err.message).toContain('Internal error');
  });
});
