import type { AgentToolHandler } from '../agent.js';
import type { PathAccessPolicy } from '@markus/shared';
import { createShellTool, type ShellAgentMeta } from './shell.js';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WebExtractTool } from './web-extract.js';
import { createGrepTool, createGlobTool, createListDirectoryTool } from './search.js';
import { createPatchTool } from './patch.js';
import { createBackgroundExecTool, createProcessTool } from './process-manager.js';
import type { SecurityGuard } from '../security.js';

export interface BuiltinToolsOptions {
  agentId?: string;
  agentMeta?: ShellAgentMeta;
  security?: SecurityGuard;
  workspacePath?: string;
  /** Multi-tier access policy (takes precedence over workspacePath when set) */
  pathPolicy?: PathAccessPolicy;
  enableBackgroundExec?: boolean;
}

export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const policy = opts?.pathPolicy;
  const wp = policy?.primaryWorkspace ?? opts?.workspacePath;

  const tools: AgentToolHandler[] = [
    createShellTool(opts?.security, wp, opts?.agentMeta, policy),
    createFileReadTool(opts?.security, wp, policy),
    createFileWriteTool(opts?.security, wp, policy),
    createFileEditTool(opts?.security, wp, policy),
    createPatchTool(opts?.security, wp, policy),
    createGrepTool(wp, policy),
    createGlobTool(wp, policy),
    createListDirectoryTool(wp, policy),
    WebFetchTool,
    WebSearchTool,
    WebExtractTool,
  ];

  if (opts?.enableBackgroundExec !== false) {
    tools.push(createBackgroundExecTool(wp));
    tools.push(createProcessTool());
  }

  return tools;
}
