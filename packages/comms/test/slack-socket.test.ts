/**
 * Slack Socket Mode — slice G7 (design §8 / §6.3).
 *
 * Socket Mode is the reason "Slack can connect without a public URL": instead of
 * exposing an HTTPS webhook, the app POSTs its app-level token to
 * `apps.connections.open`, gets a WebSocket URL, and receives every event over
 * that socket as an *envelope* which must be ACKed within ~3 s.
 *
 * The wire is injected (a fake socket + a fake REST transport), exactly as the
 * Discord client injects its gateway, so the protocol invariants are pinned
 * without a Slack app:
 *   - connect dials the URL returned by `apps.connections.open`, with the token;
 *   - `hello` is the ready signal;
 *   - every event envelope is ACKed **exactly once**, **before** the handler runs;
 *   - a `disconnect` envelope reconnects; a malformed frame is ignored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@markus/shared';
import {
  SlackSocketMode,
  type SlackEnvelope,
  type SlackSocketRestTransport,
  type SlackSocketTransport,
} from '../src/slack/socket.js';
import { SlackAdapter } from '../src/slack/adapter.js';

class FakeSocket implements SlackSocketTransport {
  url = '';
  sent: string[] = [];
  closed = false;
  private onMessage?: (raw: string) => void;
  private onClose?: (code?: number) => void;

  connect(url: string, onMessage: (raw: string) => void, onClose: (code?: number) => void): void {
    this.url = url;
    this.closed = false;
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  send(payload: unknown): void {
    this.sent.push(JSON.stringify(payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(1000);
  }

  emit(obj: unknown): void {
    this.onMessage?.(JSON.stringify(obj));
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

interface RestCall {
  url: string;
  auth?: string;
  body?: string;
}

/** A REST transport that answers every call with `{ ok: true, url }`. */
function restReturning(url: string): { transport: SlackSocketRestTransport; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
    const headers = init?.headers ?? {};
    calls.push({
      url: String(input),
      auth: headers.Authorization ?? headers.authorization,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url }),
    };
  });
  return { transport: { fetch: fetchMock as unknown as typeof globalThis.fetch }, calls };
}

/** Dial a mode and drive it to `hello`, returning the live fake socket. */
async function dial(mode: SlackSocketMode, socket: FakeSocket, url: string): Promise<void> {
  const connecting = mode.connect(() => undefined);
  await vi.waitFor(() => expect(socket.url).toBe(url));
  socket.emit({ type: 'hello' });
  await connecting;
}

