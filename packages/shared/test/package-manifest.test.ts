import { describe, it, expect } from 'vitest';
import { manifestFilename, buildManifest, readManifest, validateManifest, kebab, isValidPackageSlug, toPackageSlug, ensurePackageSlug, PACKAGE_SLUG_ERROR } from '../src/types/package.js';

describe('manifestFilename', () => {
  it('returns agent.json for agent', () => { expect(manifestFilename('agent')).toBe('agent.json'); });
  it('returns team.json for team', () => { expect(manifestFilename('team')).toBe('team.json'); });
  it('returns skill.json for skill', () => { expect(manifestFilename('skill')).toBe('skill.json'); });
  it('falls back to type.json for unknown', () => { expect(manifestFilename('custom' as any)).toBe('custom.json'); });
});

describe('kebab', () => {
  it('converts spaces to hyphens', () => { expect(kebab('Hello World')).toBe('hello-world'); });
  it('removes non-alphanumeric chars', () => { expect(kebab('My App!')).toBe('my-app'); });
  it('lowercases', () => { expect(kebab('CamelCase')).toBe('camelcase'); });
  it('strips leading/trailing hyphens', () => { expect(kebab('--hello--')).toBe('hello'); });
  it('generates hash slug for non-ASCII', () => {
    const result = kebab('中文名称');
    expect(result).toMatch(/^pkg-[a-z0-9]+$/);
  });
  it('uses fallback when result would be empty', () => {
    expect(kebab('!!!', 'fallback-name')).toBe('fallback-name');
  });
});

describe('isValidPackageSlug / toPackageSlug', () => {
  it('accepts English kebab-case', () => {
    expect(isValidPackageSlug('code-reviewer')).toBe(true);
    expect(isValidPackageSlug('ai')).toBe(true);
    expect(toPackageSlug('My Agent')).toBe('my-agent');
  });
  it('rejects Chinese and empty-after-strip', () => {
    expect(isValidPackageSlug('智库研究团队')).toBe(false);
    expect(toPackageSlug('智库研究团队')).toBeNull();
    expect(toPackageSlug('!!!')).toBeNull();
  });
});

describe('ensurePackageSlug', () => {
  it('keeps valid slugs', () => {
    expect(ensurePackageSlug('code-reviewer')).toEqual({ slug: 'code-reviewer', converted: false });
  });
  it('normalizes spaced ASCII names', () => {
    expect(ensurePackageSlug('My Agent')).toEqual({ slug: 'my-agent', converted: true });
  });
  it('converts Chinese to stable pkg-* slug', () => {
    const a = ensurePackageSlug('智库研究团队');
    const b = ensurePackageSlug('智库研究团队');
    expect(a.converted).toBe(true);
    expect(a.slug).toMatch(/^pkg-[a-z0-9]+$/);
    expect(isValidPackageSlug(a.slug)).toBe(true);
    expect(a.slug).toBe(b.slug);
  });
});

