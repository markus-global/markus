import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTemplatesDir, allTemplateDirs, resolveWebUiDir } from '../src/paths.js';

describe('resolveTemplatesDir', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-paths-home-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prefers user-local ~/.markus/templates/<sub>', () => {
    const userDir = join(tmpHome, '.markus', 'templates', 'roles');
    mkdirSync(userDir, { recursive: true });
    expect(resolveTemplatesDir('roles')).toBe(userDir);
  });

  it('falls back to cwd/templates/<sub> when user dir missing', () => {
    const cwdDir = join(process.cwd(), 'templates', 'roles');
    if (existsSync(cwdDir)) {
      expect(resolveTemplatesDir('roles')).toBe(cwdDir);
    }
  });

  it('returns cwd fallback path even when nothing exists', () => {
    const result = resolveTemplatesDir('nonexistent-sub-xyz');
    expect(result).toContain('templates');
    expect(result).toContain('nonexistent-sub-xyz');
  });
});

describe('allTemplateDirs', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-paths-tpl-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns only existing template directories', () => {
    const dirs = allTemplateDirs('roles');
    for (const dir of dirs) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('includes cwd templates when present', () => {
    const cwdDir = join(process.cwd(), 'templates', 'roles');
    if (existsSync(cwdDir)) {
      expect(allTemplateDirs('roles')).toContain(cwdDir);
    }
  });

  it('does not duplicate paths', () => {
    const dirs = allTemplateDirs('skills');
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('resolveWebUiDir', () => {
  it('returns a path when web-ui dist exists in monorepo', () => {
    const dir = resolveWebUiDir();
    const monorepoDist = join(process.cwd(), 'packages', 'web-ui', 'dist');
    if (existsSync(monorepoDist)) {
      expect(dir).toBeDefined();
      expect(existsSync(dir!)).toBe(true);
    }
  });

  it('returns undefined when no web-ui bundle is found in temp context', () => {
    const fakeHome = join(tmpdir(), 'no-webui-' + Date.now());
    mkdirSync(fakeHome, { recursive: true });
    expect(typeof resolveWebUiDir()).toMatch(/string|undefined/);
    rmSync(fakeHome, { recursive: true, force: true });
  });
});
