import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillLoader, createStubToolsFromManifest } from '../src/skills/loader.js';
import type { SkillManifest } from '../src/skills/types.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `markus-skill-loader-test-${Date.now()}`);

function createTestSkill(name: string, manifest: Partial<SkillManifest> = {}): string {
  const skillDir = join(TEST_DIR, name);
  mkdirSync(skillDir, { recursive: true });

  const fullManifest: SkillManifest = {
    name,
    version: '1.0.0',
    description: `Test skill: ${name}`,
    author: 'test',
    category: 'development',
    tools: [{ name: `${name}_tool`, description: 'A test tool', inputSchema: { type: 'object' } }],
    ...manifest,
  };

  writeFileSync(join(skillDir, 'manifest.json'), JSON.stringify(fullManifest, null, 2));
  writeFileSync(join(skillDir, 'README.md'), `# ${name}\nTest skill readme`);
  return skillDir;
}

describe('SkillLoader', () => {
  let loader: SkillLoader;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    loader = new SkillLoader([TEST_DIR]);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('discoverSkills', () => {
    it('should discover skills from directory', () => {
      createTestSkill('my-skill');
      createTestSkill('another-skill');

      const packages = loader.discoverSkills();
      expect(packages).toHaveLength(2);
      expect(packages.map(p => p.manifest.name).sort()).toEqual(['another-skill', 'my-skill']);
    });

    it('should read README files', () => {
      createTestSkill('readme-skill');
      const packages = loader.discoverSkills();
      expect(packages[0].readme).toContain('readme-skill');
    });

    it('should skip directories without manifest.json', () => {
      createTestSkill('valid-skill');
      mkdirSync(join(TEST_DIR, 'no-manifest'), { recursive: true });

      const packages = loader.discoverSkills();
      expect(packages).toHaveLength(1);
      expect(packages[0].manifest.name).toBe('valid-skill');
    });

    it('should skip invalid manifests', () => {
      createTestSkill('valid');
      const invalidDir = join(TEST_DIR, 'invalid');
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(join(invalidDir, 'manifest.json'), JSON.stringify({ name: 'INVALID NAME!' }));

      const packages = loader.discoverSkills();
      expect(packages).toHaveLength(1);
    });

    it('should handle non-existent directory gracefully', () => {
      const loader2 = new SkillLoader(['/nonexistent/path']);
      const packages = loader2.discoverSkills();
      expect(packages).toHaveLength(0);
    });
  });

  describe('validateManifest', () => {
    it('should validate a correct manifest', () => {
      const result = loader.validateManifest({
        name: 'valid-skill',
        version: '1.0.0',
        description: 'A valid skill',
        author: 'test',
        category: 'development',
        tools: [{ name: 'tool1', description: 'A tool', inputSchema: {} }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing name', () => {
      const result = loader.validateManifest({
        name: '',
        version: '1.0.0',
        description: 'A skill',
        author: 'test',
        category: 'development',
        tools: [{ name: 'tool1', description: 'A tool', inputSchema: {} }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('name is required');
    });

    it('should reject invalid name format', () => {
      const result = loader.validateManifest({
        name: 'Invalid Name!',
        version: '1.0.0',
        description: 'A skill',
        author: 'test',
        category: 'development',
        tools: [{ name: 'tool1', description: 'A tool', inputSchema: {} }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('lowercase'))).toBe(true);
    });

    it('should reject invalid semver', () => {
      const result = loader.validateManifest({
        name: 'test',
        version: 'v1',
        description: 'A skill',
        author: 'test',
        category: 'development',
        tools: [{ name: 'tool1', description: 'A tool', inputSchema: {} }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('semver'))).toBe(true);
    });

    it('should require at least one tool', () => {
      const result = loader.validateManifest({
        name: 'test',
        version: '1.0.0',
        description: 'A skill',
        author: 'test',
        category: 'development',
        tools: [],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('permissions and env', () => {
    it('should check permissions', () => {
      const manifest: SkillManifest = {
        name: 'test', version: '1.0.0', description: 'test', author: 'test',
        category: 'development', tools: [{ name: 't', description: 't', inputSchema: {} }],
        requiredPermissions: ['shell', 'network'],
      };
      const result = loader.checkPermissions(manifest, ['shell']);
      expect(result.allowed).toBe(false);
      expect(result.missing).toEqual(['network']);
    });

    it('should pass when all permissions granted', () => {
      const manifest: SkillManifest = {
        name: 'test', version: '1.0.0', description: 'test', author: 'test',
        category: 'development', tools: [{ name: 't', description: 't', inputSchema: {} }],
        requiredPermissions: ['shell'],
      };
      const result = loader.checkPermissions(manifest, ['shell', 'file', 'network']);
      expect(result.allowed).toBe(true);
    });

    it('should check env requirements', () => {
      const manifest: SkillManifest = {
        name: 'test', version: '1.0.0', description: 'test', author: 'test',
        category: 'development', tools: [{ name: 't', description: 't', inputSchema: {} }],
        requiredEnv: ['NONEXISTENT_VAR_12345'],
      };
      const result = loader.checkEnvRequirements(manifest);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toEqual(['NONEXISTENT_VAR_12345']);
    });
  });

  describe('searchSkills', () => {
    it('should search by text', () => {
      createTestSkill('git-helper', { description: 'Git operations helper', tags: ['git'] });
      createTestSkill('browser-tool', { description: 'Browser automation', tags: ['browser'] });
      loader.discoverSkills();

      const result = loader.searchSkills({ text: 'git' });
      expect(result.total).toBe(1);
      expect(result.manifests[0].name).toBe('git-helper');
    });

    it('should search by category', () => {
      createTestSkill('dev-skill', { category: 'development' });
      createTestSkill('ops-skill', { category: 'devops' });
      loader.discoverSkills();

      const result = loader.searchSkills({ category: 'devops' });
      expect(result.total).toBe(1);
      expect(result.manifests[0].name).toBe('ops-skill');
    });

    it('should search by tags', () => {
      createTestSkill('tagged', { tags: ['automation', 'ci'] });
      createTestSkill('untagged');
      loader.discoverSkills();

      const result = loader.searchSkills({ tags: ['ci'] });
      expect(result.total).toBe(1);
    });
  });
});

describe('createStubToolsFromManifest', () => {
  it('should create stub tools with error messages', async () => {
    const manifest: SkillManifest = {
      name: 'test-skill', version: '1.0.0', description: 'test', author: 'test',
      category: 'development',
      tools: [
        { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
        { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object' } },
      ],
    };

    const tools = createStubToolsFromManifest(manifest);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('tool_a');

    const result = JSON.parse(await tools[0].execute({}));
    expect(result.error).toContain('no implementation loaded');
  });
});
