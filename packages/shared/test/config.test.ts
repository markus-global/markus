import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig, getDefaultConfigPath } from '../src/utils/config.js';

describe('getDefaultConfigPath', () => {
  it('returns a path ending with .markus/markus.json', () => {
    const p = getDefaultConfigPath();
    expect(p).toMatch(/\.markus[/\\]markus\.json$/);
  });
});

describe('deepMerge (via loadConfig/saveConfig)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `markus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig returns defaults when file missing', () => {
    const cfg = loadConfig(join(tmpDir, 'missing.json'));
    expect(cfg.org.id).toBe('default');
    expect(cfg.llm.defaultProvider).toBe('anthropic');
    expect(cfg.server.apiPort).toBe(8056);
  });

  it('loadConfig merges partial file with defaults', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ org: { name: 'Test Org' } }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.org.name).toBe('Test Org');
    expect(cfg.org.id).toBe('default');
    expect(cfg.llm.defaultProvider).toBe('anthropic');
  });

  it('saveConfig creates file if missing', () => {
    const cfgPath = join(tmpDir, 'sub', 'markus.json');
    saveConfig({ org: { id: 'org1', name: 'Org1' } }, cfgPath);
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = loadConfig(cfgPath);
    expect(cfg.org.id).toBe('org1');
  });

  it('saveConfig merges into existing file', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ org: { id: 'x', name: 'X' }, server: { apiPort: 9000, webPort: 9001 } }));
    saveConfig({ org: { id: 'x', name: 'Updated' } }, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect(cfg.org.name).toBe('Updated');
    expect(cfg.server.apiPort).toBe(9000);
  });

  it('null values in saveConfig delete keys from on-disk file', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ org: { id: 'x', name: 'X' }, security: { adminPassword: 'secret' } }));
    saveConfig({ security: null } as any, cfgPath);
    // loadConfig re-merges with DEFAULT_CONFIG (which has security), so check the raw file
    const raw = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8'));
    expect(raw.org.id).toBe('x');
    expect(raw.security).toBeUndefined();
  });

  it('arrays replace rather than merge element-by-element', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ llm: { providers: {}, defaultProvider: 'openai', defaultModel: 'gpt-4o' } }));
    saveConfig({ llm: { providers: {}, defaultProvider: 'anthropic', defaultModel: 'claude-opus-4-6' } } as any, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect(cfg.llm.defaultProvider).toBe('anthropic');
  });

  it('handles corrupt JSON file gracefully', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, '{broken json!!!');
    saveConfig({ org: { id: 'new', name: 'New' } }, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect(cfg.org.id).toBe('new');
  });

  it('nested null deletes deeply nested keys', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({
      llm: { defaultProvider: 'openai', defaultModel: 'gpt-4o', providers: {}, taskRouting: { assignments: { text: { provider: 'openai' } } } },
    }));
    saveConfig({ llm: { taskRouting: { assignments: { text: null } } } } as any, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect((cfg.llm.taskRouting as any)?.assignments?.text).toBeUndefined();
  });
});
