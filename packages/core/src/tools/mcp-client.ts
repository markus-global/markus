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
  proc: ChildProcess;
}

/**
 * Manages connections to external MCP servers via stdio transport.
 * Each MCP server exposes tools that can be used by Agents.
 *
 * Supports two connection modes:
 * - **Shared** (default): one process per server name, reused across all agents.
 * - **Scoped** (per-agent): one process per (serverName, scopeId) pair, so each
 *   agent gets its own MCP server process. Tool names are unchanged — only the
 *   internal routing differs.
 *
 * Uses a per-process line buffer to correctly reassemble JSON-RPC
 * messages that may be split across multiple stdout `data` events.
 */
export class MCPClientManager {
  private servers = new Map<string, { process: ChildProcess; tools: MCPToolDescriptor[] }>();
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffers = new Map<ChildProcess, string>();

  private static scopedKey(name: string, scopeId: string): string {
    return `${name}::${scopeId}`;
  }

  /**
   * Spawn an MCP server process, run JSON-RPC init handshake, list tools,
   * and store under the given internal key. Shared by connect and connectScoped.
   */
  private async connectByKey(key: string, displayName: string, config: MCPServerConfig): Promise<MCPToolDescriptor[]> {
    const existing = this.servers.get(key);
    if (existing) {
      log.info(`MCP server ${displayName} already connected, reusing (${existing.tools.length} tools)`);
      return existing.tools;
    }

    log.info(`Connecting to MCP server: ${displayName}`, { command: config.command, key });

    const proc = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
      shell: process.platform === 'win32',
    });

    proc.on('error', (err) => {
      log.error(`MCP server ${displayName} error`, { error: String(err) });
    });

    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      if (stderrChunks.length <= 5) {
        log.warn(`MCP server ${displayName} stderr`, { text: text.trimEnd() });
      }
    });

    proc.on('exit', (code) => {
      const stderr = stderrChunks.join('').trim();
      if (stderr) {
        log.error(`MCP server ${displayName} exited with stderr`, { code, stderr: stderr.slice(0, 500) });
      } else {
        log.info(`MCP server ${displayName} exited`, { code });
      }
      this.servers.delete(key);
      this.stdoutBuffers.delete(proc);
      for (const [id, req] of this.pendingRequests) {
        if (req.proc !== proc) continue;
        req.reject(new Error(`MCP server ${displayName} exited (code ${code}) while awaiting ${req.method}`));
        clearTimeout(req.timer);
        this.pendingRequests.delete(id);
      }
    });

    this.stdoutBuffers.set(proc, '');
    proc.stdout?.on('data', (data: Buffer) => this.handleStdoutData(proc, data));

    try {
      await this.sendRequest(proc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'markus', version: APP_VERSION },
      });

      await this.sendNotification(proc, 'notifications/initialized', {});

      const toolsResult = await this.sendRequest(proc, 'tools/list', {});
      const tools = (toolsResult as { tools?: MCPToolDescriptor[] })?.tools ?? [];

      this.servers.set(key, { process: proc, tools });
      log.info(`MCP server ${displayName} connected with ${tools.length} tools`);

      return tools;
    } catch (err) {
      proc.kill();
      this.stdoutBuffers.delete(proc);
      throw err;
    }
  }

  async connectServer(name: string, config: MCPServerConfig): Promise<MCPToolDescriptor[]> {
    return this.connectByKey(name, name, config);
  }

  /**
   * Connect a scoped (per-agent) instance of the MCP server.
   * Each (name, scopeId) pair gets its own child process.
   */
  async connectServerScoped(name: string, config: MCPServerConfig, scopeId: string): Promise<MCPToolDescriptor[]> {
    const key = MCPClientManager.scopedKey(name, scopeId);
    return this.connectByKey(key, `${name}[${scopeId}]`, config);
  }

  private callToolByKey(key: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(key);
    if (!server) throw new Error(`MCP server not found: ${key}`);

    return this.sendRequest(server.process, 'tools/call', {
      name: toolName,
      arguments: args,
    }).then((result) => {
      const content = (result as { content?: Array<{ text?: string }> })?.content;
      if (content?.[0]?.text) return content[0].text;
      return JSON.stringify(result);
    });
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    return this.callToolByKey(serverName, toolName, args);
  }

  async callToolScoped(serverName: string, scopeId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    return this.callToolByKey(MCPClientManager.scopedKey(serverName, scopeId), toolName, args);
  }

  private getToolHandlersByKey(key: string, toolPrefix: string): AgentToolHandler[] {
    const server = this.servers.get(key);
    if (!server) return [];

    return server.tools.map((tool) => ({
      name: `${toolPrefix}__${tool.name}`,
      description: `[MCP:${toolPrefix}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        return this.callToolByKey(key, tool.name, args);
      },
    }));
  }

  getToolHandlers(serverName: string): AgentToolHandler[] {
    return this.getToolHandlersByKey(serverName, serverName);
  }

  /**
   * Return tool handlers for a scoped server instance.
   * Tool names use the original serverName prefix (e.g. "chrome-devtools__navigate_page"),
   * but execute() routes to the agent-specific MCP process.
   */
  getToolHandlersScoped(serverName: string, scopeId: string): AgentToolHandler[] {
    return this.getToolHandlersByKey(MCPClientManager.scopedKey(serverName, scopeId), serverName);
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

  async disconnectServerScoped(name: string, scopeId: string): Promise<void> {
    const key = MCPClientManager.scopedKey(name, scopeId);
    await this.disconnectServer(key);
  }

  /**
   * Disconnect all scoped server instances belonging to a given scope (e.g. agent).
   * Shared (non-scoped) servers are not affected.
   */
  async disconnectAllForScope(scopeId: string): Promise<void> {
    const suffix = `::${scopeId}`;
    for (const key of [...this.servers.keys()]) {
      if (key.endsWith(suffix)) {
        await this.disconnectServer(key);
      }
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
        if (msg.id === null || msg.id === undefined) continue; // notification — ignore
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

      this.pendingRequests.set(id, { resolve, reject, method, timer, proc });
      proc.stdin?.write(message);
    });
  }

  private sendNotification(proc: ChildProcess, method: string, params: unknown): Promise<void> {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin?.write(message);
    return Promise.resolve();
  }
}
