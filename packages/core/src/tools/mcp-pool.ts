import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger, APP_VERSION } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('mcp-pool');

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

export interface MCPPoolConfig {
  /** Minimum number of processes to keep alive (hot standby). Default: 3 */
  minSize: number;
  /** Soft max size. 0 = unlimited. Exceeding logs a warning but does not block. Default: 0 */
  maxSize: number;
  /** Idle time (ms) before a surplus process is killed. Default: 300_000 (5 min) */
  shrinkAfterMs: number;
  /** MCP server command/args to spawn */
  serverConfig: MCPServerConfig;
}

interface PoolEntry {
  id: string;
  process: ChildProcess;
  tools: MCPToolDescriptor[];
  leasedBy: string | null;
  lastReleasedAt: number;
  shrinkTimer?: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
  proc: ChildProcess;
}

/**
 * Elastic exclusive-lease pool for chrome-devtools MCP processes.
 *
 * Each agent acquires exclusive access to one process at a time.
 * Processes are reused across sessions — they stay alive after release.
 * The pool dynamically grows on demand (never blocks) and shrinks idle
 * surplus back to minSize after shrinkAfterMs.
 */
export class MCPPool {
  private entries: PoolEntry[] = [];
  private seq = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffers = new Map<ChildProcess, string>();
  private config: MCPPoolConfig;
  private toolCache: MCPToolDescriptor[] = [];
  private shuttingDown = false;

  constructor(config: MCPPoolConfig) {
    this.config = config;
  }

