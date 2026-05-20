import { createLogger } from '@markus/shared';
import { WebSocket } from 'ws';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac } from 'node:crypto';
import {
  PeerConnection,
  DataChannel,
  initLogger as initRtcLogger,
  type RtcConfig,
  type IceServer,
  DescriptionType,
} from 'node-datachannel';

const log = createLogger('remote');

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const PEER_PING_INTERVAL_MS = 15_000;
const PEER_PING_TIMEOUT_MS = 10_000;
const RELAY_INACTIVITY_TIMEOUT_MS = 5 * 60_000;

export interface RemoteAccessConfig {
  hubUrl: string;
  hubToken: string;
  instanceName?: string;
  localPort: number;
  jwtSecret?: string;
}

export interface RemotePeerInfo {
  peerId: string;
  transport: 'p2p' | 'relay' | 'connecting';
  connectedAt: number;
  lastActiveAt: number;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  connected: boolean;
  state: 'idle' | 'registering' | 'connecting' | 'connected' | 'disconnected';
  instanceId: string | null;
  remoteUrl: string | null;
  signalUrl: string | null;
  peerCount: number;
  peers: RemotePeerInfo[];
}

interface TurnServer {
  urls: string;
  username: string;
  credential: string;
}

interface RegistrationResult {
  instanceId: string;
  signalingToken: string;
  signalUrl: string;
  remoteUrl: string;
  turnServers?: TurnServer[] | null;
}

interface PeerSession {
  pc: PeerConnection | null;
  dc: DataChannel | null;
  pendingChunks: Map<string, Buffer[]>;
  markusToken: string | null;
  connectedAt: number;
  lastActiveAt: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  lastPong: number;
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
  private localOwnerUserId: string | null = null;

  private statusListeners = new Set<(status: RemoteAccessStatus) => void>();

