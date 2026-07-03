import type { AgentToolHandler } from '../agent.js';
import type { PathAccessPolicy } from '@markus/shared';
import { createShellTool, type ShellAgentMeta, type CommandApprovalCallback } from './shell.js';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WebExtractTool } from './web-extract.js';
import { createGrepTool, createGlobTool, createListDirectoryTool } from './search.js';
import { createPatchTool } from './patch.js';
import { createBackgroundExecTool, createProcessTool } from './process-manager.js';
import type { SecurityGuard } from '../security.js';
import { ToolRegistry, globalToolRegistry } from './registry.js';

export interface BuiltinToolsOptions {
  agentId?: string;
  agentMeta?: ShellAgentMeta;
  security?: SecurityGuard;
  workspacePath?: string;
  /** Multi-tier access policy (takes precedence over workspacePath when set) */
  pathPolicy?: PathAccessPolicy;
  enableBackgroundExec?: boolean;
  onCommandApproval?: CommandApprovalCallback;
}

/**
 * Create the array of built-in tool handlers.
 *
 * Delegates to `registerBuiltinTools()` with a local registry so tools are
 * always constructed through the single `registerBuiltinTools()` code path
 * (eliminating duplicate handler construction). Uses a local registry to
 * avoid accumulating stale entries in the globalToolRegistry across calls.
 */
export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const localReg = new ToolRegistry();
  registerBuiltinTools(opts, localReg);
  return Array.from(localReg.getAll());
}

/**
 * Built-in tool categories for the discovery catalog.
 */
const BUILTIN_TOOL_CATEGORIES = {
  shell: { name: 'shell', description: 'Shell command execution, process management, and background tasks' },
  file: { name: 'file', description: 'File system operations: read, write, edit, patch, search' },
  web: { name: 'web', description: 'Web operations: fetch, search, extract content' },
} as const;

/**
 * Register all built-in tools in the global ToolRegistry for runtime discovery.
 *
 * This is the single source of truth for constructing built-in tool handler
 * instances. Both `registerBuiltinTools()` and `createBuiltinTools()` share
 * the same handler instances via the registry.
 *
 * Tools are tagged with categories and search keywords so the agent can
 * discover them at runtime via `discover_tools()`.
 */
export function registerBuiltinTools(opts?: BuiltinToolsOptions, registry?: ToolRegistry): void {
  const policy = opts?.pathPolicy;
  const wp = policy?.primaryWorkspace ?? opts?.workspacePath;
  const reg = registry ?? globalToolRegistry;

  reg.register({
    handler: createShellTool(opts?.security, wp, opts?.agentMeta, policy, opts?.onCommandApproval),
    category: BUILTIN_TOOL_CATEGORIES.shell,
    priority: 100,
    tags: ['shell', 'bash', 'command', 'exec'],
  });

  reg.register({
    handler: createFileReadTool(opts?.security, wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 90,
    tags: ['file', 'read'],
  });

  reg.register({
    handler: createFileWriteTool(opts?.security, wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 90,
    tags: ['file', 'write'],
  });

  reg.register({
    handler: createFileEditTool(opts?.security, wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 90,
    tags: ['file', 'edit'],
  });

  reg.register({
    handler: createPatchTool(opts?.security, wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 80,
    tags: ['file', 'patch', 'diff'],
  });

  reg.register({
    handler: createGrepTool(wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 80,
    tags: ['file', 'search', 'grep'],
  });

  reg.register({
    handler: createGlobTool(wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 80,
    tags: ['file', 'glob', 'pattern'],
  });

  reg.register({
    handler: createListDirectoryTool(wp, policy),
    category: BUILTIN_TOOL_CATEGORIES.file,
    priority: 80,
    tags: ['file', 'directory', 'ls'],
  });

  reg.register({
    handler: WebFetchTool,
    category: BUILTIN_TOOL_CATEGORIES.web,
    priority: 70,
    tags: ['web', 'fetch', 'http', 'url'],
  });

  reg.register({
    handler: WebSearchTool,
    category: BUILTIN_TOOL_CATEGORIES.web,
    priority: 70,
    tags: ['web', 'search', 'google'],
  });

  reg.register({
    handler: WebExtractTool,
    category: BUILTIN_TOOL_CATEGORIES.web,
    priority: 70,
    tags: ['web', 'extract', 'scrape'],
  });

  if (opts?.enableBackgroundExec !== false) {
    reg.register({
      handler: createBackgroundExecTool(wp),
      category: BUILTIN_TOOL_CATEGORIES.shell,
      priority: 60,
      tags: ['shell', 'background', 'async'],
    });

    reg.register({
      handler: createProcessTool(),
      category: BUILTIN_TOOL_CATEGORIES.shell,
      priority: 60,
      tags: ['shell', 'process', 'signal'],
    });
  }
}
