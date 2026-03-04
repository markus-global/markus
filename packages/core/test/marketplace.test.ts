import { describe, it, expect, beforeEach } from 'vitest';
import {
  TemplateRegistry,
  createDefaultTemplateRegistry,
  type AgentTemplate,
  type TemplatePersistenceAdapter,
} from '../src/templates/index.js';

describe('Marketplace - TemplateRegistry with persistence', () => {
  let registry: TemplateRegistry;
  let savedTemplates: Map<string, AgentTemplate>;
  let adapter: TemplatePersistenceAdapter;

  beforeEach(() => {
    registry = new TemplateRegistry();
    savedTemplates = new Map();

    adapter = {
      loadPublished: async () => [...savedTemplates.values()],
      save: async (tpl) => { savedTemplates.set(tpl.id, tpl); },
      remove: async (id) => { savedTemplates.delete(id); },
    };
  });

  const communityTemplate: AgentTemplate = {
    id: 'community-tpl-1',
    name: 'Data Analyst',
    description: 'Analyzes data and creates reports',
    source: 'community',
    version: '1.0.0',
    author: 'Community User',
    roleId: 'data-analyst',
    agentRole: 'worker',
    skills: ['code-analysis'],
    tags: ['data', 'analytics', 'reports'],
    category: 'productivity',
  };

  describe('persistence adapter', () => {
    it('should register without adapter (backwards compatible)', () => {
      registry.register(communityTemplate);
      expect(registry.get('community-tpl-1')).toBeDefined();
      expect(registry.get('community-tpl-1')!.name).toBe('Data Analyst');
    });

    it('should registerAndPersist to the adapter', async () => {
      registry.setPersistenceAdapter(adapter);
      await registry.registerAndPersist(communityTemplate);

      expect(registry.get('community-tpl-1')).toBeDefined();
      expect(savedTemplates.has('community-tpl-1')).toBe(true);
    });

    it('should unregisterAndRemove from adapter', async () => {
      registry.setPersistenceAdapter(adapter);
      await registry.registerAndPersist(communityTemplate);
      expect(savedTemplates.size).toBe(1);

      await registry.unregisterAndRemove('community-tpl-1');
      expect(registry.get('community-tpl-1')).toBeUndefined();
      expect(savedTemplates.has('community-tpl-1')).toBe(false);
    });

    it('should sync templates from database', async () => {
      savedTemplates.set('community-tpl-1', communityTemplate);
      savedTemplates.set('community-tpl-2', {
        ...communityTemplate,
        id: 'community-tpl-2',
        name: 'Security Auditor',
        tags: ['security', 'audit'],
      });

      registry.setPersistenceAdapter(adapter);
      const loaded = await registry.syncFromDatabase();

      expect(loaded).toBe(2);
      expect(registry.list()).toHaveLength(2);
      expect(registry.get('community-tpl-1')!.name).toBe('Data Analyst');
      expect(registry.get('community-tpl-2')!.name).toBe('Security Auditor');
    });

    it('should not overwrite existing templates during sync', async () => {
      const existing: AgentTemplate = {
        ...communityTemplate,
        name: 'Modified Data Analyst',
      };
      registry.register(existing);
      savedTemplates.set('community-tpl-1', communityTemplate);

      registry.setPersistenceAdapter(adapter);
      const loaded = await registry.syncFromDatabase();

      expect(loaded).toBe(0);
      expect(registry.get('community-tpl-1')!.name).toBe('Modified Data Analyst');
    });

    it('should handle sync failure gracefully', async () => {
      const failAdapter: TemplatePersistenceAdapter = {
        loadPublished: async () => { throw new Error('DB connection failed'); },
        save: async () => {},
        remove: async () => {},
      };
      registry.setPersistenceAdapter(failAdapter);
      const loaded = await registry.syncFromDatabase();
      expect(loaded).toBe(0);
    });

    it('should return 0 when no adapter is set', async () => {
      const loaded = await registry.syncFromDatabase();
      expect(loaded).toBe(0);
    });
  });

  describe('search with community templates', () => {
    beforeEach(() => {
      const defaults = createDefaultTemplateRegistry();
      for (const tpl of defaults.list()) {
        registry.register(tpl);
      }
      registry.register(communityTemplate);
    });

    it('should find community templates by source', () => {
      const result = registry.search({ source: 'community' });
      expect(result.templates).toHaveLength(1);
      expect(result.templates[0]!.name).toBe('Data Analyst');
    });

    it('should find templates by text across all sources', () => {
      const result = registry.search({ text: 'data' });
      expect(result.templates.length).toBeGreaterThanOrEqual(1);
      expect(result.templates.some(t => t.id === 'community-tpl-1')).toBe(true);
    });

    it('should list all templates (official + community)', () => {
      const all = registry.list();
      expect(all.length).toBe(15); // 14 official + 1 community
      expect(all.filter(t => t.source === 'official')).toHaveLength(14);
      expect(all.filter(t => t.source === 'community')).toHaveLength(1);
    });

    it('should filter by category', () => {
      const result = registry.search({ category: 'productivity' });
      expect(result.templates.length).toBeGreaterThanOrEqual(1);
      const names = result.templates.map(t => t.name);
      expect(names).toContain('Data Analyst');
      expect(names).toContain('Technical Writer');
    });

    it('should filter by tags', () => {
      const result = registry.search({ tags: ['analytics'] });
      expect(result.templates).toHaveLength(1);
      expect(result.templates[0]!.name).toBe('Data Analyst');
    });

    it('should filter by agentRole', () => {
      const managers = registry.search({ agentRole: 'manager' });
      expect(managers.templates).toHaveLength(3);
      expect(managers.templates.map(t => t.name)).toContain('Project Manager');

      const workers = registry.search({ agentRole: 'worker' });
      expect(workers.templates.length).toBe(12); // 11 official + 1 community
    });
  });
});

