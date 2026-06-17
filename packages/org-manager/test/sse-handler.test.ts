import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SSEHandler } from '../src/sse-handler.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  destroyed = false;

  get writableEnded() { return this.ended; }

  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
  }
  write(chunk: string) { this.body += chunk; return true; }
  end(chunk?: string) { if (chunk) this.body += chunk; this.ended = true; }
  setHeader() { return this; }
  destroy() { this.destroyed = true; }
}

function createAgent(overrides: Record<string, unknown> = {}) {
  return {
    sendMessageStream: vi.fn(async (_text, onEvent) => {
      onEvent({ type: 'text_delta', content: 'Hello' });
      onEvent({ type: 'thinking_delta', content: 'thinking...' });
      onEvent({ type: 'tool_call_start', tool: 'read_file', arguments: { path: '/a' } });
      onEvent({ type: 'tool_call_end', tool: 'read_file', result: 'ok' });
      onEvent({ type: 'progress', processedTokens: 3, totalTokens: 10 });
      return 'Hello world';
    }),
    getState: vi.fn(() => ({ tokensUsedToday: 12, status: 'idle' })),
    cancelActiveStream: vi.fn(),
    config: { name: 'Agent A' },
    ...overrides,
  };
}

describe('SSEHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams assistant reply and persists messages', async () => {
    const onComplete = vi.fn();
    const persistUser = vi.fn(async () => 'sess-1');
    const persistAssistant = vi.fn(async () => {});
    const wsBroadcaster = { broadcastChat: vi.fn(), broadcastAgentUpdate: vi.fn() };

    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: createAgent() as never,
      userText: 'Hi there',
      senderId: 'user-1',
      senderInfo: { name: 'User', role: 'owner' },
      persistUserMessage: persistUser,
      persistAssistantMessage: persistAssistant,
      wsBroadcaster,
      onComplete,
      executionStreamRepo: { append: vi.fn() },
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    await vi.advanceTimersByTimeAsync(150);

    expect(onComplete).toHaveBeenCalled();
    expect(persistUser).toHaveBeenCalled();
    expect(persistAssistant).toHaveBeenCalled();
    expect(res.body).toContain('Hello');
  });

  it('handles stream errors via onError callback', async () => {
    const agent = createAgent({
      sendMessageStream: vi.fn(async () => { throw new Error('stream failed'); }),
    });
    const onError = vi.fn(async () => {});
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
      onError,
    });

    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(onError).toHaveBeenCalled();
  });

  it('rejects concurrent handle calls', async () => {
    const agent = createAgent({
      sendMessageStream: vi.fn(() => new Promise(() => {})),
    });
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: agent as never,
      userText: 'Hi',
    });
    const res = new MockResponse() as unknown as ServerResponse;
    void handler.handle(res);
    await Promise.resolve();
    await expect(handler.handle(res)).rejects.toThrow('already processing');
  });

  it('handles resume stream with existing session', async () => {
    const handler = new SSEHandler({
      agentId: 'agent-1',
      agent: createAgent() as never,
      userText: '',
      sessionId: 'sess-existing',
      isResume: true,
      persistAssistantMessage: vi.fn(async () => {}),
    });
    const res = new MockResponse() as unknown as ServerResponse;
    await handler.handle(res);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
