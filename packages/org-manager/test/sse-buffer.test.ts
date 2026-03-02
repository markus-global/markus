import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SSEBuffer, type SSEBufferOptions } from '../src/sse-buffer.js';

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  destroyed = false;

  get writableEnded() {
    return this.ended;
  }

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
  }

  write(data: string): boolean {
    if (this.ended || this.destroyed) throw new Error('Write after end');
    this.chunks.push(data);
    return true;
  }

  end() {
    this.ended = true;
  }

  get allData() {
    return this.chunks.join('');
  }

  get parsedEvents(): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    const raw = this.allData;
    const parts = raw.split('\n\n').filter(Boolean);
    for (const part of parts) {
      const dataLine = part.replace(/^data: /, '');
      try {
        events.push(JSON.parse(dataLine));
      } catch {
        // skip non-JSON
      }
    }
    return events;
  }
}

function createMockResponse(): MockResponse {
  return new MockResponse();
}

function createSSEBuffer(res: MockResponse, opts?: SSEBufferOptions): SSEBuffer {
  return new SSEBuffer(res as unknown as ServerResponse, {
    heartbeatInterval: 0, // disable heartbeat for most tests
    flushInterval: 10,
    bufferSize: 1024,
    ...opts,
  });
}

describe('SSEBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('sets correct SSE response headers', () => {
      const res = createMockResponse();
      createSSEBuffer(res);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream');
      expect(res.headers['Cache-Control']).toBe('no-cache');
      expect(res.headers['Connection']).toBe('keep-alive');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
    });

    it('sends initial connected event immediately', () => {
      const res = createMockResponse();
      createSSEBuffer(res);

      const events = res.parsedEvents;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('connected');
      expect(events[0].timestamp).toBeDefined();
    });
  });

  describe('send()', () => {
    it('buffers messages and flushes on timer', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);
      const initialEventCount = res.parsedEvents.length;

      buf.send({ type: 'test', data: 'hello' });

      // Message is buffered, not yet flushed (only connected event exists)
      expect(res.parsedEvents.length).toBe(initialEventCount);

      // Advance timer to trigger flush
      vi.advanceTimersByTime(20);

      const events = res.parsedEvents;
      const testEvent = events.find((e) => e.type === 'test');
      expect(testEvent).toBeDefined();
      expect(testEvent!.data).toBe('hello');
    });

    it('auto-flushes when buffer exceeds threshold', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res, {
        bufferSize: 50, // very small threshold
        heartbeatInterval: 0,
      });
      const initialChunks = res.chunks.length;

      // Send enough data to exceed 50 bytes
      buf.send({ type: 'big', payload: 'x'.repeat(100) });

      // Should have flushed immediately (no need to advance timers)
      expect(res.chunks.length).toBeGreaterThan(initialChunks);
      const events = res.parsedEvents;
      expect(events.some((e) => e.type === 'big')).toBe(true);
    });

    it('ignores messages after close', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.close();
      const chunksAfterClose = res.chunks.length;

      buf.send({ type: 'late', data: 'ignored' });
      vi.advanceTimersByTime(100);

      // No new chunks written (only the close event was added)
      expect(res.chunks.length).toBe(chunksAfterClose);
    });
  });

  describe('sendImmediate()', () => {
    it('writes directly without buffering', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendImmediate({ type: 'urgent', data: 'now' });

      const events = res.parsedEvents;
      expect(events.some((e) => e.type === 'urgent')).toBe(true);
    });
  });

  describe('sendProgress()', () => {
    it('sends correctly formatted progress event', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendProgress(50, 100, 'Halfway there');
      vi.advanceTimersByTime(20);

      const events = res.parsedEvents;
      const progress = events.find((e) => e.type === 'progress');
      expect(progress).toBeDefined();
      expect(progress!.progress).toBe(50);
      expect(progress!.current).toBe(50);
      expect(progress!.total).toBe(100);
      expect(progress!.message).toBe('Halfway there');
    });

    it('handles zero total gracefully', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendProgress(0, 0, 'Unknown');
      vi.advanceTimersByTime(20);

      const events = res.parsedEvents;
      const progress = events.find((e) => e.type === 'progress');
      expect(progress!.progress).toBe(0);
    });
  });

  describe('sendError()', () => {
    it('sends error message from string', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendError('Something failed', true);
      vi.advanceTimersByTime(20);

      const events = res.parsedEvents;
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err!.error).toBe('Something failed');
      expect(err!.recoverable).toBe(true);
    });

    it('sends error message from Error object', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendError(new Error('Boom'));
      vi.advanceTimersByTime(20);

      const events = res.parsedEvents;
      const err = events.find((e) => e.type === 'error');
      expect(err!.error).toBe('Boom');
      expect(err!.recoverable).toBe(false);
    });
  });

  describe('close()', () => {
    it('flushes remaining buffer and sends complete event', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.send({ type: 'pending', data: 'flush-me' });
      buf.close();

      const events = res.parsedEvents;
      expect(events.some((e) => e.type === 'pending')).toBe(true);
      expect(events.some((e) => e.type === 'complete')).toBe(true);
      expect(res.ended).toBe(true);
    });

    it('handles already-ended response gracefully', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      // Simulate response already ended by something else
      res.end();

      // Should not throw
      expect(() => buf.close()).not.toThrow();
    });

    it('handles destroyed response gracefully', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      res.destroyed = true;

      expect(() => buf.close()).not.toThrow();
    });

    it('is idempotent', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.close();
      const chunksAfterFirst = res.chunks.length;

      buf.close();
      expect(res.chunks.length).toBe(chunksAfterFirst);
    });
  });

  describe('heartbeat', () => {
    it('sends periodic heartbeat events', () => {
      const res = createMockResponse();
      createSSEBuffer(res, { heartbeatInterval: 1000 });

      vi.advanceTimersByTime(1100);

      const events = res.parsedEvents;
      expect(events.some((e) => e.type === 'heartbeat')).toBe(true);
    });

    it('stops heartbeat on close', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res, { heartbeatInterval: 1000 });

      buf.close();
      const chunksAfterClose = res.chunks.length;

      vi.advanceTimersByTime(2000);
      expect(res.chunks.length).toBe(chunksAfterClose);
    });
  });

  describe('isActive()', () => {
    it('returns true for active connection', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      expect(buf.isActive()).toBe(true);
    });

    it('returns false after close', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.close();
      expect(buf.isActive()).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('tracks sent messages and flushes', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.send({ type: 'a' });
      buf.send({ type: 'b' });
      vi.advanceTimersByTime(20);

      const stats = buf.getStats();
      expect(stats.messagesSent).toBeGreaterThanOrEqual(2);
      expect(stats.flushes).toBeGreaterThanOrEqual(1);
      expect(stats.bytesSent).toBeGreaterThan(0);
    });
  });

  describe('SSE protocol compliance', () => {
    it('formats events with correct data: prefix and double newlines', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      buf.sendImmediate({ type: 'test', value: 42 });

      const rawChunks = res.chunks;
      const testChunk = rawChunks.find((c) => c.includes('"test"'));
      expect(testChunk).toBeDefined();
      expect(testChunk).toMatch(/^data: \{.*\}\n\n$/);
    });

    it('produces valid JSON in data field', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      const complexMessage = {
        type: 'complex',
        nested: { a: 1, b: [2, 3] },
        unicode: '你好世界',
        special: 'line\nbreak\ttab',
      };

      buf.sendImmediate(complexMessage);

      const events = res.parsedEvents;
      const parsed = events.find((e) => e.type === 'complex');
      expect(parsed).toBeDefined();
      expect((parsed!.nested as any).b).toEqual([2, 3]);
      expect(parsed!.unicode).toBe('你好世界');
    });
  });

  describe('connection error handling', () => {
    it('closes on response error event', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      expect(buf.isActive()).toBe(true);
      res.emit('error', new Error('connection reset'));

      // Should be closed after error
      expect(buf.isActive()).toBe(false);
    });

    it('closes on response close event', () => {
      const res = createMockResponse();
      const buf = createSSEBuffer(res);

      expect(buf.isActive()).toBe(true);
      res.emit('close');

      expect(buf.isActive()).toBe(false);
    });
  });
});
