import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateRegistry, createDefaultTemplateRegistry } from '../src/templates/registry.js';
import type { AgentTemplate } from '../src/templates/types.js';

const mockTemplate: AgentTemplate = {
  id: 'tpl-test',
  name: 'Test Template',
  description: 'A test template for unit testing',
  source: 'custom',
  version: '1.0.0',
  author: 'Test',
  roleId: 'test-role',
  agentRole: 'worker',
  skills: ['git', 'code-analysis'],
  tags: ['test', 'development'],
  category: 'development',
};

describe('TemplateRegistry', () => {
  let registry: TemplateRegistry;

  beforeEach(() => {
    registry = new TemplateRegistry();
  });

  it('should register and retrieve a template', () => {
    registry.register(mockTemplate);
    const retrieved = registry.get('tpl-test');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Test Template');
  });

  it('should unregister a template', () => {
    registry.register(mockTemplate);
    registry.unregister('tpl-test');
    expect(registry.get('tpl-test')).toBeUndefined();
  });

  it('should list all templates', () => {
    registry.register(mockTemplate);
    registry.register({ ...mockTemplate, id: 'tpl-other', name: 'Other' });
    expect(registry.list()).toHaveLength(2);
  });

  it('should list by source', () => {
    registry.register(mockTemplate);
    registry.register({ ...mockTemplate, id: 'tpl-official', source: 'official' });

    expect(registry.list('official')).toHaveLength(1);
    expect(registry.list('custom')).toHaveLength(1);
    expect(registry.list('community')).toHaveLength(0);
  });

  describe('search', () => {
    beforeEach(() => {
      registry.register(mockTemplate);
      registry.register({
        ...mockTemplate,
        id: 'tpl-manager',
        name: 'PM Template',
        description: 'Project management',
        agentRole: 'manager',
        category: 'management',
        source: 'official',
        tags: ['management', 'planning'],
      });
      registry.register({
        ...mockTemplate,
        id: 'tpl-browser',
        name: 'Browser Agent',
        description: 'Browser automation specialist',
        category: 'browser',
        tags: ['browser', 'automation'],
      });
    });

    it('should search by text', () => {
      const result = registry.search({ text: 'browser' });
      expect(result.total).toBe(1);
      expect(result.templates[0].id).toBe('tpl-browser');
    });

    it('should search by source', () => {
      const result = registry.search({ source: 'official' });
      expect(result.total).toBe(1);
      expect(result.templates[0].id).toBe('tpl-manager');
    });

    it('should search by category', () => {
      const result = registry.search({ category: 'management' });
      expect(result.total).toBe(1);
    });

    it('should search by agentRole', () => {
      const result = registry.search({ agentRole: 'manager' });
      expect(result.total).toBe(1);
      expect(result.templates[0].id).toBe('tpl-manager');
    });

    it('should search by tags', () => {
      const result = registry.search({ tags: ['automation'] });
      expect(result.total).toBe(1);
    });

    it('should combine multiple search criteria', () => {
      const result = registry.search({ text: 'agent', category: 'browser' });
      expect(result.total).toBe(1);
      expect(result.templates[0].id).toBe('tpl-browser');
    });

    it('should return empty for no matches', () => {
      const result = registry.search({ text: 'nonexistent-xyz' });
      expect(result.total).toBe(0);
    });
  });
});

describe('createDefaultTemplateRegistry', () => {
  it('should create registry with built-in templates', () => {
    const registry = createDefaultTemplateRegistry();
    const templates = registry.list();
    expect(templates.length).toBeGreaterThanOrEqual(5);
  });

  it('should include developer template', () => {
    const registry = createDefaultTemplateRegistry();
    const dev = registry.get('tpl-developer');
    expect(dev).toBeDefined();
    expect(dev!.roleId).toBe('developer');
    expect(dev!.agentRole).toBe('worker');
    expect(dev!.skills).toContain('git');
  });

  it('should include project manager template', () => {
    const registry = createDefaultTemplateRegistry();
    const pm = registry.get('tpl-project-manager');
    expect(pm).toBeDefined();
    expect(pm!.agentRole).toBe('manager');
    expect(pm!.heartbeatIntervalMs).toBeDefined();
  });

  it('should include reviewer template', () => {
    const registry = createDefaultTemplateRegistry();
    const reviewer = registry.get('tpl-reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('official');
  });

  it('all templates should be official source', () => {
    const registry = createDefaultTemplateRegistry();
    for (const tpl of registry.list()) {
      expect(tpl.source).toBe('official');
    }
  });

  it('all templates should have required fields', () => {
    const registry = createDefaultTemplateRegistry();
    for (const tpl of registry.list()) {
      expect(tpl.id).toBeTruthy();
      expect(tpl.name).toBeTruthy();
      expect(tpl.description).toBeTruthy();
      expect(tpl.version).toBeTruthy();
      expect(tpl.roleId).toBeTruthy();
      expect(tpl.skills.length).toBeGreaterThan(0);
      expect(tpl.tags.length).toBeGreaterThan(0);
    }
  });
});
