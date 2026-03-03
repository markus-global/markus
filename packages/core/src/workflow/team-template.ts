import { createLogger, generateId } from '@markus/shared';
import type { AgentTemplate } from '../templates/types.js';
import type { WorkflowDefinition } from './types.js';

const log = createLogger('team-template');

export interface TeamMemberSpec {
  templateId: string;
  name?: string;
  count?: number;
  role?: 'manager' | 'worker';
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

/**
 * Create the default set of team templates covering common software development scenarios.
 */
export function createDefaultTeamTemplates(): TeamTemplateRegistry {
  const registry = new TeamTemplateRegistry();

  const builtins: TeamTemplate[] = [
    {
      id: 'team-dev-squad',
      name: 'Development Squad',
      description: 'A full development team with PM, developers, and QA. Suitable for feature development sprints.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-project-manager', name: 'PM', count: 1, role: 'manager' },
        { templateId: 'tpl-developer', name: 'Developer', count: 2, role: 'worker' },
        { templateId: 'tpl-reviewer', name: 'Code Reviewer', count: 1, role: 'worker' },
        { templateId: 'tpl-qa-engineer', name: 'QA', count: 1, role: 'worker' },
      ],
      tags: ['development', 'agile', 'sprint', 'feature'],
      category: 'development',
      icon: 'users',
    },
    {
      id: 'team-code-review',
      name: 'Code Review Team',
      description: 'Developer + Reviewer pair for code review workflows. Developer writes, reviewer checks.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-developer', name: 'Author', count: 1 },
        { templateId: 'tpl-reviewer', name: 'Reviewer', count: 1 },
      ],
      tags: ['review', 'quality', 'pair'],
      category: 'development',
      icon: 'git-pull-request',
    },
    {
      id: 'team-devops-pipeline',
      name: 'DevOps Pipeline Team',
      description: 'DevOps engineer + Developer for CI/CD setup and infrastructure automation.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-devops', name: 'DevOps Lead', count: 1, role: 'manager' },
        { templateId: 'tpl-developer', name: 'Developer', count: 1 },
      ],
      tags: ['devops', 'ci-cd', 'infrastructure'],
      category: 'devops',
      icon: 'server',
    },
    {
      id: 'team-docs-squad',
      name: 'Documentation Squad',
      description: 'Technical writer + Research assistant for comprehensive documentation projects.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-tech-writer', name: 'Lead Writer', count: 1, role: 'manager' },
        { templateId: 'tpl-research-assistant', name: 'Researcher', count: 1 },
        { templateId: 'tpl-reviewer', name: 'Editor', count: 1 },
      ],
      tags: ['documentation', 'writing', 'research'],
      category: 'productivity',
      icon: 'book',
    },
    {
      id: 'team-full-stack',
      name: 'Full Stack Team',
      description: 'Complete team for end-to-end product development: PM, developers, QA, DevOps, and docs.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-project-manager', name: 'Product Manager', count: 1, role: 'manager' },
        { templateId: 'tpl-developer', name: 'Developer', count: 3 },
        { templateId: 'tpl-reviewer', name: 'Senior Reviewer', count: 1 },
        { templateId: 'tpl-qa-engineer', name: 'QA Engineer', count: 1 },
        { templateId: 'tpl-devops', name: 'DevOps', count: 1 },
        { templateId: 'tpl-tech-writer', name: 'Tech Writer', count: 1 },
      ],
      tags: ['full-stack', 'complete', 'product', 'enterprise'],
      category: 'management',
      icon: 'briefcase',
    },
    {
      id: 'team-marketing',
      name: 'Marketing Team',
      description: 'Content-driven marketing team: strategist, content writer, and research support for campaigns and brand building.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-marketing-specialist', name: 'Marketing Lead', count: 1, role: 'manager' },
        { templateId: 'tpl-content-writer', name: 'Content Writer', count: 2 },
        { templateId: 'tpl-research-assistant', name: 'Market Researcher', count: 1 },
      ],
      tags: ['marketing', 'content', 'campaigns', 'brand'],
      category: 'general',
      icon: 'megaphone',
    },
    {
      id: 'team-hr',
      name: 'HR & People Team',
      description: 'Human resources team handling recruitment, onboarding, employee relations, and organizational culture.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-hr-specialist', name: 'HR Manager', count: 1, role: 'manager' },
        { templateId: 'tpl-hr-specialist', name: 'Recruiter', count: 1 },
        { templateId: 'tpl-content-writer', name: 'HR Communications', count: 1 },
      ],
      tags: ['hr', 'recruitment', 'people', 'culture', 'onboarding'],
      category: 'general',
      icon: 'users',
    },
    {
      id: 'team-finance',
      name: 'Finance & Accounting Team',
      description: 'Financial operations team: budgeting, reporting, forecasting, and financial analysis.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-operations-manager', name: 'Finance Director', count: 1, role: 'manager' },
        { templateId: 'tpl-finance-analyst', name: 'Financial Analyst', count: 2 },
        { templateId: 'tpl-research-assistant', name: 'Data Analyst', count: 1 },
      ],
      tags: ['finance', 'accounting', 'budget', 'reporting', 'analysis'],
      category: 'general',
      icon: 'dollar-sign',
    },
    {
      id: 'team-customer-success',
      name: 'Customer Success Team',
      description: 'Customer-facing team for support, success management, and knowledge base maintenance.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-operations-manager', name: 'CS Manager', count: 1, role: 'manager' },
        { templateId: 'tpl-customer-support', name: 'Support Agent', count: 2 },
        { templateId: 'tpl-tech-writer', name: 'Knowledge Base Writer', count: 1 },
      ],
      tags: ['support', 'customer-success', 'helpdesk', 'knowledge-base'],
      category: 'general',
      icon: 'headphones',
    },
    {
      id: 'team-product',
      name: 'Product Team',
      description: 'Product management team for strategy, research, and roadmap planning with cross-functional coordination.',
      version: '1.0.0',
      author: 'Markus Team',
      members: [
        { templateId: 'tpl-product-manager', name: 'Head of Product', count: 1, role: 'manager' },
        { templateId: 'tpl-research-assistant', name: 'UX Researcher', count: 1 },
        { templateId: 'tpl-content-writer', name: 'Product Writer', count: 1 },
        { templateId: 'tpl-developer', name: 'Technical Advisor', count: 1 },
      ],
      tags: ['product', 'strategy', 'research', 'roadmap', 'ux'],
      category: 'management',
      icon: 'target',
    },
  ];

  for (const tpl of builtins) {
    registry.register(tpl);
  }

  return registry;
}
