import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { WSBroadcaster } from '../src/ws-server.js';

class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  terminated = false;
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; }
}

describe('WSBroadcaster', () => {
  let broadcaster: WSBroadcaster;
  let httpServer: Server;
  let client: MockWebSocket;
  let userClient: MockWebSocket;

  beforeEach(async () => {
    vi.useFakeTimers();
    broadcaster = new WSBroadcaster();
    httpServer = createServer();
    broadcaster.attach(httpServer);

    client = new MockWebSocket();
    userClient = new MockWebSocket();
    (broadcaster as unknown as { clients: Set<MockWebSocket> }).clients.add(client);
    const userSet = new Set<MockWebSocket>([userClient]);
    (broadcaster as unknown as { userConnections: Map<string, Set<MockWebSocket>> }).userConnections.set('user-1', userSet);
  });

  afterEach(() => {
    vi.useRealTimers();
    httpServer.close();
  });

  it('broadcasts immediate events to all clients', () => {
    broadcaster.broadcast({ type: 'task:update', payload: { taskId: 't1' }, timestamp: new Date().toISOString() });
    expect(client.sent.length).toBeGreaterThan(0);
    expect(JSON.parse(client.sent[0]!).type).toBe('task:update');
  });

  it('coalesces agent update events', () => {
    broadcaster.broadcastAgentUpdate('agent-1', 'idle');
    broadcaster.broadcastAgentUpdate('agent-1', 'busy');
    expect(client.sent).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(client.sent.length).toBeGreaterThan(0);
  });

  it('sendToUsers delivers to scoped connections', () => {
    broadcaster.sendToUsers(['user-1', 'user-1'], {
      type: 'notification',
      payload: { id: 'n1' },
      timestamp: new Date().toISOString(),
    });
    expect(userClient.sent).toHaveLength(1);
  });

  it('exposes helper broadcast methods', () => {
    broadcaster.broadcastTaskCreate('t1', 'Title');
    broadcaster.broadcastTaskUpdate('t1', 'done');
    broadcaster.broadcastTeamUpdate('team-1');
    broadcaster.broadcastDeliverableUpdate('d1', 'created');
    broadcaster.broadcastChat('agent-1', 'Hi', 'user');
    broadcaster.broadcastUnreadUpdate('conv-1', 'm1');
    broadcaster.broadcastExecutionLog({ id: 'log-1' });
    broadcaster.broadcastExecutionLogDelta('task', 't1', 'agent-1', 'text');
    vi.advanceTimersByTime(250);
    expect(client.sent.length).toBeGreaterThan(0);
    expect(broadcaster.getClientCount()).toBe(1);
  });

  it('broadcastProactiveMessage targets user when specified', () => {
    broadcaster.broadcastProactiveMessage('agent-1', 'Agent', 'sess-1', 'm1', 'Hello', {}, 'user-1');
    expect(userClient.sent).toHaveLength(1);
    broadcaster.broadcastProactiveMessage('agent-1', 'Agent', 'sess-1', 'm2', 'Broadcast');
    expect(client.sent.length).toBeGreaterThan(0);
  });

  it('registers connection handlers via attach', () => {
    const wss = (broadcaster as unknown as { wss: { listeners: (event: string) => Array<(ws: MockWebSocket, req: { headers: Record<string, string>; url?: string }) => void> } }).wss;
    const handlers = wss.listeners('connection');
    expect(handlers.length).toBeGreaterThan(0);

    const attached = new MockWebSocket();
    handlers[0]!(attached, { headers: { host: '127.0.0.1' }, url: '/ws?userId=user-2' });
    expect(attached.sent.some(s => s.includes('connected'))).toBe(true);
    expect(broadcaster.getClientCount()).toBe(2);

    attached.emit('close');
    expect(broadcaster.getClientCount()).toBe(1);

    const badReqClient = new MockWebSocket();
    handlers[0]!(badReqClient, { headers: { host: '127.0.0.1' }, url: '%bad' });
    badReqClient.emit('error', new Error('fail'));
    expect(broadcaster.getClientCount()).toBe(1);
  });

  it('tracks client count when manually managed', () => {
    expect(broadcaster.getClientCount()).toBe(1);
    (broadcaster as unknown as { clients: Set<MockWebSocket> }).clients.delete(client);
    expect(broadcaster.getClientCount()).toBe(0);
  });

  it('detach() terminates every client and clears tracking (regression: rebind hang)', () => {
    // Rationale: applyBindHost() calls http.Server.close(), which only fires its
    // callback after ALL connections end. An upgraded /ws socket never ends on
    // its own, so without detach() the rebind hangs forever ("switch takes
    // forever, then fails"). detach() must (a) terminate each client socket and
    // (b) drop all tracking so a fresh attach() starts clean.
    const extra = new MockWebSocket();
    (broadcaster as unknown as { clients: Set<MockWebSocket> }).clients.add(extra);

    broadcaster.detach();

    expect(client.terminated).toBe(true);
    expect(userClient.terminated).toBe(true);
    expect(extra.terminated).toBe(true);
    expect(broadcaster.getClientCount()).toBe(0);
    expect((broadcaster as unknown as { userConnections: Map<string, Set<MockWebSocket>> }).userConnections.size).toBe(0);
    expect((broadcaster as unknown as { wss?: unknown }).wss).toBeUndefined();
  });
});
