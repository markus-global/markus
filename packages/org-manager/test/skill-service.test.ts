import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  searchSkillHub,
  searchSkillsSh,
  searchRegistries,
  installSkill,
} from '../src/skill-service.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => String(p).includes('templates/skills/builtin-skill') || String(p).includes('skill.json')),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ name: 'test-skill', version: '1.0.0' })),
    readdirSync: vi.fn(() => ['SKILL.md']),
    copyFileSync: vi.fn(),
  };
});

vi.mock('@markus/core', () => ({
  discoverSkillsInDir: vi.fn(() => [{ manifest: { name: 'test-skill' }, path: '/tmp/skills/test-skill' }]),
}));

describe('skill-service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('searchSkillHub filters and caches results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        skills: [
          { slug: 'alpha', name: 'Alpha Skill', description: 'A', description_zh: 'Alpha', version: '1.0', homepage: 'https://x', tags: [], downloads: 1, stars: 1, installs: 10, score: 90 },
          { slug: 'beta', name: 'Beta', description: 'B', version: '1.0', homepage: 'https://y', tags: [], downloads: 1, stars: 1, installs: 5, score: 50 },
        ],
      }),
    });
    const results = await searchSkillHub('alpha');
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('Alpha Skill');
    await searchSkillHub('alpha');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('searchSkillHub returns empty on fetch failure', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    expect(await searchSkillHub('q')).toEqual([]);
  });

  it('searchSkillsSh parses HTML and fetches descriptions', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<a href="/author/repo/skill-a"><h3>Skill A</h3><span class="font-mono text-sm">1.2K</span></a>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<p class="text-muted">Skill description here</p>',
      });
    const results = await searchSkillsSh('skill');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.githubRepo).toBe('author/repo');
  });

  it('searchRegistries merges both sources', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ skills: [{ slug: 'a', name: 'A', description: 'd', version: '1', homepage: 'h', tags: [], downloads: 0, stars: 0, installs: 0, score: 1 }] }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    const merged = await searchRegistries('a');
    expect(merged.length).toBeGreaterThan(0);
  });

  it('installSkill via github skillssh source', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '# Skill content' });
    const result = await installSkill({
      name: 'remote-skill',
      source: 'skillssh',
      githubRepo: 'author/repo',
      githubSkillPath: 'skills/remote',
    });
    expect(result.installed).toBe(true);
    expect(result.method).toContain('github');
  });

  it('installSkill via skillhub zip', async () => {
    const { execSync } = await import('node:child_process');
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.mocked(execSync).mockReturnValue('' as never);
    const result = await installSkill({
      name: 'hub-skill',
      source: 'skillhub',
      slug: 'hub-skill',
    });
    expect(result.installed).toBe(true);
  });

  it('installSkill throws when all strategies fail', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await expect(installSkill({ name: 'missing-skill', source: 'skillhub', slug: 'missing' }))
      .rejects.toThrow(/Download failed/);
  });
});
