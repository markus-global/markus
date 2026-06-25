import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentManager } from '../src/agent-manager.js';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events.js';
import { RoleLoader } from '../src/role-loader.js';
import type { LLMRouter } from '../src/llm/router.js';

function makeMockRouter(overrides?: Partial<LLMRouter>): LLMRouter {
  return {
    defaultProviderName: 'anthropic',
    chat: vi.fn(async () => ({
      content: 'Reply.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 25 },
    })),
    chatStream: vi.fn(async (_req, onEvent) => {
      onEvent?.({ type: 'text_delta', text: 'Working...' });
      return {
        content: 'Done.',
        finishReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    }),
    resolveModalityCandidates: vi.fn(() => []),
    getActiveModelName: vi.fn(() => 'claude-test'),
    getActiveModelContextWindow: vi.fn(() => 200000),
    getActiveModelMaxOutput: vi.fn(() => 8000),
    getModelContextWindow: vi.fn(() => 200000),
    getModelMaxOutput: vi.fn(() => 8000),
    getModelCost: vi.fn(),
    isCompactionSupported: vi.fn(() => true),
    modelSupportsVision: vi.fn(() => false),
    ...overrides,
  } as LLMRouter;
}

function createRoleTemplate(rolesDir: string, name: string, files: Record<string, string>) {
  const roleDir = join(rolesDir, name);
  mkdirSync(roleDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(roleDir, file), content);
  }
}

describe('AgentManager team_id passthrough via getters', () => {
  let manager: AgentManager;
  let dataDir: string;
  let rolesDir: string;
  let roleLoader: RoleLoader;
  let builderServiceMock: { installArtifact: ReturnType<typeof vi.fn>; listArtifacts: ReturnType<typeof vi.fn> };
  let templateRegistryMock: { list: ReturnType<typeof vi.fn>; getTemplate: ReturnType<typeof vi.fn> };
  let createAgentFromTemplateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'markus-am-tid-'));
    rolesDir = mkdtempSync(join(tmpdir(), 'markus-am-tid-roles-'));
    roleLoader = new RoleLoader([rolesDir]);
    createRoleTemplate(rolesDir, 'developer', {
      'ROLE.md': '# Developer\nWrites code.',
      'HEARTBEAT.md': '- Check CI',
      'POLICIES.md': '## Code\n- Write tests',
      'AGENTS.md': '# Agents\n## Meta\n- N/A',
    });
    manager = new AgentManager({
      llmRouter: makeMockRouter(),
      roleLoader,
      dataDir,
      eventBus: new EventBus(),
    } as never);

    builderServiceMock = {
      installArtifact: vi.fn(async (type: string, name: string) => {
        if (type === 'agent' && name === 'custom-dev') return { type, installed: { name } };
        throw new Error(`Artifact not found: ${type}/${name}`);
      }),
      listArtifacts: vi.fn(() => [{ type: 'agent', name: 'custom-dev', description: 'Custom developer' }]),
    };
    manager.setBuilderService(builderServiceMock);

    createAgentFromTemplateSpy = vi.fn(async (opts: Record<string, unknown>) => ({
      id: 'agt_template',
      config: { name: opts.name as string },
      role: { name: 'developer' },
    }));

    templateRegistryMock = {
      list: vi.fn(() => [{ id: 'tpl_dev', name: 'Developer', description: 'A dev', roleId: 'developer', category: 'dev' }]),
      getTemplate: vi.fn(() => ({
        id: 'tpl_dev',
        name: 'Developer',
        description: 'A developer',
        roleId: 'developer',
        category: 'dev',
        files: {},
      })),
    };
    manager.setTemplateRegistry(templateRegistryMock as never);

    // Stub createAgentFromTemplate to use our spy
    (manager as never).createAgentFromTemplate = createAgentFromTemplateSpy;

    manager.setApprovalHandler(vi.fn(async () => ({ approved: true })));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(rolesDir, { recursive: true, force: true });
  });

  describe('installArtifact getter', () => {
    it('passes teamId to builderService.installArtifact when team_id is provided', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      await tool.execute({ type: 'agent', name: 'custom-dev', team_id: 'team_42' });

      expect(builderServiceMock.installArtifact).toHaveBeenCalledWith('agent', 'custom-dev', 'team_42');
    });

    it('passes undefined teamId when team_id is omitted', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      await tool.execute({ type: 'agent', name: 'custom-dev' });

      expect(builderServiceMock.installArtifact).toHaveBeenCalledWith('agent', 'custom-dev', undefined);
    });

    it('trims whitespace from team_id before passing to builderService', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      await tool.execute({ type: 'agent', name: 'custom-dev', team_id: '  team_99  ' });

      expect(builderServiceMock.installArtifact).toHaveBeenCalledWith('agent', 'custom-dev', 'team_99');
    });
  });

  describe('hireFromTemplate getter', () => {
    it('passes teamId to createAgentFromTemplate when team_id is provided', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      // Make installArtifact throw so it falls back to hireFromTemplate
      builderServiceMock.installArtifact = vi.fn(async () => { throw new Error('not found'); });
      await tool.execute({ type: 'agent', name: 'tpl_dev', agent_name: 'Helper', team_id: 'team_42' });

      expect(createAgentFromTemplateSpy).toHaveBeenCalledWith(expect.objectContaining({
        teamId: 'team_42',
        name: 'Helper',
      }));
    });

    it('falls back to config.teamId when team_id is omitted', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        teamId: 'team_default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      builderServiceMock.installArtifact = vi.fn(async () => { throw new Error('not found'); });
      await tool.execute({ type: 'agent', name: 'tpl_dev', agent_name: 'Helper' });

      expect(createAgentFromTemplateSpy).toHaveBeenCalledWith(expect.objectContaining({
        teamId: 'team_default',
      }));
    });

    it('uses provided teamId over config.teamId', async () => {
      const agent = await manager.createAgent({
        name: 'Test Agent',
        roleName: 'developer',
        orgId: 'default',
        teamId: 'team_default',
        tools: [],
      });

      const tool = agent.getTools().get('package_install')!;
      builderServiceMock.installArtifact = vi.fn(async () => { throw new Error('not found'); });
      await tool.execute({ type: 'agent', name: 'tpl_dev', agent_name: 'Helper', team_id: 'team_explicit' });

      expect(createAgentFromTemplateSpy).toHaveBeenCalledWith(expect.objectContaining({
        teamId: 'team_explicit',
      }));
    });
  });
});
