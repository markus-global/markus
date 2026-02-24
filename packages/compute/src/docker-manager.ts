import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ComputeEnvironment, CommandExecution, ResourceLimits } from '@markus/shared';
import { createLogger, envId, generateId } from '@markus/shared';

const execFileAsync = promisify(execFile);
const log = createLogger('docker-manager');

export interface DockerRunOptions {
  image: string;
  name?: string;
  agentId: string;
  resources?: Partial<ResourceLimits>;
  env?: Record<string, string>;
  volumes?: Array<{ host: string; container: string; readonly?: boolean }>;
  ports?: Array<{ host: number; container: number }>;
  command?: string[];
  workDir?: string;
}

export class DockerManager {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? '/var/run/docker.sock';
  }

  async createContainer(options: DockerRunOptions): Promise<ComputeEnvironment> {
    const id = envId();
    const containerName = options.name ?? `markus-${options.agentId.slice(0, 12)}`;

    const args: string[] = [
      'run', '-d',
      '--name', containerName,
      '--hostname', containerName,
      '--label', `markus.agent.id=${options.agentId}`,
      '--label', `markus.env.id=${id}`,
    ];

    if (options.resources?.cpuShares) {
      args.push('--cpu-shares', String(options.resources.cpuShares));
    }
    if (options.resources?.memoryMb) {
      args.push('--memory', `${options.resources.memoryMb}m`);
    }

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    if (options.volumes) {
      for (const vol of options.volumes) {
        const mode = vol.readonly ? 'ro' : 'rw';
        args.push('-v', `${vol.host}:${vol.container}:${mode}`);
      }
    }

    if (options.ports) {
      for (const port of options.ports) {
        args.push('-p', `${port.host}:${port.container}`);
      }
    }

    if (options.workDir) {
      args.push('-w', options.workDir);
    }

    args.push(options.image);
    if (options.command?.length) {
      args.push(...options.command);
    } else {
      args.push('sleep', 'infinity');
    }

    log.info(`Creating container: ${containerName}`, { image: options.image, agentId: options.agentId });

    const { stdout } = await execFileAsync('docker', args);
    const containerId = stdout.trim().slice(0, 12);

    const env: ComputeEnvironment = {
      id,
      agentId: options.agentId,
      type: 'docker',
      status: 'running',
      containerId,
      image: options.image,
      hostname: containerName,
      ports: (options.ports ?? []).map((p) => ({
        hostPort: p.host,
        containerPort: p.container,
        protocol: 'tcp',
      })),
      volumes: (options.volumes ?? []).map((v) => ({
        hostPath: v.host,
        containerPath: v.container,
        readOnly: v.readonly ?? false,
      })),
      resources: {
        cpuShares: options.resources?.cpuShares ?? 1024,
        memoryMb: options.resources?.memoryMb ?? 512,
        diskMb: options.resources?.diskMb ?? 2048,
        gpuEnabled: options.resources?.gpuEnabled ?? false,
      },
      createdAt: new Date().toISOString(),
    };

    log.info(`Container created: ${containerId}`, { name: containerName });
    return env;
  }

  async execCommand(
    containerId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<CommandExecution> {
    const execId = generateId('cmd');
    const startedAt = new Date().toISOString();

    const args: string[] = ['exec'];

    if (options?.cwd) {
      args.push('-w', options.cwd);
    }

    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    args.push(containerId, 'sh', '-c', command);

    log.debug(`Executing in container ${containerId}: ${command}`);

    try {
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: options?.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        id: execId,
        environmentId: containerId,
        command,
        args: [],
        cwd: options?.cwd,
        env: options?.env,
        exitCode: 0,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        timeoutMs: options?.timeoutMs ?? 60_000,
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        id: execId,
        environmentId: containerId,
        command,
        args: [],
        cwd: options?.cwd,
        env: options?.env,
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? String(error),
        startedAt,
        finishedAt: new Date().toISOString(),
        timeoutMs: options?.timeoutMs ?? 60_000,
      };
    }
  }

  async writeFile(containerId: string, path: string, content: string): Promise<void> {
    const encoded = Buffer.from(content).toString('base64');
    await this.execCommand(containerId, `echo '${encoded}' | base64 -d > ${path}`);
  }

  async readFile(containerId: string, path: string): Promise<string> {
    const result = await this.execCommand(containerId, `cat ${path}`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${path}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async stopContainer(containerId: string): Promise<void> {
    log.info(`Stopping container: ${containerId}`);
    await execFileAsync('docker', ['stop', containerId]);
  }

  async removeContainer(containerId: string, force = false): Promise<void> {
    log.info(`Removing container: ${containerId}`);
    const args = ['rm'];
    if (force) args.push('-f');
    args.push(containerId);
    await execFileAsync('docker', args);
  }

  async listContainers(): Promise<Array<{ id: string; name: string; status: string; agentId?: string }>> {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a',
      '--filter', 'label=markus.agent.id',
      '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label "markus.agent.id"}}',
    ]);

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, status, agentId] = line.split('\t');
        return { id: id ?? '', name: name ?? '', status: status ?? '', agentId };
      });
  }

  async getContainerStats(containerId: string): Promise<{ cpuPercent: string; memUsage: string }> {
    const { stdout } = await execFileAsync('docker', [
      'stats', containerId, '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}',
    ]);
    const [cpuPercent, memUsage] = stdout.trim().split('\t');
    return { cpuPercent: cpuPercent ?? '0%', memUsage: memUsage ?? '0B' };
  }
}
