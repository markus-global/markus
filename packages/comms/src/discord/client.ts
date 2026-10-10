import { createLogger } from '@markus/shared';
// Route outbound calls through the platform's proxy-aware fetch (../net/http.ts).
import { httpFetch, type FetchLike } from '../net/http.js';

const log = createLogger('discord-client');

export type DiscordMessageHandler = (message: DiscordMessage) => void | Promise<void>;

export interface DiscordClientConfig {
  botToken: string;
  apiUrl?: string;
  gatewayUrl?: string;
  reconnectDelaysMs?: number[];
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  message_reference?: {
    message_id?: string;
  };
}

export interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
}

export interface DiscordGatewayEvent {
  op: number;
  t?: string;
  d?: Record<string, unknown> | null;
  s?: number;
}

export interface DiscordRestTransport {
  fetch: FetchLike;
}

export interface DiscordGatewayTransport {
  connect(url: string, onMessage: (event: DiscordGatewayEvent) => void, onclose: (code?: number) => void): void;
  send(payload: unknown): void;
  close(): void;
}

/** Node 22's native WebSocket; no Discord SDK is bundled. */
class NativeGateway implements DiscordGatewayTransport {
  private socket?: WebSocket;

  connect(url: string, onMessage: (event: DiscordGatewayEvent) => void, onClose: (code?: number) => void): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const payload: unknown = JSON.parse(String(event.data));
        if (typeof payload === 'object' && payload !== null && 'op' in payload && typeof payload.op === 'number') {
          onMessage(payload as DiscordGatewayEvent);
        }
      } catch {
        socket.close(1002, 'Invalid Gateway payload');
      }
    };
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

export class DiscordClient {
  private readonly config: DiscordClientConfig;
  private readonly apiUrl: string;
  private readonly gatewayUrl: string;
  private messageHandler?: DiscordMessageHandler;
  private connected = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatStart?: ReturnType<typeof setTimeout>;
  private sequence: number | null = null;
  private acknowledged = true;
  private sessionId?: string;
  private resumeUrl?: string;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;

  constructor(
    config: DiscordClientConfig,
    private readonly rest: DiscordRestTransport = { fetch: httpFetch },
    private readonly gateway: DiscordGatewayTransport = new NativeGateway(),
  ) {
    this.config = config;
    this.apiUrl = config.apiUrl ?? 'https://discord.com/api/v10';
    this.gatewayUrl = config.gatewayUrl ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
  }

