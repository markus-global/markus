import type { SkillCategory } from '../skills/types.js';

export type TemplateSource = 'official' | 'community' | 'custom';

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  source: TemplateSource;
  version: string;
  author: string;

  /** Role template folder name (for RoleLoader) */
  roleId: string;

  /** Default agent role */
  agentRole: 'manager' | 'worker';

  /** Skills to enable */
  skills: string[];

  /** Preferred LLM provider (optional override) */
  llmProvider?: string;

  /** Tags for search/discovery */
  tags: string[];
  category: SkillCategory | 'management' | 'general';

  /** Heartbeat interval override */
  heartbeatIntervalMs?: number;

  /** Initial tasks to create on agent startup */
  starterTasks?: Array<{
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high';
  }>;

  /** Icon identifier for UI */
  icon?: string;
}

export interface TemplateSearchQuery {
  text?: string;
  category?: string;
  source?: TemplateSource;
  tags?: string[];
  agentRole?: 'manager' | 'worker';
}

export interface TemplateSearchResult {
  templates: AgentTemplate[];
  total: number;
}

export interface TemplateInstantiateRequest {
  templateId: string;
  name: string;
  orgId?: string;
  teamId?: string;
  overrides?: Partial<Pick<AgentTemplate, 'skills' | 'llmProvider' | 'heartbeatIntervalMs'>>;
}
