import { createLogger } from '@markus/shared';
import type { AgentTemplate, TemplateSearchQuery, TemplateSearchResult, TemplateSource } from './types.js';

const log = createLogger('template-registry');

export class TemplateRegistry {
  private templates = new Map<string, AgentTemplate>();

  register(template: AgentTemplate): void {
    this.templates.set(template.id, template);
    log.info(`Template registered: ${template.name} (${template.id})`, {
      source: template.source,
      category: template.category,
    });
  }

  unregister(id: string): void {
    this.templates.delete(id);
  }

  get(id: string): AgentTemplate | undefined {
    return this.templates.get(id);
  }

  list(source?: TemplateSource): AgentTemplate[] {
    const all = [...this.templates.values()];
    if (source) return all.filter(t => t.source === source);
    return all;
  }

  search(query: TemplateSearchQuery): TemplateSearchResult {
    let results = [...this.templates.values()];

    if (query.source) results = results.filter(t => t.source === query.source);
    if (query.category) results = results.filter(t => t.category === query.category);
    if (query.agentRole) results = results.filter(t => t.agentRole === query.agentRole);
    if (query.tags?.length) {
      results = results.filter(t => query.tags!.some(tag => t.tags.includes(tag)));
    }
    if (query.text) {
      const lower = query.text.toLowerCase();
      results = results.filter(t =>
        t.name.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower) ||
        t.tags.some(tag => tag.toLowerCase().includes(lower))
      );
    }

    return { templates: results, total: results.length };
  }
}

export function createDefaultTemplateRegistry(): TemplateRegistry {
  const registry = new TemplateRegistry();

  const builtins: AgentTemplate[] = [
    {
      id: 'tpl-developer',
      name: 'Developer',
      description: 'Full-stack developer agent for writing, reviewing, and debugging code. Proficient in multiple languages and frameworks.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'developer',
      agentRole: 'worker',
      skills: ['git', 'code-analysis', 'browser'],
      tags: ['development', 'coding', 'fullstack', 'backend', 'frontend'],
      category: 'development',
      icon: 'code',
    },
    {
      id: 'tpl-reviewer',
      name: 'Code Reviewer',
      description: 'Specialized in code review, quality assurance, and best practices enforcement. Reviews PRs and suggests improvements.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'reviewer',
      agentRole: 'worker',
      skills: ['git', 'code-analysis'],
      tags: ['review', 'quality', 'best-practices'],
      category: 'development',
      icon: 'search',
    },
    {
      id: 'tpl-project-manager',
      name: 'Project Manager',
      description: 'Manages tasks, coordinates team members, tracks progress, and ensures project milestones are met.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'project-manager',
      agentRole: 'manager',
      skills: ['git'],
      tags: ['management', 'planning', 'coordination', 'tracking'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'clipboard',
    },
    {
      id: 'tpl-qa-engineer',
      name: 'QA Engineer',
      description: 'Automated testing specialist. Writes tests, performs integration testing, and ensures software quality.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'qa-engineer',
      agentRole: 'worker',
      skills: ['git', 'code-analysis', 'browser'],
      tags: ['testing', 'qa', 'automation', 'quality'],
      category: 'development',
      icon: 'check-circle',
    },
    {
      id: 'tpl-devops',
      name: 'DevOps Engineer',
      description: 'Infrastructure, CI/CD, deployment, and monitoring specialist. Manages build pipelines and environments.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'devops',
      agentRole: 'worker',
      skills: ['git', 'code-analysis'],
      tags: ['devops', 'ci-cd', 'infrastructure', 'deployment', 'monitoring'],
      category: 'devops',
      icon: 'server',
    },
    {
      id: 'tpl-tech-writer',
      name: 'Technical Writer',
      description: 'Documentation specialist. Creates and maintains technical docs, API references, and user guides.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'tech-writer',
      agentRole: 'worker',
      skills: ['git', 'code-analysis'],
      tags: ['documentation', 'writing', 'api-docs'],
      category: 'productivity',
      icon: 'file-text',
    },
    {
      id: 'tpl-research-assistant',
      name: 'Research Assistant',
      description: 'Gathers information, analyzes data, summarizes findings, and supports decision-making with evidence-based research.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'research-assistant',
      agentRole: 'worker',
      skills: ['browser', 'code-analysis'],
      tags: ['research', 'analysis', 'information-gathering'],
      category: 'general',
      icon: 'book-open',
    },
  ];

  for (const tpl of builtins) {
    registry.register(tpl);
  }

  return registry;
}
