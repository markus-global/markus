import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BuilderService } from '../src/builder-service.js';

function createMockOrgService() {
  const agent = {
    id: 'agent-installed',
    config: { name: 'Installed Agent' },
    role: { name: 'Custom Developer' },
    reloadRole: vi.fn(),
    getState: vi.fn(() => ({ status: 'idle' })),
  };
  const agentManager = {
    getDataDir: vi.fn(() => join(homedir(), '.markus', 'agents')),
    startAgent: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getAgentManager: vi.fn(() => agentManager),
    hireAgent: vi.fn().mockResolvedValue(agent),
    createTeam: vi.fn().mockResolvedValue({ id: 'team-installed', name: 'Installed Team' }),
    updateTeam: vi.fn().mockResolvedValue(undefined),
    ensureTeamDataDir: vi.fn(),
    _agent: agent,
    _agentManager: agentManager,
  };
}

describe('BuilderService', () => {
  let service: BuilderService;
  let orgService: ReturnType<typeof createMockOrgService>;
  let artifactsRoot: string;

  beforeEach(() => {
    orgService = createMockOrgService();
    service = new BuilderService(orgService as never);
    artifactsRoot = join(homedir(), '.markus', 'builder-artifacts');
  });

  afterEach(() => {
    if (existsSync(artifactsRoot)) {
      rmSync(artifactsRoot, { recursive: true, force: true });
    }
  });

  function writeAgentArtifact(name: string) {
    const dir = join(artifactsRoot, 'agents', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({
      type: 'agent',
      name,
      version: '1.0.0',
      description: `${name} package`,
      displayName: name,
      agent: { roleName: 'developer', agentRole: 'worker' },
    }));
    writeFileSync(join(dir, 'ROLE.md'), '# Custom Role\nYou are a builder agent.');
  }

  function writeSkillArtifact(name: string) {
    const dir = join(artifactsRoot, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), JSON.stringify({
      type: 'skill',
      name,
      version: '1.0.0',
      description: `${name} skill`,
      skill: { skillFile: 'SKILL.md' },
    }));
    writeFileSync(join(dir, 'SKILL.md'), '---\ntitle: Skill\n---\nDo skill things.');
  }

  describe('listArtifacts', () => {
    it('lists installed artifacts by type', () => {
      writeAgentArtifact('my-agent');
      writeSkillArtifact('my-skill');

      const all = service.listArtifacts();
      expect(all.some(a => a.type === 'agent' && a.name === 'my-agent')).toBe(true);
      expect(all.some(a => a.type === 'skill' && a.name === 'my-skill')).toBe(true);

      const agentsOnly = service.listArtifacts('agent');
      expect(agentsOnly.every(a => a.type === 'agent')).toBe(true);
    });

    it('returns empty when artifact dir missing', () => {
      if (existsSync(artifactsRoot)) rmSync(artifactsRoot, { recursive: true, force: true });
      expect(service.listArtifacts()).toEqual([]);
    });
  });

  describe('installArtifact', () => {
    it('installs agent artifact', async () => {
      writeAgentArtifact('deploy-bot');
      const result = await service.installArtifact('agent', 'deploy-bot');
      expect(result.type).toBe('agent');
      expect(orgService.hireAgent).toHaveBeenCalledWith(expect.objectContaining({
        name: 'deploy-bot',
        skipAutoStart: true,
      }));
      expect(orgService._agent.reloadRole).toHaveBeenCalled();
      expect(orgService._agentManager.startAgent).toHaveBeenCalledWith('agent-installed');
    });

    it('installs skill artifact and registers in registry', async () => {
      writeSkillArtifact('lint-helper');
      const skillRegistry = { register: vi.fn() };
      service = new BuilderService(orgService as never, skillRegistry as never);
      const result = await service.installArtifact('skill', 'lint-helper');
      expect(result.type).toBe('skill');
      expect(skillRegistry.register).toHaveBeenCalled();
    });

    it('throws when artifact not found', async () => {
      await expect(service.installArtifact('agent', 'missing')).rejects.toThrow(/Artifact not found/);
    });

    it('throws when manifest is invalid', async () => {
      const dir = join(artifactsRoot, 'agents', 'bad-agent');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent.json'), JSON.stringify({ type: 'agent', name: '' }));
      await expect(service.installArtifact('agent', 'bad-agent')).rejects.toThrow(/Invalid manifest/);
    });
  });

  describe('installTeam', () => {
    function writeTeamArtifact(name: string, extra: Record<string, unknown> = {}) {
      const dir = join(artifactsRoot, 'teams', name);
      mkdirSync(join(dir, 'members', 'lead'), { recursive: true });
      writeFileSync(join(dir, 'team.json'), JSON.stringify({
        type: 'team',
        name,
        version: '1.0.0',
        description: `${name} team package`,
        displayName: name,
        team: {
          members: [{ name: 'Lead', role: 'manager', roleName: 'developer', count: 1 }],
          workflows: ['workflows/demo.yaml'],
        },
        starterTasks: [{ title: 'Kickoff', description: 'Start the project', priority: 'high' }],
        ...extra,
      }));
      writeFileSync(join(dir, 'members', 'lead', 'ROLE.md'), '# Lead\nTeam lead role.');
      writeFileSync(join(dir, 'ANNOUNCEMENT.md'), 'Welcome to the team');
      writeFileSync(join(dir, 'NORMS.md'), 'Be kind');
      mkdirSync(join(dir, 'workflows'), { recursive: true });
      writeFileSync(join(dir, 'workflows', 'demo.yaml'), 'name: demo\nsteps: []');
    }

    it('installs team with members, starter tasks, and workflows', async () => {
      writeTeamArtifact('dev-team');
      const taskService = { createTask: vi.fn(() => ({ id: 'task-starter' })) };
      const wsBroadcast = vi.fn();
      service = new BuilderService(orgService as never, undefined, wsBroadcast);
      service.setTaskService(taskService as never);

      const result = await service.installArtifact('team', 'dev-team');
      expect(result.type).toBe('team');
      expect(orgService.createTeam).toHaveBeenCalledWith('default', 'dev-team', expect.any(String));
      expect(orgService.hireAgent).toHaveBeenCalled();
      expect(orgService.ensureTeamDataDir).toHaveBeenCalled();
      expect(taskService.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Kickoff' }));
      expect(wsBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat:group_created' }));
      expect((result.installed as { workflows: string[] }).workflows).toContain('demo.yaml');
    });

    it('falls back to builtin team template directory', async () => {
      const builtinDir = join(homedir(), '.markus', 'builtin-teams-test');
      const teamDir = join(builtinDir, 'builtin-team');
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, 'team.json'), JSON.stringify({
        type: 'team',
        name: 'builtin-team',
        version: '1.0.0',
        description: 'Built-in team',
        team: { members: [{ name: 'Solo', role: 'worker', roleName: 'developer', count: 1 }] },
      }));
      mkdirSync(join(teamDir, 'members', 'solo'), { recursive: true });
      writeFileSync(join(teamDir, 'members', 'solo', 'ROLE.md'), '# Solo\nWorker role.');

      service = new BuilderService(orgService as never);
      service.setBuiltinTeamTemplatesDir(builtinDir);
      const result = await service.installArtifact('team', 'builtin-team');
      expect(result.type).toBe('team');

      rmSync(builtinDir, { recursive: true, force: true });
    });
  });
});
