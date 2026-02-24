import type { AgentToolHandler } from '../agent.js';

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  category: SkillCategory;
  tags?: string[];
  tools: SkillToolDef[];
  requiredEnv?: string[];
  requiredPermissions?: ('shell' | 'file' | 'network' | 'browser')[];
}

export type SkillCategory =
  | 'development'
  | 'devops'
  | 'communication'
  | 'data'
  | 'productivity'
  | 'browser'
  | 'custom';

export interface SkillToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillInstance {
  manifest: SkillManifest;
  tools: AgentToolHandler[];
}

export interface SkillRegistry {
  register(skill: SkillInstance): void;
  unregister(skillName: string): void;
  get(skillName: string): SkillInstance | undefined;
  list(): SkillManifest[];
  getToolsForSkills(skillNames: string[]): AgentToolHandler[];
}