describe('Marketplace - TemplatePersistenceAdapter integration', () => {
  it('should support full lifecycle: register, persist, sync, remove', async () => {
    const db = new Map<string, AgentTemplate>();
    const adapter: TemplatePersistenceAdapter = {
      loadPublished: async () => [...db.values()],
      save: async (tpl) => { db.set(tpl.id, tpl); },
      remove: async (id) => { db.delete(id); },
    };

    const registry1 = new TemplateRegistry();
    registry1.setPersistenceAdapter(adapter);

    const tpl: AgentTemplate = {
      id: 'persist-test-1',
      name: 'Persistence Test',
      description: 'Testing persistence',
      source: 'community',
      version: '1.0.0',
      author: 'Test',
      roleId: 'test',
      agentRole: 'worker',
      skills: [],
      tags: ['test'],
      category: 'general',
    };

    await registry1.registerAndPersist(tpl);
    expect(db.size).toBe(1);

    const registry2 = new TemplateRegistry();
    registry2.setPersistenceAdapter(adapter);
    const loaded = await registry2.syncFromDatabase();
    expect(loaded).toBe(1);
    expect(registry2.get('persist-test-1')!.name).toBe('Persistence Test');

    await registry2.unregisterAndRemove('persist-test-1');
    expect(registry2.get('persist-test-1')).toBeUndefined();
    expect(db.size).toBe(0);
  });

  it('should merge default + community templates in search', async () => {
    const db = new Map<string, AgentTemplate>();
    db.set('community-1', {
      id: 'community-1',
      name: 'Custom Security Auditor',
      description: 'Community security template',
      source: 'community',
      version: '1.0.0',
      author: 'Community',
      roleId: 'security',
      agentRole: 'worker',
      skills: ['code-analysis'],
      tags: ['security', 'audit'],
      category: 'development',
    });

    const adapter: TemplatePersistenceAdapter = {
      loadPublished: async () => [...db.values()],
      save: async (tpl) => { db.set(tpl.id, tpl); },
      remove: async (id) => { db.delete(id); },
    };

    const registry = createDefaultTemplateRegistry();
    registry.setPersistenceAdapter(adapter);
    await registry.syncFromDatabase();

    const all = registry.list();
    expect(all).toHaveLength(15); // 14 official + 1 community

    const securityResults = registry.search({ text: 'security' });
    expect(securityResults.templates).toHaveLength(1);
    expect(securityResults.templates[0]!.source).toBe('community');

    const officialOnly = registry.search({ source: 'official' });
    expect(officialOnly.templates).toHaveLength(14);

    const communityOnly = registry.search({ source: 'community' });
    expect(communityOnly.templates).toHaveLength(1);
  });
});
