import { createLogger } from '@markus/shared';
import { WebSocket } from 'ws';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import {
  PeerConnection,
  DataChannel,
  initLogger as initRtcLogger,
  type RtcConfig,
  DescriptionType,
} from 'node-datachannel';

const log = createLogger('remote');

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

export interface RemoteAccessConfig {
  hubUrl: string;
  hubToken: string;
  instanceName?: string;
  localPort: number;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  connected: boolean;
  instanceId: string | null;
  remoteUrl: string | null;
  signalUrl: string | null;
  peerCount: number;
}

interface RegistrationResult {
  instanceId: string;
  signalingToken: string;
  signalUrl: string;
  remoteUrl: string;
}

interface PeerSession {
  pc: PeerConnection;
  dc: DataChannel | null;
  pendingChunks: Map<string, Buffer[]>;
}

export class RemoteAccessAgent {
  private config: RemoteAccessConfig;
  private ws: WebSocket | null = null;
  private registration: RegistrationResult | null = null;
  private peers = new Map<string, PeerSession>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private destroyed = false;

  private statusListeners = new Set<(status: RemoteAccessStatus) => void>();

  constructor(config: RemoteAccessConfig) {
    this.config = config;
    initRtcLogger('Warning');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.destroyed) return;
    log.info('Starting remote access agent...');

    try {
      this.registration = await this.registerInstance();
      log.info('Registered with Hub', {
        instanceId: this.registration.instanceId,
        remoteUrl: this.registration.remoteUrl,
      });
      this.connectSignaling();
    } catch (err) {
      log.error('Failed to register with Hub', { error: String(err) });
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    for (const [peerId, session] of this.peers) {
      try { session.dc?.close(); } catch { /* ignore */ }
      try { session.pc.close(); } catch { /* ignore */ }
      this.peers.delete(peerId);
    }

    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }

    if (this.registration) {
      await this.unregisterInstance().catch(() => {});
      this.registration = null;
    }

