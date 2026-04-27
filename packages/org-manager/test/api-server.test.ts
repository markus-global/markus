import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIServer } from '../src/api-server.js';

// ---------------------------------------------------------------------------
// Mock IncomingMessage (simulates an HTTP request)
// ---------------------------------------------------------------------------
class MockIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private bodyBuffer: string = '';

  constructor(method: string, url: string, headers: Record<string, string> = {}, private body: string = '') {
    super();
    this.method = method;
    this.url = url;
    this.headers = { 'host': 'localhost:8056', ...headers, 'content-length': String(body.length) };
    if (body.length > 0) {
      this.bodyBuffer = body;
    }
  }

  /** Simulate receiving the body by emitting a 'data' event then 'end' */
  _simulate(): void {
    if (this.bodyBuffer) {
      this.emit('data', Buffer.from(this.bodyBuffer));
    }
    this.emit('end');
  }

  setTimeout(ms: number, cb?: () => void): this {
    if (cb) this.once('timeout', cb);
    return this;
  }

  destroy(): void {}
}

// ---------------------------------------------------------------------------
// Mock ServerResponse (captures statusCode, headers, body)
// ---------------------------------------------------------------------------
class MockServerResponse {
  statusCode: number = 200;
  statusMessage: string = 'OK';
  headers: Record<string, string> = {};
  body: string = '';
  private _ended: boolean = false;

  writeHead(statusCode: number, statusMessage?: string, headers?: Record<string, string>): this;
  writeHead(statusCode: number, headers?: Record<string, string>): this;
  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, string>, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders;
      if (headers) this.headers = headers;
    } else if (statusMessageOrHeaders) {
      this.headers = statusMessageOrHeaders;
    }
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name];
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.body += chunk.toString();
    this._ended = true;
  }

  on(event: string, cb: (...args: unknown[]) => void): this { return this; }
  once(event: string, cb: (...args: unknown[]) => void): this { return this; }
  emit(event: string, ...args: unknown[]): boolean { return true; }

  get ended(): boolean { return this._ended; }
}

// ============================================================================
// Integration tests: ApiServer request body parsing
// ============================================================================
describe('ApiServer request body parsing', () => {
  let server: APIServer;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Spy on console.error to suppress expected error logs in tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = new APIServer({ port: 0 });
    await server.start();
    // Clear any registered handlers before each test
    server['handlers'] = {};
    // Register a simple echo handler for /api/agents for all test methods
    server.post('/api/agents', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body: (req as any).body ?? null }));
    });
    server.put('/api/agents', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body: (req as any).body ?? null }));
    });
    server.patch('/api/agents', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body: (req as any).body ?? null }));
    });
    // Register a minimal handler for /api/agents/:id
    server.get('/api/agents/:id', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: (req as any).params?.id }));
    });
    server.delete('/api/agents/:id', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deleted: (req as any).params?.id }));
    });
    server.post('/api/agents/:id/config', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body: (req as any).body ?? null }));
    });
    server.get('/api/agents/:id/config', async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: (req as any).params?.id }));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
  });

  // ------------------------------------------------------------------
  // BUG-003: null / array body → 400 Bad Request
  // ------------------------------------------------------------------
  describe('BUG-003: null/array body → 400 Bad Request', () => {
    it('should return 400 for JSON null body', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, 'null');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const parsed = JSON.parse(res.body);
          expect(parsed.error).toBe('Bad Request');
          done();
        });
      });
    });

    it('should return 400 for JSON array body (top-level array)', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '[1,2,3]');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const parsed = JSON.parse(res.body);
          expect(parsed.error).toBe('Bad Request');
          done();
        });
      });
    });

    it('should return 400 for empty body when Content-Type is application/json', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const parsed = JSON.parse(res.body);
          expect(parsed.error).toBe('Bad Request');
          done();
        });
      });
    });
  });

  // ------------------------------------------------------------------
  // BUG-005: missing/wrong Content-Type → 415 Unsupported Media Type
  // ------------------------------------------------------------------
  describe('BUG-005: missing/wrong Content-Type → 415', () => {
    it('should return 415 for POST with no content-type and non-empty body', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', {}, 'some body');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          done();
        });
      });
    });

    it('should return 415 for POST with text/plain content-type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'text/plain' }, 'plain text');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          done();
        });
      });
    });

    it('should return 415 for POST with application/xml content-type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/xml' }, '<xml/>');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          done();
        });
      });
    });

    it('should pass through POST with application/json content-type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '{"a":1}');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body).body).toEqual({ a: 1 });
          done();
        });
      });
    });
  });

  // ------------------------------------------------------------------
  // Regression: valid requests still work
  // ------------------------------------------------------------------
  describe('Regression: valid requests still work', () => {
    it('should handle JSON object body correctly for POST', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '{"name":"test"}');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          expect(res.statusCode).toBe(200);
          const parsed = JSON.parse(res.body);
          expect(parsed.body).toEqual({ name: 'test' });
          done();
        });
      });
    });

    it('should handle empty body with no content-type (GET) gracefully', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('GET', '/api/agents/123', {});
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          // GET with no body and no Content-Type should work normally
          expect(res.statusCode).toBe(200);
          done();
        });
      });
    });

    it('should handle malformed JSON (non-JSON body) gracefully without 500', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, 'not-json-at-all');
        const res = new MockServerResponse();
        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();
        setImmediate(() => {
          // Malformed JSON should resolve({}) — so body is empty, handler gets {}
          // Handler may return 400 if required field is missing, but must NOT crash (no 500/415)
          expect(res.statusCode).not.toBe(415);
          expect(res.statusCode).not.toBe(500);
          done();
        });
      });
    });
  });
});

