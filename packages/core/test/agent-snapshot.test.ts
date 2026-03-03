import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentSnapshotManager,
  type AgentDataProvider, type AgentDataRestorer, type MemorySnapshot,
} from '../src/agent-snapshot.js';
import type { AgentConfig } from '@markus/shared';

const mockConfig: AgentConfig = {
  id: 'agent-1',
  name: 'Test Agent',
  roleId: 'developer',
  orgId: 'org-1',
  agentRole: 'worker',
  skills: ['code', 'git'],
};

const mockMemories: MemorySnapshot[] = [
  { key: 'fact-1', value: 'User prefers TypeScript', tier: 'long', category: 'preference', importance: 0.8 },
  { key: 'episode-1', value: 'Completed PR review yesterday', tier: 'medium', category: 'episode' },
  { key: 'short-1', value: 'Current task is about API design', tier: 'short' },
];

function createMockProvider(): AgentDataProvider {
  return {
    getConfig: vi.fn((agentId: string) => agentId === 'agent-1' ? { ...mockConfig } : undefined),
    getMemories: vi.fn((_agentId: string) => [...mockMemories]),
    getSkills: vi.fn((_agentId: string) => ['git-skill', 'code-analysis']),
  };
}

function createMockRestorer(): AgentDataRestorer {
  return {
    createAgent: vi.fn(async (config: AgentConfig) => config.id),
    restoreMemories: vi.fn(async (_agentId: string, memories: MemorySnapshot[]) => memories.length),
    restoreSkills: vi.fn(async (_agentId: string, skills: string[]) => skills.length),
  };
}

describe('AgentSnapshotManager', () => {
  let manager: AgentSnapshotManager;
  let provider: AgentDataProvider;
  let restorer: AgentDataRestorer;

  beforeEach(() => {
    provider = createMockProvider();
    restorer = createMockRestorer();
    manager = new AgentSnapshotManager(provider, restorer);
  });

  describe('snapshot creation', () => {
    it('should create a snapshot of an agent', () => {
      const snap = manager.createSnapshot('agent-1', 'Before refactor');
      expect(snap.agentId).toBe('agent-1');
      expect(snap.version).toBe(1);
      expect(snap.memories).toHaveLength(3);
      expect(snap.skills).toEqual(['git-skill', 'code-analysis']);
      expect(snap.description).toBe('Before refactor');
      expect(snap.agentConfig.name).toBe('Test Agent');
    });

    it('should increment version on subsequent snapshots', () => {
      const snap1 = manager.createSnapshot('agent-1');
      const snap2 = manager.createSnapshot('agent-1');
      expect(snap1.version).toBe(1);
      expect(snap2.version).toBe(2);
    });

    it('should throw for unknown agent', () => {
      expect(() => manager.createSnapshot('nonexistent')).toThrow('not found');
    });
  });

  describe('snapshot listing', () => {
    it('should list all snapshots', () => {
      manager.createSnapshot('agent-1');
      manager.createSnapshot('agent-1');
      expect(manager.listSnapshots()).toHaveLength(2);
    });

    it('should list snapshots for specific agent', () => {
      manager.createSnapshot('agent-1');
      const snapshots = manager.listSnapshots('agent-1');
      expect(snapshots).toHaveLength(1);
    });

    it('should retrieve snapshot by id', () => {
      const snap = manager.createSnapshot('agent-1');
      expect(manager.getSnapshot(snap.id)).toBeDefined();
      expect(manager.getSnapshot(snap.id)!.agentId).toBe('agent-1');
    });

    it('should delete snapshot', () => {
      const snap = manager.createSnapshot('agent-1');
      expect(manager.deleteSnapshot(snap.id)).toBe(true);
      expect(manager.getSnapshot(snap.id)).toBeUndefined();
    });
  });

  describe('agent cloning', () => {
    it('should clone an agent from snapshot', async () => {
      const snap = manager.createSnapshot('agent-1');
      const result = await manager.cloneAgent(snap.id, { name: 'Cloned Agent' });

      expect(result.success).toBe(true);
      expect(result.sourceAgentId).toBe('agent-1');
      expect(result.memoriesRestored).toBe(3);
      expect(result.skillsRestored).toBe(2);
      expect(restorer.createAgent).toHaveBeenCalledOnce();
    });

    it('should use default clone name', async () => {
      const snap = manager.createSnapshot('agent-1');
      await manager.cloneAgent(snap.id);

      expect(restorer.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Test Agent (clone)' })
      );
    });

    it('should handle clone failure gracefully', async () => {
      (restorer.createAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB down'));
      const snap = manager.createSnapshot('agent-1');
      const result = await manager.cloneAgent(snap.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB down');
    });

    it('should throw without restorer', async () => {
      const noRestorer = new AgentSnapshotManager(provider);
      const snap = noRestorer.createSnapshot('agent-1');
      await expect(noRestorer.cloneAgent(snap.id)).rejects.toThrow('No data restorer');
    });
  });

  describe('agent restore', () => {
    it('should restore agent from snapshot', async () => {
      const snap = manager.createSnapshot('agent-1');
      const result = await manager.restoreAgent(snap.id);

      expect(result.success).toBe(true);
      expect(result.targetAgentId).toBe('agent-1');
      expect(result.memoriesRestored).toBe(3);
      expect(result.skillsRestored).toBe(2);
    });
  });

  describe('export/import', () => {
    it('should export snapshot as JSON', () => {
      const snap = manager.createSnapshot('agent-1', 'Export test');
      const json = manager.exportSnapshot(snap.id);
      const parsed = JSON.parse(json) as Record<string, unknown>;

      expect(parsed['_format']).toBe('markus-snapshot-v1');
      expect(parsed['agentId']).toBe('agent-1');
      expect(parsed['description']).toBe('Export test');
    });

    it('should import snapshot from JSON', () => {
      const snap = manager.createSnapshot('agent-1', 'To import');
      const json = manager.exportSnapshot(snap.id);

      const imported = manager.importSnapshot(json);
      expect(imported.agentId).toBe('agent-1');
      expect(imported.memories).toHaveLength(3);
      expect(imported.metadata).toHaveProperty('importedAt');
      expect(imported.metadata).toHaveProperty('originalSnapshotId');
    });

    it('should reject invalid format', () => {
      expect(() => manager.importSnapshot(JSON.stringify({ foo: 'bar' }))).toThrow('Invalid snapshot format');
    });

    it('should round-trip: export → import → clone', async () => {
      const snap = manager.createSnapshot('agent-1');
      const json = manager.exportSnapshot(snap.id);
      const imported = manager.importSnapshot(json);
      const result = await manager.cloneAgent(imported.id, { name: 'Imported Clone' });

      expect(result.success).toBe(true);
      expect(result.memoriesRestored).toBe(3);
    });
  });
});
