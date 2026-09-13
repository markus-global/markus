import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTemplatesDir, allTemplateDirs, resolveWebUiDir } from '../src/paths.js';

// 外部环境可能设置 MARKUS_TEMPLATES_DIR（例如桌面版运行时注入的模板目录）。
// 它会让 resolveTemplatesDir 的 envDir 分支恒命中，导致「user-local / cwd 优先」
// 的断言在任何装有桌面版的机器上都失败——测试必须清理。
// 每个 vitest worker 是独立进程，模块级 delete 即可（不要在 afterEach 恢复，
// 否则第一个测试后 env 又变回 app.asar 劫持后续断言）。
delete process.env.MARKUS_TEMPLATES_DIR;

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