describe('SlackSocketMode — transport', () => {
  it('opens a connection with the app token and dials the returned WSS url', async () => {
    const { transport, calls } = restReturning('wss://wss-primary.slack.com/link/?ticket=t1');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1-abc' }, transport, socket);

    await dial(mode, socket, 'wss://wss-primary.slack.com/link/?ticket=t1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/apps.connections.open');
    expect(calls[0]!.auth).toBe('Bearer xapp-1-abc');
    expect(mode.isConnected()).toBe(true);
    mode.disconnect();
  });

  it('ACKs each event envelope exactly once', async () => {
    const { transport } = restReturning('wss://a');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1' }, transport, socket);
    const seen: SlackEnvelope[] = [];
    const connecting = mode.connect((env) => {
      seen.push(env);
    });
    await vi.waitFor(() => expect(socket.url).toBe('wss://a'));
    socket.emit({ type: 'hello' });
    await connecting;

    socket.emit({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: { type: 'event_callback', event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1' } },
    });

    expect(socket.frames()).toEqual([{ envelope_id: 'env-1' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('events_api');
    mode.disconnect();
  });

  it('ACKs before the handler resolves — the read loop is never blocked', async () => {
    const { transport } = restReturning('wss://a');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1' }, transport, socket);

    let releaseHandler: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const connecting = mode.connect(async () => {
      await gate; // a slow agent turn
    });
    await vi.waitFor(() => expect(socket.url).toBe('wss://a'));
    socket.emit({ type: 'hello' });
    await connecting;

    socket.emit({ type: 'events_api', envelope_id: 'env-slow', payload: {} });

    // The ACK is already on the wire while the handler is still parked.
    expect(socket.frames()).toEqual([{ envelope_id: 'env-slow' }]);

    releaseHandler();
    mode.disconnect();
  });

  it('still ACKs when the handler throws (a bad handler must not drop the event)', async () => {
    const { transport } = restReturning('wss://a');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1' }, transport, socket);
    const connecting = mode.connect(() => {
      throw new Error('handler exploded');
    });
    await vi.waitFor(() => expect(socket.url).toBe('wss://a'));
    socket.emit({ type: 'hello' });
    await connecting;

    socket.emit({ type: 'events_api', envelope_id: 'env-boom', payload: {} });
    expect(socket.frames()).toEqual([{ envelope_id: 'env-boom' }]);
    mode.disconnect();
  });

  it('ignores malformed frames instead of tearing the socket down', async () => {
    const { transport } = restReturning('wss://a');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1' }, transport, socket);
    const connecting = mode.connect(() => undefined);
    await vi.waitFor(() => expect(socket.url).toBe('wss://a'));
    socket.emit({ type: 'hello' });
    await connecting;

    socket.emit('not-json-at-all');
    // @ts-expect-error — a JSON value that is not an object must also be ignored.
    socket.emit(42);
    expect(socket.frames()).toEqual([]);
    expect(mode.isConnected()).toBe(true);
    mode.disconnect();
  });

  it('reconnects when Slack sends a disconnect envelope', async () => {
    const { transport, calls } = restReturning('wss://a');
    const socket = new FakeSocket();
    const mode = new SlackSocketMode({ appToken: 'xapp-1', reconnectDelaysMs: [5] }, transport, socket);
    await dial(mode, socket, 'wss://a');
    expect(calls).toHaveLength(1);

    socket.emit({ type: 'disconnect', reason: 'warning' });

    await vi.waitFor(() => expect(calls.length).toBe(2));
    mode.disconnect();
  });

  it('refuses to connect without an app token', async () => {
    const { transport } = restReturning('wss://a');
    const mode = new SlackSocketMode({ appToken: '   ' }, transport, new FakeSocket());
    await expect(mode.connect(() => undefined)).rejects.toThrow(/app token/i);
  });
});

describe('SlackAdapter — Socket Mode needs no public URL', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('connects with socketMode + appToken and no webhookPort', async () => {
    const { transport, calls } = restReturning('wss://wss-primary.slack.com/link/?ticket=t1');
    const socket = new FakeSocket();
    const adapter = new SlackAdapter({ rest: transport, socket });

    const connecting = adapter.connect({
      platform: 'slack',
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 'shh',
      socketMode: true,
    } as never);
    await vi.waitFor(() => expect(socket.url).not.toBe(''));
    socket.emit({ type: 'hello' });
    await connecting;

    expect(adapter.isConnected()).toBe(true);
    // auth.test + apps.connections.open — and no HTTP server was ever bound.
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/auth.test',
      'https://slack.com/api/apps.connections.open',
    ]);
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('routes a socket events_api envelope to onMessage as a slack Message', async () => {
    const { transport } = restReturning('wss://a');
    const socket = new FakeSocket();
    const adapter = new SlackAdapter({ rest: transport, socket });
    const messages: Message[] = [];
    adapter.onMessage((m) => {
      messages.push(m);
    });

    const connecting = adapter.connect({
      platform: 'slack',
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 'shh',
      socketMode: true,
    } as never);
    await vi.waitFor(() => expect(socket.url).toBe('wss://a'));
    socket.emit({ type: 'hello' });
    await connecting;

    socket.emit({
      type: 'events_api',
      envelope_id: 'env-42',
      payload: {
        type: 'event_callback',
        event: { type: 'message', text: '<@U0BOT> hello there', channel: 'C9', user: 'U1', ts: '7.7' },
      },
    });

    expect(socket.frames()).toEqual([{ envelope_id: 'env-42' }]);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      platform: 'slack',
      direction: 'inbound',
      channelId: 'C9',
      senderId: 'U1',
      content: { type: 'text', text: 'hello there' },
    });
    await adapter.disconnect();
  });
});
