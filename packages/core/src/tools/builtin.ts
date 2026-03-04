import type { AgentToolHandler } from '../agent.js';
import { createShellTool } from './shell.js';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { createGUITool } from './gui.js';
import type { SecurityGuard } from '../security.js';

export interface BuiltinToolsOptions {
  agentId?: string;
  security?: SecurityGuard;
  workspacePath?: string;
  enableGUI?: boolean;
  guiConfig?: {
    containerId?: string;
    display?: string;
    debug?: boolean;
  };
}

export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const tools: AgentToolHandler[] = [
    createShellTool(opts?.security, opts?.workspacePath),
    createFileReadTool(opts?.security, opts?.workspacePath),
    createFileWriteTool(opts?.security, opts?.workspacePath),
    createFileEditTool(opts?.security, opts?.workspacePath),
    WebFetchTool,
    WebSearchTool,
  ];

  // 如果启用了GUI，添加GUI工具
  if (opts?.enableGUI !== false) {
    const guiTool = createGUITool(opts?.guiConfig);
    tools.push(guiTool);
  }

  return tools;
}
