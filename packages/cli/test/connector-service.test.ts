import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConnectors,
  findConnector,
  readPlatformConfig,
  writePlatformConfig,
  scanInstalledPlatforms,
  installSkillTemplate,
  readPlatformLLMProviders,
} from '../src/connector-service.js';

describe('connector-service', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-connector-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loadConnectors includes built-in openclaw connector', () => {
    const connectors = loadConnectors();
    expect(connectors.some(c => c.platform === 'openclaw')).toBe(true);
    expect(connectors.some(c => c.platform === '_template')).toBe(false);
  });

  it('findConnector returns connector by platform name', () => {
    const connector = findConnector('openclaw');
    expect(connector?.platform).toBe('openclaw');
    expect(connector?.displayName).toBeTruthy();
  });

  it('findConnector returns undefined for unknown platform', () => {
    expect(findConnector('nonexistent-platform-xyz')).toBeUndefined();
  });

  it('loadConnectors merges user connector overrides', () => {
    const userDir = join(tmpHome, '.markus', 'connectors');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'openclaw.json'),
      JSON.stringify({
        platform: 'openclaw',
        displayName: 'Custom OpenClaw',
        integration: { configPath: '~/.openclaw/openclaw.json' },
      }),
    );

    const connector = findConnector('openclaw');
    expect(connector?.displayName).toBe('Custom OpenClaw');
  });

  it('readPlatformConfig parses JSON config files', () => {
    const connector = findConnector('openclaw');
    expect(connector).toBeDefined();

    const configDir = join(tmpHome, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'openclaw.json'),
      JSON.stringify({ models: { providers: { openai: { apiKey: 'sk-test' } } } }),
    );

    const config = readPlatformConfig(connector!);
    expect(config).not.toBeNull();
    expect((config as Record<string, unknown>).models).toBeDefined();
  });

  it('readPlatformConfig returns null when config file missing', () => {
    const connector = findConnector('openclaw');
    expect(readPlatformConfig(connector!)).toBeNull();
  });

  it('readPlatformConfig parses json5-style comments', () => {
    const connector = findConnector('openclaw');
    const configDir = join(tmpHome, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'openclaw.json'),
      `{
        // comment line
        "models": { "providers": {} }
      }`,
    );

    const json5Connector = {
      ...connector!,
      integration: { ...connector!.integration, configFormat: 'json5' as const },
    };
    const config = readPlatformConfig(json5Connector);
    expect(config).not.toBeNull();
  });

  it('writePlatformConfig creates config with markus URL and token', () => {
    const connector = findConnector('openclaw')!;
    const configPath = join(tmpHome, '.openclaw', 'openclaw.json');
    const ok = writePlatformConfig(connector, 'http://localhost:8056', 'test-token-abc');
    expect(ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(saved).toBeDefined();
  });

  it('scanInstalledPlatforms detects config presence', () => {
    const connector = findConnector('openclaw')!;
    const configDir = join(tmpHome, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({ models: {} }));

    const results = scanInstalledPlatforms();
    const openclaw = results.find(r => r.platform === 'openclaw');
    expect(openclaw).toBeDefined();
    expect(openclaw?.installed).toBe(true);
    expect(openclaw?.configPath).toBeTruthy();
  });

  it('installSkillTemplate returns false when skill template not configured', () => {
    const fakeConnector = {
      platform: 'test',
      displayName: 'Test',
      integration: { configPath: '~/.test/config.json' },
    };
    expect(installSkillTemplate(fakeConnector as never)).toBe(false);
  });

  it('readPlatformLLMProviders extracts nested provider config', () => {
    const connector = findConnector('openclaw')!;
    const configDir = join(tmpHome, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'openclaw.json'),
      JSON.stringify({
        models: {
          providers: {
            openai: { apiKey: 'sk-from-platform', models: [{ id: 'gpt-4o' }] },
          },
        },
      }),
    );

    const providers = readPlatformLLMProviders(connector);
    expect(providers).not.toBeNull();
    expect((providers as Record<string, unknown>).openai).toBeDefined();
  });

  it('installSkillTemplate copies template when source exists', () => {
    const connector = findConnector('openclaw')!;
    const templateRoot = join(tmpHome, '.markus', 'templates', connector.integration.skillTemplateName!);
    mkdirSync(templateRoot, { recursive: true });
    writeFileSync(join(templateRoot, 'SKILL.md'), '# skill');

    expect(installSkillTemplate(connector)).toBe(true);
    const target = join(tmpHome, '.openclaw', 'skills', connector.integration.skillTemplateName!);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
  });

  it('writePlatformConfig merges into existing config file', () => {
    const connector = findConnector('openclaw')!;
    const configDir = join(tmpHome, '.openclaw');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify({ existing: true }));

    writePlatformConfig(connector, 'http://localhost:8056', 'merged-token');
    const saved = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf-8')) as Record<string, unknown>;
    expect(saved.existing).toBe(true);
  });
});
