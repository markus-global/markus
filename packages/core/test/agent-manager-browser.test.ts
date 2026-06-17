import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;

function makeMockRouter(): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    chatStream: vi.fn(async () => ({ content: 'ok', finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })),
    resolveModalityCandidates: vi.fn(() => []),
    listProviders: vi.fn(() => ['anthropic']),
    getProvider: vi.fn(),
    getDefaultProvider: vi.fn(() => 'anthropic'),
    getActiveModelName: vi.fn(() => 'claude-test'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
  } as unknown as LLMRouter;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-mgr-br-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-mgr-br-roles-'));
  const roleDir = join(rolesDir, 'custom');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'ROLE.md'), '# Custom\nRole.');
  writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- Ping');
  writeFileSync(join(roleDir, 'POLICIES.md'), '## Safe');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('AgentManager browser bridge helpers', () => {
  it('exposes browser bridge and runs quick test when disconnected', async () => {
    const manager = new AgentManager({
      llmRouter: makeMockRouter(),
      roleLoader: new RoleLoader([rolesDir]),
      dataDir,
      eventBus: new EventBus(),
    });

    manager.setBrowserRemoteDebuggingPort(9222);
    manager.setBrowserAutoCloseTabs(true);
    manager.setBrowserBringToFront(false);
    manager.startBrowserBridge(18792);
    expect(manager.getBrowserBridge()).toBeDefined();
    expect(manager.browserExtensionConnected).toBe(false);

    const result = await manager.runQuickBrowserTest();
    expect(result.connected).toBe(false);

    manager.stopBrowserBridge();
  });

  it('runChaosBrowserTest throws when extension not connected', async () => {
    const manager = new AgentManager({
      llmRouter: makeMockRouter(),
      roleLoader: new RoleLoader([rolesDir]),
      dataDir,
      eventBus: new EventBus(),
    });
    manager.startBrowserBridge(18793);
    const gen = manager.runChaosBrowserTest({ durationMs: 50, intervalMs: 10 });
    await expect(gen.next()).rejects.toThrow('Extension not connected');
    manager.stopBrowserBridge();
  });
});
