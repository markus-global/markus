import type { Transport, WebSocketLike, ConnectionState } from './types';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

interface PendingRequest {
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}

/**
 * P2P Transport — routes HTTP/WS through WebRTC DataChannel to a remote Markus instance.
 * Falls back to relay mode via the signal server if P2P fails.
 */
export class P2PTransport implements Transport {
  private signalWs: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private wsProxies = new Map<string, VirtualWebSocket>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private _state: ConnectionState = 'disconnected';
  private reqCounter = 0;

  constructor(
    private signalUrl: string,
    private signalingToken: string,
    private instanceId: string,
  ) {}

  get state(): ConnectionState { return this._state; }

  onStateChange(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  async connect(): Promise<void> {
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      const wsUrl = `${this.signalUrl}?token=${encodeURIComponent(this.signalingToken)}`;
      const ws = new WebSocket(wsUrl);
      this.signalWs = ws;

      ws.onopen = () => {
        this.sendSignal({ type: 'peer_request', instanceId: this.instanceId });
        this.setupPeerConnection(resolve, reject);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          this.handleSignalingMessage(msg);
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (this._state === 'connecting') {
          reject(new Error('Signal server disconnected'));
        }
        this.setState('disconnected');
      };

      ws.onerror = () => ws.close();
    });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const reqId = `req_${++this.reqCounter}`;
    const body = init?.body
      ? (typeof init.body === 'string' ? btoa(init.body) : btoa(await new Response(init.body).text()))
      : undefined;

    const msg = JSON.stringify({
      type: 'http',
      id: reqId,
      method: init?.method ?? 'GET',
      path: `/api${path}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });

    return new Promise<Response>((resolve, reject) => {
      this.pendingRequests.set(reqId, { resolve, reject });
      this.sendData(msg);

      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, 30_000);
    });
  }

  openWebSocket(path: string, userId?: string): WebSocketLike {
    const wsId = `ws_${++this.reqCounter}`;
    const proxy = new VirtualWebSocket(wsId, (data) => this.sendData(data));
    this.wsProxies.set(wsId, proxy);

    const userParam = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    this.sendData(JSON.stringify({
      type: 'ws_open',
      wsId,
      path: `${path}${userParam}`,
    }));

    return proxy;
  }

  close(): void {
    for (const [, proxy] of this.wsProxies) proxy.forceClose();
    this.wsProxies.clear();
    this.pendingRequests.clear();
    this.dc?.close();
    this.pc?.close();
    this.signalWs?.close();
    this.dc = null;
    this.pc = null;
    this.signalWs = null;
    this.setState('disconnected');
  }

  // ── WebRTC Setup ────────────────────────────────────────────────────────

  private setupPeerConnection(onConnected: () => void, onFailed: (err: Error) => void): void {
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    this.pc = pc;

    const dc = pc.createDataChannel('markus', { ordered: true });
    this.dc = dc;

    dc.onopen = () => {
      this.setState('connected');
      this.sendData(JSON.stringify({ type: 'auth' }));
      onConnected();
    };

    dc.onmessage = (e) => {
      this.handleDataMessage(e.data as string);
    };

    dc.onclose = () => {
      this.setState('disconnected');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({
          type: 'ice',
          instanceId: this.instanceId,
          candidate: e.candidate.candidate,
          mid: e.candidate.sdpMid ?? '0',
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.setState('relay');
        onConnected();
      }
    };

    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      this.sendSignal({
        type: 'offer',
        instanceId: this.instanceId,
        sdp: offer.sdp,
      });
    }).catch(onFailed);
  }

  private handleSignalingMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    switch (type) {
      case 'answer':
        if (msg['sdp'] && this.pc) {
          this.pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: msg['sdp'] as string,
          }));
        }
        break;
      case 'ice':
        if (msg['candidate'] && this.pc) {
          this.pc.addIceCandidate(new RTCIceCandidate({
            candidate: msg['candidate'] as string,
            sdpMid: (msg['mid'] as string) ?? '0',
          }));
        }
        break;
      case 'relay_frame':
        if (msg['data']) {
          this.handleDataMessage(msg['data'] as string);
        }
        break;
    }
  }

  private handleDataMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const type = msg.type as string;

      switch (type) {
        case 'http_response': {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            this.pendingRequests.delete(msg.id);
            const body = msg.body ? atob(msg.body) : '';
            pending.resolve(new Response(body, {
              status: msg.status,
              headers: msg.headers,
            }));
          }
          break;
        }
        case 'ws_opened': {
          const proxy = this.wsProxies.get(msg.wsId);
          if (proxy) proxy.setReady();
          break;
        }
        case 'ws_frame': {
          const proxy = this.wsProxies.get(msg.wsId);
          if (proxy) proxy.receiveMessage(msg.data);
          break;
        }
        case 'ws_closed': {
          const proxy = this.wsProxies.get(msg.wsId);
          if (proxy) {
            proxy.receiveClose();
            this.wsProxies.delete(msg.wsId);
          }
          break;
        }
        case 'ws_error': {
          const proxy = this.wsProxies.get(msg.wsId);
          if (proxy) {
            proxy.receiveError(msg.error);
            this.wsProxies.delete(msg.wsId);
          }
          break;
        }
        case 'auth_ok':
          break;
      }
    } catch { /* ignore */ }
  }

  private sendData(data: string): void {
    if (this.dc?.readyState === 'open') {
      this.dc.send(data);
    } else if (this.signalWs?.readyState === WebSocket.OPEN) {
      this.signalWs.send(JSON.stringify({
        type: 'relay_frame',
        instanceId: this.instanceId,
        data,
      }));
    }
  }

  private sendSignal(msg: unknown): void {
    if (this.signalWs?.readyState === WebSocket.OPEN) {
      this.signalWs.send(JSON.stringify(msg));
    }
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateListeners) {
      try { cb(s); } catch { /* ignore */ }
    }
  }
}

class VirtualWebSocket implements WebSocketLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 0; // CONNECTING

  constructor(
    private wsId: string,
    private sender: (data: string) => void,
  ) {}

  send(data: string): void {
    this.sender(JSON.stringify({
      type: 'ws_message',
      wsId: this.wsId,
      data,
    }));
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.sender(JSON.stringify({
      type: 'ws_close',
      wsId: this.wsId,
    }));
  }

  setReady(): void {
    this.readyState = 1; // OPEN
  }

  receiveMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  receiveClose(): void {
    this.readyState = 3;
    if (this.onclose) this.onclose(new Event('close'));
  }

  receiveError(error: string): void {
    this.readyState = 3;
    if (this.onerror) this.onerror(new ErrorEvent('error', { message: error }));
  }

  forceClose(): void {
    this.readyState = 3;
    if (this.onclose) this.onclose(new Event('close'));
  }
}
