import type { AgentToolHandler } from '../agent.js';
import { createShellTool, type ShellAgentMeta } from './shell.js';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WebExtractTool } from './web-extract.js';
import { createGrepTool, createGlobTool, createListDirectoryTool } from './search.js';
import { createPatchTool } from './patch.js';
import { createBackgroundExecTool, createProcessTool } from './process-manager.js';
import { createGUITool } from './gui.js';
import type { SecurityGuard } from '../security.js';

export interface BuiltinToolsOptions {
  agentId?: string;
  agentMeta?: ShellAgentMeta;
  security?: SecurityGuard;
  workspacePath?: string;
  enableGUI?: boolean;
  enableBackgroundExec?: boolean;
  guiConfig?: {
    containerId?: string;
    display?: string;
    debug?: boolean;
  };
}

export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const tools: AgentToolHandler[] = [
    createShellTool(opts?.security, opts?.workspacePath, opts?.agentMeta),
    createFileReadTool(opts?.security, opts?.workspacePath),
    createFileWriteTool(opts?.security, opts?.workspacePath),
    createFileEditTool(opts?.security, opts?.workspacePath),
    createPatchTool(opts?.security, opts?.workspacePath),
    createGrepTool(opts?.workspacePath),
    createGlobTool(opts?.workspacePath),
    createListDirectoryTool(opts?.workspacePath),
    WebFetchTool,
    WebSearchTool,
    WebExtractTool,
  ];

  if (opts?.enableBackgroundExec !== false) {
    tools.push(createBackgroundExecTool(opts?.workspacePath));
    tools.push(createProcessTool());
  }

  if (opts?.enableGUI !== false) {
    const guiTool = createGUITool(opts?.guiConfig);
    tools.push(guiTool);
  }

  return tools;
}
