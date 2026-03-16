import { createLogger, generateId } from '@markus/shared';
import type { AgentTemplate } from '../templates/types.js';
import type { WorkflowDefinition } from './types.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('team-template');

export interface TeamMemberSpec {
  templateId?: string;
  roleName?: string;
  name?: string;
  count?: number;
  role?: 'manager' | 'worker';
  description?: string;
  systemPrompt?: string;
  skills?: string[];
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  members: TeamMemberSpec[];
  /** Optional workflow that defines how team members collaborate */
  workflow?: WorkflowDefinition;
  tags?: string[];
  category?: string;
  icon?: string;
  announcements?: string;
  norms?: string;
}

export interface TeamInstantiateRequest {
  teamTemplateId: string;
  teamName: string;
  orgId: string;
  overrides?: Record<string, Partial<{ name: string; agentId: string }>>;
}

export interface TeamInstantiateResult {
  teamId: string;
  teamName: string;
  agents: Array<{ id: string; name: string; templateId: string; role: string }>;
  workflowId?: string;
}

export class TeamTemplateRegistry {
  private templates = new Map<string, TeamTemplate>();

  register(template: TeamTemplate): void {
    this.templates.set(template.id, template);
    log.info(`Team template registered: ${template.name}`, {
      members: template.members.length,
      hasWorkflow: !!template.workflow,
    });
  }

  unregister(id: string): void {
    this.templates.delete(id);
  }

  get(id: string): TeamTemplate | undefined {
    return this.templates.get(id);
  }

  list(): TeamTemplate[] {
    return [...this.templates.values()];
  }

  search(query: string): TeamTemplate[] {
    const lower = query.toLowerCase();
    return this.list().filter(t =>
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.tags?.some(tag => tag.toLowerCase().includes(lower))
    );
  }
}

function loadTeamTemplateFromDir(dirPath: string): TeamTemplate | null {
  const teamJsonPath = join(dirPath, 'team.json');
  const membersJsonPath = join(dirPath, 'members.json');

  if (!existsSync(teamJsonPath)) return null;

  try {
    const meta = JSON.parse(readFileSync(teamJsonPath, 'utf-8'));
    const membersData = existsSync(membersJsonPath)
      ? JSON.parse(readFileSync(membersJsonPath, 'utf-8'))
      : { members: [] };

    const annPath = join(dirPath, 'ANNOUNCEMENT.md');
    const normsPath = join(dirPath, 'NORMS.md');

    return {
      id: meta.id ?? dirPath.split('/').pop() ?? generateId('tpl'),
      name: meta.name ?? 'Unnamed Team',
      description: meta.description ?? '',
      version: meta.version ?? '1.0.0',
      author: meta.author ?? 'Unknown',
      members: (membersData.members ?? []).map((m: Record<string, unknown>) => ({
        templateId: m.templateId as string | undefined,
        roleName: m.roleName as string | undefined,
        name: m.name as string | undefined,
        count: m.count as number | undefined,
        role: m.role as 'manager' | 'worker' | undefined,
        description: m.description as string | undefined,
        systemPrompt: m.systemPrompt as string | undefined,
        skills: Array.isArray(m.skills) ? m.skills as string[] : typeof m.skills === 'string' ? (m.skills as string).split(',').map((s: string) => s.trim()).filter(Boolean) : [],
      })),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      category: meta.category,
      icon: meta.icon,
      announcements: existsSync(annPath) ? readFileSync(annPath, 'utf-8') : undefined,
      norms: existsSync(normsPath) ? readFileSync(normsPath, 'utf-8') : undefined,
    };
  } catch (err) {
    log.warn(`Failed to load team template from ${dirPath}`, { error: String(err) });
    return null;
  }
}

/**
 * Load team templates from the templates/teams/ directory.
 * Each subdirectory should contain team.json, members.json, ANNOUNCEMENT.md, NORMS.md.
 */
export function createDefaultTeamTemplates(): TeamTemplateRegistry {
  const registry = new TeamTemplateRegistry();

  // Resolve templates/teams/ relative to the package root
  let templatesDir: string;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // packages/core/src/workflow/team-template.ts -> root/templates/teams
    templatesDir = resolve(dirname(thisFile), '..', '..', '..', '..', 'templates', 'teams');
  } catch {
    templatesDir = resolve(process.cwd(), 'templates', 'teams');
  }

  if (!existsSync(templatesDir)) {
    log.warn(`Team templates directory not found: ${templatesDir}`);
    return registry;
  }

  const entries = readdirSync(templatesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tpl = loadTeamTemplateFromDir(join(templatesDir, entry.name));
    if (tpl) {
      registry.register(tpl);
    }
  }

  log.info(`Loaded ${registry.list().length} team templates from ${templatesDir}`);
  return registry;
}
