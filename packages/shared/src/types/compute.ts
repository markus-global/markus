export type ContainerStatus = 'creating' | 'running' | 'paused' | 'stopped' | 'error' | 'destroyed';

export interface ComputeEnvironment {
  id: string;
  agentId: string;
  type: 'docker' | 'vm';
  status: ContainerStatus;
  containerId?: string;
  vmId?: string;
  image: string;
  hostname: string;
  ip?: string;
  ports: PortMapping[];
  volumes: VolumeMount[];
  resources: ResourceLimits;
  createdAt: string;
}

export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface ResourceLimits {
  cpuShares: number;
  memoryMb: number;
  diskMb: number;
  gpuEnabled: boolean;
}

export interface CommandExecution {
  id: string;
  environmentId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt?: string;
  timeoutMs: number;
}
