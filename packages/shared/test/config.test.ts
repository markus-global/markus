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
    // Factory default is Markus Cloud AI (an env-detected key must never
    // silently become the default — see commands-start-services.test.ts).
    expect(cfg.llm.defaultProvider).toBe('markus');
    expect(cfg.server.apiPort).toBe(8056);
  });

  it('loadConfig merges partial file with defaults', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({ org: { name: 'Test Org' } }));
    const cfg = loadConfig(cfgPath);
    expect(cfg.org.name).toBe('Test Org');
    expect(cfg.org.id).toBe('default');
    expect(cfg.llm.defaultProvider).toBe('markus');
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

  it('null deletes a key even when the parent object is brand new', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    // Fresh file: the provider key did not exist before this save.
    saveConfig({
      llm: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', apiKey: null, enabled: true } } },
    } as any, cfgPath);
    const raw = JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf-8'));
    expect(raw.llm.providers.openai.apiKey).toBeUndefined();
    expect(raw.llm.providers.openai.apiKeyEnv).toBe('OPENAI_API_KEY');
    expect(raw.llm.providers.openai.enabled).toBe(true);
  });

  it('nested null deletes deeply nested keys', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    writeFileSync(cfgPath, JSON.stringify({
      llm: { defaultProvider: 'openai', defaultModel: 'gpt-4o', providers: {}, capabilityRouting: { assignments: { text: { provider: 'openai' } } } },
    }));
    saveConfig({ llm: { capabilityRouting: { assignments: { text: null } } } } as any, cfgPath);
    const cfg = loadConfig(cfgPath);
    expect((cfg.llm.capabilityRouting as any)?.assignments?.text).toBeUndefined();
  });
});

/**
 * 并发处理配置（智能体设置 → 并发处理）落 markus.json 的往返一致性。
 *
 * 这是「问题3」的持久化契约：POST /api/settings/agent 走 saveConfig 写盘，
 * 重启时 createServices 走 loadConfig 读回 → AgentManager.concurrentConfig。
 * 若此层丢字段，重启后并发设置必然回落默认值（历史 bug：改了没用/重启即丢）。
 */
describe('agent.concurrent 持久化（保存 → 重载 → 读回）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `markus-test-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveConfig → loadConfig 逐字段读回（enabled / maxWorkers / conflictPolicy）', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    saveConfig({
      agent: {
        maxToolIterations: 30,
        concurrent: { enabled: true, maxWorkers: 7, conflictPolicy: 'report' },
      },
    }, cfgPath);

    const cfg = loadConfig(cfgPath);
    expect(cfg.agent?.concurrent).toEqual({ enabled: true, maxWorkers: 7, conflictPolicy: 'report' });
  });

  it('enabled:false 也能读回（关掉并发不能丢，否则重启后又被默认打开）', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    saveConfig({ agent: { concurrent: { enabled: false, conflictPolicy: 'auto' } } }, cfgPath);

    const cfg = loadConfig(cfgPath);
    expect(cfg.agent?.concurrent).toEqual({ enabled: false, conflictPolicy: 'auto' });
  });

  it('二次保存按字段合并，不被部分更新抹掉（maxWorkers 保留）', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    saveConfig({ agent: { concurrent: { enabled: true, maxWorkers: 5, conflictPolicy: 'report' } } }, cfgPath);
    // 后续只改 conflictPolicy（例如另一个设置项的部分写）
    saveConfig({ agent: { concurrent: { conflictPolicy: 'auto' } } } as any, cfgPath);

    const cfg = loadConfig(cfgPath);
    expect(cfg.agent?.concurrent?.maxWorkers).toBe(5);
    expect(cfg.agent?.concurrent?.conflictPolicy).toBe('auto');
  });
});

/**
 * 任务上限（智能体设置 → 任务上限）落 markus.json 的往返一致性。
 *
 * 这是「问题2」的持久化契约：POST /api/settings/agent 走 saveConfig 写盘，
 * 重启时 createServices 走 loadConfig 读回 → AgentManager.maxPendingTasksPerAgent
 * → TaskService.checkTaskLimits。若此层丢字段，重启后任务上限必然回落治理默认值。
 */
describe('agent.maxPendingTasksPerAgent 持久化（保存 → 重载 → 读回）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `markus-test-taskcap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveConfig → loadConfig 读回任务上限', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    saveConfig({ agent: { maxToolIterations: 30, maxPendingTasksPerAgent: 7 } }, cfgPath);

    const cfg = loadConfig(cfgPath);
    expect(cfg.agent?.maxPendingTasksPerAgent).toBe(7);
  });

  it('与 concurrent 同处 agent 命名空间，互不覆盖', () => {
    const cfgPath = join(tmpDir, 'markus.json');
    saveConfig({ agent: { concurrent: { enabled: true, maxWorkers: 5 } } }, cfgPath);
    saveConfig({ agent: { maxPendingTasksPerAgent: 15 } } as any, cfgPath);

    const cfg = loadConfig(cfgPath);
    expect(cfg.agent?.maxPendingTasksPerAgent).toBe(15);
    expect(cfg.agent?.concurrent?.maxWorkers).toBe(5);
  });
});
