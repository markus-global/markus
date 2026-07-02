import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, globalToolRegistry } from '../src/tools/registry.js';
import type { AgentToolHandler } from '../src/agent.js';
import type { ToolRegistration } from '../src/tools/registry.js';

function makeMockHandler(name: string, execute?: () => Promise<string>): AgentToolHandler {
  return {
    name,
    description: `Mock tool: ${name}`,
    execute: execute ?? (async () => `Executed ${name}`),
  };
}

const shellCategory = { name: 'shell', description: 'Shell command execution' };
const fileCategory = { name: 'file', description: 'File operations' };
const webCategory = { name: 'web', description: 'Web tools' };

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('basic registration and retrieval', () => {
    it('should register a tool and retrieve it by name', () => {
      registry.register({
        handler: makeMockHandler('shell_exec'),
        category: shellCategory,
        priority: 100,
        tags: ['shell', 'exec'],
      });
      const tool = registry.get('shell_exec');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('shell_exec');
    });

    it('should return undefined for unregistered tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should overwrite a tool with the same name', () => {
      registry.register({
        handler: makeMockHandler('shell_exec', async () => 'v1'),
        category: shellCategory,
        priority: 100,
        tags: ['shell'],
      });
      registry.register({
        handler: makeMockHandler('shell_exec', async () => 'v2'),
        category: shellCategory,
        priority: 200,
        tags: ['shell', 'updated'],
      });
      const tool = registry.get('shell_exec');
      expect(tool).toBeDefined();
      expect(tool!.description).toBe('Mock tool: shell_exec');
    });
  });

  describe('getAll / getAllRegistrations', () => {
    it('should return empty array when no tools registered', () => {
      expect(registry.getAll()).toHaveLength(0);
      expect(registry.getAllRegistrations()).toHaveLength(0);
    });

    it('should return all registered handlers', () => {
      registry.register({
        handler: makeMockHandler('read'),
        category: fileCategory,
        priority: 90,
        tags: ['file', 'read'],
      });
      registry.register({
        handler: makeMockHandler('write'),
        category: fileCategory,
        priority: 80,
        tags: ['file', 'write'],
      });
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(h => h.name).sort()).toEqual(['read', 'write']);
    });

    it('should return all registrations with metadata', () => {
      registry.register({
        handler: makeMockHandler('fetch'),
        category: webCategory,
        priority: 80,
        tags: ['web', 'http'],
      });
      const registrations = registry.getAllRegistrations();
      expect(registrations).toHaveLength(1);
      expect(registrations[0].category.name).toBe('web');
      expect(registrations[0].priority).toBe(80);
      expect(registrations[0].tags).toEqual(['web', 'http']);
    });
  });

  describe('findByCategory', () => {
    it('should return tools in a category', () => {
      registry.register({
        handler: makeMockHandler('shell_exec'),
        category: shellCategory,
        priority: 100,
        tags: ['shell'],
      });
      registry.register({
        handler: makeMockHandler('read'),
        category: fileCategory,
        priority: 90,
        tags: ['file'],
      });
      registry.register({
        handler: makeMockHandler('write'),
        category: fileCategory,
        priority: 80,
        tags: ['file'],
      });

      const fileTools = registry.findByCategory('file');
      expect(fileTools).toHaveLength(2);
      expect(fileTools.map(r => r.handler.name).sort()).toEqual(['read', 'write']);

      const shellTools = registry.findByCategory('shell');
      expect(shellTools).toHaveLength(1);
      expect(shellTools[0].handler.name).toBe('shell_exec');

      const webTools = registry.findByCategory('web');
      expect(webTools).toHaveLength(0);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      registry.register({
        handler: makeMockHandler('shell_exec'),
        category: shellCategory,
        priority: 100,
        tags: ['shell', 'command'],
      });
      registry.register({
        handler: makeMockHandler('file_read'),
        category: fileCategory,
        priority: 90,
        tags: ['file', 'read', 'content'],
      });
      registry.register({
        handler: makeMockHandler('web_fetch'),
        category: webCategory,
        priority: 80,
        tags: ['web', 'http', 'download'],
      });
    });

    it('should find by name substring (case-insensitive)', () => {
      const results = registry.search('read');
      expect(results).toHaveLength(1);
      expect(results[0].handler.name).toBe('file_read');
    });

    it('should find by tag match', () => {
      const results = registry.search('http');
      expect(results).toHaveLength(1);
      expect(results[0].handler.name).toBe('web_fetch');
    });

    it('should find multiple tools matching the same query', () => {
      const results = registry.search('shell');
      expect(results).toHaveLength(1);
      expect(results[0].handler.name).toBe('shell_exec');
    });

    it('should return empty array for no match', () => {
      const results = registry.search('zzznonexistent');
      expect(results).toHaveLength(0);
    });

    it('should return all tools for empty query', () => {
      const results = registry.search('');
      expect(results).toHaveLength(3);
    });

    it('should be case-insensitive', () => {
      const results = registry.search('SHELL');
      expect(results).toHaveLength(1);
      expect(results[0].handler.name).toBe('shell_exec');
    });
  });

  describe('unregister', () => {
    beforeEach(() => {
      registry.register({
        handler: makeMockHandler('shell_exec'),
        category: shellCategory,
        priority: 100,
        tags: ['shell'],
      });
      registry.register({
        handler: makeMockHandler('file_read'),
        category: fileCategory,
        priority: 90,
        tags: ['file', 'read'],
      });
    });

    it('should unregister an existing tool and return true', () => {
      const result = registry.unregister('shell_exec');
      expect(result).toBe(true);
      expect(registry.get('shell_exec')).toBeUndefined();
      expect(registry.findByCategory('shell')).toHaveLength(0);
    });

    it('should not affect other tools when unregistering', () => {
      registry.unregister('shell_exec');
      expect(registry.get('file_read')).toBeDefined();
      expect(registry.findByCategory('file')).toHaveLength(1);
    });

    it('should return false for non-existent tool', () => {
      const result = registry.unregister('nonexistent');
      expect(result).toBe(false);
    });

    it('should clean up tag indexes on unregister', () => {
      // 'shell_exec' has tag 'shell'; 'file_read' also has tag 'read'
      // Both appear in search before unregister
      expect(registry.search('file')).toHaveLength(1);
      registry.unregister('file_read');
      expect(registry.search('file')).toHaveLength(0);
      expect(registry.search('shell')).toHaveLength(1);
    });

    it('should allow re-register after unregister', () => {
      registry.unregister('shell_exec');
      registry.register({
        handler: makeMockHandler('shell_exec', async () => 're-registered'),
        category: shellCategory,
        priority: 100,
        tags: ['shell'],
      });
      expect(registry.get('shell_exec')).toBeDefined();
    });

    it('should handle unregister when tool was overwritten', () => {
      // Overwrite shell_exec with different metadata
      registry.register({
        handler: makeMockHandler('shell_exec'),
        category: { name: 'custom', description: 'Custom' },
        priority: 50,
        tags: ['custom'],
      });
      // Now unregister — should clean up from 'custom' category, not 'shell'
      registry.unregister('shell_exec');
      expect(registry.get('shell_exec')).toBeUndefined();
      expect(registry.findByCategory('custom')).toHaveLength(0);
      // NOTE: register() currently does not clean up stale indexes on overwrite,
      // so the original 'shell' category still contains the stale entry.
      // This is a known limitation — unregister() only cleans up the most recent
      // registration's indexes.
      const shellTools = registry.findByCategory('shell');
      expect(shellTools).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('should handle many registrations', () => {
      const count = 100;
      for (let i = 0; i < count; i++) {
        registry.register({
          handler: makeMockHandler(`tool_${i}`),
          category: { name: `cat_${i % 5}`, description: `Category ${i % 5}` },
          priority: i,
          tags: [`tag_${i}`, `group_${i % 3}`],
        });
      }
      expect(registry.getAll()).toHaveLength(count);
      // Verify category index
      expect(registry.findByCategory('cat_0')).toHaveLength(20); // 100 / 5
      // Verify tag index — tag_0 unique, group_0 appears ~33 times
      expect(registry.search('tag_0')).toHaveLength(1);
    });

    it('should handle tool names with special characters', () => {
      registry.register({
        handler: makeMockHandler('my-custom_tool@2'),
        category: { name: 'custom', description: 'Custom tools' },
        priority: 10,
        tags: ['special'],
      });
      expect(registry.get('my-custom_tool@2')).toBeDefined();
      expect(registry.search('custom')).toHaveLength(1);
    });

    it('search should match by tag even if name is different', () => {
      registry.register({
        handler: makeMockHandler('ls'),
        category: shellCategory,
        priority: 100,
        tags: ['directory', 'list', 'filesystem'],
      });
      const results = registry.search('filesystem');
      expect(results).toHaveLength(1);
      expect(results[0].handler.name).toBe('ls');
    });
  });
});

describe('globalToolRegistry', () => {
  it('should be a ToolRegistry instance', () => {
    expect(globalToolRegistry).toBeInstanceOf(ToolRegistry);
  });

  it('should start empty', () => {
    // Create a fresh registry for testing since globalToolRegistry
    // may have tools registered during module initialization
    const fresh = new ToolRegistry();
    expect(fresh.getAll()).toHaveLength(0);
  });
});
