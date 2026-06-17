import { describe, it, expect, vi } from 'vitest';
import { createBuiltinTools } from '../src/tools/builtin.js';

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
