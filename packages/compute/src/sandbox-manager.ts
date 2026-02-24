import { DockerManager, type DockerRunOptions } from './docker-manager.js';
import type { ComputeEnvironment, CommandExecution } from '@markus/shared';
import { createLogger } from '@markus/shared';

const log = createLogger('sandbox-manager');

export interface SandboxOptions {
  agentId: string;
  image?: string;
  cpuShares?: number;
  memoryMb?: number;
  env?: Record<string, string>;
}

export interface Sandbox {
  env: ComputeEnvironment;
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<CommandExecution>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export class SandboxManager {
  private docker: DockerManager;
  private sandboxes = new Map<string, Sandbox>();

  constructor(dockerSocketPath?: string) {
    this.docker = new DockerManager(dockerSocketPath);
  }

  async createSandbox(options: SandboxOptions): Promise<Sandbox> {
    const runOptions: DockerRunOptions = {
      agentId: options.agentId,
      image: options.image ?? 'node:20-slim',
      resources: {
        cpuShares: options.cpuShares ?? 1024,
        memoryMb: options.memoryMb ?? 512,
      },
      env: options.env,
      command: ['sleep', 'infinity'],
    };

    const env = await this.docker.createContainer(runOptions);
    const containerId = env.containerId!;

    const sandbox: Sandbox = {
      env,
      exec: (command, opts) =>
        this.docker.execCommand(containerId, command, opts),
      writeFile: (path, content) =>
        this.docker.writeFile(containerId, path, content),
      readFile: (path) =>
        this.docker.readFile(containerId, path),
      stop: async () => {
        await this.docker.stopContainer(containerId);
        env.status = 'stopped';
      },
      destroy: async () => {
        await this.docker.removeContainer(containerId, true);
        env.status = 'destroyed';
        this.sandboxes.delete(options.agentId);
      },
    };

    this.sandboxes.set(options.agentId, sandbox);
    log.info(`Sandbox created for agent ${options.agentId}`, { containerId });

    return sandbox;
  }

  getSandbox(agentId: string): Sandbox | undefined {
    return this.sandboxes.get(agentId);
  }

  async destroyAll(): Promise<void> {
    for (const [agentId, sandbox] of this.sandboxes) {
      try {
        await sandbox.destroy();
        log.info(`Sandbox destroyed for agent ${agentId}`);
      } catch (error) {
        log.error(`Failed to destroy sandbox for agent ${agentId}`, { error: String(error) });
      }
    }
    this.sandboxes.clear();
  }

  listSandboxes(): Array<{ agentId: string; containerId?: string; status: string }> {
    return [...this.sandboxes.entries()].map(([agentId, sandbox]) => ({
      agentId,
      containerId: sandbox.env.containerId,
      status: sandbox.env.status,
    }));
  }

  /**
   * Returns an object conforming to the SandboxFactory interface from @markus/core,
   * so it can be passed to AgentManager for automatic sandbox lifecycle management.
   */
  asSandboxFactory(defaultImage?: string): SandboxFactory {
    return {
      create: async (agentId: string, image?: string) => {
        const sandbox = await this.createSandbox({
          agentId,
          image: image ?? defaultImage ?? 'node:20-slim',
        });
        return sandbox;
      },
      destroy: async (agentId: string) => {
        const sandbox = this.sandboxes.get(agentId);
        if (sandbox) {
          await sandbox.destroy();
        }
      },
    };
  }
}

export interface SandboxFactory {
  create(agentId: string, image?: string): Promise<Sandbox>;
  destroy(agentId: string): Promise<void>;
}
