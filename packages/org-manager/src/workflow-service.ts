import {
  createLogger,
  validateWorkflowTemplate,
  extractRoles,
  type WorkflowTemplate,
  type WorkflowScheduleState,
} from '@markus/shared';
import { parse as parseYaml } from 'yaml';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OrganizationService } from './org-service.js';

const log = createLogger('workflow-service');

export interface WorkflowInfo {
  name: string;
  displayName: string;
  description: string;
  version: string;
  roles: string[];
  hasSchedule: boolean;
  schedule?: WorkflowTemplate['schedule'];
  stepCount: number;
  params: WorkflowTemplate['params'];
}

export interface RoleCandidate {
  role: string;
  candidates: Array<{
    agentId: string;
    agentName: string;
    roleName: string;
    agentRole: 'manager' | 'worker';
    score: number;
  }>;
  recommended?: string;
}

export class WorkflowService {
  private orgService: OrganizationService;

  constructor(orgService: OrganizationService) {
    this.orgService = orgService;
  }

  private getWorkflowsDir(teamId: string): string {
    return join(homedir(), '.markus', 'teams', teamId, 'workflows');
  }

  private ensureWorkflowsDir(teamId: string): string {
    const dir = this.getWorkflowsDir(teamId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  listWorkflows(teamId: string): WorkflowInfo[] {
    const dir = this.getWorkflowsDir(teamId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    const result: WorkflowInfo[] = [];

    for (const file of files) {
      try {
        const template = this.parseTemplateFile(join(dir, file));
        result.push({
          name: template.name,
          displayName: template.displayName || template.name,
          description: template.description,
          version: template.version,
          roles: extractRoles(template),
          hasSchedule: !!template.schedule,
          schedule: template.schedule,
          stepCount: template.steps.length,
          params: template.params,
        });
      } catch (err) {
        log.warn('Failed to parse workflow template', { file, error: String(err) });
      }
    }

    return result;
  }

  getWorkflow(teamId: string, name: string): WorkflowTemplate | null {
    const dir = this.getWorkflowsDir(teamId);
    const filePath = this.resolveWorkflowFile(dir, name);
    if (!filePath) return null;

    try {
      return this.parseTemplateFile(filePath);
    } catch (err) {
      log.warn('Failed to parse workflow template', { name, error: String(err) });
      return null;
    }
  }

  addWorkflow(teamId: string, name: string, yamlContent: string): WorkflowTemplate {
    const parsed = parseYaml(yamlContent) as unknown;
    const errors = validateWorkflowTemplate(parsed);
    if (errors.length > 0) {
      throw new Error(`Invalid workflow template: ${errors.join('; ')}`);
    }

    const template = parsed as WorkflowTemplate;
    const dir = this.ensureWorkflowsDir(teamId);
    const fileName = `${name}.yaml`;
    const filePath = join(dir, fileName);

    if (existsSync(filePath)) {
      throw new Error(`Workflow "${name}" already exists. Use updateWorkflow to modify it.`);
    }

    writeFileSync(filePath, yamlContent, 'utf-8');
    log.info('Workflow template created', { teamId, name });
    return template;
  }

  updateWorkflow(teamId: string, name: string, yamlContent: string): WorkflowTemplate {
    const parsed = parseYaml(yamlContent) as unknown;
    const errors = validateWorkflowTemplate(parsed);
    if (errors.length > 0) {
      throw new Error(`Invalid workflow template: ${errors.join('; ')}`);
    }

    const template = parsed as WorkflowTemplate;
    const dir = this.getWorkflowsDir(teamId);
    const filePath = this.resolveWorkflowFile(dir, name);
    if (!filePath) {
      throw new Error(`Workflow "${name}" not found`);
    }

    writeFileSync(filePath, yamlContent, 'utf-8');
    log.info('Workflow template updated', { teamId, name });
    return template;
  }

  removeWorkflow(teamId: string, name: string): void {
    const dir = this.getWorkflowsDir(teamId);
    const filePath = this.resolveWorkflowFile(dir, name);
    if (!filePath) {
      throw new Error(`Workflow "${name}" not found`);
    }

    unlinkSync(filePath);
    log.info('Workflow template removed', { teamId, name });
  }

  /**
   * Auto-resolve template roles to team member agents.
   * Matching priority: roleName exact > agentRole > name substring > skill match.
   */
  resolveRoles(teamId: string, template: WorkflowTemplate): RoleCandidate[] {
    const team = this.orgService.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const agentManager = this.orgService.getAgentManager();
    const roles = extractRoles(template);
    const result: RoleCandidate[] = [];

    for (const role of roles) {
      const candidates: RoleCandidate['candidates'] = [];
      const roleLower = role.toLowerCase();

      for (const agentId of team.memberAgentIds) {
        try {
          const agent = agentManager.getAgent(agentId);
          const agentName = agent.config.name;
          const agentRoleName = agent.role?.name ?? '';
          const agentRole = (agent.config.agentRole ?? 'worker') as 'manager' | 'worker';
          const agentNameLower = agentName.toLowerCase();
          const roleNameLower = agentRoleName.toLowerCase();

          let score = 0;

          // Exact roleName match
          if (roleNameLower === roleLower) score += 100;
          // roleName contains role
          else if (roleNameLower.includes(roleLower)) score += 60;
          // Agent name contains role
          else if (agentNameLower.includes(roleLower)) score += 50;
          // Role contains agent role type
          else if (roleLower.includes(agentRole)) score += 20;

          // Boost managers for "reviewer"/"editor" type roles
          if ((roleLower.includes('review') || roleLower.includes('editor') || roleLower.includes('manager'))
              && agentRole === 'manager') {
            score += 30;
          }

          if (score > 0) {
            candidates.push({ agentId, agentName, roleName: agentRoleName, agentRole, score });
          }
        } catch {
          // skip unavailable agents
        }
      }

      candidates.sort((a, b) => b.score - a.score);

      result.push({
        role,
        candidates,
        recommended: candidates[0]?.agentId,
      });
    }

    return result;
  }

  /**
   * Build a default role mapping by picking the best candidate for each role.
   * Falls back to the team manager for unresolvable roles.
   */
  buildDefaultRoleMapping(teamId: string, template: WorkflowTemplate): Record<string, string> {
    const team = this.orgService.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const roleCandidates = this.resolveRoles(teamId, template);
    const mapping: Record<string, string> = {};
    const assigned = new Set<string>();

    // First pass: assign best unique candidate to each role
    for (const rc of roleCandidates) {
      const best = rc.candidates.find(c => !assigned.has(c.agentId));
      if (best) {
        mapping[rc.role] = best.agentId;
        assigned.add(best.agentId);
      }
    }

    // Second pass: fill any unassigned roles with the manager or first available agent
    const fallbackAgent = team.managerId || team.memberAgentIds[0];
    for (const rc of roleCandidates) {
      if (!mapping[rc.role] && fallbackAgent) {
        mapping[rc.role] = fallbackAgent;
      }
    }

    return mapping;
  }

  /**
   * List all teams' scheduled workflows and their current state.
   */
  listScheduledWorkflows(orgId: string): WorkflowScheduleState[] {
    const teams = this.orgService.listTeams(orgId);
    const states: WorkflowScheduleState[] = [];

    for (const team of teams) {
      const workflows = this.listWorkflows(team.id);
      for (const wf of workflows) {
        if (wf.hasSchedule && wf.schedule) {
          states.push({
            teamId: team.id,
            workflowName: wf.name,
            schedule: wf.schedule,
            nextRunAt: null,
            totalRuns: 0,
            lastRunAt: null,
            paused: false,
            lastRoleMapping: {},
          });
        }
      }
    }

    return states;
  }

  private parseTemplateFile(filePath: string): WorkflowTemplate {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content) as unknown;
    const errors = validateWorkflowTemplate(parsed);
    if (errors.length > 0) {
      throw new Error(`Invalid template at ${filePath}: ${errors.join('; ')}`);
    }
    return parsed as WorkflowTemplate;
  }

  private resolveWorkflowFile(dir: string, name: string): string | null {
    if (!existsSync(dir)) return null;

    const yamlPath = join(dir, `${name}.yaml`);
    if (existsSync(yamlPath)) return yamlPath;

    const ymlPath = join(dir, `${name}.yml`);
    if (existsSync(ymlPath)) return ymlPath;

    // Try matching by template name field
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const parsed = parseYaml(content) as Record<string, unknown>;
        if (parsed.name === name) return join(dir, file);
      } catch { /* skip */ }
    }

    return null;
  }
}