describe('APIServer Route Table (405 Method Not Allowed)', () => {
  const table = APIServer.buildRouteTable();

  it('should return a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('should have POST for /api/auth/login', () => {
    const entry = table.find(r => r.test('/api/auth/login'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('POST');
  });

  it('should have POST for /api/auth/register', () => {
    const entry = table.find(r => r.test('/api/auth/register'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('POST');
  });

  it('should have GET / POST for /api/agents', () => {
    const entry = table.find(r => r.test('/api/agents'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
    expect(entry!.methods).toContain('POST');
  });

  it('should have GET / PUT / PATCH / DELETE for /api/agents/:id', () => {
    const entry = table.find(r => r.test('/api/agents/agt_123'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
    expect(entry!.methods).toContain('PUT');
    expect(entry!.methods).toContain('PATCH');
    expect(entry!.methods).toContain('DELETE');
  });

  it('should have GET / POST for /api/agents/:id/config', () => {
    const entry = table.find(r => r.test('/api/agents/agt_123/config'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
    expect(entry!.methods).toContain('POST');
  });

  it('should have GET for /api/agents/:id/tasks', () => {
    const entry = table.find(r => r.test('/api/agents/agt_123/tasks'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
  });

  it('should have GET for /api/projects', () => {
    const entry = table.find(r => r.test('/api/projects'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
  });

  it('should have POST for /api/projects', () => {
    const entry = table.find(r => r.test('/api/projects'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('POST');
  });

  it('should have GET / PUT / DELETE for /api/projects/:id', () => {
    const entry = table.find(r => r.test('/api/projects/proj_123'));
    expect(entry).toBeDefined();
    expect(entry!.methods).toContain('GET');
    expect(entry!.methods).toContain('PUT');
    expect(entry!.methods).toContain('DELETE');
  });

  it('should NOT match /api/auth (too short — waits for segment)', () => {
    const entry = table.find(r => r.test('/api/auth'));
    expect(entry).toBeUndefined();
  });

  it('should NOT allow DELETE on /api/auth/login', () => {
    const entry = table.find(r => r.test('/api/auth/login'));
    expect(entry).toBeDefined();
    expect(entry!.methods).not.toContain('DELETE');
  });

  it('should NOT allow DELETE on /api/auth/register', () => {
    const entry = table.find(r => r.test('/api/auth/register'));
    expect(entry).toBeDefined();
    expect(entry!.methods).not.toContain('DELETE');
  });

  it('should NOT allow DELETE on /api/agents', () => {
    const entry = table.find(r => r.test('/api/agents'));
    expect(entry).toBeDefined();
    expect(entry!.methods).not.toContain('DELETE');
  });

  it('should NOT allow POST on /api/agents/:id (single agent resource)', () => {
    const entry = table.find(r => r.test('/api/agents/agt_123'));
    expect(entry).toBeDefined();
    expect(entry!.methods).not.toContain('POST');
  });

  it('should NOT match route for /api/auth (no exact entry)', () => {
    const entry = table.find(r => r.test('/api/auth'));
    expect(entry).toBeUndefined();
  });
});
