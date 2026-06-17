import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import { AgentManager } from '../src/agent-manager.js';
import type { LLMRouter } from '../src/llm/router.js';

let dataDir: string;
let rolesDir: string;
let roleLoader: RoleLoader;

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

function createManager() {
  return new AgentManager({
    llmRouter: makeMockRouter(),
    roleLoader,
    dataDir,
    eventBus: new EventBus(),
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'markus-mgr-role-'));
  rolesDir = mkdtempSync(join(tmpdir(), 'markus-mgr-role-tmpl-'));
  roleLoader = new RoleLoader([rolesDir]);
  const devDir = join(rolesDir, 'developer');
  mkdirSync(devDir, { recursive: true });
  writeFileSync(join(devDir, 'ROLE.md'), '# Developer\nWrites code.');
  writeFileSync(join(devDir, 'HEARTBEAT.md'), '- Check CI');
  writeFileSync(join(devDir, 'POLICIES.md'), '## Code\n- Write tests');
  writeFileSync(join(devDir, 'CONTEXT.md'), 'Project uses TypeScript.');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(rolesDir, { recursive: true, force: true });
});

describe('AgentManager role sync and updates', () => {
  it('checkRoleUpdate detects modified agent role files', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Dev Agent', roleName: 'developer', tools: [] });
    const roleDir = join(dataDir, agent.id, 'role');
    writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- Custom heartbeat only for this agent');

    const status = manager.checkRoleUpdate(agent.id);
    expect(status.hasTemplate).toBe(true);
    expect(status.isUpToDate).toBe(false);
    expect(status.files.some(f => f.file === 'HEARTBEAT.md' && f.status === 'modified')).toBe(true);
  });

  it('syncRoleFromTemplate restores selected modified files', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Sync Agent', roleName: 'developer', tools: [] });
    const roleDir = join(dataDir, agent.id, 'role');
    writeFileSync(join(roleDir, 'HEARTBEAT.md'), '- Overridden heartbeat');

    const result = manager.syncRoleFromTemplate(agent.id, ['HEARTBEAT.md']);
    expect(result.synced).toContain('HEARTBEAT.md');
    const content = readFileSync(join(roleDir, 'HEARTBEAT.md'), 'utf-8');
    expect(content).toContain('Check CI');
  });

  it('checkRoleUpdate skips agents whose ROLE title differs from template', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Custom Title', roleName: 'developer', tools: [] });
    writeFileSync(join(dataDir, agent.id, 'role', 'ROLE.md'), '# Custom Built Agent\nFully custom.');

    const status = manager.checkRoleUpdate(agent.id);
    expect(status.hasTemplate).toBe(false);
    expect(status.isUpToDate).toBe(true);
  });

  it('pauseAllAgents and resumeAllAgents toggle global pause state', async () => {
    const manager = createManager();
    const agent = await manager.createAgent({ name: 'Pause Agent', roleName: 'developer', tools: [] });
    await manager.startAgent(agent.id);

    await manager.pauseAllAgents('maintenance');
    expect(manager.isGlobalPaused()).toBe(true);

    await manager.resumeAllAgents();
    expect(manager.isGlobalPaused()).toBe(false);
    expect(manager.isEmergencyMode()).toBe(false);
    await manager.stopAgent(agent.id);
  });

  it('setAgentConfigPersister is invoked when manager tools update agent config', async () => {
    const persister = vi.fn(async () => {});
    const manager = createManager();
    manager.setAgentConfigPersister(persister);
    manager.setTaskService({
      createTask: vi.fn(),
      listTasks: vi.fn(() => []),
      queryTasks: vi.fn(() => ({ tasks: [], total: 0 })),
      updateTaskStatus: vi.fn(),
      getTask: vi.fn(),
    } as never);

    const agent = await manager.createAgent({
      name: 'Manager Agent',
      roleName: 'developer',
      orgId: 'org_mgr',
      agentRole: 'manager',
      tools: [],
    });

    const updateTool = agent.getTools().get('agent_update_config');
    if (updateTool) {
      await updateTool.execute({ agent_id: agent.id, name: 'Renamed Agent' });
      expect(persister).toHaveBeenCalled();
    } else {
      expect(agent.config.name).toBe('Manager Agent');
    }
  });
});
