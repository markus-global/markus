/**
 * SSE Handler - Server-Sent Events for streaming external session responses.
 *
 * Separate from internal WebSocket to avoid auth confusion.
 * External clients connect via share token; responses stream as SSE events.
 */
import { createLogger } from '@markus/shared';
import type { StreamEvent } from '../types.js';

const log = createLogger('external-sse');

export interface SSEConnection {
  id: string;
  sessionId: string;
  write(data: string): boolean;
  close(): void;
  onClose(cb: () => void): void;
}

/**
 * Format a StreamEvent as an SSE message string.
 */
export function formatSSEEvent(event: StreamEvent): string {
  const data = JSON.stringify(event);
  return `data: ${data}\n\n`;
}

/**
 * Send the SSE done signal.
 */
export function formatSSEDone(): string {
  return `data: [DONE]\n\n`;
}

/**
 * SSE connection manager for external sessions.
 * Keeps track of active connections and routes stream events to them.
 */
export class SSEConnectionManager {
  private connections = new Map<string, SSEConnection>();

  register(conn: SSEConnection): void {
    this.connections.set(conn.id, conn);
    conn.onClose(() => {
      this.connections.delete(conn.id);
      log.debug('SSE connection closed', { connId: conn.id, sessionId: conn.sessionId });
    });
    log.debug('SSE connection registered', { connId: conn.id, sessionId: conn.sessionId });
  }

  /**
   * Send a stream event to a specific session's connection.
   */
  sendToSession(sessionId: string, event: StreamEvent): void {
    for (const conn of this.connections.values()) {
      if (conn.sessionId === sessionId) {
        const ok = conn.write(formatSSEEvent(event));
        if (!ok) {
          this.connections.delete(conn.id);
        }
      }
    }
  }

  /**
   * Signal completion to a session's connection.
   */
  completeSession(sessionId: string): void {
    for (const conn of this.connections.values()) {
      if (conn.sessionId === sessionId) {
        conn.write(formatSSEDone());
      }
    }
  }

  /**
   * Create a StreamCallback that routes events to SSE connections.
   */
  createStreamCallback(sessionId: string): (event: StreamEvent) => void {
    return (event: StreamEvent) => {
      this.sendToSession(sessionId, event);
      if (event.type === 'done' || event.type === 'error') {
        this.completeSession(sessionId);
      }
    };
  }

  /**
   * Close all connections for a session.
   */
  closeSession(sessionId: string): void {
    for (const [id, conn] of this.connections) {
      if (conn.sessionId === sessionId) {
        conn.close();
        this.connections.delete(id);
      }
    }
  }

  /**
   * Get count of active connections.
   */
  get activeCount(): number {
    return this.connections.size;
  }

  /**
   * Build the HTTP response headers for an SSE connection.
   */
  static sseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
  }
}
