export interface SkillMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  category: SkillCategory;
  tags?: string[];
  /** Full SKILL.md body content -- the actual skill instructions */
  instructions?: string;
  /** @deprecated Kept for backward compat with old manifest.json files; ignored by system */
  tools?: SkillToolDef[];
  requiredEnv?: string[];
  requiredPermissions?: ('shell' | 'file' | 'network' | 'browser')[];
  /** MCP servers this skill provides. Connected when the skill is activated on an agent. */
  mcpServers?: Record<string, SkillMcpServerConfig>;
  /** Filesystem path where this skill was loaded from */
  sourcePath?: string;
  /** Origin of this skill: skillhub, skillssh, local, builder */
  source?: string;
  sourceUrl?: string;
  /** True for skills shipped with Markus (templates/skills/) — auto-injected into all agents */
  builtIn?: boolean;
}

export type SkillCategory =
  | 'development'
  | 'devops'
  | 'communication'
  | 'data'
  | 'productivity'
  | 'browser'
  | 'custom';

/** @deprecated Tool definitions inside skills are no longer used */
export interface SkillToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SkillInstance {
  manifest: SkillManifest;
}

export interface SkillRegistry {
  register(skill: SkillInstance): void;
  unregister(skillName: string): void;
  get(skillName: string): SkillInstance | undefined;
  list(): SkillManifest[];
  /** Return instructions for all prompt-based skills in the given list */
  getInstructionsForSkills(skillNames: string[]): Map<string, string>;
  /** Return instructions for all builtin skills (auto-injected into every agent) */
  getBuiltinInstructions(): Map<string, string>;
}
