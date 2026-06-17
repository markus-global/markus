import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemorySkillRegistry } from '../src/skills/registry.js';
import { discoverSkillsInDir, createDefaultSkillRegistry, WELL_KNOWN_SKILL_DIRS } from '../src/skills/index.js';
import { resolveMcpServerPaths } from '../src/skills/loader.js';
import type { SkillManifest } from '../src/skills/types.js';

vi.mock('../src/skills/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/skills/index.js')>();
  return { ...actual, WELL_KNOWN_SKILL_DIRS: [] };
});

const TEST_DIR = join(tmpdir(), `markus-skills-test-${Date.now()}`);

function writeMarkusSkill(
  dir: string,
  name: string,
  extra: Record<string, unknown> = {},
  skillMd?: string,
) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'skill.json'),
    JSON.stringify({
      type: 'skill',
      name,
      version: '1.0.0',
      description: `Skill ${name}`,
      author: 'test',
      category: 'development',
      tags: ['test'],
      ...extra,
    }),
  );
  if (skillMd) {
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
  }
  return skillDir;
}

function writeClaudeSkill(dir: string, name: string, content: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

describe('InMemorySkillRegistry', () => {
  let registry: InMemorySkillRegistry;

  const baseManifest = (overrides: Partial<SkillManifest> = {}): SkillManifest => ({
    name: 'test-skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'test',
    category: 'development',
    instructions: 'Do the thing.',
    ...overrides,
  });

  beforeEach(() => {
    registry = new InMemorySkillRegistry();
  });

  it('registers, gets, lists, and unregisters skills', () => {
    registry.register({ manifest: baseManifest() });
    expect(registry.get('test-skill')?.manifest.description).toBe('A test skill');
    expect(registry.list()).toHaveLength(1);
    registry.unregister('test-skill');
    expect(registry.get('test-skill')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('overwrites skill on duplicate register', () => {
    registry.register({ manifest: baseManifest({ description: 'v1' }) });
    registry.register({ manifest: baseManifest({ description: 'v2' }) });
    expect(registry.get('test-skill')?.manifest.description).toBe('v2');
    expect(registry.list()).toHaveLength(1);
  });

  it('resolves skills by kebab-case alias', () => {
    registry.register({ manifest: baseManifest({ name: 'My Cool Skill' }) });
    expect(registry.get('my-cool-skill')?.manifest.name).toBe('My Cool Skill');
  });

  it('returns instructions for requested skills only', () => {
    registry.register({ manifest: baseManifest({ name: 'a', instructions: 'A instructions' }) });
    registry.register({ manifest: baseManifest({ name: 'b', instructions: 'B instructions' }) });
    registry.register({ manifest: baseManifest({ name: 'c', instructions: undefined }) });

    const map = registry.getInstructionsForSkills(['a', 'c', 'missing']);
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe('A instructions');
  });

  it('returns builtin always-on instructions', () => {
    registry.register({
      manifest: baseManifest({
        name: 'always-on',
        builtIn: true,
        alwaysOn: true,
        instructions: 'Always injected',
      }),
    });
    registry.register({
      manifest: baseManifest({
        name: 'catalog-only',
        builtIn: true,
        alwaysOn: false,
        instructions: 'Listed only',
      }),
    });

    const alwaysOn = registry.getBuiltinInstructions();
    expect(alwaysOn.get('always-on')).toBe('Always injected');
    expect(alwaysOn.has('catalog-only')).toBe(false);
  });

  it('builds builtin and full skill catalogs excluding alwaysOn', () => {
    registry.register({
      manifest: baseManifest({ name: 'builtin-catalog', builtIn: true, category: 'devops' }),
    });
    registry.register({
      manifest: baseManifest({ name: 'always-on', builtIn: true, alwaysOn: true }),
    });
    registry.register({
      manifest: baseManifest({ name: 'installed', category: 'custom' }),
    });

    const builtinCatalog = registry.getBuiltinSkillCatalog();
    expect(builtinCatalog.map(c => c.name)).toEqual(['builtin-catalog']);

    const fullCatalog = registry.getSkillCatalog();
    expect(fullCatalog.map(c => c.name).sort()).toEqual(['builtin-catalog', 'installed']);
  });
});

describe('resolveMcpServerPaths', () => {
  it('replaces ${SKILL_DIR} in args and env', () => {
    const skillDir = '/skills/my-skill';
    const resolved = resolveMcpServerPaths(
      {
        browser: {
          command: 'node',
          args: ['${SKILL_DIR}/server.js', '--dir=${SKILL_DIR}'],
          env: { ROOT: '${SKILL_DIR}' },
        },
      },
      skillDir,
    );

    expect(resolved?.browser.args).toEqual(['/skills/my-skill/server.js', '--dir=/skills/my-skill']);
    expect(resolved?.browser.env?.ROOT).toBe('/skills/my-skill');
  });

  it('returns undefined when servers are undefined', () => {
    expect(resolveMcpServerPaths(undefined, '/tmp')).toBeUndefined();
  });
});

describe('discoverSkillsInDir', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('discovers Markus manifest.json skills with SKILL.md instructions', () => {
    writeMarkusSkill(
      TEST_DIR,
      'markus-skill',
      { skill: { requiredPermissions: ['shell'], alwaysOn: true } },
      '---\nname: markus-skill\n---\n\nRun commands safely.',
    );

    const found = discoverSkillsInDir(TEST_DIR);
    expect(found).toHaveLength(1);
    expect(found[0].manifest.name).toBe('markus-skill');
    expect(found[0].manifest.instructions).toContain('Run commands safely');
    expect(found[0].manifest.requiredPermissions).toEqual(['shell']);
    expect(found[0].manifest.alwaysOn).toBe(true);
  });

  it('discovers Claude Code SKILL.md format', () => {
    writeClaudeSkill(
      TEST_DIR,
      'claude-skill',
      '---\nname: claude-skill\ndescription: From Claude format\n---\n\nClaude instructions here.',
    );

    const found = discoverSkillsInDir(TEST_DIR);
    expect(found).toHaveLength(1);
    expect(found[0].manifest.name).toBe('claude-skill');
    expect(found[0].manifest.description).toBe('From Claude format');
    expect(found[0].manifest.instructions).toContain('Claude instructions here');
    expect(found[0].manifest.author).toBe('community');
  });

  it('parses SKILL.md without frontmatter using directory name', () => {
    writeClaudeSkill(TEST_DIR, 'no-frontmatter', '# Raw instructions\n\nNo YAML header.');

    const found = discoverSkillsInDir(TEST_DIR);
    expect(found).toHaveLength(1);
    expect(found[0].manifest.name).toBe('no-frontmatter');
    expect(found[0].manifest.instructions).toContain('Raw instructions');
  });

  it('returns empty array for missing directory', () => {
    expect(discoverSkillsInDir('/nonexistent/skills-dir')).toEqual([]);
  });

  it('skips non-directory entries', () => {
    writeFileSync(join(TEST_DIR, 'not-a-skill.txt'), 'ignore me');
    writeMarkusSkill(TEST_DIR, 'valid-skill');
    expect(discoverSkillsInDir(TEST_DIR)).toHaveLength(1);
  });
});

describe('createDefaultSkillRegistry', () => {
  const customDir = join(TEST_DIR, 'custom-skills');

  beforeEach(() => {
    mkdirSync(customDir, { recursive: true });
    writeMarkusSkill(customDir, 'custom-skill', {}, '# Custom skill body');
  });

  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('loads skills from extraSkillDirs and marks them built-in', async () => {
    const registry = await createDefaultSkillRegistry({ extraSkillDirs: [customDir] });
    const skill = registry.get('custom-skill');
    expect(skill?.manifest.builtIn).toBe(true);
    expect(skill?.manifest.instructions).toContain('Custom skill body');
    expect(registry.getSkillCatalog().some(c => c.name === 'custom-skill')).toBe(true);
  });

  it('skips duplicate skill names from later directories', async () => {
    const dupDir = join(TEST_DIR, 'dup-skills');
    mkdirSync(dupDir, { recursive: true });
    writeMarkusSkill(customDir, 'shared-name');
    writeMarkusSkill(dupDir, 'shared-name', { description: 'Second copy' });

    const registry = await createDefaultSkillRegistry({
      extraSkillDirs: [customDir, dupDir],
    });
    expect(registry.get('shared-name')?.manifest.description).toBe('Skill shared-name');
  });
});
