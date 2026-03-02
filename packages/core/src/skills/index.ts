export type { SkillManifest, SkillInstance, SkillRegistry, SkillCategory, SkillToolDef } from './types.js';
export { InMemorySkillRegistry } from './registry.js';
export { createGitSkill } from './builtin/git-skill.js';
export { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
export { createFeishuSkill } from './builtin/feishu-skill.js';
export { createBrowserSkill } from './builtin/browser-skill.js';
export { createGUISkill } from './builtin/gui-skill.js';
export { createAdvancedGUISkill } from './builtin/advanced-gui-skill.js';

import { InMemorySkillRegistry } from './registry.js';
import { createGitSkill } from './builtin/git-skill.js';
import { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
import { createFeishuSkill } from './builtin/feishu-skill.js';
import { createBrowserSkill } from './builtin/browser-skill.js';
import { createGUISkill } from './builtin/gui-skill.js';
import { createAdvancedGUISkill } from './builtin/advanced-gui-skill.js';

export interface SkillRegistryOptions {
  containerId?: string;
  screenshotDir?: string;
  enableAdvancedGUI?: boolean;
  debug?: boolean;
}

export async function createDefaultSkillRegistry(options?: SkillRegistryOptions): Promise<InMemorySkillRegistry> {
  const registry = new InMemorySkillRegistry();
  registry.register(createGitSkill());
  registry.register(createCodeAnalysisSkill());
  registry.register(createBrowserSkill());
  
  // Register GUI skill with container info if available
  if (options?.enableAdvancedGUI) {
    // Use advanced GUI skill with OmniParser integration
    const advancedGuiSkill = await createAdvancedGUISkill(
      options?.containerId,
      options?.screenshotDir,
      { debug: options?.debug }
    );
    registry.register(advancedGuiSkill);
  } else {
    // Use basic GUI skill
    const guiSkill = await createGUISkill(options?.containerId, options?.screenshotDir);
    registry.register(guiSkill);
  }

  if (process.env['FEISHU_APP_ID'] && process.env['FEISHU_APP_SECRET']) {
    registry.register(createFeishuSkill());
  }

  return registry;
}
