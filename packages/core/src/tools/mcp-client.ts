import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger, APP_VERSION } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('mcp-client');

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages connections to external MCP servers via stdio transport.
 * Each MCP server exposes tools that can be used by Agents.
 *
 * Uses a per-process line buffer to correctly reassemble JSON-RPC
 * messages that may be split across multiple stdout `data` events.
 */
export class MCPClientManager {
  private servers = new Map<string, { process: ChildProcess; tools: MCPToolDescriptor[] }>();
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffers = new Map<ChildProcess, string>();

  async connectServer(name: string, config: MCPServerConfig): Promise<MCPToolDescriptor[]> {
    const existing = this.servers.get(name);
    if (existing) {
      log.info(`MCP server ${name} already connected, reusing (${existing.tools.length} tools)`);
      return existing.tools;
    }

    log.info(`Connecting to MCP server: ${name}`, { command: config.command });

    const proc = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    proc.on('error', (err) => {
      log.error(`MCP server ${name} error`, { error: String(err) });
    });

    proc.on('exit', (code) => {
      log.info(`MCP server ${name} exited`, { code });
      this.servers.delete(name);
      this.stdoutBuffers.delete(proc);
      for (const [id, req] of this.pendingRequests) {
        req.reject(new Error(`MCP server ${name} exited (code ${code}) while awaiting ${req.method}`));
        clearTimeout(req.timer);
        this.pendingRequests.delete(id);
      }
    });

    this.stdoutBuffers.set(proc, '');
    proc.stdout?.on('data', (data: Buffer) => this.handleStdoutData(proc, data));

    const initResult = await this.sendRequest(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'markus', version: APP_VERSION },
    });

    await this.sendNotification(proc, 'notifications/initialized', {});

    const toolsResult = await this.sendRequest(proc, 'tools/list', {});
    const tools = (toolsResult as { tools?: MCPToolDescriptor[] })?.tools ?? [];

    this.servers.set(name, { process: proc, tools });
    log.info(`MCP server ${name} connected with ${tools.length} tools`);

    return tools;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server not found: ${serverName}`);

    const result = await this.sendRequest(server.process, 'tools/call', {
      name: toolName,
      arguments: args,
    });

    const content = (result as { content?: Array<{ text?: string }> })?.content;
    if (content?.[0]?.text) return content[0].text;
    return JSON.stringify(result);
  }

  getToolHandlers(serverName: string): AgentToolHandler[] {
    const server = this.servers.get(serverName);
    if (!server) return [];

    return server.tools.map((tool) => ({
      name: `${serverName}__${tool.name}`,
      description: `[MCP:${serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return this.callTool(serverName, tool.name, args);
      },
    }));
  }

  listServers(): Array<{ name: string; toolCount: number }> {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      toolCount: s.tools.length,
    }));
  }

  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      server.process.kill();
      this.servers.delete(name);
      this.stdoutBuffers.delete(server.process);
      log.info(`MCP server disconnected: ${name}`);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.disconnectServer(name);
    }
  }

  /**
   * Accumulates stdout data into a line buffer and dispatches
   * complete JSON-RPC lines to pending requests.
   */
  private handleStdoutData(proc: ChildProcess, data: Buffer): void {
    const buf = (this.stdoutBuffers.get(proc) ?? '') + data.toString();
    const lines = buf.split('\n');
    // Last element is either '' (if buf ended with \n) or an incomplete chunk
    this.stdoutBuffers.set(proc, lines.pop()!);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { code: number; message: string } };
        if (msg.id == null) continue; // notification — ignore
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // non-JSON output (e.g. server debug logs on stdout) — skip
      }
    }
  }

  private sendRequest(proc: ChildProcess, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      const timeoutMs = method === 'tools/call' ? 120_000 : 30_000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout for ${method} (id=${id}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, method, timer });
      proc.stdin?.write(message);
    });
  }

  private sendNotification(proc: ChildProcess, method: string, params: unknown): Promise<void> {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin?.write(message);
    return Promise.resolve();
  }
}