  async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async sendReply(channelId: string, replyToId: string, content: string): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        message_reference: {
          message_id: replyToId,
        },
      }),
    });
  }

  async getCurrentUser(): Promise<DiscordUser> {
    return this.request<DiscordUser>('/users/@me');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.rest.fetch(`${this.apiUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private connectGateway(): void {
    this.gateway?.connect(
      this.resumeUrl ?? this.gatewayUrl,
      (event) => {
        this.handleGatewayEvent(event).catch((error) => {
          log.error('Failed to handle Discord Gateway event', { error });
        });
      },
      (code) => {
        this.clearHeartbeat();
        this.connected = false;
        if (this.rejectReady) {
          this.rejectReady(new Error(`Discord Gateway connection failed (${code ?? 'network'})`));
          this.disconnect();
          return;
        }

        if (code && [4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
          this.disconnect();
          return;
        }
        if (code === 4007 || code === 4009) {
          this.sessionId = undefined;
          this.resumeUrl = undefined;
          this.sequence = null;
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      },
    );
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delays = this.config.reconnectDelaysMs ?? [1000, 2000, 5000, 10000];
    const index = Math.min(this.reconnectAttempt, delays.length - 1);
    const delay = delays[index] ?? 1000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      try {
        this.connectGateway();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async connect(onMessage: DiscordMessageHandler): Promise<void> {
    this.disconnect();
    if (typeof this.config.botToken !== 'string' || !this.config.botToken.trim()) {
      throw new Error('Discord bot token is required');
    }
    const delays = this.config.reconnectDelaysMs;
    if (delays && (!delays.length || delays.some(delay => !Number.isFinite(delay) || delay <= 0))) {
      throw new Error('Discord reconnect delays must be positive finite numbers');
    }
    await this.getCurrentUser();

    this.messageHandler = onMessage;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discord Gateway connection timed out')), 15000);
        this.resolveReady = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.rejectReady = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
        try {
          this.connectGateway();
        } catch {
          this.rejectReady(new Error('Discord Gateway connection failed'));
        }
      });
    } catch (error) {
      this.disconnect();
      throw error;
    } finally {
      this.resolveReady = undefined;
      this.rejectReady = undefined;
    }
  }

  disconnect(): void {
    this.rejectReady?.(new Error('Discord connection cancelled'));
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.gateway?.close();
    this.clearHeartbeat();
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.sequence = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async handleGatewayEvent(event: DiscordGatewayEvent): Promise<void> {
    if (!this.shouldReconnect) return;
    if (typeof event.s === 'number') this.sequence = event.s;
    if (event.op === 11) {
      this.acknowledged = true;
      return;
    }
    if (event.op === 1) {
      this.sendHeartbeat();
      return;
    }
    if (event.op === 7 || event.op === 9) {
      if (event.op === 9) {
        this.sessionId = undefined;
        this.resumeUrl = undefined;
        this.sequence = null;
      }
      this.reconnect();
      return;
    }
    if (event.op === 10) {
      const interval = event.d?.heartbeat_interval;
      if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
        this.reconnect();
        return;
      }
      this.clearHeartbeat();
      this.acknowledged = true;
      this.heartbeatStart = setTimeout(() => {
        if (!this.sendHeartbeat()) return;
        this.heartbeatTimer = setInterval(() => {
          if (!this.acknowledged) {
            this.reconnect();
            return;
          }
          this.sendHeartbeat();
        }, interval);
      }, Math.random() * interval);
      if (this.sessionId) {
        this.gateway.send({
          op: 6,
          d: {
            token: this.config.botToken,
            session_id: this.sessionId,
            seq: this.sequence,
          },
        });
        return;
      }
      this.gateway?.send({
        op: 2,
        d: {
          token: this.config.botToken,
          intents: 33280,
          properties: {
            os: 'linux',
            browser: 'markus',
            device: 'markus',
          },
        },
      });
      return;
    }

    if (event.op === 0 && event.t === 'READY') {
      this.sessionId = typeof event.d?.session_id === 'string' ? event.d.session_id : undefined;
      if (typeof event.d?.resume_gateway_url === 'string') {
        const url = new URL(event.d.resume_gateway_url);
        url.searchParams.set('v', '10');
        url.searchParams.set('encoding', 'json');
        this.resumeUrl = url.toString();
      }
      this.connected = true;
      this.reconnectAttempt = 0;
      this.resolveReady?.();
      return;
    }
    if (event.op === 0 && event.t === 'RESUMED') {
      this.connected = true;
      this.reconnectAttempt = 0;
      return;
    }

    if (
      event.op === 0 &&
      event.t === 'MESSAGE_CREATE' &&
      event.d &&
      typeof event.d.id === 'string' &&
      typeof event.d.channel_id === 'string' &&
      typeof event.d.content === 'string' &&
      typeof event.d.timestamp === 'string' &&
      typeof event.d.author === 'object' &&
      event.d.author !== null &&
      'id' in event.d.author &&
      typeof event.d.author.id === 'string' &&
      'username' in event.d.author &&
      typeof event.d.author.username === 'string'
    ) {
      await this.messageHandler?.(event.d as unknown as DiscordMessage);
    }
  }

  private clearHeartbeat(): void {
    clearTimeout(this.heartbeatStart);
    clearInterval(this.heartbeatTimer);
    this.heartbeatStart = undefined;
    this.heartbeatTimer = undefined;
  }

  private sendHeartbeat(): boolean {
    this.acknowledged = false;
    try {
      this.gateway.send({ op: 1, d: this.sequence });
      return true;
    } catch {
      this.reconnect();
      return false;
    }
  }

  private reconnect(): void {
    this.clearHeartbeat();
    this.connected = false;
    this.gateway.close();
    this.scheduleReconnect();
  }
}
