/**
 * WebSocket bridge between Markus and the Chrome extension.
 *
 * Markus side (this file) runs a WS server. The Chrome extension connects
 * as a client. Tool calls are forwarded over the socket and results returned.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@markus/shared';

const log = createLogger('browser-bridge');

export interface BridgeToolResult {
  content: string;
  error?: string;
}

interface PendingCall {
  resolve: (result: BridgeToolResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PORT = 9333;
const TOOL_CALL_TIMEOUT_MS = 120_000;

export class MarkusBrowserBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingCall>();
  private port: number;
  private _started = false;
  private connectionListeners: Array<(connected: boolean) => void> = [];

  constructor(port?: number) {
    this.port = port ?? DEFAULT_PORT;
  }

  get started(): boolean { return this._started; }
  get connected(): boolean { return this.client?.readyState === 1; }

  onConnectionChange(listener: (connected: boolean) => void): void {
    this.connectionListeners.push(listener);
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      try { listener(connected); } catch { /* ignore */ }
    }
  }

  start(): void {
    if (this._started) return;
    this._started = true;

    this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });

    this.wss.on('listening', () => {
      log.info(`Browser bridge WebSocket server listening on ws://127.0.0.1:${this.port}`);
    });

    this.wss.on('error', (err) => {
      log.warn(`Browser bridge WebSocket server error: ${err.message}`);
    });

    this.wss.on('connection', (ws) => {
      if (this.client) {
        log.info('New extension connection replacing existing one');
        this.client.close();
      }
      this.client = ws;
      log.info('Chrome extension connected to browser bridge');
      this.notifyConnectionChange(true);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          log.warn(`Invalid message from extension: ${err}`);
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          log.info('Chrome extension disconnected from browser bridge');
          this.notifyConnectionChange(false);
          this.rejectAllPending('Extension disconnected');
        }
      });

      ws.on('error', (err) => {
        log.warn(`Extension WebSocket error: ${err.message}`);
      });
    });
  }

  stop(): void {
    this.rejectAllPending('Bridge shutting down');
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this._started = false;
  }

  /**
   * Call a tool on the Chrome extension and wait for the result.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    if (!this.connected) {
      throw new Error('Chrome extension not connected');
    }

    const id = ++this.requestId;
    const message = JSON.stringify({ id, method: name, params: args });

    return new Promise<BridgeToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool call ${name} timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
      }, TOOL_CALL_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(message);
    });
  }

  private handleMessage(msg: { id?: number; result?: unknown; error?: string; event?: string; data?: unknown }): void {
    if (msg.event) {
      log.debug(`Extension event: ${msg.event}`, msg.data as Record<string, unknown>);
      return;
    }

    if (msg.id === undefined) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.resolve({ content: '', error: msg.error });
    } else {
      const text = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result);
      pending.resolve({ content: text });
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