describe('buildManifest', () => {
  it('builds agent manifest from raw data', () => {
    const m = buildManifest('agent', { name: 'My Agent', description: 'desc', version: '2.0.0', author: 'Me', agentRole: 'worker' });
    expect(m.type).toBe('agent');
    expect(m.name).toBe('my-agent');
    expect(m.displayName).toBe('My Agent');
    expect(m.version).toBe('2.0.0');
    expect(m.agent?.agentRole).toBe('worker');
  });

  it('builds team manifest with members', () => {
    const m = buildManifest('team', {
      name: 'Dev Team', description: 'team', version: '1.0.0', author: 'Me',
      team: { members: [{ name: 'Dev', role: 'worker', count: 2 }] },
    });
    expect(m.type).toBe('team');
    expect(m.team?.members.length).toBe(1);
    expect(m.team?.members[0].count).toBe(2);
  });

  it('builds skill manifest', () => {
    const m = buildManifest('skill', {
      name: 'Search Skill', description: 'skill', version: '1.0.0', author: 'Me',
      skill: { skillFile: 'SKILL.md' },
    });
    expect(m.type).toBe('skill');
    expect(m.skill?.skillFile).toBe('SKILL.md');
  });

  it('does not invent pkg-* hash for Chinese name', () => {
    const m = buildManifest('agent', { name: '智库研究团队', displayName: '智库研究团队' });
    expect(m.name).toBe('智库研究团队');
    expect(validateManifest(m)).toContain(PACKAGE_SLUG_ERROR);
  });

  it('handles tags as comma-separated string', () => {
    const m = buildManifest('agent', { name: 'test', tags: 'dev,ops,ai' });
    expect(m.tags).toEqual(['dev', 'ops', 'ai']);
  });

  it('handles author as object with name', () => {
    const m = buildManifest('agent', { name: 'test', author: { name: 'AuthorName' } });
    expect(m.author).toBe('AuthorName');
  });

  it('defaults category to general', () => {
    const m = buildManifest('agent', { name: 'test' });
    expect(m.category).toBe('general');
  });

  it('defaults version to 1.0.0', () => {
    const m = buildManifest('agent', { name: 'test' });
    expect(m.version).toBe('1.0.0');
  });
});

describe('validateManifest', () => {
  it('accepts valid manifest', () => {
    const errors = validateManifest({ type: 'agent', name: 'test', version: '1.0.0', description: 'desc' });
    expect(errors).toEqual([]);
  });

  it('rejects null', () => {
    expect(validateManifest(null)).toContain('Manifest must be a non-null object');
  });

  it('rejects invalid type', () => {
    expect(validateManifest({ type: 'invalid', name: 'ok', version: '1.0.0' }).some(e => e.includes('type'))).toBe(true);
  });

  it('rejects missing name', () => {
    expect(validateManifest({ type: 'agent', version: '1.0.0' }).some(e => e.includes('name'))).toBe(true);
  });

  it('rejects Chinese name', () => {
    expect(validateManifest({ type: 'agent', name: '智库研究团队', version: '1.0.0' })).toContain(PACKAGE_SLUG_ERROR);
  });

  it('rejects non-semver version', () => {
    expect(validateManifest({ type: 'agent', name: 'ok', version: 'latest' }).some(e => e.includes('semver'))).toBe(true);
  });

  it('rejects author as non-string', () => {
    expect(validateManifest({ type: 'agent', name: 'ok', version: '1.0.0', author: 123 }).some(e => e.includes('author'))).toBe(true);
  });

  it('rejects team with empty members', () => {
    expect(validateManifest({ type: 'team', name: 'ok', version: '1.0.0', team: { members: [] } }).some(e => e.includes('members'))).toBe(true);
  });
});

describe('readManifest', () => {
  it('returns null when fs is not provided', () => {
    expect(readManifest('/dir', 'agent')).toBeNull();
  });

  it('reads manifest with mock fs', () => {
    const mockFs = {
      existsSync: (p: string) => p.endsWith('agent.json'),
      readFileSync: () => JSON.stringify({ type: 'agent', name: 'test', version: '1.0.0' }),
      join: (...parts: string[]) => parts.join('/'),
    };
    const m = readManifest('/dir', 'agent', mockFs);
    expect(m).not.toBeNull();
    expect(m!.name).toBe('test');
  });

  it('tries all types when no type specified', () => {
    const calls: string[] = [];
    const mockFs = {
      existsSync: (p: string) => { calls.push(p); return p.endsWith('team.json'); },
      readFileSync: () => JSON.stringify({ type: 'team', name: 'tteam', version: '1.0.0' }),
      join: (...parts: string[]) => parts.join('/'),
    };
    const m = readManifest('/dir', mockFs);
    expect(m).not.toBeNull();
    expect(m!.type).toBe('team');
  });

  it('returns null when no manifest found', () => {
    const mockFs = {
      existsSync: () => false,
      readFileSync: () => '',
      join: (...parts: string[]) => parts.join('/'),
    };
    expect(readManifest('/dir', mockFs)).toBeNull();
  });
});
