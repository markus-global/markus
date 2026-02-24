import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@markus/shared';
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

/**
 * Manages connections to external MCP servers via stdio transport.
 * Each MCP server exposes tools that can be used by Agents.
 */
export class MCPClientManager {
  private servers = new Map<string, { process: ChildProcess; tools: MCPToolDescriptor[] }>();
  private requestId = 0;

  async connectServer(name: string, config: MCPServerConfig): Promise<MCPToolDescriptor[]> {
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
    });

    // Initialize MCP protocol
    const initResult = await this.sendRequest(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'markus', version: '0.1.0' },
    });

    await this.sendNotification(proc, 'notifications/initialized', {});

    // List available tools
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
      log.info(`MCP server disconnected: ${name}`);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.disconnectServer(name);
    }
  }

  private sendRequest(proc: ChildProcess, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      const onData = (data: Buffer) => {
        try {
          const lines = data.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            const response = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
            if (response.id === id) {
              proc.stdout?.off('data', onData);
              if (response.error) {
                reject(new Error(response.error.message));
              } else {
                resolve(response.result);
              }
              return;
            }
          }
        } catch {
          // incomplete JSON, wait for more data
        }
      };

      proc.stdout?.on('data', onData);

      setTimeout(() => {
        proc.stdout?.off('data', onData);
        reject(new Error(`MCP request timeout for ${method}`));
      }, 30_000);

      proc.stdin?.write(message);
    });
  }

  private sendNotification(proc: ChildProcess, method: string, params: unknown): Promise<void> {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin?.write(message);
    return Promise.resolve();
  }
}
