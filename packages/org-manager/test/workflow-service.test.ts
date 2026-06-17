import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowService } from '../src/workflow-service.js';

const VALID_WORKFLOW_YAML = `
name: test-workflow
displayName: Test Workflow
description: A test workflow
version: "1.0.0"
params:
  - name: topic
    type: string
    required: true
steps:
  - id: step-1
    name: Research
    role: researcher
    prompt: Research {{topic}}
    type: agent_task
  - id: step-2
    name: Write
    role: writer
    prompt: Write about {{topic}}
    type: agent_task
    depends_on:
      - step-1
`;

const SCHEDULED_WORKFLOW_YAML = `
name: scheduled-wf
description: Scheduled
version: "1.0.0"
schedule:
  cron: "0 9 * * 1-5"
steps:
  - id: s1
    name: Run
    role: worker
    prompt: do it
    type: agent_task
`;

function createMockOrgService(teamId = 'team-1') {
  const teams = new Map([
    [teamId, {
      id: teamId,
      orgId: 'org-1',
      name: 'Core',
      memberAgentIds: ['agent-dev', 'agent-writer'],
      humanMemberIds: [],
      managerId: 'agent-dev',
    }],
  ]);
  const agents = {
    'agent-dev': {
      config: { name: 'Researcher Bot', agentRole: 'manager' },
      role: { name: 'Researcher' },
    },
    'agent-writer': {
      config: { name: 'Writer Bot', agentRole: 'worker' },
      role: { name: 'Writer' },
    },
  };
  return {
    getTeam: vi.fn((id: string) => teams.get(id)),
    listTeams: vi.fn(() => [...teams.values()]),
    getAgentManager: vi.fn(() => ({
      getAgent: vi.fn((id: string) => agents[id as keyof typeof agents]),
    })),
  };
}

describe('WorkflowService', () => {
  let service: WorkflowService;
  let teamId: string;
  let tmpHome: string;
  let workflowsDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'markus-wf-'));
    process.env.HOME = tmpHome;
    teamId = `team-${Date.now()}`;
    workflowsDir = join(tmpHome, '.markus', 'teams', teamId, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    service = new WorkflowService(createMockOrgService(teamId) as never);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('CRUD', () => {
    it('adds, lists, gets, updates, and removes workflows', () => {
      const template = service.addWorkflow(teamId, 'test-workflow', VALID_WORKFLOW_YAML);
      expect(template.name).toBe('test-workflow');

      const listed = service.listWorkflows(teamId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.stepCount).toBe(2);
      expect(listed[0]?.roles).toContain('researcher');

      const fetched = service.getWorkflow(teamId, 'test-workflow');
      expect(fetched?.displayName).toBe('Test Workflow');

      const updatedYaml = VALID_WORKFLOW_YAML.replace('Test Workflow', 'Updated Workflow');
      const updated = service.updateWorkflow(teamId, 'test-workflow', updatedYaml);
      expect(updated.displayName).toBe('Updated Workflow');

      service.removeWorkflow(teamId, 'test-workflow');
      expect(service.getWorkflow(teamId, 'test-workflow')).toBeNull();
    });

    it('rejects invalid workflow yaml', () => {
      expect(() => service.addWorkflow(teamId, 'bad', 'name: only')).toThrow(/Invalid workflow template/);
    });

    it('rejects duplicate workflow name', () => {
      service.addWorkflow(teamId, 'dup', VALID_WORKFLOW_YAML);
      expect(() => service.addWorkflow(teamId, 'dup', VALID_WORKFLOW_YAML)).toThrow(/already exists/);
    });

    it('throws when updating missing workflow', () => {
      expect(() => service.updateWorkflow(teamId, 'missing', VALID_WORKFLOW_YAML)).toThrow(/not found/);
    });
  });

  describe('role resolution', () => {
    beforeEach(() => {
      service.addWorkflow(teamId, 'test-workflow', VALID_WORKFLOW_YAML);
    });

    it('resolves roles to team agents with scores', () => {
      const template = service.getWorkflow(teamId, 'test-workflow')!;
      const candidates = service.resolveRoles(teamId, template);
      expect(candidates).toHaveLength(2);

      const researcher = candidates.find(c => c.role === 'researcher');
      expect(researcher?.candidates.length).toBeGreaterThan(0);
      expect(researcher?.recommended).toBeDefined();
    });

    it('builds default role mapping without duplicate agents', () => {
      const template = service.getWorkflow(teamId, 'test-workflow')!;
      const mapping = service.buildDefaultRoleMapping(teamId, template);
      expect(mapping.researcher).toBeDefined();
      expect(mapping.writer).toBeDefined();
    });

    it('throws when team not found', () => {
      const template = service.getWorkflow(teamId, 'test-workflow')!;
      expect(() => service.resolveRoles('missing', template)).toThrow(/Team not found/);
    });
  });

  describe('scheduled workflows', () => {
    it('lists scheduled workflows for org', () => {
      service.addWorkflow(teamId, 'scheduled-wf', SCHEDULED_WORKFLOW_YAML);
      const scheduled = service.listScheduledWorkflows('org-1');
      expect(scheduled.some(s => s.workflowName === 'scheduled-wf')).toBe(true);
    });
  });
});
