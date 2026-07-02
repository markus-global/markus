import { describe, it, expect, vi } from 'vitest';
import { createBuiltinTools, registerBuiltinTools } from '../src/tools/builtin.js';

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

// Create mock factory via vi.hoisted() — runs before vi.mock factories, available in test body
const { createMockRegistry } = vi.hoisted(() => {
  function createMockRegistry() {
    const registered: Array<{ name: string; category?: unknown; tags?: string[] }> = [];
    return {
      register: vi.fn((entry: { handler: { name: string }; category?: unknown; tags?: string[] }) => {
        registered.push({ name: entry.handler.name, category: entry.category, tags: entry.tags });
      }),
      getAll: vi.fn(() => registered),
      get: vi.fn(() => undefined as never),
      findByCategory: vi.fn(() => []),
      search: vi.fn(() => []),
      unregister: vi.fn(),
    };
  }
  return { createMockRegistry };
});

vi.mock('../src/tools/registry.js', () => ({
  globalToolRegistry: createMockRegistry(),
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
    const policy = { primaryWorkspace: '/workspace/a', denyWritePaths: ['/workspace/b'] };
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
    const registry = createMockRegistry();
    registerBuiltinTools(undefined, registry );
    const registered = registry.getAll();

    // Should include shell, file, web tools plus background exec
    const names = registered.map((r: { name: string }) => r.name);
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
      expect(entry.tags!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('registers correct number of tools (13 with background exec)', () => {
    const registry = createMockRegistry();
    registerBuiltinTools(undefined, registry );
    expect(registry.register).toHaveBeenCalledTimes(13);
  });

  it('registers tools grouped by category', () => {
    const registry = createMockRegistry();
    registerBuiltinTools(undefined, registry );
    const registered = registry.getAll();

    // Shell tools
    const shellTools = registered.filter((r: { tags?: string[] }) => r.tags?.includes('shell'));
    expect(shellTools.length).toBeGreaterThanOrEqual(1);
    expect(shellTools.map((r: { name: string }) => r.name)).toContain('shell_execute');

    // File tools
    const fileTools = registered.filter((r: { tags?: string[] }) => r.tags?.some(t => ['file_read', 'file_write'].includes(t) || t === 'file'));
    const allNames = registered.map((r: { name: string }) => r.name);
    expect(allNames).toContain('file_read');
    expect(allNames).toContain('file_write');
  });
});
