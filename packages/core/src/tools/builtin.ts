import type { AgentToolHandler } from '../agent.js';
import { ShellTool } from './shell.js';
import { FileReadTool, FileWriteTool } from './file.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';

export function createBuiltinTools(): AgentToolHandler[] {
  return [ShellTool, FileReadTool, FileWriteTool, WebFetchTool, WebSearchTool];
}
