import type { Transport } from './types';

/**
 * Direct transport — standard fetch/WS to the local Markus server.
 * Used when the web UI is served from the same origin.
 */
export class DirectTransport implements Transport {
  async fetch(path: string, init?: RequestInit): Promise<Response> {
    return window.fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...init,
    });
  }

  openWebSocket(path: string, userId?: string): WebSocket {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const userParam = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    return new WebSocket(`${protocol}//${window.location.host}${path}${userParam}`);
  }

  close(): void {
    // nothing to cleanup
  }
}
