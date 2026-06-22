import type { ToolAdapter, CodingToolName } from '@markus/shared';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAgentAdapter } from './cursor-agent-adapter.js';

const adapters: Record<CodingToolName, () => ToolAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  'cursor-agent': () => new CursorAgentAdapter(),
};

export function getAdapter(name: CodingToolName): ToolAdapter {
  const factory = adapters[name];
  if (!factory) throw new Error(`Unknown coding tool: ${name}`);
  return factory();
}

export function getAllAdapters(): ToolAdapter[] {
  return Object.values(adapters).map((f) => f());
}

export { ClaudeCodeAdapter, CodexAdapter, CursorAgentAdapter };
