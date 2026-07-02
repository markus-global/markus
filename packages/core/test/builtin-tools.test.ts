import { describe, it, expect, vi } from 'vitest';
import { createBuiltinTools, registerBuiltinTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/registry.js';

vi.mock('../src/tools/shell.js', () => ({
  createShellTool: vi.fn(() => ({ name: 'shell_execute', execute: vi.fn() })),
}));
vi.mock('../src/tools/file.js', () => ({
  createFileReadTool: vi.fn(() => ({ name: 'file_read', execute: vi.fn() })),
  createFileWriteTool: vi.fn(() => ({ name: 'file_write', execute: vi.fn() })),
  createFileEditTool: vi.fn(() => ({ name: 'file_edit', execute: vi.fn() })),
}));
vi.mock('../src/tools/patch.js', () => ({
  createPatchTool: vi.fn(() => ({ name: 'file_patch', execute: vi.fn() })),
}));
vi.mock('../src/tools/search.js', () => ({
  createGrepTool: vi.fn(() => ({ name: 'grep_search', execute: vi.fn() })),
  createGlobTool: vi.fn(() => ({ name: 'glob_find', execute: vi.fn() })),
  createListDirectoryTool: vi.fn(() => ({ name: 'list_directory', execute: vi.fn() })),
}));
vi.mock('../src/tools/web-fetch.js', () => ({
  WebFetchTool: { name: 'web_fetch', execute: vi.fn() },
}));
vi.mock('../src/tools/web-search.js', () => ({
  WebSearchTool: { name: 'web_search', execute: vi.fn() },
}));
vi.mock('../src/tools/web-extract.js', () => ({
  WebExtractTool: { name: 'web_extract', execute: vi.fn() },
}));
vi.mock('../src/tools/process-manager.js', () => ({
  createBackgroundExecTool: vi.fn(() => ({ name: 'background_exec', execute: vi.fn() })),
  createProcessTool: vi.fn(() => ({ name: 'process_manage', execute: vi.fn() })),
}));

describe('createBuiltinTools', () => {
  it('returns correct tool set with background exec enabled by default', () => {
    const tools = createBuiltinTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual([
      'shell_execute',
      'file_read',
      'file_write',
      'file_edit',
      'file_patch',
      'grep_search',
      'glob_find',
      'list_directory',
      'web_fetch',
      'web_search',
      'web_extract',
      'background_exec',
      'process_manage',
    ]);
    expect(tools).toHaveLength(13);
  });

  it('excludes background exec tools when disabled', () => {
    const tools = createBuiltinTools({ enableBackgroundExec: false });
    const names = tools.map(t => t.name);
    expect(names).not.toContain('background_exec');
    expect(names).not.toContain('process_manage');
    expect(tools).toHaveLength(11);
  });

  it('passes workspace and policy options to file tools', async () => {
    const { createFileReadTool } = await import('../src/tools/file.js');
    const policy = { primaryWorkspace: '/workspace/a', denyWritePaths: ['/workspace/b'] } as any;
    createBuiltinTools({ pathPolicy: policy });
    expect(createFileReadTool).toHaveBeenCalledWith(undefined, '/workspace/a', policy);
  });

  it('passes agent meta and approval callback to shell tool', async () => {
    const { createShellTool } = await import('../src/tools/shell.js');
    const onApproval = vi.fn();
    const agentMeta = { agentId: 'agt_1', agentName: 'Alice' };
    createBuiltinTools({ agentMeta, onCommandApproval: onApproval, workspacePath: '/ws' });
    expect(createShellTool).toHaveBeenCalledWith(undefined, '/ws', agentMeta, undefined, onApproval);
  });
});

describe('registerBuiltinTools', () => {
  it('registers all built-in tools with metadata in an injected registry', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(undefined, registry);
    const registered = registry.getAllRegistrations();

    // Should include shell, file, web tools plus background exec
    const names = registered.map((r) => r.handler.name);
    expect(names).toContain('shell_execute');
    expect(names).toContain('file_read');
    expect(names).toContain('file_write');
    expect(names).toContain('file_edit');
    expect(names).toContain('file_patch');
    expect(names).toContain('grep_search');
    expect(names).toContain('glob_find');
    expect(names).toContain('list_directory');
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(names).toContain('web_extract');
    expect(names).toContain('background_exec');
    expect(names).toContain('process_manage');
    expect(registered).toHaveLength(13);

    // Verify each tool has category and tags metadata
    for (const entry of registered) {
      expect(entry.category).toBeDefined();
      expect(entry.tags).toBeDefined();
      expect(entry.tags.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('registers correct number of tools (13 with background exec)', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(undefined, registry);
    expect(registry.getAllRegistrations()).toHaveLength(13);
  });

  it('registers tools grouped by category', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(undefined, registry);
    const registered = registry.getAllRegistrations();

    // Shell tools
    const shellTools = registered.filter((r) => r.tags.includes('shell'));
    expect(shellTools.length).toBeGreaterThanOrEqual(1);
    expect(shellTools.map((r) => r.handler.name)).toContain('shell_execute');

    // File tools
    const allNames = registered.map((r) => r.handler.name);
    expect(allNames).toContain('file_read');
    expect(allNames).toContain('file_write');
  });
});

describe('ToolRegistry (real instance)', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    const handler = { name: 'test_tool', execute: vi.fn() };

    registry.register({
      handler,
      category: { name: 'test', description: 'Test category' },
      priority: 50,
      tags: ['test', 'demo'],
    });

    expect(registry.get('test_tool')).toBe(handler);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()).toContain(handler);
  });

  it('overwrites existing tool with same name on re-register', () => {
    const registry = new ToolRegistry();
    const handler1 = { name: 'dup_tool', execute: vi.fn() };
    const handler2 = { name: 'dup_tool', execute: vi.fn() };

    registry.register({
      handler: handler1,
      category: { name: 'cat', description: '' },
      priority: 10,
      tags: [],
    });
    registry.register({
      handler: handler2,
      category: { name: 'cat', description: '' },
      priority: 20,
      tags: [],
    });

    expect(registry.get('dup_tool')).toBe(handler2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('finds tools by category', () => {
    const registry = new ToolRegistry();

    registry.register({
      handler: { name: 'shell_exec', execute: vi.fn() },
      category: { name: 'shell', description: 'Shell commands' },
      priority: 100,
      tags: ['shell'],
    });
    registry.register({
      handler: { name: 'file_read', execute: vi.fn() },
      category: { name: 'file', description: 'File ops' },
      priority: 90,
      tags: ['file'],
    });
    registry.register({
      handler: { name: 'web_fetch', execute: vi.fn() },
      category: { name: 'web', description: 'Web ops' },
      priority: 70,
      tags: ['web'],
    });

    const shellTools = registry.getToolsByCategory('shell');
    expect(shellTools).toHaveLength(1);
    expect(shellTools[0].name).toBe('shell_exec');

    const fileTools = registry.getToolsByCategory('file');
    expect(fileTools).toHaveLength(1);
    expect(fileTools[0].name).toBe('file_read');

    const allRegs = registry.getAllRegistrations();
    const fileReg = allRegs.find(r => r.handler.name === 'file_read')!;
    expect(fileReg.category.name).toBe('file');
    expect(fileReg.priority).toBe(90);
  });

  it('returns empty array for unknown category', () => {
    const registry = new ToolRegistry();
    expect(registry.getToolsByCategory('nonexistent')).toEqual([]);
  });

  it('searches tools by name', () => {
    const registry = new ToolRegistry();

    registry.register({
      handler: { name: 'shell_execute', execute: vi.fn() },
      category: { name: 'shell', description: '' },
      priority: 100,
      tags: ['shell', 'bash'],
    });
    registry.register({
      handler: { name: 'file_read', execute: vi.fn() },
      category: { name: 'file', description: '' },
      priority: 90,
      tags: ['file', 'read'],
    });
    registry.register({
      handler: { name: 'file_write', execute: vi.fn() },
      category: { name: 'file', description: '' },
      priority: 90,
      tags: ['file', 'write'],
    });

    const results = registry.search('file_');
    expect(results).toHaveLength(2);
    expect(results.map(r => r.name).sort()).toEqual(['file_read', 'file_write']);
  });

  it('searches tools by tag', () => {
    const registry = new ToolRegistry();

    registry.register({
      handler: { name: 'shell_exec', execute: vi.fn() },
      category: { name: 'shell', description: '' },
      priority: 100,
      tags: ['shell', 'bash', 'command'],
    });
    registry.register({
      handler: { name: 'background_run', execute: vi.fn() },
      category: { name: 'shell', description: '' },
      priority: 60,
      tags: ['shell', 'background', 'async'],
    });

    // Search by tag 'async'
    const results = registry.search('async');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('background_run');

    // Search by tag 'bash'
    const bashResults = registry.search('bash');
    expect(bashResults).toHaveLength(1);
    expect(bashResults[0].name).toBe('shell_exec');
  });

  it('returns empty array when search matches nothing', () => {
    const registry = new ToolRegistry();
    registry.register({
      handler: { name: 'some_tool', execute: vi.fn() },
      category: { name: 'cat', description: '' },
      priority: 50,
      tags: ['tag1'],
    });

    expect(registry.search('nonexistent')).toEqual([]);
  });

  it('unregisters a tool by name', () => {
    const registry = new ToolRegistry();
    const handler = { name: 'temp_tool', execute: vi.fn() };

    registry.register({
      handler,
      category: { name: 'temp', description: 'Temp' },
      priority: 50,
      tags: ['temp'],
    });
    expect(registry.getAll()).toHaveLength(1);

    const result = registry.unregister('temp_tool');
    expect(result).toBe(true);
    expect(registry.get('temp_tool')).toBeUndefined();
    expect(registry.getAll()).toHaveLength(0);
  });

  it('unregister removes from category and tag indices', () => {
    const registry = new ToolRegistry();

    registry.register({
      handler: { name: 'tool_a', execute: vi.fn() },
      category: { name: 'cat_a', description: '' },
      priority: 50,
      tags: ['tag_a'],
    });

    // Verify it's findable before unregister
    expect(registry.getToolsByCategory('cat_a')).toHaveLength(1);
    expect(registry.search('tag_a')).toHaveLength(1);

    registry.unregister('tool_a');

    // Should no longer appear in indices
    expect(registry.getToolsByCategory('cat_a')).toHaveLength(0);
    expect(registry.search('tag_a')).toHaveLength(0);
  });

  it('returns false when unregistering non-existent tool', () => {
    const registry = new ToolRegistry();
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('returns all registrations with metadata', () => {
    const registry = new ToolRegistry();

    registry.register({
      handler: { name: 'tool_1', execute: vi.fn() },
      category: { name: 'cat1', description: 'Category 1' },
      priority: 100,
      tags: ['tag1'],
    });
    registry.register({
      handler: { name: 'tool_2', execute: vi.fn() },
      category: { name: 'cat2', description: 'Category 2' },
      priority: 50,
      tags: ['tag2'],
    });

    const allRegs = registry.getAllRegistrations();
    expect(allRegs).toHaveLength(2);
    expect(allRegs.find(r => r.handler.name === 'tool_1')?.priority).toBe(100);
    expect(allRegs.find(r => r.handler.name === 'tool_2')?.category.name).toBe('cat2');
  });

  it('createBuiltinTools uses a fresh local registry (no cross-test pollution)', () => {
    // First call with background exec enabled
    const tools1 = createBuiltinTools();
    expect(tools1).toHaveLength(13);

    // Second call with background exec disabled — should NOT include bg tools
    const tools2 = createBuiltinTools({ enableBackgroundExec: false });
    const names = tools2.map(t => t.name);
    expect(names).not.toContain('background_exec');
    expect(names).not.toContain('process_manage');
    expect(tools2).toHaveLength(11);
  });
});
