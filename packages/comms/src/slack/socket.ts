/**
 * Slack Socket Mode transport — design §8 / §6.3, slice G7.
 *
 * Why this exists: the Slack *webhook* path needs a publicly reachable HTTPS
 * URL, which a laptop (and most self-hosted installs) does not have. Socket Mode
 * inverts the connection — the app dials Slack:
 *
 *   1. `POST apps.connections.open` with the **app-level** token (`xapp-…`)
 *      returns a short-lived `wss://` URL.
 *   2. Every event arrives over that socket as an *envelope*.
 *   3. The envelope **must be ACKed within ~3 s** by sending back its
 *      `envelope_id`; otherwise Slack redelivers.
 *
 * Step 3 is where naive implementations break: the ACK is easy to hang off the
 * agent turn, which takes seconds. Here the ACK rides the read path — it is sent
 * the instant the envelope arrives (see `gateway/ack.ts`) and the handler is
 * dispatched **without being awaited**, so a slow turn never blocks the socket.
 *
 * The wire (REST + WebSocket) is injected, mirroring the Discord client, so the
 * protocol is testable without a Slack app.
 */
import { createLogger } from '@markus/shared';
// Route outbound calls through the platform's proxy-aware fetch (../net/http.ts).
import { httpFetch, type FetchLike } from '../net/http.js';
import { createDeadlineAck, type AckHandle } from '../gateway/ack.js';

const log = createLogger('slack-socket');

const DEFAULT_API_URL = 'https://slack.com/api';
const DEFAULT_ACK_DEADLINE_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;

/** An envelope Slack pushes over the socket. Only the fields we rely on. */
export interface SlackEnvelope {
  /** Present on every envelope that must be ACKed. */
  envelope_id?: string;
  /** `hello` | `events_api` | `slash_commands` | `interactive` | `disconnect` | … */
  type: string;
  payload?: Record<string, unknown>;
  accepts_response_payload?: boolean;
  /** Human-readable reason, present on `disconnect`. */
  reason?: string;
}

export interface SlackSocketConfig {
  /** App-level token (`xapp-…`) — the credential for Socket Mode. */
  appToken: string;
  /** REST base URL. Defaults to `https://slack.com/api`. */
  apiUrl?: string;
  /** Slack's ACK window. Defaults to 3000 ms. */
  ackDeadlineMs?: number;
  /** Backoff schedule for reconnects. Defaults to 1s/2s/5s/10s. */
  reconnectDelaysMs?: number[];
}

/** The WebSocket, injected so tests can drive the protocol deterministically. */
export interface SlackSocketTransport {
  connect(url: string, onMessage: (raw: string) => void, onClose: (code?: number) => void): void;
  send(payload: unknown): void;
  close(): void;
}

export interface SlackSocketRestTransport {
  fetch: FetchLike;
}

export type SlackSocketHandler = (envelope: SlackEnvelope, ack: AckHandle) => void | Promise<void>;

/** Node's native WebSocket; no Slack SDK is bundled. */
class NativeSocket implements SlackSocketTransport {
  private socket?: WebSocket;

  connect(url: string, onMessage: (raw: string) => void, onClose: (code?: number) => void): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => onMessage(String(event.data));
    socket.onclose = (event) => onClose(event.code);
    socket.onerror = () => {
      this.close();
      onClose(1006);
    };
  }

  send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
  }
}

export class SlackSocketMode {
  private readonly apiUrl: string;
  private handler?: SlackSocketHandler;
  private connected = false;
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;

  constructor(
    private readonly config: SlackSocketConfig,
    private readonly rest: SlackSocketRestTransport = { fetch: httpFetch },
    private readonly transport: SlackSocketTransport = new NativeSocket(),
  ) {
    this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Open the socket and resolve once Slack says `hello`. */
  async connect(handler: SlackSocketHandler): Promise<void> {
    if (typeof this.config.appToken !== 'string' || !this.config.appToken.trim()) {
      throw new Error('Slack app token (xapp-) is required for Socket Mode');
    }
    this.disconnect();
    this.handler = handler;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    await this.openSocket(true);
  }

  /** Close the socket and stop reconnecting. Idempotent. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.transport.close();
    this.connected = false;
    this.handler = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async openSocket(awaitReady: boolean): Promise<void> {
    const url = await this.requestSocketUrl();

    let ready: Promise<void> | undefined;
    if (awaitReady) {
      ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Slack Socket Mode connection timed out')),
          CONNECT_TIMEOUT_MS,
        );
        this.resolveReady = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.rejectReady = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
      });
    }

    try {
      this.transport.connect(
        url,
        (raw) => this.handleFrame(raw),
        () => this.handleClose(),
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.rejectReady) this.rejectReady(failure);
      else throw failure;
    }

    if (ready) {
      try {
        await ready;
      } finally {
        this.resolveReady = undefined;
        this.rejectReady = undefined;
      }
    }
  }

  private async requestSocketUrl(): Promise<string> {
    const response = await this.rest.fetch(`${this.apiUrl}/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = (await response.json()) as { ok?: boolean; url?: string; error?: string };
    if (!data?.ok || typeof data.url !== 'string' || data.url.length === 0) {
      throw new Error(`Slack apps.connections.open failed: ${data?.error ?? 'no url returned'}`);
    }
    return data.url;
  }

  private handleFrame(raw: string): void {
    let envelope: SlackEnvelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      if (typeof (parsed as { type?: unknown }).type !== 'string') return;
      envelope = parsed as SlackEnvelope;
    } catch {
      // A frame we cannot parse is not a reason to tear down the socket.
      log.debug('Ignoring unparsable Slack socket frame');
      return;
    }

    if (envelope.type === 'hello') {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.resolveReady?.();
      return;
    }

    if (envelope.type === 'disconnect') {
      log.warn('Slack asked for a reconnect', { reason: envelope.reason });
      this.reconnect();
      return;
    }

    if (typeof envelope.envelope_id !== 'string') return;

    // ACK on the read path: Slack's window is ~3 s, an agent turn is not.
    const envelopeId = envelope.envelope_id;
    const ack = createDeadlineAck(this.config.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS, () => {
      try {
        this.transport.send({ envelope_id: envelopeId });
      } catch (error) {
        log.error('Failed to ACK Slack envelope', { error });
      }
    });
    ack.ack();

    // Dispatch out-of-band: awaiting here would stall the socket for every event.
    try {
      const result = this.handler?.(envelope, ack);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error) =>
          log.error('Slack socket handler failed', { error }),
        );
      }
    } catch (error) {
      log.error('Slack socket handler threw synchronously', { error });
    }
  }

  private handleClose(): void {
    this.connected = false;
    if (this.shouldReconnect) this.scheduleReconnect();
  }

  private reconnect(): void {
    this.connected = false;
    const wasConnected = this.shouldReconnect;
    this.transport.close();
    if (wasConnected) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delays = this.config.reconnectDelaysMs ?? [1000, 2000, 5000, 10000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 1000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(false).catch((error) => {
        log.error('Slack Socket Mode reconnect failed', { error });
        this.scheduleReconnect();
      });
    }, delay);
    const unref = (this.reconnectTimer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(this.reconnectTimer);
  }
}
