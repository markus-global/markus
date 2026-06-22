import { describe, it, expect } from 'vitest';
import { createCodingTools, getAdapter, getAllAdapters } from '../../src/coding-tools/index.js';
import type { MarkusConfig } from '@markus/shared';

describe('coding tools integration', () => {
  it('createCodingTools returns both handlers', () => {
    const tools = createCodingTools();
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name).sort()).toEqual(['coding_tool_apply', 'invoke_coding_tool']);
  });

  it('invoke_coding_tool has valid schema', () => {
    const tools = createCodingTools();
    const invoke = tools.find(t => t.name === 'invoke_coding_tool')!;
    expect(invoke.inputSchema).toHaveProperty('properties.tool');
    expect(invoke.inputSchema).toHaveProperty('properties.prompt');
    expect(invoke.inputSchema).toHaveProperty('properties.workdir');
  });

  it('coding_tool_apply has valid schema', () => {
    const tools = createCodingTools();
    const apply = tools.find(t => t.name === 'coding_tool_apply')!;
    expect(apply.inputSchema).toHaveProperty('properties.session_id');
    expect(apply.inputSchema).toHaveProperty('properties.workdir');
  });

  it('getAdapter and getAllAdapters work from the index', () => {
    const adapter = getAdapter('claude-code');
    expect(adapter.name).toBe('claude-code');
    expect(adapter.binaryName).toBeTruthy();

    const all = getAllAdapters();
    expect(all).toHaveLength(3);
    expect(all.map(a => a.name).sort()).toEqual(['claude-code', 'codex', 'cursor-agent']);
  });

  it('MarkusConfig includes codingTools field', () => {
    const config: MarkusConfig = {
      org: { id: 'default', name: 'Test' },
      llm: { defaultProvider: 'anthropic', defaultModel: 'claude-opus-4-6', providers: {} },
      server: { apiPort: 8056, webPort: 8057 },
      codingTools: {
        enabled: true,
        tools: {
          'claude-code': { enabled: true, timeoutMs: 600_000 },
        },
      },
    };
    expect(config.codingTools?.enabled).toBe(true);
    expect(config.codingTools?.tools?.['claude-code']?.timeoutMs).toBe(600_000);
  });
});
