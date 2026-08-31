import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { categorizeTools, TOOL_CATEGORY_DEF } from './toolCategories.ts';
import type { AgentToolInfo } from '../api.ts';

// Minimal t() that returns the last segment of the dotted key (category ids).
const stubT = ((key: string, opts?: Record<string, unknown>): string => {
  if (key === 'agent:toolCategories.mcp') {
    return `MCP:${(opts as { server?: string })?.server ?? ''}`;
  }
  return key.split('.').pop()!;
}) as unknown as TFunction;

function tool(name: string): AgentToolInfo {
  return { name, description: name };
}

describe('categorizeTools', () => {
  it('groups platform tools into their proper categories (not 其他)', () => {
    const tools = [
      'file_read', 'shell_execute', 'web_fetch', 'generate_image',
      'describe_image', 'upload_reference', 'task_create', 'requirement_propose',
      'deliverable_create', 'spawn_subagent', 'spawn_subagents', 'memory_save',
      'session', 'agent_send_message', 'llm_list_providers', 'agent_model_get',
      'list_teams', 'goal_create', 'check_mailbox', 'discover_tools',
    ].map(tool);

    const groups = categorizeTools(tools, stubT);

    // Collect { toolId -> category }
    const byCategory = new Map<string, string[]>();
    for (const g of groups) byCategory.set(g.category, g.tools.map(x => x.name));

    const catOf = (n: string): string | undefined =>
      [...byCategory.entries()].find(([, names]) => names.includes(n))?.[0];

    expect(catOf('file_read')).toBe('files');
    expect(catOf('shell_execute')).toBe('runtime');
    expect(catOf('web_fetch')).toBe('web');
    expect(catOf('generate_image')).toBe('multimodal');
    // Previously fell into 其他:
    expect(catOf('describe_image')).toBe('multimodal');
    expect(catOf('upload_reference')).toBe('multimodal');
    expect(catOf('task_create')).toBe('tasks');
    expect(catOf('requirement_propose')).toBe('requirements');
    expect(catOf('deliverable_create')).toBe('deliverables');
    expect(catOf('spawn_subagent')).toBe('subagents');
    expect(catOf('spawn_subagents')).toBe('subagents');
    expect(catOf('memory_save')).toBe('memory');
    expect(catOf('session')).toBe('memory');
    expect(catOf('agent_send_message')).toBe('communication');
    expect(catOf('llm_list_providers')).toBe('llm');
    expect(catOf('agent_model_get')).toBe('llm');
    expect(catOf('list_teams')).toBe('teamManager');
    expect(catOf('goal_create')).toBe('planning');
    expect(catOf('check_mailbox')).toBe('mailbox');
    expect(catOf('discover_tools')).toBe('system');

    // None of these known platform tools should be in 其他.
    const other = byCategory.get('other') ?? [];
    expect(other).toHaveLength(0);
  });

  it('groups MCP namespaced tools under their server, and unknown ones to 其他', () => {
    const groups = categorizeTools([
      tool('feishu-bitable__record_create'),
      tool('chrome-devtools__navigate'),
      tool('completely_custom_third_party_tool'),
    ], stubT);

    const byCategory = new Map<string, string[]>();
    for (const g of groups) byCategory.set(g.category, g.tools.map(x => x.name));

    expect(byCategory.get('MCP:feishu-bitable')).toContain('feishu-bitable__record_create');
    expect(byCategory.get('MCP:chrome-devtools')).toContain('chrome-devtools__navigate');
    expect(byCategory.get('other')).toContain('completely_custom_third_party_tool');
  });

  it('every category id in TOOL_CATEGORY_DEF is distinct/assignable and has prefixes', () => {
    const ids = TOOL_CATEGORY_DEF.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of TOOL_CATEGORY_DEF) {
      expect(d.prefixes.length).toBeGreaterThan(0);
    }
  });
});
