import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '@markus/shared';

const log = createLogger('ws-server');

export interface WSEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

export class WSBroadcaster {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, _req) => {
      this.clients.add(ws);
      log.info('WebSocket client connected', { clients: this.clients.size });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.debug('WebSocket client disconnected', { clients: this.clients.size });
      });

      ws.on('error', (err) => {
        log.error('WebSocket client error', { error: String(err) });
        this.clients.delete(ws);
      });

      // Send initial ping
      ws.send(JSON.stringify({
        type: 'connected',
        payload: { message: 'Connected to Markus WebSocket' },
        timestamp: new Date().toISOString(),
      }));
    });

    log.info('WebSocket server attached');
  }

  broadcast(event: WSEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastAgentUpdate(agentId: string, status: string, extra?: Record<string, unknown>): void {
    this.broadcast({
      type: 'agent:update',
      payload: { agentId, status, ...extra },
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTaskUpdate(taskId: string, status: string, extra?: Record<string, unknown>): void {
    this.broadcast({
      type: 'task:update',
      payload: { taskId, status, ...extra },
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTeamUpdate(teamId: string, extra?: Record<string, unknown>): void {
    this.broadcast({
      type: 'team:update',
      payload: { teamId, ...extra },
      timestamp: new Date().toISOString(),
    });
  }

  broadcastDeliverableUpdate(deliverableId: string, action: 'created' | 'updated' | 'removed', extra?: Record<string, unknown>): void {
    this.broadcast({
      type: `deliverable:${action}`,
      payload: { deliverableId, ...extra },
      timestamp: new Date().toISOString(),
    });
  }

  broadcastChat(agentId: string, message: string, sender: 'user' | 'agent'): void {
    this.broadcast({
      type: 'chat:message',
      payload: { agentId, message, sender },
      timestamp: new Date().toISOString(),
    });
  }

  broadcastProactiveMessage(agentId: string, agentName: string, sessionId: string, messageId: string, message: string): void {
    this.broadcast({
      type: 'chat:proactive_message',
      payload: { agentId, agentName, sessionId, messageId, message },
      timestamp: new Date().toISOString(),
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
