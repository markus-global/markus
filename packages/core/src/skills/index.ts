export type { SkillManifest, SkillInstance, SkillRegistry, SkillCategory, SkillToolDef } from './types.js';
export { InMemorySkillRegistry } from './registry.js';
export { createGitSkill } from './builtin/git-skill.js';
export { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';

import { InMemorySkillRegistry } from './registry.js';
import { createGitSkill } from './builtin/git-skill.js';
import { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';

export function createDefaultSkillRegistry(): InMemorySkillRegistry {
  const registry = new InMemorySkillRegistry();
  registry.register(createGitSkill());
  registry.register(createCodeAnalysisSkill());
  return registry;
}
