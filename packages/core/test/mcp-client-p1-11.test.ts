/**
 * P1-11 回归：MCP 工具生命周期。
 *
 * 以前：子进程退出只 `servers.delete`，agent 工具表永不删项（stale 工具残留、
 * 消失工具仍可被“调用”然后必错）；重连只换进程不重拉 `tools/list`（新增工具不可见）。
 * 现在：`setOnToolsChanged` 在退出（[]）/ 连接（最新清单）时广播；对不可达 server
 * 的调用返回明确 `disconnected` 错误。
 */
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

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

describe('MCPClientManager — P1-11 tool lifecycle', () => {
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

  it('broadcasts the fresh tools/list on connect (new tools become visible)', async () => {
    const cb = vi.fn();
    manager.setOnToolsChanged(cb);

    const p = manager.connectServer('srv', { command: 'mock-mcp' });
    await completeHandshake(proc, [{ name: 'fresh', description: 'Fresh', inputSchema: {} }]);
    await p;

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('srv', [expect.objectContaining({ name: 'fresh' })]);
  });

  it('broadcasts an empty list when the process exits (stale tools unregistered)', async () => {
    const p = manager.connectServer('srv', { command: 'mock-mcp' });
    await completeHandshake(proc);
    await p;

    const cb = vi.fn();
    manager.setOnToolsChanged(cb);
    proc.emit('exit', 1);
    await waitTick();

    expect(cb).toHaveBeenCalledWith('srv', []);
    expect(manager.listServers()).toEqual([]);
  });

  it('calling a server that has no process and no config reports a clear "disconnected" error', async () => {
    await expect(manager.callTool('ghost', 'x', {})).rejects.toThrow(/disconnected/i);
  });
});
