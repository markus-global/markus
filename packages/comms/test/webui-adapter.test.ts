import { createServer, type Server } from 'node:http';
import { WebUIAdapter } from '../src/webui/adapter.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function httpRequest(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

describe('WebUIAdapter', () => {
  let adapter: WebUIAdapter;
  let port: number;

  beforeEach(async () => {
    port = await getFreePort();
    adapter = new WebUIAdapter();
    await adapter.connect({ platform: 'webui', port });
    await new Promise(r => setTimeout(r, 50));
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('has platform webui', () => {
    expect(adapter.platform).toBe('webui');
  });

  it('responds to health check', async () => {
    const res = await httpRequest(port, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('handles OPTIONS preflight', async () => {
    const res = await httpRequest(port, 'OPTIONS', '/api/message');
    expect(res.status).toBe(204);
  });

  it('sendMessage stores outbound messages retrievable via GET', async () => {
    await adapter.sendMessage('agent-1', 'Hello from agent');
    const res = await httpRequest(port, 'GET', '/api/messages?channelId=agent-1');
    expect(res.status).toBe(200);
    const messages = (res.body as { messages: Array<{ content: string; channelId: string }> }).messages;
    expect(messages.some(m => m.content === 'Hello from agent' && m.channelId === 'agent-1')).toBe(true);
  });

  it('sendReply delegates to sendMessage', async () => {
    const id = await adapter.sendReply('agent-1', 'ignored', 'Reply content');
    expect(id).toBeTruthy();
    const res = await httpRequest(port, 'GET', '/api/messages');
    const messages = (res.body as { messages: Array<{ content: string }> }).messages;
    expect(messages.some(m => m.content === 'Reply content')).toBe(true);
  });

  it('accepts inbound POST /api/message and invokes handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    const res = await httpRequest(port, 'POST', '/api/message', {
      agentId: 'agent-1',
      text: 'User message',
      senderId: 'user-1',
      senderName: 'Alice',
    });

    expect(res.status).toBe(200);
    expect((res.body as { received: boolean }).received).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].content.text).toBe('User message');
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await httpRequest(port, 'GET', '/unknown');
    expect(res.status).toBe(404);
  });

  it('isConnected reflects lifecycle', async () => {
    expect(adapter.isConnected()).toBe(true);
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});
