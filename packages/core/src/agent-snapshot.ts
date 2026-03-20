import { createLogger, generateId, type AgentConfig } from '@markus/shared';

const log = createLogger('agent-snapshot');

export interface AgentSnapshot {
  id: string;
  agentId: string;
  agentConfig: AgentConfig;
  version: number;
  memories: MemorySnapshot[];
  skills: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  description?: string;
}

export interface MemorySnapshot {
  key: string;
  value: string;
  tier: 'short' | 'medium' | 'long';
  category?: string;
  importance?: number;
}

export interface MigrationResult {
  success: boolean;
  sourceAgentId: string;
  targetAgentId: string;
  snapshotId: string;
  memoriesRestored: number;
  skillsRestored: number;
  error?: string;
}

export interface AgentDataProvider {
  getConfig(agentId: string): AgentConfig | undefined;
  getMemories(agentId: string): MemorySnapshot[];
  getSkills(agentId: string): string[];
}

export interface AgentDataRestorer {
  createAgent(config: AgentConfig): Promise<string>;
  restoreMemories(agentId: string, memories: MemorySnapshot[]): Promise<number>;
  restoreSkills(agentId: string, skills: string[]): Promise<number>;
}

export class AgentSnapshotManager {
  private snapshots = new Map<string, AgentSnapshot>();
  private agentVersions = new Map<string, number>();

  constructor(
    private dataProvider: AgentDataProvider,
    private dataRestorer?: AgentDataRestorer,
  ) {}

  setRestorer(restorer: AgentDataRestorer): void {
    this.dataRestorer = restorer;
  }

  createSnapshot(agentId: string, description?: string): AgentSnapshot {
    const config = this.dataProvider.getConfig(agentId);
    if (!config) throw new Error(`Agent ${agentId} not found`);

    const memories = this.dataProvider.getMemories(agentId);
    const skills = this.dataProvider.getSkills(agentId);

    const version = (this.agentVersions.get(agentId) ?? 0) + 1;
    this.agentVersions.set(agentId, version);

    const snapshot: AgentSnapshot = {
      id: generateId('snap'),
      agentId,
      agentConfig: { ...config },
      version,
      memories,
      skills,
      metadata: {
        memoryCount: memories.length,
        skillCount: skills.length,
        snapshotTime: new Date().toISOString(),
      },
      createdAt: new Date(),
      description,
    };

    this.snapshots.set(snapshot.id, snapshot);
    log.info('Snapshot created', { snapshotId: snapshot.id, agentId, version, memories: memories.length });

    return snapshot;
  }

  getSnapshot(snapshotId: string): AgentSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  listSnapshots(agentId?: string): AgentSnapshot[] {
    const all = [...this.snapshots.values()];
    if (!agentId) return all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all
      .filter(s => s.agentId === agentId)
      .sort((a, b) => b.version - a.version);
  }

  deleteSnapshot(snapshotId: string): boolean {
    return this.snapshots.delete(snapshotId);
  }

  async cloneAgent(
    snapshotId: string,
    overrides: Partial<AgentConfig> = {},
  ): Promise<MigrationResult> {
    if (!this.dataRestorer) throw new Error('No data restorer configured');

    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    try {
      const newConfig: AgentConfig = {
        ...snapshot.agentConfig,
        ...overrides,
        id: overrides.id ?? generateId('agent'),
        name: overrides.name ?? `${snapshot.agentConfig.name} (clone)`,
      };

      const targetAgentId = await this.dataRestorer.createAgent(newConfig);

      const memoriesRestored = await this.dataRestorer.restoreMemories(targetAgentId, snapshot.memories);
      const skillsRestored = await this.dataRestorer.restoreSkills(targetAgentId, snapshot.skills);

      log.info('Agent cloned', {
        sourceAgentId: snapshot.agentId,
        targetAgentId,
        snapshotId,
        memoriesRestored,
        skillsRestored,
      });

      return {
        success: true,
        sourceAgentId: snapshot.agentId,
        targetAgentId,
        snapshotId,
        memoriesRestored,
        skillsRestored,
      };
    } catch (err) {
      log.error('Agent clone failed', { snapshotId, error: String(err) });
      return {
        success: false,
        sourceAgentId: snapshot.agentId,
        targetAgentId: '',
        snapshotId,
        memoriesRestored: 0,
        skillsRestored: 0,
        error: String(err),
      };
    }
  }

  async restoreAgent(snapshotId: string): Promise<MigrationResult> {
    if (!this.dataRestorer) throw new Error('No data restorer configured');

    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    try {
      const memoriesRestored = await this.dataRestorer.restoreMemories(
        snapshot.agentId, snapshot.memories,
      );
      const skillsRestored = await this.dataRestorer.restoreSkills(
        snapshot.agentId, snapshot.skills,
      );

      log.info('Agent restored from snapshot', {
        agentId: snapshot.agentId,
        snapshotId,
        version: snapshot.version,
        memoriesRestored,
        skillsRestored,
      });

      return {
        success: true,
        sourceAgentId: snapshot.agentId,
        targetAgentId: snapshot.agentId,
        snapshotId,
        memoriesRestored,
        skillsRestored,
      };
    } catch (err) {
      log.error('Agent restore failed', { snapshotId, error: String(err) });
      return {
        success: false,
        sourceAgentId: snapshot.agentId,
        targetAgentId: snapshot.agentId,
        snapshotId,
        memoriesRestored: 0,
        skillsRestored: 0,
        error: String(err),
      };
    }
  }

  exportSnapshot(snapshotId: string): string {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    return JSON.stringify({
      ...snapshot,
      createdAt: snapshot.createdAt.toISOString(),
      _format: 'markus-snapshot-v1',
    }, null, 2);
  }

  importSnapshot(json: string): AgentSnapshot {
    const data = JSON.parse(json) as Record<string, unknown>;
    if (data['_format'] !== 'markus-snapshot-v1') {
      throw new Error('Invalid snapshot format');
    }

    const snapshot: AgentSnapshot = {
      id: generateId('snap-imported'),
      agentId: data['agentId'] as string,
      agentConfig: data['agentConfig'] as AgentConfig,
      version: (data['version'] as number) ?? 1,
      memories: (data['memories'] as MemorySnapshot[]) ?? [],
      skills: (data['skills'] as string[]) ?? [],
      metadata: {
        ...(data['metadata'] as Record<string, unknown> ?? {}),
        importedAt: new Date().toISOString(),
        originalSnapshotId: data['id'] as string,
      },
      createdAt: new Date(),
      description: data['description'] as string,
    };

    this.snapshots.set(snapshot.id, snapshot);
    log.info('Snapshot imported', { snapshotId: snapshot.id, originalAgent: snapshot.agentId });

    return snapshot;
  }
}