  async warmUp(): Promise<void> {
    const toSpawn = Math.max(0, this.config.minSize - this.entries.length);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < toSpawn; i++) {
      promises.push(this.spawnEntry().then(() => {}));
    }
    await Promise.all(promises);
    log.info(`MCPPool warmed up with ${this.entries.length} processes`);
  }

  /**
   * Acquire an exclusive process for agentId.
   * If the agent already holds a lease, returns immediately (idempotent).
   * If no idle process is available, spawns a new one (never blocks).
   */
  async acquire(agentId: string): Promise<PoolEntry> {
    const existing = this.entries.find(e => e.leasedBy === agentId);
    if (existing) return existing;

    const idle = this.entries.find(e => e.leasedBy === null);
    if (idle) {
      if (idle.shrinkTimer) {
        clearTimeout(idle.shrinkTimer);
        idle.shrinkTimer = undefined;
      }
      idle.leasedBy = agentId;
      log.info(`MCPPool: agent ${agentId} acquired existing process ${idle.id}`);
      return idle;
    }

    if (this.config.maxSize > 0 && this.entries.length >= this.config.maxSize) {
      log.warn(`MCPPool: exceeding soft max size (${this.config.maxSize}), spawning anyway for agent ${agentId}`);
    }

    const entry = await this.spawnEntry();
    entry.leasedBy = agentId;
    log.info(`MCPPool: agent ${agentId} acquired new process ${entry.id} (pool size: ${this.entries.length})`);
    return entry;
  }

  /**
   * Release a process back to the pool. It stays alive for reuse.
   * If pool size exceeds minSize, starts a shrink timer.
   */
  release(agentId: string): void {
    const entry = this.entries.find(e => e.leasedBy === agentId);
    if (!entry) return;

    entry.leasedBy = null;
    entry.lastReleasedAt = Date.now();
    log.info(`MCPPool: agent ${agentId} released process ${entry.id}`);

    if (this.entries.length > this.config.minSize && this.config.shrinkAfterMs > 0) {
      entry.shrinkTimer = setTimeout(() => {
        entry.shrinkTimer = undefined;
        if (entry.leasedBy !== null) return;
        if (this.entries.length <= this.config.minSize) return;
        this.destroyEntry(entry);
        log.info(`MCPPool: shrunk idle process ${entry.id} (pool size: ${this.entries.length})`);
      }, this.config.shrinkAfterMs);
      entry.shrinkTimer.unref();
    }
  }

  /**
   * Execute a tool call for an agent. Auto-acquires if needed.
   */
  async callTool(agentId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const entry = await this.acquire(agentId);
    const result = await this.sendRequest(entry.process, 'tools/call', {
      name: toolName,
      arguments: args,
    });
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    if (content?.[0]?.text) return content[0].text;
    return JSON.stringify(result);
  }

  /**
   * Build tool handlers that route through this pool for a given agent.
   * The handlers auto-acquire on first call.
   */
  getToolHandlers(agentId: string, toolPrefix: string): AgentToolHandler[] {
    const tools = this.toolCache;
    if (tools.length === 0) return [];

    return tools.map((tool) => ({
      name: `${toolPrefix}__${tool.name}`,
      description: `[MCP:${toolPrefix}] ${tool.description}`,
      inputSchema: tool.inputSchema,
      execute: async (toolArgs: Record<string, unknown>) => {
        return this.callTool(agentId, tool.name, toolArgs);
      },
    }));
  }

  stats(): { total: number; leased: number; idle: number } {
    const leased = this.entries.filter(e => e.leasedBy !== null).length;
    return { total: this.entries.length, leased, idle: this.entries.length - leased };
  }

  isAgentLeased(agentId: string): boolean {
    return this.entries.some(e => e.leasedBy === agentId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const entry of this.entries) {
      if (entry.shrinkTimer) clearTimeout(entry.shrinkTimer);
      entry.process.kill();
    }
    this.entries = [];
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('MCPPool shutting down'));
    }
    this.pendingRequests.clear();
    this.stdoutBuffers.clear();
    log.info('MCPPool shutdown complete');
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async spawnEntry(): Promise<PoolEntry> {
    const id = `pool_${this.seq++}`;
    const { command, args = [], env } = this.config.serverConfig;

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });

    proc.on('error', (err) => {
      log.error(`MCPPool process ${id} error`, { error: String(err) });
    });

    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      if (stderrChunks.length <= 5) {
        log.warn(`MCPPool ${id} stderr`, { text: text.trimEnd() });
      }
    });

    proc.on('exit', (code) => {
      if (this.shuttingDown) return;
      const stderr = stderrChunks.join('').trim();
      if (stderr) {
        log.error(`MCPPool ${id} exited with stderr`, { code, stderr: stderr.slice(0, 500) });
      } else {
        log.info(`MCPPool ${id} exited`, { code });
      }
      this.stdoutBuffers.delete(proc);
      const idx = this.entries.findIndex(e => e.id === id);
      if (idx !== -1) this.entries.splice(idx, 1);
      for (const [reqId, req] of this.pendingRequests) {
        if (req.proc !== proc) continue;
        req.reject(new Error(`MCPPool ${id} exited (code ${code}) while awaiting ${req.method}`));
        clearTimeout(req.timer);
        this.pendingRequests.delete(reqId);
      }
      if (this.entries.length < this.config.minSize) {
        this.spawnEntry().catch(err => {
          log.error('MCPPool: failed to respawn after unexpected exit', { error: String(err) });
        });
      }
    });

    this.stdoutBuffers.set(proc, '');
    proc.stdout?.on('data', (data: Buffer) => this.handleStdoutData(proc, data));

    try {
      await this.sendRequest(proc, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'markus-pool', version: APP_VERSION },
      });

      await this.sendNotification(proc, 'notifications/initialized', {});

      const toolsResult = await this.sendRequest(proc, 'tools/list', {});
      const tools = (toolsResult as { tools?: MCPToolDescriptor[] })?.tools ?? [];

      if (this.toolCache.length === 0 && tools.length > 0) {
        this.toolCache = tools;
      }

      const entry: PoolEntry = {
        id,
        process: proc,
        tools,
        leasedBy: null,
        lastReleasedAt: Date.now(),
      };
      this.entries.push(entry);
      return entry;
    } catch (err) {
      proc.kill();
      this.stdoutBuffers.delete(proc);
      throw err;
    }
  }

  private destroyEntry(entry: PoolEntry): void {
    if (entry.shrinkTimer) clearTimeout(entry.shrinkTimer);
    entry.process.kill();
    this.stdoutBuffers.delete(entry.process);
    const idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
  }

  private handleStdoutData(proc: ChildProcess, data: Buffer): void {
    const buf = (this.stdoutBuffers.get(proc) ?? '') + data.toString();
    const lines = buf.split('\n');
    this.stdoutBuffers.set(proc, lines.pop()!);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { code: number; message: string } };
        if (msg.id === null || msg.id === undefined) continue;
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
        // non-JSON output — skip
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
        reject(new Error(`MCPPool request timeout for ${method} (id=${id}, ${timeoutMs}ms)`));
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
