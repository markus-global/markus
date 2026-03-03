import { createLogger } from '@markus/shared';
import type { AgentTemplate, TemplateSearchQuery, TemplateSearchResult, TemplateSource } from './types.js';

const log = createLogger('template-registry');

/**
 * Persistence adapter for storing templates in a database.
 * Implement this interface to connect the registry to your storage layer.
 */
export interface TemplatePersistenceAdapter {
  loadPublished(): Promise<AgentTemplate[]>;
  save(template: AgentTemplate): Promise<void>;
  remove(id: string): Promise<void>;
}

export class TemplateRegistry {
  private templates = new Map<string, AgentTemplate>();
  private persistence?: TemplatePersistenceAdapter;

  setPersistenceAdapter(adapter: TemplatePersistenceAdapter): void {
    this.persistence = adapter;
  }

  /**
   * Load published community/custom templates from DB into memory.
   * Call this on startup after setting the persistence adapter.
   */
  async syncFromDatabase(): Promise<number> {
    if (!this.persistence) return 0;
    try {
      const dbTemplates = await this.persistence.loadPublished();
      let loaded = 0;
      for (const tpl of dbTemplates) {
        if (!this.templates.has(tpl.id)) {
          this.templates.set(tpl.id, tpl);
          loaded++;
        }
      }
      log.info(`Synced ${loaded} templates from database`, { total: this.templates.size });
      return loaded;
    } catch (err) {
      log.warn('Failed to sync templates from database', { error: String(err) });
      return 0;
    }
  }

  register(template: AgentTemplate): void {
    this.templates.set(template.id, template);
    log.info(`Template registered: ${template.name} (${template.id})`, {
      source: template.source,
      category: template.category,
    });
  }

  /**
   * Register and persist a template to the database.
   */
  async registerAndPersist(template: AgentTemplate): Promise<void> {
    this.register(template);
    if (this.persistence) {
      await this.persistence.save(template);
    }
  }

  unregister(id: string): void {
    this.templates.delete(id);
  }

  async unregisterAndRemove(id: string): Promise<void> {
    this.unregister(id);
    if (this.persistence) {
      await this.persistence.remove(id);
    }
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
    {
      id: 'tpl-hr-specialist',
      name: 'HR Specialist',
      description: 'Human resources specialist handling recruitment, onboarding, policy management, employee relations, and organizational development.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'hr',
      agentRole: 'worker',
      skills: ['browser'],
      tags: ['hr', 'recruitment', 'onboarding', 'people', 'culture'],
      category: 'management',
      icon: 'users',
    },
    {
      id: 'tpl-finance-analyst',
      name: 'Finance Analyst',
      description: 'Financial analysis, budgeting, forecasting, expense tracking, and financial reporting specialist.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'finance',
      agentRole: 'worker',
      skills: ['browser', 'code-analysis'],
      tags: ['finance', 'budget', 'accounting', 'forecasting', 'reporting'],
      category: 'management',
      icon: 'dollar-sign',
    },
    {
      id: 'tpl-marketing-specialist',
      name: 'Marketing Specialist',
      description: 'Marketing strategy, content creation, campaign management, SEO/SEM, social media, and market analysis.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'marketing',
      agentRole: 'worker',
      skills: ['browser'],
      tags: ['marketing', 'content', 'seo', 'social-media', 'campaigns'],
      category: 'productivity',
      icon: 'megaphone',
    },
    {
      id: 'tpl-content-writer',
      name: 'Content Writer',
      description: 'Creates blog posts, articles, social media content, newsletters, and marketing copy with SEO awareness.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'content-writer',
      agentRole: 'worker',
      skills: ['browser'],
      tags: ['writing', 'content', 'blog', 'copywriting', 'seo'],
      category: 'productivity',
      icon: 'edit',
    },
    {
      id: 'tpl-customer-support',
      name: 'Customer Support',
      description: 'Handles customer inquiries, troubleshooting, ticket management, and knowledge base maintenance.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'support',
      agentRole: 'worker',
      skills: ['browser'],
      tags: ['support', 'customer-service', 'helpdesk', 'tickets'],
      category: 'general',
      icon: 'headphones',
    },
    {
      id: 'tpl-operations-manager',
      name: 'Operations Manager',
      description: 'Oversees daily operations, process optimization, resource allocation, and cross-functional coordination.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'operations',
      agentRole: 'manager',
      skills: ['browser'],
      tags: ['operations', 'process', 'efficiency', 'coordination'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'settings',
    },
    {
      id: 'tpl-product-manager',
      name: 'Product Manager',
      description: 'Product strategy, roadmap planning, user research, feature prioritization, and stakeholder communication.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'product-manager',
      agentRole: 'manager',
      skills: ['browser', 'code-analysis'],
      tags: ['product', 'strategy', 'roadmap', 'user-research'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'target',
    },
  ];

  for (const tpl of builtins) {
    registry.register(tpl);
  }

  return registry;
}