    this.emitStatus();
    log.info('Remote access agent stopped');
  }

  getStatus(): RemoteAccessStatus {
    return {
      enabled: !this.destroyed,
      connected: this.ws?.readyState === WebSocket.OPEN,
      instanceId: this.registration?.instanceId ?? null,
      remoteUrl: this.registration?.remoteUrl ?? null,
      signalUrl: this.registration?.signalUrl ?? null,
      peerCount: this.peers.size,
    };
  }

  onStatus(listener: (status: RemoteAccessStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ── Hub Registration ──────────────────────────────────────────────────────

  private async registerInstance(): Promise<RegistrationResult> {
    const resp = await this.hubFetch('POST', '/api/remote/instances', {
      name: this.config.instanceName ?? 'My Markus',
    });
    return resp as RegistrationResult;
  }

  private async unregisterInstance(): Promise<void> {
    if (!this.registration) return;
    await this.hubFetch('DELETE', '/api/remote/instances', {
      instanceId: this.registration.instanceId,
    });
  }

  private hubFetch(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.hubUrl);
      const data = body ? JSON.stringify(body) : undefined;

      const req = httpRequest(
        url,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.hubToken}`,
            ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
          },
        },
        (res: IncomingMessage) => {
          let raw = '';
          res.on('data', (c: Buffer) => (raw += c.toString()));
          res.on('end', () => {
            try {
              const json = JSON.parse(raw);
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(json.error ?? `HTTP ${res.statusCode}`));
              } else {
                resolve(json);
              }
            } catch {
              reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
            }
          });
        }
      );

      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ── Signaling WebSocket ───────────────────────────────────────────────────

  private connectSignaling(): void {
    if (this.destroyed || !this.registration) return;

    const { signalUrl, signalingToken } = this.registration;
    const wsUrl = `${signalUrl}?token=${encodeURIComponent(signalingToken)}`;

    log.info('Connecting to signal server...', { signalUrl });

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      log.info('Signal server connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emitStatus();

      this.send({ type: 'register', instanceId: this.registration!.instanceId });
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleSignalingMessage(msg);
      } catch (err) {
        log.warn('Invalid signaling message', { error: String(err) });
      }
    });

    ws.on('close', (code: number) => {
      log.warn('Signal server disconnected', { code });
      this.stopHeartbeat();
      this.ws = null;
      this.emitStatus();
      if (!this.destroyed) this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('Signal server error', { error: err.message });
    });
  }

  private handleSignalingMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;
    const peerId = msg['peerId'] as string | undefined;

    switch (type) {
      case 'peer_request':
        if (peerId) this.handlePeerRequest(peerId);
        break;
      case 'offer':
        if (peerId && msg['sdp']) {
          this.handleOffer(peerId, msg['sdp'] as string);
        }
        break;
      case 'ice':
        if (peerId && msg['candidate']) {
          this.handleIce(peerId, msg['candidate'] as string, msg['mid'] as string | undefined);
        }
        break;
      case 'peer_disconnected':
        if (peerId) this.cleanupPeer(peerId);
        break;
      case 'relay_frame':
        if (peerId && msg['data']) {
          this.handleRelayFrame(peerId, msg['data'] as string);
        }
        break;
      default:
        log.debug('Unknown signaling message type', { type });
    }
  }

  // ── WebRTC Peer Connections ───────────────────────────────────────────────

  private handlePeerRequest(peerId: string): void {
    log.info('Peer connection requested', { peerId });
    this.createPeerConnection(peerId);
  }

  private handleOffer(peerId: string, sdp: string): void {
    let session = this.peers.get(peerId);
    if (!session) {
      session = this.createPeerConnection(peerId);
    }

    session.pc.setRemoteDescription(sdp, DescriptionType.Offer);
  }

  private handleIce(peerId: string, candidate: string, mid?: string): void {
    const session = this.peers.get(peerId);
    if (!session) return;
    session.pc.addRemoteCandidate(candidate, mid ?? '0');
  }

  private createPeerConnection(peerId: string): PeerSession {
    if (this.peers.has(peerId)) {
      this.cleanupPeer(peerId);
    }

    const pc = new PeerConnection(`markus-${peerId}`, {
      iceServers: STUN_SERVERS,
    } satisfies RtcConfig);

    const session: PeerSession = { pc, dc: null, pendingChunks: new Map() };
    this.peers.set(peerId, session);

    pc.onStateChange((state: string) => {
      log.debug('Peer state change', { peerId, state });
      if (state === 'failed' || state === 'closed') {
        this.cleanupPeer(peerId);
      }
      this.emitStatus();
    });

    pc.onGatheringStateChange((state: string) => {
      log.debug('ICE gathering state', { peerId, state });
    });

    pc.onLocalDescription((sdp: string, type: DescriptionType) => {
      this.send({ type: type as string, peerId, sdp });
    });

    pc.onLocalCandidate((candidate: string, mid: string) => {
      this.send({ type: 'ice', peerId, candidate, mid });
    });

    pc.onDataChannel((dc: DataChannel) => {
      log.info('DataChannel opened', { peerId, label: dc.getLabel() });
      session.dc = dc;

      dc.onMessage((msg: string | Buffer) => {
        const data = typeof msg === 'string' ? msg : msg.toString('utf-8');
        this.handleDataChannelMessage(peerId, data);
      });

      dc.onClosed(() => {
        log.info('DataChannel closed', { peerId });
        this.cleanupPeer(peerId);
      });
    });

    return session;
  }

  private cleanupPeer(peerId: string): void {
    const session = this.peers.get(peerId);
    if (!session) return;

    try { session.dc?.close(); } catch { /* ignore */ }
    try { session.pc.close(); } catch { /* ignore */ }
    this.peers.delete(peerId);
    this.emitStatus();
    log.info('Peer cleaned up', { peerId });
  }

  // ── DataChannel Message Handling (HTTP/WS proxy) ─────────────────────────

  private handleDataChannelMessage(peerId: string, raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const type = msg.type as string;

      switch (type) {
        case 'http':
          this.proxyHttpRequest(peerId, msg);
          break;
        case 'ws_open':
          this.proxyWsOpen(peerId, msg);
          break;
        case 'ws_message':
          this.proxyWsMessage(peerId, msg);
          break;
        case 'ws_close':
          this.proxyWsClose(peerId, msg);
          break;
        case 'auth':
          this.handleAuthHandshake(peerId, msg);
          break;
        default:
          this.sendToPeer(peerId, { type: 'error', error: `Unknown message type: ${type}` });
      }
    } catch (err) {
      log.warn('Invalid DataChannel message', { peerId, error: String(err) });
    }
  }

  private handleRelayFrame(peerId: string, data: string): void {
    this.handleDataChannelMessage(peerId, data);
  }

  private handleAuthHandshake(peerId: string, _msg: Record<string, unknown>): void {
    this.sendToPeer(peerId, {
      type: 'auth_ok',
      instanceName: this.config.instanceName ?? 'My Markus',
    });
  }

  private proxyHttpRequest(peerId: string, msg: Record<string, unknown>): void {
    const reqId = msg.id as string;
    const method = (msg.method as string) ?? 'GET';
    const path = (msg.path as string) ?? '/';
    const headers = (msg.headers as Record<string, string>) ?? {};
    const body = msg.body as string | undefined;

    const url = new URL(path, `http://127.0.0.1:${this.config.localPort}`);

    const req = httpRequest(
      url,
      {
        method,
        headers: { ...headers, host: `127.0.0.1:${this.config.localPort}` },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('base64');
          this.sendToPeer(peerId, {
            type: 'http_response',
            id: reqId,
            status: res.statusCode ?? 200,
            headers: res.headers,
            body: bodyStr,
          });
        });
      }
    );

    req.on('error', (err: Error) => {
      this.sendToPeer(peerId, {
        type: 'http_response',
        id: reqId,
        status: 502,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: err.message })).toString('base64'),
      });
    });

    if (body) req.write(Buffer.from(body, 'base64'));
    req.end();
  }

  private wsConnections = new Map<string, WebSocket>();

  private proxyWsOpen(peerId: string, msg: Record<string, unknown>): void {
    const wsId = msg.wsId as string;
    const path = (msg.path as string) ?? '/ws';
    const wsUrl = `ws://127.0.0.1:${this.config.localPort}${path}`;

    const ws = new WebSocket(wsUrl);
    const key = `${peerId}:${wsId}`;

    ws.on('open', () => {
      this.wsConnections.set(key, ws);
      this.sendToPeer(peerId, { type: 'ws_opened', wsId });
    });

    ws.on('message', (data: Buffer) => {
      this.sendToPeer(peerId, {
        type: 'ws_frame',
        wsId,
        data: data.toString('utf-8'),
      });
    });

    ws.on('close', (code: number) => {
      this.wsConnections.delete(key);
      this.sendToPeer(peerId, { type: 'ws_closed', wsId, code });
    });

    ws.on('error', (err: Error) => {
      this.wsConnections.delete(key);
      this.sendToPeer(peerId, { type: 'ws_error', wsId, error: err.message });
    });
  }

  private proxyWsMessage(peerId: string, msg: Record<string, unknown>): void {
    const wsId = msg.wsId as string;
    const key = `${peerId}:${wsId}`;
    const ws = this.wsConnections.get(key);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(msg.data as string);
    }
  }

  private proxyWsClose(peerId: string, msg: Record<string, unknown>): void {
    const wsId = msg.wsId as string;
    const key = `${peerId}:${wsId}`;
    const ws = this.wsConnections.get(key);
    if (ws) {
      ws.close();
      this.wsConnections.delete(key);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendToPeer(peerId: string, msg: unknown): void {
    const session = this.peers.get(peerId);
    const data = JSON.stringify(msg);

    if (session?.dc && session.dc.isOpen()) {
      try {
        session.dc.sendMessage(data);
        return;
      } catch (err) {
        log.warn('DataChannel send failed, falling back to relay', { peerId, error: String(err) });
      }
    }

    this.send({ type: 'relay_frame', peerId, data });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;
    log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => this.start(), delay);
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }
}