  constructor(config: RemoteAccessConfig) {
    this.config = config;
    initRtcLogger('Warning');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.destroyed = false;
    log.info('Starting remote access agent...');

    await this.discoverLocalOwner();

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

  private async discoverLocalOwner(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await new Promise<string>((resolve, reject) => {
          const req = httpRequest(
            `http://127.0.0.1:${this.config.localPort}/api/users`,
            { method: 'GET', headers: { host: `127.0.0.1:${this.config.localPort}` } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks).toString()));
            }
          );
          req.on('error', reject);
          req.end();
        });

        const data = JSON.parse(resp);
        const users = data.users as Array<{ id: string; role: string }> | undefined;
        if (users?.length) {
          const owner = users.find(u => u.role === 'owner') ?? users[0];
          this.localOwnerUserId = owner!.id;
          log.info('Discovered local owner', { userId: this.localOwnerUserId });
        }
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          log.warn('Failed to discover local owner, using synthetic user', { error: String(err) });
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    for (const [peerId, session] of this.peers) {
      try { session.dc?.close(); } catch { /* ignore */ }
      try { session.pc?.close(); } catch { /* ignore */ }
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
    const wsOpen = this.ws?.readyState === WebSocket.OPEN;
    let state: RemoteAccessStatus['state'] = 'idle';
    if (!this.destroyed) {
      if (wsOpen) state = 'connected';
      else if (this.registration) state = 'connecting';
      else if (this.reconnectTimer) state = 'connecting';
      else state = 'registering';
    }

    const peers: RemotePeerInfo[] = [];
    for (const [peerId, session] of this.peers) {
      let transport: 'p2p' | 'relay' | 'connecting' = 'connecting';
      if (session.dc && session.dc.isOpen()) {
        transport = 'p2p';
      } else if (wsOpen) {
        transport = 'relay';
      }
      peers.push({
        peerId,
        transport,
        connectedAt: session.connectedAt,
        lastActiveAt: session.lastActiveAt,
      });
    }

    return {
      enabled: !this.destroyed,
      connected: wsOpen,
      state,
      instanceId: this.registration?.instanceId ?? null,
      remoteUrl: this.registration?.remoteUrl ?? null,
      signalUrl: this.registration?.signalUrl ?? null,
      peerCount: this.peers.size,
      peers,
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

  private hubFetch(method: string, path: string, body?: unknown, _redirects = 0): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.hubUrl);
      const data = body ? JSON.stringify(body) : undefined;
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;

      const req = transport(
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
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (_redirects >= 5) { reject(new Error('Too many redirects')); return; }
            const redirectUrl = new URL(res.headers.location, url);
            this.config.hubUrl = redirectUrl.origin;
            resolve(this.hubFetch(method, redirectUrl.pathname + redirectUrl.search, body, _redirects + 1));
            return;
          }
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
    const peerId = (msg['peerId'] ?? msg['from']) as string | undefined;

    switch (type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'registered':
        log.info('Registered with signal server', { instanceId: msg['instanceId'] });
        break;
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
      case 'relay_activated':
        if (peerId) log.info('Peer activated relay mode', { peerId });
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
    } else if (!session.pc) {
      // ICE restart: create new PC but preserve existing session state (markusToken, etc.)
      log.info('Received offer for relay-only peer, upgrading to P2P', { peerId });
      const newSession = this.createPeerConnection(peerId);
      newSession.markusToken = session.markusToken;
      newSession.connectedAt = session.connectedAt;
      newSession.lastActiveAt = session.lastActiveAt;
      if (session.pingTimer) clearInterval(session.pingTimer);
      session = newSession;
    }

    session.pc!.setRemoteDescription(sdp, DescriptionType.Offer);
  }

  private handleIce(peerId: string, candidate: string, mid?: string): void {
    const session = this.peers.get(peerId);
    if (!session?.pc) return;
    session.pc.addRemoteCandidate(candidate, mid ?? '0');
  }

  private createPeerConnection(peerId: string): PeerSession {
    if (this.peers.has(peerId)) {
      this.cleanupPeer(peerId);
    }

    const iceServers: (string | IceServer)[] = [...STUN_SERVERS];
    if (this.registration?.turnServers) {
      for (const t of this.registration.turnServers) {
        const parsed = t.urls.match(/^(turns?):([^:?]+):(\d+)/);
        if (parsed) {
          const isTcp = t.urls.includes('transport=tcp');
          const isTls = parsed[1] === 'turns';
          let relayType = 'TurnUdp';
          if (isTls) relayType = 'TurnTls';
          else if (isTcp) relayType = 'TurnTcp';
          iceServers.push({
            hostname: parsed[2]!,
            port: parseInt(parsed[3]!, 10),
            username: t.username,
            password: t.credential,
            relayType,
          } as IceServer);
        }
      }
    }
    const pc = new PeerConnection(`markus-${peerId}`, {
      iceServers,
    } satisfies RtcConfig);

    const now = Date.now();
    const session: PeerSession = { pc, dc: null, pendingChunks: new Map(), markusToken: null, connectedAt: now, lastActiveAt: now, pingTimer: null, lastPong: now };
    this.peers.set(peerId, session);

    pc.onStateChange((state: string) => {
      log.debug('Peer state change', { peerId, state });
      if (state === 'failed' || state === 'closed') {
        this.handlePcFailed(peerId);
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
      session.lastPong = Date.now();
      this.emitStatus();

      dc.onMessage((msg: string | Buffer) => {
        const data = typeof msg === 'string' ? msg : msg.toString('utf-8');
        session.lastActiveAt = Date.now();
        this.handleDataChannelMessage(peerId, data);
      });

      dc.onClosed(() => {
        log.info('DataChannel closed, keeping session for relay', { peerId });
        session.dc = null;
        this.emitStatus();
      });
    });

    return session;
  }

  private handlePcFailed(peerId: string): void {
    const session = this.peers.get(peerId);
    if (!session) return;

    log.info('WebRTC failed, keeping session alive for relay', { peerId });
    try { session.dc?.close(); } catch { /* ignore */ }
    session.dc = null;
    try { session.pc?.close(); } catch { /* ignore */ }
    session.pc = null;
  }

  private cleanupPeer(peerId: string): void {
    const session = this.peers.get(peerId);
    if (!session) return;

    if (session.pingTimer) clearInterval(session.pingTimer);
    try { session.dc?.close(); } catch { /* ignore */ }
    try { session.pc?.close(); } catch { /* ignore */ }
    for (const [key, ws] of this.wsConnections) {
      if (key.startsWith(`${peerId}:`)) {
        ws.close();
        this.wsConnections.delete(key);
      }
    }
    this.peers.delete(peerId);
    this.emitStatus();
    log.info('Peer cleaned up', { peerId });
  }

  private startPeerPing(peerId: string, session: PeerSession): void {
    if (session.pingTimer) clearInterval(session.pingTimer);
    session.lastPong = Date.now();
    session.pingTimer = setInterval(() => {
      const now = Date.now();

      // Check inactivity — clean up if no messages for RELAY_INACTIVITY_TIMEOUT_MS
      if (now - session.lastActiveAt > RELAY_INACTIVITY_TIMEOUT_MS) {
        log.info('Peer inactive for too long, cleaning up', { peerId });
        this.cleanupPeer(peerId);
        return;
      }

      // Check pong timeout
      const elapsed = now - session.lastPong;
      if (elapsed > PEER_PING_TIMEOUT_MS) {
        log.warn('Peer ping timeout, unresponsive', { peerId, elapsed });
        this.cleanupPeer(peerId);
        return;
      }

      // Send ping via whatever transport is available (DC or relay)
      this.sendRaw(peerId, JSON.stringify({ type: '__ping' }));
    }, PEER_PING_INTERVAL_MS);
  }

  // ── DataChannel Message Handling (HTTP/WS proxy) ─────────────────────────

  private handleDataChannelMessage(peerId: string, raw: string): void {
    const session = this.peers.get(peerId);
    if (session) session.lastActiveAt = Date.now();

    try {
      const msg = JSON.parse(raw);
      const type = msg.type as string;

      switch (type) {
        case '__pong': {
          const s = this.peers.get(peerId);
          if (s) s.lastPong = Date.now();
          return;
        }
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
    if (!this.peers.has(peerId)) {
      log.info('Relay frame from unknown peer, creating relay-only session', { peerId });
      const now = Date.now();
      this.peers.set(peerId, {
        pc: null,
        dc: null,
        pendingChunks: new Map(),
        markusToken: null,
        connectedAt: now,
        lastActiveAt: now,
        pingTimer: null,
        lastPong: now,
      });
      this.emitStatus();
    }
    this.handleDataChannelMessage(peerId, data);
  }

  private generateMarkusToken(): string {
    const secret = this.config.jwtSecret ?? process.env['JWT_SECRET'] ?? 'markus-dev-secret-change-in-prod';
    const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
    const userId = this.localOwnerUserId ?? 'remote_owner';
    return signJwt({ userId, orgId: 'default', role: 'owner', exp }, secret);
  }

  private handleAuthHandshake(peerId: string, _msg: Record<string, unknown>): void {
    const session = this.peers.get(peerId);
    if (session && !session.markusToken) {
      session.markusToken = this.generateMarkusToken();
    }
    if (session && !session.pingTimer) {
      this.startPeerPing(peerId, session);
    }
    this.sendToPeer(peerId, {
      type: 'auth_ok',
      instanceName: this.config.instanceName ?? 'My Markus',
      token: session?.markusToken ?? null,
    });
  }

  private proxyHttpRequest(peerId: string, msg: Record<string, unknown>): void {
    const reqId = msg.id as string;
    const method = (msg.method as string) ?? 'GET';
    const path = (msg.path as string) ?? '/';
    const headers = (msg.headers as Record<string, string>) ?? {};
    const body = msg.body as string | undefined;

    const session = this.peers.get(peerId);
    if (session && !session.markusToken) {
      session.markusToken = this.generateMarkusToken();
    }
    const tokenCookie = session?.markusToken ? `markus_token=${session.markusToken}` : '';
    const existingCookie = headers['cookie'] ?? headers['Cookie'] ?? '';
    const cookie = existingCookie ? `${existingCookie}; ${tokenCookie}` : tokenCookie;

    const url = new URL(path, `http://127.0.0.1:${this.config.localPort}`);

    const req = httpRequest(
      url,
      {
        method,
        headers: { ...headers, host: `127.0.0.1:${this.config.localPort}`, cookie },
      },
      (res: IncomingMessage) => {
        const contentType = res.headers['content-type'] ?? '';
        const isStreaming = contentType.includes('text/event-stream') ||
          contentType.includes('application/x-ndjson') ||
          res.headers['transfer-encoding'] === 'chunked' && contentType.includes('stream');

        if (isStreaming) {
          this.sendToPeer(peerId, {
            type: 'http_response_start',
            id: reqId,
            status: res.statusCode ?? 200,
            headers: res.headers,
          });

          res.on('data', (c: Buffer) => {
            this.sendToPeer(peerId, {
              type: 'http_response_chunk',
              id: reqId,
              data: c.toString('base64'),
            });
          });

          res.on('end', () => {
            this.sendToPeer(peerId, {
              type: 'http_response_end',
              id: reqId,
            });
          });
        } else {
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

    const session = this.peers.get(peerId);
    if (session && !session.markusToken) {
      session.markusToken = this.generateMarkusToken();
    }
    const headers: Record<string, string> = {};
    if (session?.markusToken) {
      headers['cookie'] = `markus_token=${session.markusToken}`;
    }

    const ws = new WebSocket(wsUrl, { headers });
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

  private static readonly CHUNK_SIZE = 48 * 1024; // 48KB per chunk (safe for DC + relay)

  private sendToPeer(peerId: string, msg: unknown): void {
    const data = JSON.stringify(msg);

    if (data.length > RemoteAccessAgent.CHUNK_SIZE) {
      this.sendChunked(peerId, data);
      return;
    }

    this.sendRaw(peerId, data);
  }

  private sendChunked(peerId: string, data: string): void {
    const chunkId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const total = Math.ceil(data.length / RemoteAccessAgent.CHUNK_SIZE);

    for (let i = 0; i < total; i++) {
      const chunk = data.slice(i * RemoteAccessAgent.CHUNK_SIZE, (i + 1) * RemoteAccessAgent.CHUNK_SIZE);
      this.sendRaw(peerId, JSON.stringify({
        type: '__chunk',
        chunkId,
        index: i,
        total,
        data: chunk,
      }));
    }
  }

  private sendRaw(peerId: string, data: string): void {
    // Prefer P2P DataChannel — direct, low latency
    const session = this.peers.get(peerId);
    if (session?.dc && session.dc.isOpen()) {
      try {
        session.dc.sendMessage(data);
        return;
      } catch (err) {
        log.warn('DataChannel send failed, falling back to relay', { peerId, error: String(err) });
      }
    }

    // Fallback to relay via signaling WS
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'relay_frame', peerId, data });
      return;
    }

    log.warn('No transport available for peer', { peerId });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'pong' });
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
