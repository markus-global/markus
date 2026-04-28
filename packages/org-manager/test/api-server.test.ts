import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIServer } from '../src/api-server.js';

// ---------------------------------------------------------------------------
// Mock IncomingMessage (simulates an HTTP request)
// ---------------------------------------------------------------------------
class MockIncomingMessage extends EventEmitter {
  method: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
  destroyed = false;

  constructor(method: string, url: string, headers: Record<string, string>, body: string | null) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { ...headers };
    this.body = body;
  }

  /** Simulate the incoming data stream (synchronous for test simplicity). */
  _simulate() {
    setImmediate(() => {
      if (this.body !== null) {
        this.emit('data', Buffer.from(this.body));
      }
      this.emit('end');
    });
  }
}

// ---------------------------------------------------------------------------
// Mock ServerResponse
// ---------------------------------------------------------------------------
class MockServerResponse extends EventEmitter {
  statusCode = 0;
  statusMessage = '';
  headers: Record<string, string> = {};

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  _headersSent = false;

  get headersSent() {
    return this._headersSent;
  }

  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) this.headers = headers;
  }

  write(data: string): boolean {
    this._headersSent = true;
    this.chunks.push(data);
    return true;
  }

  end(data?: string) {
    if (data) this.chunks.push(data);
    this.ended = true;
  }

  get bodyText(): string {
    return this.chunks.join('');
  }
}

// ---------------------------------------------------------------------------
// Helper: create an ApiServer with minimal dependencies
// ---------------------------------------------------------------------------
function createServer() {
  const mockAgentManager = {
    getTemplateRegistry: () => null,
    setTemplateRegistry: () => {},
    setGroupChatHandlers: () => {},
    getDataDir: () => '/tmp',
    getAgent: () => null,
  };
  const mockOrgService = {
    getAgentManager: () => mockAgentManager,
  } as any;
  const server = new (APIServer as any)(mockOrgService, {} as any);
  return server;
}

// ---------------------------------------------------------------------------
// Test: BUG-003 + BUG-005 – Request body parsing
// ---------------------------------------------------------------------------
describe('ApiServer request body parsing', () => {
  let server: ApiServer;

  beforeEach(() => {
    process.env.AUTH_ENABLED = 'false';
    server = createServer();
  });

  afterEach(() => {
    delete process.env.AUTH_ENABLED;
  });

  describe('BUG-003: null/array body → 400 Bad Request', () => {
    it('should return 400 when POST body is JSON literal null', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, 'null');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Invalid request body');
          done();
        });
      });
    });

    it('should return 400 when POST body is a JSON array', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '[1,2,3]');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Invalid request body');
          done();
        });
      });
    });

    it('should return 400 when PUT body is JSON literal null', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('PUT', '/api/agents/1', { 'content-type': 'application/json' }, 'null');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(400);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Invalid request body');
          done();
        });
      });
    });
  });

  describe('BUG-005: missing/wrong Content-Type → 415', () => {
    it('should return 415 when POST has no Content-Type header', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', {}, '{"name":"test"}');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Content-Type must be application/json');
          done();
        });
      });
    });

    it('should return 415 when POST has wrong Content-Type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'text/plain' }, '{"name":"test"}');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Content-Type must be application/json');
          done();
        });
      });
    });

    it('should return 415 when PUT has no Content-Type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('PUT', '/api/agents/1', {}, '{"name":"test"}');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).toBe(415);
          const body = JSON.parse(res.bodyText);
          expect(body.error).toBe('Content-Type must be application/json');
          done();
        });
      });
    });
  });

  describe('Regression: valid requests still work', () => {
    it('should NOT reject POST with valid JSON object body and Content-Type', async () => {
      // We test that the request reaches the route handler (and fails with 404 because
      // the route may not be registered — that's fine, as long as it's NOT 400/415)
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('POST', '/api/agents', { 'content-type': 'application/json' }, '{"name":"test"}');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          // Should NOT be 400 or 415 — could be 200, 201, 404, 500, etc.
          expect(res.statusCode).not.toBe(400);
          expect(res.statusCode).not.toBe(415);
          done();
        });
      });
    });

    it('should NOT reject GET requests missing Content-Type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('GET', '/api/agents', {}, '');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).not.toBe(400);
          expect(res.statusCode).not.toBe(415);
          done();
        });
      });
    });

    it('should NOT reject DELETE requests missing Content-Type', async () => {
      return new Promise<void>((done) => {
        const req = new MockIncomingMessage('DELETE', '/api/agents/1', {}, '');
        const res = new MockServerResponse();

        server.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
        req._simulate();

        setImmediate(() => {
          expect(res.statusCode).not.toBe(400);
          expect(res.statusCode).not.toBe(415);
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
