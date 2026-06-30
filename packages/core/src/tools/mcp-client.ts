import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createLogger, APP_VERSION } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('mcp-client');

/**
 * Optimize npx-based MCP configs by resolving the package locally.
 * If the package is already installed, replaces `npx -y <pkg> ...args`
 * with `node <local-cli-path> ...args` to avoid 30-60s cold-start downloads.
 */
function optimizeNpxConfig(config: MCPServerConfig): MCPServerConfig {
  if (config.command !== 'npx') return config;
  const args = config.args ?? [];

  // Parse: npx [-y] <package>[@version] [...rest]
  let idx = 0;
  while (idx < args.length && args[idx].startsWith('-')) idx++; // skip flags like -y
  if (idx >= args.length) return config;

  const pkgSpec = args[idx]; // e.g. "@larksuiteoapi/lark-mcp" or "chrome-devtools-mcp@latest"
  const rest = args.slice(idx + 1); // remaining args after package name

  // Strip version specifier to get package name for require.resolve
  const pkgName = pkgSpec.replace(/@(latest|next|\d+\..*)$/, '');
  if (!pkgName) return config;

  try {
    const esmRequire = createRequire(import.meta.url);
    const pkgJsonPath = esmRequire.resolve(`${pkgName}/package.json`);
    const pkgJson = JSON.parse(esmRequire('fs').readFileSync(pkgJsonPath, 'utf8'));
    const pkgDir = dirname(pkgJsonPath);

    // Resolve bin entry
    let binPath: string | undefined;
    if (typeof pkgJson.bin === 'string') {
      binPath = join(pkgDir, pkgJson.bin);
    } else if (typeof pkgJson.bin === 'object') {
      const entries = Object.values(pkgJson.bin) as string[];
      binPath = entries[0] ? join(pkgDir, entries[0]) : undefined;
    }

    if (binPath && existsSync(binPath)) {
      log.info(`Optimized npx → node for MCP package ${pkgName}`, { binPath });
      return { ...config, command: 'node', args: [binPath, ...rest] };
    }
  } catch {
    // Package not locally installed — fall back to npx
  }
  return config;
}

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPToolDescriptor {
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
/** Default idle timeout: 5 minutes with no tool calls triggers automatic disconnect. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class MCPClientManager {
  private servers = new Map<string, { process: ChildProcess; tools: MCPToolDescriptor[] }>();
  private serverConfigs = new Map<string, { displayName: string; config: MCPServerConfig }>();
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffers = new Map<ChildProcess, string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS;
  private onReconnectCallback?: (serverName: string) => void;

  private static scopedKey(name: string, scopeId: string): string {
    return `${name}::${scopeId}`;
  }

  setOnReconnect(callback: (serverName: string) => void): void {
    this.onReconnectCallback = callback;
  }

  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  private resetIdleTimer(key: string): void {
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);

    if (this.idleTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      if (this.servers.has(key)) {
        log.info(`MCP server idle timeout reached, disconnecting: ${key}`);
        this.disconnectServer(key).catch(() => {});
      }
    }, this.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(key, timer);
  }

  private clearIdleTimer(key: string): void {
    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }
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

    this.serverConfigs.set(key, { displayName, config });

    const resolvedConfig = optimizeNpxConfig(config);
    log.info(`Connecting to MCP server: ${displayName}`, { command: resolvedConfig.command, key });

    const proc = spawn(resolvedConfig.command, resolvedConfig.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...resolvedConfig.env },
      shell: process.platform === 'win32',
    });

    proc.on('error', (err) => {
      log.error(`MCP server ${displayName} error`, { error: String(err) });
    });
    if (typeof proc.stdin?.on === 'function') {
      proc.stdin.on('error', () => { /* suppress EPIPE when server exits before write */ });
    }

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
      this.clearIdleTimer(key);
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
      this.resetIdleTimer(key);
      // Cache tool descriptors by base server name (for lazy registration)
      const baseName = key.split('::')[0];
      this.toolCache.set(baseName, tools);
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
   * Serialized via startup lock to prevent concurrent connections to the same external resource.
   */
  async connectServerScoped(name: string, config: MCPServerConfig, scopeId: string): Promise<MCPToolDescriptor[]> {
    const key = MCPClientManager.scopedKey(name, scopeId);
    let tools: MCPToolDescriptor[] = [];
    await this.withStartupLock(name, async () => {
      tools = await this.connectByKey(key, `${name}[${scopeId}]`, config);
    });
    return tools;
  }

  /**
   * Startup semaphore: serializes MCP process creation for servers that share
   * an external resource (e.g. chrome-devtools → Chrome). Prevents concurrent
   * CDP connections from crashing Chrome.
   */
  private startupLocks = new Map<string, Promise<void>>();

  private async withStartupLock(serverName: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.startupLocks.get(serverName) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    this.startupLocks.set(serverName, gate);
    await prev;
    try {
      await fn();
    } finally {
      release!();
    }
  }

  private async callToolByKey(key: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    let server = this.servers.get(key);

    if (!server) {
      const saved = this.serverConfigs.get(key);
      if (saved) {
        log.info(`MCP server ${key} not running, auto-reconnecting...`);
        const serverName = key.split('::')[0];
        this.onReconnectCallback?.(serverName);
        await this.withStartupLock(serverName, async () => {
          if (!this.servers.has(key)) {
            await this.connectByKey(key, saved.displayName, saved.config);
          }
        });
        server = this.servers.get(key);
      }
      if (!server) throw new Error(`MCP server not found: ${key}`);
    }

    this.resetIdleTimer(key);

    const result = await this.sendRequest(server.process, 'tools/call', {
      name: toolName,
      arguments: args,
    });
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    if (content?.[0]?.text) return content[0].text;
    return JSON.stringify(result);
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

  /**
   * Register a server config and tool descriptors WITHOUT starting the process.
   * Returns tool handlers that will auto-connect on first call via callToolByKey.
   * Used for lazy-start servers (e.g. chrome-devtools: only connect when agent
   * actually calls a browser tool).
   */
  registerLazyScoped(name: string, config: MCPServerConfig, scopeId: string, tools: MCPToolDescriptor[]): AgentToolHandler[] {
    const key = MCPClientManager.scopedKey(name, scopeId);
    const displayName = `${name}[${scopeId}]`;
    this.serverConfigs.set(key, { displayName, config });
    return tools.map((tool) => ({
      name: `${name}__${tool.name}`,
      description: `[MCP:${name}] ${tool.description}`,
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

  /**
   * Get cached tool descriptors for a server (from any scoped or shared instance).
   * Returns undefined if no instance has connected yet.
   */
  getCachedTools(serverName: string): MCPToolDescriptor[] | undefined {
    for (const [key, server] of this.servers) {
      if (key === serverName || key.startsWith(`${serverName}::`)) {
        return server.tools;
      }
    }
    return this.toolCache.get(serverName);
  }

  private toolCache = new Map<string, MCPToolDescriptor[]>();

  async disconnectServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (server) {
      this.clearIdleTimer(name);
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
   * The server configs are retained so the server can auto-reconnect on next tool call.
   */
  async disconnectAllForScope(scopeId: string, opts?: { skip?: string[] }): Promise<void> {
    const suffix = `::${scopeId}`;
    const skipSet = opts?.skip ? new Set(opts.skip) : undefined;
    for (const key of [...this.servers.keys()]) {
      if (key.endsWith(suffix)) {
        const serverName = key.split('::')[0];
        if (skipSet?.has(serverName)) continue;
        await this.disconnectServer(key);
      }
    }
  }

  /**
   * Permanently disconnect and forget all scoped servers for a scope.
   * Used when an agent is removed and will never reconnect.
   */
  async removeAllForScope(scopeId: string): Promise<void> {
    const suffix = `::${scopeId}`;
    for (const key of [...this.servers.keys()]) {
      if (key.endsWith(suffix)) {
        await this.disconnectServer(key);
      }
    }
    for (const key of [...this.serverConfigs.keys()]) {
      if (key.endsWith(suffix)) {
        this.serverConfigs.delete(key);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.disconnectServer(name);
    }
    this.serverConfigs.clear();
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

      const timeoutMs = method === 'tools/call' ? 120_000 : 60_000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout for ${method} (id=${id}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, method, timer, proc });
      try { proc.stdin?.write(message); } catch { /* EPIPE */ }
    });
  }

  private sendNotification(proc: ChildProcess, method: string, params: unknown): Promise<void> {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { proc.stdin?.write(message); } catch { /* EPIPE */ }
    return Promise.resolve();
  }
}
