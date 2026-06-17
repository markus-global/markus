import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

type MockProc = ChildProcess & {
  stdin: { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdin = { write: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function replyJson(proc: MockProc, id: number, result: unknown): void {
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
}

async function waitTick(): Promise<void> {
  await new Promise<void>(r => setImmediate(r));
}

async function completeHandshake(
  proc: MockProc,
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    { name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: {} } },
  ],
): Promise<void> {
  await waitTick();
  const initWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string | undefined;
  const initId = initWrite ? (JSON.parse(initWrite.trim()) as { id: number }).id : 1;
  replyJson(proc, initId, { protocolVersion: '2024-11-05', capabilities: {} });
  await waitTick();
  const listWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string | undefined;
  const listId = listWrite ? (JSON.parse(listWrite.trim()) as { id: number }).id : initId + 1;
  replyJson(proc, listId, { tools });
  await waitTick();
}

async function replyToLastRequest(proc: MockProc, result: unknown): Promise<void> {
  await waitTick();
  const lastWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string | undefined;
  const id = lastWrite ? (JSON.parse(lastWrite.trim()) as { id: number }).id : 1;
  replyJson(proc, id, result);
}

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

describe('MCPClientManager', () => {
  let MCPClientManager: typeof import('../src/tools/mcp-client.js').MCPClientManager;
  let manager: InstanceType<typeof MCPClientManager>;
  let proc: MockProc;

  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    ({ MCPClientManager } = await import('../src/tools/mcp-client.js'));
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAll();
    vi.useRealTimers();
  });

  async function connectAndRespond(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    { name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: {} } },
  ]) {
    const connectPromise = manager.connectServer('test-server', { command: 'mock-mcp', args: ['--stdio'] });
    await completeHandshake(proc, tools);
    return connectPromise;
  }

  it('connects, lists tools, and reuses existing connection', async () => {
    const tools = await connectAndRespond();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('echo');
    expect(spawnMock).toHaveBeenCalledOnce();

    const toolsAgain = await manager.connectServer('test-server', { command: 'mock-mcp' });
    expect(toolsAgain).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('calls a tool and returns text content', async () => {
    await connectAndRespond();
    const callPromise = manager.callTool('test-server', 'echo', { message: 'hi' });
    await replyToLastRequest(proc, { content: [{ text: 'echo: hi' }] });
    const result = await callPromise;
    expect(result).toBe('echo: hi');
  });

  it('returns JSON string when tool result has no text content', async () => {
    await connectAndRespond();
    const callPromise = manager.callTool('test-server', 'echo', {});
    await replyToLastRequest(proc, { content: [{ type: 'image' }] });
    const result = await callPromise;
    expect(JSON.parse(result)).toEqual({ content: [{ type: 'image' }] });
  });

  it('rejects pending requests when process exits', async () => {
    await connectAndRespond();
    const callPromise = manager.callTool('test-server', 'echo', {});
    proc.emit('exit', 1);
    await expect(callPromise).rejects.toThrow(/exited/);
  });

  it('handles JSON-RPC errors from server', async () => {
    await connectAndRespond();
    const callPromise = manager.callTool('test-server', 'echo', {});
    await waitTick();
    const lastWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string;
    const id = (JSON.parse(lastWrite.trim()) as { id: number }).id;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Tool failed' },
    }) + '\n'));
    await expect(callPromise).rejects.toThrow('Tool failed');
  });

  it('connectServerScoped uses scoped key and startup lock', async () => {
    const connectPromise = manager.connectServerScoped('chrome-devtools', { command: 'mock-mcp' }, 'agent-1');
    await completeHandshake(proc, [{ name: 'navigate', description: 'Navigate', inputSchema: {} }]);
    const tools = await connectPromise;
    expect(tools[0]!.name).toBe('navigate');

    const servers = manager.listServers();
    expect(servers.some(s => s.name.includes('chrome-devtools::agent-1'))).toBe(true);
  });

  it('registerLazyScoped returns handlers that auto-connect on first call', async () => {
    const handlers = manager.registerLazyScoped(
      'lazy-server',
      { command: 'mock-mcp' },
      'scope-1',
      [{ name: 'ping', description: 'Ping', inputSchema: {} }],
    );
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.name).toBe('lazy-server__ping');

    const execPromise = handlers[0]!.execute({ value: 1 });
    await completeHandshake(proc, [{ name: 'ping', description: 'Ping', inputSchema: {} }]);
    await replyToLastRequest(proc, { content: [{ text: 'pong' }] });
    const result = await execPromise;
    expect(result).toBe('pong');
  });

  it('getToolHandlers and getToolHandlersScoped route to correct process', async () => {
    await connectAndRespond([{ name: 'tool_a', description: 'A', inputSchema: {} }]);
    const handlers = manager.getToolHandlers('test-server');
    expect(handlers[0]!.name).toBe('test-server__tool_a');

    const scopedProc = createMockProc();
    spawnMock.mockReturnValueOnce(scopedProc);
    const scopedPromise = manager.connectServerScoped('scoped', { command: 'mock-mcp' }, 's1');
    await completeHandshake(scopedProc, [{ name: 'tool_b', description: 'B', inputSchema: {} }]);
    await scopedPromise;

    const scopedHandlers = manager.getToolHandlersScoped('scoped', 's1');
    expect(scopedHandlers[0]!.name).toBe('scoped__tool_b');
  });

  it('getCachedTools returns descriptors from connected server', async () => {
    await connectAndRespond([{ name: 'cached', description: 'Cached', inputSchema: {} }]);
    expect(manager.getCachedTools('test-server')?.[0]?.name).toBe('cached');
  });

  it('disconnectServer and disconnectAll clean up processes', async () => {
    await connectAndRespond();
    await manager.disconnectServer('test-server');
    expect(proc.kill).toHaveBeenCalled();
    expect(manager.listServers()).toEqual([]);

    proc.stdin.write.mockClear();
    await connectAndRespond();
    await manager.disconnectAll();
    expect(manager.listServers()).toEqual([]);
  });

  it('disconnectAllForScope and removeAllForScope handle scoped servers', async () => {
    const connectX = manager.connectServerScoped('scoped', { command: 'mock-mcp' }, 'agent-x');
    await completeHandshake(proc, []);
    await connectX;

    await manager.disconnectAllForScope('agent-x');
    expect(manager.listServers()).toEqual([]);

    const connectY = manager.connectServerScoped('scoped', { command: 'mock-mcp' }, 'agent-y');
    await completeHandshake(proc, []);
    await connectY;

    await manager.removeAllForScope('agent-y');
    expect(manager.listServers()).toEqual([]);
  });

  it('auto-reconnects on callTool when server config is saved but process stopped', async () => {
    await connectAndRespond();
    await manager.disconnectServer('test-server');

    const reconnectCb = vi.fn();
    manager.setOnReconnect(reconnectCb);

    const newProc = createMockProc();
    spawnMock.mockReturnValueOnce(newProc);

    const callPromise = manager.callTool('test-server', 'echo', {});
    await completeHandshake(newProc, [{ name: 'echo', description: 'Echo', inputSchema: {} }]);
    await replyToLastRequest(newProc, { content: [{ text: 'reconnected' }] });

    const result = await callPromise;
    expect(reconnectCb).toHaveBeenCalledWith('test-server');
    expect(result).toBe('reconnected');
  });

  it('handles split JSON-RPC messages across stdout chunks', async () => {
    const connectPromise = manager.connectServer('split-server', { command: 'mock-mcp' });
    await waitTick();
    const initWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string;
    const initId = (JSON.parse(initWrite.trim()) as { id: number }).id;
    const half = JSON.stringify({ jsonrpc: '2.0', id: initId, result: { protocolVersion: '2024-11-05' } });
    proc.stdout.emit('data', Buffer.from(half.slice(0, 20)));
    proc.stdout.emit('data', Buffer.from(half.slice(20) + '\n'));
    await waitTick();
    const listWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string;
    const listId = (JSON.parse(listWrite.trim()) as { id: number }).id;
    replyJson(proc, listId, { tools: [] });
    await connectPromise;
    expect(manager.listServers()).toHaveLength(1);
  });

  it('disconnects idle servers after timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    manager.setIdleTimeout(1000);
    await connectAndRespond();
    await vi.advanceTimersByTimeAsync(1500);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('setIdleTimeout 0 disables idle disconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    manager.setIdleTimeout(0);
    await connectAndRespond();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('kills process when initialize handshake fails', async () => {
    const connectPromise = manager.connectServer('bad-server', { command: 'mock-mcp' });
    await waitTick();
    const initWrite = proc.stdin.write.mock.calls.at(-1)?.[0] as string;
    const initId = (JSON.parse(initWrite.trim()) as { id: number }).id;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: initId,
      error: { code: -32603, message: 'init failed' },
    }) + '\n'));
    await expect(connectPromise).rejects.toThrow('init failed');
    expect(proc.kill).toHaveBeenCalled();
  });
});
