import { describe, it, expect } from 'vitest';
import { applyToolPolicy, getToolGroups, getAvailableProfiles } from '../src/tool-profiles.js';
import type { AgentToolHandler } from '../src/agent.js';

function makeTool(name: string): AgentToolHandler {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: async () => '{}',
  };
}

const ALL_TOOLS: AgentToolHandler[] = [
  makeTool('file_read'),
  makeTool('file_write'),
  makeTool('file_edit'),
  makeTool('apply_patch'),
  makeTool('shell_execute'),
  makeTool('background_exec'),
  makeTool('process'),
  makeTool('grep_search'),
  makeTool('glob_find'),
  makeTool('list_directory'),
  makeTool('web_search'),
  makeTool('web_fetch'),
  makeTool('memory_save'),
  makeTool('memory_search'),
  makeTool('memory_list'),
  makeTool('memory_update_longterm'),
  makeTool('message'),
  makeTool('send_message'),
];

describe('Tool Profiles', () => {
  it('full profile should allow all tools', () => {
    const result = applyToolPolicy(ALL_TOOLS, { profile: 'full' });
    expect(result.length).toBe(ALL_TOOLS.length);
  });

  it('coding profile should allow fs, runtime, memory, web but not messaging', () => {
    const result = applyToolPolicy(ALL_TOOLS, { profile: 'coding' });
    const names = result.map(t => t.name);

    expect(names).toContain('file_read');
    expect(names).toContain('shell_execute');
    expect(names).toContain('memory_search');
    expect(names).toContain('web_search');
    expect(names).not.toContain('message');
    expect(names).not.toContain('send_message');
  });

  it('messaging profile should only allow messaging + memory tools', () => {
    const result = applyToolPolicy(ALL_TOOLS, { profile: 'messaging' });
    const names = result.map(t => t.name);

    expect(names).toContain('message');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('file_read');
    expect(names).not.toContain('shell_execute');
  });

  it('minimal profile should only allow memory_search and memory_list', () => {
    const result = applyToolPolicy(ALL_TOOLS, { profile: 'minimal' });
    const names = result.map(t => t.name);

    expect(names).toContain('memory_search');
    expect(names).toContain('memory_list');
    expect(names.length).toBe(2);
  });

  it('deny should override profile allowlist', () => {
    const result = applyToolPolicy(ALL_TOOLS, {
      profile: 'coding',
      deny: ['group:runtime'],
    });
    const names = result.map(t => t.name);

    expect(names).toContain('file_read');
    expect(names).not.toContain('shell_execute');
    expect(names).not.toContain('background_exec');
    expect(names).not.toContain('process');
  });

  it('allow should add to profile', () => {
    const result = applyToolPolicy(ALL_TOOLS, {
      profile: 'messaging',
      allow: ['web_search'],
    });
    const names = result.map(t => t.name);

    expect(names).toContain('message');
    expect(names).toContain('web_search');
  });

  it('no policy should return all tools', () => {
    const result = applyToolPolicy(ALL_TOOLS, {});
    expect(result.length).toBe(ALL_TOOLS.length);
  });

  it('getToolGroups should return non-empty groups', () => {
    const groups = getToolGroups();
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    expect(groups['group:fs']).toContain('file_read');
  });

  it('getAvailableProfiles should list all profiles', () => {
    const profiles = getAvailableProfiles();
    expect(profiles).toContain('full');
    expect(profiles).toContain('coding');
    expect(profiles).toContain('messaging');
    expect(profiles).toContain('minimal');
  });
});
