import type { AgentToolHandler } from '../agent.js';
import { createInvokeCodingToolHandler, createCodingToolApplyHandler, type CodingToolHandlerOptions } from './handlers.js';

export { CodingToolRuntime } from './runtime.js';
export { injectContext } from './context-injector.js';
export { detectProjectType, runTests } from './quality-verifier.js';
export { getAdapter, getAllAdapters } from './adapters/index.js';
export { ClaudeCodeAdapter, CodexAdapter, CursorAgentAdapter } from './adapters/index.js';
export type { CodingToolHandlerOptions } from './handlers.js';

export function createCodingTools(options?: CodingToolHandlerOptions): AgentToolHandler[] {
  return [createInvokeCodingToolHandler(options), createCodingToolApplyHandler()];
}
