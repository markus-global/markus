export type { SkillManifest, SkillInstance, SkillRegistry, SkillCategory, SkillToolDef } from './types.js';
export { InMemorySkillRegistry } from './registry.js';
export { createGitSkill } from './builtin/git-skill.js';
export { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
export { createFeishuSkill } from './builtin/feishu-skill.js';
export { createBrowserSkill } from './builtin/browser-skill.js';

import { InMemorySkillRegistry } from './registry.js';
import { createGitSkill } from './builtin/git-skill.js';
import { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
import { createFeishuSkill } from './builtin/feishu-skill.js';
import { createBrowserSkill } from './builtin/browser-skill.js';

export function createDefaultSkillRegistry(): InMemorySkillRegistry {
  const registry = new InMemorySkillRegistry();
  registry.register(createGitSkill());
  registry.register(createCodeAnalysisSkill());
  registry.register(createBrowserSkill());

  if (process.env['FEISHU_APP_ID'] && process.env['FEISHU_APP_SECRET']) {
    registry.register(createFeishuSkill());
  }

  return registry;
}
