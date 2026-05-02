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
      skills: [],
      tags: ['development', 'coding', 'fullstack', 'backend', 'frontend'],
      category: 'development',
      icon: 'code',
      i18n: { 'zh-CN': { name: '全栈开发者', description: '全栈开发智能体，擅长代码编写、审查和调试，精通多种编程语言和框架。' } },
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
      skills: [],
      tags: ['review', 'quality', 'best-practices'],
      category: 'development',
      icon: 'search',
      i18n: { 'zh-CN': { name: '代码审查员', description: '专注于代码审查、质量保证和最佳实践执行，审查 PR 并提出改进建议。' } },
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
      skills: [],
      tags: ['management', 'planning', 'coordination', 'tracking'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'clipboard',
      i18n: { 'zh-CN': { name: '项目经理', description: '管理任务、协调团队成员、跟踪进度，确保项目里程碑按时完成。' } },
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
      skills: [],
      tags: ['testing', 'qa', 'automation', 'quality'],
      category: 'development',
      icon: 'check-circle',
      i18n: { 'zh-CN': { name: '质量工程师', description: '自动化测试专家，编写测试用例、执行集成测试，确保软件质量。' } },
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
      skills: [],
      tags: ['devops', 'ci-cd', 'infrastructure', 'deployment', 'monitoring'],
      category: 'devops',
      icon: 'server',
      i18n: { 'zh-CN': { name: 'DevOps 工程师', description: '基础设施、CI/CD、部署和监控专家，管理构建流水线和运行环境。' } },
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
      skills: [],
      tags: ['documentation', 'writing', 'api-docs'],
      category: 'productivity',
      icon: 'file-text',
      i18n: { 'zh-CN': { name: '技术文档工程师', description: '文档专家，创建和维护技术文档、API 参考和用户指南。' } },
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
      skills: [],
      tags: ['research', 'analysis', 'information-gathering'],
      category: 'general',
      icon: 'book-open',
      i18n: { 'zh-CN': { name: '研究助理', description: '收集信息、分析数据、总结发现，以循证研究支持决策制定。' } },
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
      skills: [],
      tags: ['hr', 'recruitment', 'onboarding', 'people', 'culture'],
      category: 'management',
      icon: 'users',
      i18n: { 'zh-CN': { name: '人力资源专员', description: '人力资源专家，负责招聘、入职、制度管理、员工关系和组织发展。' } },
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
      skills: [],
      tags: ['finance', 'budget', 'accounting', 'forecasting', 'reporting'],
      category: 'management',
      icon: 'dollar-sign',
      i18n: { 'zh-CN': { name: '财务分析师', description: '财务分析、预算编制、财务预测、费用追踪和财务报告专家。' } },
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
      skills: [],
      tags: ['marketing', 'content', 'seo', 'social-media', 'campaigns'],
      category: 'productivity',
      icon: 'megaphone',
      i18n: { 'zh-CN': { name: '市场营销专员', description: '市场营销策略、内容创作、活动管理、SEO/SEM、社交媒体和市场分析。' } },
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
      skills: [],
      tags: ['writing', 'content', 'blog', 'copywriting', 'seo'],
      category: 'productivity',
      icon: 'edit',
      i18n: { 'zh-CN': { name: '内容创作者', description: '创作博客文章、社交媒体内容、新闻通讯和营销文案，具备 SEO 意识。' } },
    },
    {
      id: 'tpl-customer-support',
      name: 'Customer Support',
      description: 'Handles customer inquiries, troubleshooting, ticket management, and deliverable management.',
      source: 'official',
      version: '1.0.0',
      author: 'Markus Team',
      roleId: 'support',
      agentRole: 'worker',
      skills: [],
      tags: ['support', 'customer-service', 'helpdesk', 'tickets'],
      category: 'general',
      icon: 'headphones',
      i18n: { 'zh-CN': { name: '客户支持', description: '处理客户咨询、故障排除、工单管理和交付物管理。' } },
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
      skills: [],
      tags: ['operations', 'process', 'efficiency', 'coordination'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'settings',
      i18n: { 'zh-CN': { name: '运营经理', description: '监督日常运营、流程优化、资源调配和跨部门协调。' } },
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
      skills: [],
      tags: ['product', 'strategy', 'roadmap', 'user-research'],
      category: 'management',
      heartbeatIntervalMs: 15 * 60 * 1000,
      icon: 'target',
      i18n: { 'zh-CN': { name: '产品经理', description: '产品策略、路线图规划、用户研究、功能优先级排序和利益相关者沟通。' } },
    },
  ];

  for (const tpl of builtins) {
    registry.register(tpl);
  }

  return registry;
}
