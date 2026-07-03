import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySkillRegistry } from '../src/skills/registry.js';
import { findSkillsProvidingTool } from '../src/skills/index.js';
import type { SkillManifest, SkillInstance } from '../src/skills/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillManifest(overrides: Partial<SkillManifest> & { name: string }): SkillManifest {
  return {
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    description: overrides.description ?? `Skill ${overrides.name}`,
    author: overrides.author ?? 'test',
    category: overrides.category ?? 'development',
    tags: overrides.tags ?? [],
    instructions: overrides.instructions,
    mcpServers: overrides.mcpServers,
    providesTools: overrides.providesTools,
    builtIn: overrides.builtIn,
    alwaysOn: overrides.alwaysOn,
    sourcePath: overrides.sourcePath,
  };
}

function makeSkillInstance(overrides: Partial<SkillManifest> & { name: string }): SkillInstance {
  return { manifest: makeSkillManifest(overrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillManifest — providesTools field', () => {

  it('can have a providesTools field with tool names', () => {
    const manifest: SkillManifest = {
      name: 'chrome-devtools',
      version: '1.0.0',
      description: 'Browser automation',
      author: 'markus',
      category: 'browser',
      providesTools: ['browser_navigate', 'browser_click', 'browser_type'],
    };
    expect(manifest.providesTools).toBeDefined();
    expect(manifest.providesTools!.length).toBe(3);
    expect(manifest.providesTools!).toContain('browser_navigate');
    expect(manifest.providesTools!).toContain('browser_click');
    expect(manifest.providesTools!).toContain('browser_type');
  });

  it('is optional — SkillManifest without providesTools is valid', () => {
    const manifest: SkillManifest = {
      name: 'my-skill',
      version: '1.0.0',
      description: 'A skill without providesTools',
      author: 'test',
      category: 'custom',
    };
    expect(manifest.providesTools).toBeUndefined();
  });

  it('can be an empty array', () => {
    const manifest: SkillManifest = {
      name: 'empty-skill',
      version: '1.0.0',
      description: 'Skill with empty providesTools',
      author: 'test',
      category: 'custom',
      providesTools: [],
    };
    expect(manifest.providesTools).toEqual([]);
  });
});

describe('findSkillsProvidingTool', () => {

  it('returns skill names when a match is found', () => {
    const manifests: SkillManifest[] = [
      makeSkillManifest({ name: 'chrome', providesTools: ['browser_navigate', 'browser_click'] }),
      makeSkillManifest({ name: 'node', providesTools: ['shell_execute'] }),
    ];
    const result = findSkillsProvidingTool(manifests, 'browser_navigate');
    expect(result).toEqual(['chrome']);
  });

  it('returns empty array when no skill provides the tool', () => {
    const manifests: SkillManifest[] = [
      makeSkillManifest({ name: 'chrome', providesTools: ['browser_navigate'] }),
    ];
    const result = findSkillsProvidingTool(manifests, 'unknown_tool');
    expect(result).toEqual([]);
  });

  it('returns empty array when no skills have providesTools', () => {
    const manifests: SkillManifest[] = [
      makeSkillManifest({ name: 'plain-skill' }),
    ];
    const result = findSkillsProvidingTool(manifests, 'any_tool');
    expect(result).toEqual([]);
  });

  it('returns empty array when manifests array is empty', () => {
    const result = findSkillsProvidingTool([], 'any_tool');
    expect(result).toEqual([]);
  });

  it('returns multiple skill names when multiple skills provide the same tool', () => {
    const manifests: SkillManifest[] = [
      makeSkillManifest({ name: 'skill-a', providesTools: ['shared_tool'] }),
      makeSkillManifest({ name: 'skill-b', providesTools: ['shared_tool', 'other_tool'] }),
      makeSkillManifest({ name: 'skill-c', providesTools: ['different_tool'] }),
    ];
    const result = findSkillsProvidingTool(manifests, 'shared_tool');
    expect(result).toHaveLength(2);
    expect(result).toContain('skill-a');
    expect(result).toContain('skill-b');
    expect(result).not.toContain('skill-c');
  });

  it('is case-insensitive (tool names are compared in lowercase)', () => {
    const manifests: SkillManifest[] = [
      makeSkillManifest({ name: 'skill', providesTools: ['Browser_Navigate'] }),
    ];
    // Both lowercase and mixed-case variants match because findSkillsProvidingTool
    // normalizes both sides to lowercase
    expect(findSkillsProvidingTool(manifests, 'browser_navigate')).toEqual(['skill']);
    expect(findSkillsProvidingTool(manifests, 'Browser_Navigate')).toEqual(['skill']);
    expect(findSkillsProvidingTool(manifests, 'BROWSER_NAVIGATE')).toEqual(['skill']);
  });
});

describe('findSkillsProvidingTool with InMemorySkillRegistry', () => {

  let registry: InMemorySkillRegistry;

  beforeEach(() => {
    registry = new InMemorySkillRegistry();
    registry.register(makeSkillInstance({
      name: 'chrome-devtools',
      providesTools: ['browser_navigate', 'browser_click', 'browser_snapshot'],
    }));
    registry.register(makeSkillInstance({
      name: 'shell-tools',
      providesTools: ['shell_execute', 'shell_script'],
    }));
  });

  it('finds tools across registered skills', () => {
    const result = findSkillsProvidingTool(registry.list(), 'browser_navigate');
    expect(result).toEqual(['chrome-devtools']);
  });

  it('returns empty when tool is not provided by any registered skill', () => {
    const result = findSkillsProvidingTool(registry.list(), 'file_read');
    expect(result).toEqual([]);
  });

  it('finds tool from second skill', () => {
    const result = findSkillsProvidingTool(registry.list(), 'shell_execute');
    expect(result).toEqual(['shell-tools']);
  });
});

describe('SkillRegistry — providesTools stored and listed', () => {

  it('stores providesTools when registering a skill', () => {
    const registry = new InMemorySkillRegistry();
    registry.register(makeSkillInstance({
      name: 'test-skill',
      providesTools: ['tool_a', 'tool_b'],
    }));
    const manifests = registry.list();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.providesTools).toEqual(['tool_a', 'tool_b']);
  });

  it('includes providesTools in list() output', () => {
    const registry = new InMemorySkillRegistry();
    registry.register(makeSkillInstance({
      name: 'skill-a',
      providesTools: ['alpha'],
    }));
    registry.register(makeSkillInstance({
      name: 'skill-b',
      providesTools: ['beta'],
    }));
    registry.register(makeSkillInstance({
      name: 'skill-c',
      // no providesTools
    }));
    const manifests = registry.list();
    const a = manifests.find(m => m.name === 'skill-a');
    const b = manifests.find(m => m.name === 'skill-b');
    const c = manifests.find(m => m.name === 'skill-c');
    expect(a?.providesTools).toEqual(['alpha']);
    expect(b?.providesTools).toEqual(['beta']);
    expect(c?.providesTools).toBeUndefined();
  });

  it('survives unregister and re-register', () => {
    const registry = new InMemorySkillRegistry();
    const inst = makeSkillInstance({ name: 'temp', providesTools: ['temp_tool'] });
    registry.register(inst);
    expect(findSkillsProvidingTool(registry.list(), 'temp_tool')).toEqual(['temp']);

    registry.unregister('temp');
    expect(findSkillsProvidingTool(registry.list(), 'temp_tool')).toEqual([]);

    registry.register(makeSkillInstance({ name: 'temp', providesTools: ['temp_tool'] }));
    expect(findSkillsProvidingTool(registry.list(), 'temp_tool')).toEqual(['temp']);
  });
});

describe('chrome-devtools skill.json — providesTools present', () => {

  it('has the correct providesTools in the template', () => {
    // This test validates that the chrome-devtools template skill.json
    // includes providesTools for L2 progressive loading
    const fs = require('node:fs');
    const path = require('node:path');
    const skillJsonPath = path.resolve(
      __dirname, '..', '..', '..', 'templates', 'skills', 'chrome-devtools', 'skill.json',
    );
    const content = JSON.parse(fs.readFileSync(skillJsonPath, 'utf-8'));
    expect(content.skill.providesTools).toBeDefined();
    expect(Array.isArray(content.skill.providesTools)).toBe(true);
    expect(content.skill.providesTools).toContain('browser_navigate');
    expect(content.skill.providesTools).toContain('browser_snapshot');
    expect(content.skill.providesTools).toContain('browser_click');
    expect(content.skill.providesTools).toContain('browser_type');
    expect(content.skill.providesTools).toContain('browser_evaluate');
  });
});
