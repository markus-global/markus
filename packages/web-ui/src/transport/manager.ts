import { DirectTransport } from './direct';
import { P2PTransport } from './p2p';
import type { Transport, ConnectionState } from './types';

export type TransportMode = 'direct' | 'p2p' | 'relay';
export type { ConnectionState };

/**
 * Manages the active transport layer for the Web UI.
 * In direct mode (default), uses standard fetch/WS.
 * In remote mode, establishes a WebRTC DataChannel to the Markus instance.
 */
class TransportManagerImpl {
  private transport: Transport = new DirectTransport();
  private p2pTransport: P2PTransport | null = null;
  private _mode: TransportMode = 'direct';
  private stateListeners = new Set<(state: ConnectionState) => void>();

  get mode(): TransportMode { return this._mode; }
  get isRemote(): boolean { return this._mode !== 'direct'; }

  get connectionState(): ConnectionState {
    if (this._mode === 'direct') return 'connected';
    return this.p2pTransport?.state ?? 'disconnected';
  }

  async connectRemote(signalUrl: string, signalingToken: string, instanceId: string): Promise<void> {
    this.disconnect();

    const p2p = new P2PTransport(signalUrl, signalingToken, instanceId);
    this.p2pTransport = p2p;

    p2p.onStateChange((state) => {
      if (state === 'connected') {
        this._mode = 'p2p';
      } else if (state === 'relay') {
        this._mode = 'relay';
      }
      for (const cb of this.stateListeners) {
        try { cb(state); } catch { /* ignore */ }
      }
    });

    await p2p.connect();
    this.transport = p2p;
  }

  disconnect(): void {
    this.p2pTransport?.close();
    this.p2pTransport = null;
    this.transport = new DirectTransport();
    this._mode = 'direct';
  }

  onStateChange(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.transport.fetch(path, init);
  }

  openWebSocket(path: string, userId?: string) {
    return this.transport.openWebSocket(path, userId);
  }
}

export const TransportManager = new TransportManagerImpl();
