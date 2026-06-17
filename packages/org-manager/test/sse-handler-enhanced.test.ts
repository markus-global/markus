import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SSEHandlerEnhanced } from '../src/sse-handler-enhanced.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
  }
  write(chunk: string) { this.body += chunk; return true; }
  end(chunk?: string) { if (chunk) this.body += chunk; }
  setHeader() { return this; }
}

describe('SSEHandlerEnhanced', () => {
  let agent: {
    sendMessageStream: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    agent = {
      sendMessageStream: vi.fn(async (_text, onEvent) => {
        onEvent({ type: 'text_delta', content: 'Hello' });
        onEvent({ type: 'progress', processedTokens: 5, totalTokens: 10 });
        onEvent({ type: 'tool_call_start', tool: 'read_file' });
        return 'Hello world';
      }),
      getState: vi.fn(() => ({ tokensUsedToday: 42 })),
    };
  });

  it('streams message and completes', async () => {
    const onComplete = vi.fn();
    const handler = new SSEHandlerEnhanced({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
      persistUserMessage: vi.fn(async () => 'sess-1'),
      persistAssistantMessage: vi.fn(async () => {}),
      onComplete,
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(handler.isCompleted()).toBe(true);
    expect(onComplete).toHaveBeenCalled();
    expect(handler.getProgress().current).toBe(5);
    expect(handler.getConnectionStatus().retryCount).toBe(0);
  });

  it('retries on connection errors then succeeds', async () => {
    let attempts = 0;
    agent.sendMessageStream.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNRESET socket timeout');
      return 'retry ok';
    });

    const handler = new SSEHandlerEnhanced({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
      maxRetries: 2,
      retryDelayMs: 1,
      onError: vi.fn(async () => true),
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(attempts).toBe(2);
  });

  it('rejects concurrent processing', async () => {
    agent.sendMessageStream.mockImplementation(() => new Promise(() => {}));
    const handler = new SSEHandlerEnhanced({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
    });
    const res = new MockResponse() as unknown as ServerResponse;
    void handler.handle(res);
    await new Promise(r => setImmediate(r));
    await expect(handler.handle(res)).rejects.toThrow('already processing');
    handler.cancel();
  });

  it('falls back when stream handler throws non-retryable error', async () => {
    agent.sendMessageStream.mockRejectedValue(new Error('validation failed'));
    const handler = new SSEHandlerEnhanced({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
      onError: vi.fn(async () => false),
    });
    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
