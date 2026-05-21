/**
 * WebSocket client that connects to the Markus browser bridge.
 * Handles reconnection, keepalive, and message routing.
 */

export interface BridgeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<string>;

const DEFAULT_URL = 'ws://127.0.0.1:9333';
const RECONNECT_INTERVAL_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 25000;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers = new Map<string, ToolHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(url?: string) {
    this.url = url ?? DEFAULT_URL;
  }

  get connected(): boolean { return this._connected; }

  registerHandler(method: string, handler: ToolHandler): void {
    this.handlers.set(method, handler);
  }

  connect(): void {
    this.cleanup();

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[Markus] Connected to bridge');
      this._connected = true;
      this.startKeepalive();
      chrome.action.setIcon({ path: {
        '16': 'icons/icon16.png',
        '48': 'icons/icon48.png',
      }});
      chrome.action.setTitle({ title: 'Markus Browser Automation (Connected)' });
    };

    this.ws.onclose = () => {
      console.log('[Markus] Disconnected from bridge');
      this._connected = false;
      this.stopKeepalive();
      chrome.action.setTitle({ title: 'Markus Browser Automation (Disconnected)' });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as BridgeRequest;
        this.enqueueRequest(msg);
      } catch (err) {
        console.error('[Markus] Failed to parse message:', err);
      }
    };
  }

  /**
   * Serialize all incoming requests so only one tool runs at a time.
   * Prevents race conditions on shared PageManager state (selectedPageId)
   * when multiple agents issue concurrent tool calls.
   */
  private enqueueRequest(req: BridgeRequest): void {
    this.requestQueue = this.requestQueue
      .then(() => this.handleRequest(req))
      .catch((err) => console.error('[Markus] Request queue error:', err));
  }

  private async handleRequest(req: BridgeRequest): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.send({ id: req.id, error: `Unknown method: ${req.method}` });
      return;
    }

    try {
      const result = await handler(req.params);
      this.send({ id: req.id, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ id: req.id, error: msg });
    }
  }

  send(msg: BridgeResponse | { event: string; data: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ event: 'keepalive', data: { timestamp: Date.now() } });
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private cleanup(): void {
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this._connected = false;
  }

  disconnect(): void {
    this.cleanup();
  }
}
