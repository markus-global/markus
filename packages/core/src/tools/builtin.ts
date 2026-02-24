import type { AgentToolHandler } from '../agent.js';
import { createShellTool } from './shell.js';
import { createFileReadTool, createFileWriteTool, createFileEditTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { createTodoWriteTool, createTodoReadTool } from './todo.js';
import type { SecurityGuard } from '../security.js';

export interface BuiltinToolsOptions {
  agentId?: string;
  security?: SecurityGuard;
}

export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const agentId = opts?.agentId ?? 'default';
  return [
    createShellTool(opts?.security),
    createFileReadTool(opts?.security),
    createFileWriteTool(opts?.security),
    createFileEditTool(opts?.security),
    WebFetchTool,
    WebSearchTool,
    createTodoWriteTool(agentId),
    createTodoReadTool(agentId),
  ];
}
