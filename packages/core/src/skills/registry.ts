import { createLogger } from '@markus/shared';
import type { SkillInstance, SkillManifest, SkillRegistry } from './types.js';

const log = createLogger('skill-registry');

export class InMemorySkillRegistry implements SkillRegistry {
  private skills = new Map<string, SkillInstance>();

  register(skill: SkillInstance): void {
    if (this.skills.has(skill.manifest.name)) {
      log.warn(`Skill ${skill.manifest.name} already registered, overwriting`);
    }
    this.skills.set(skill.manifest.name, skill);
    log.info(`Skill registered: ${skill.manifest.name} v${skill.manifest.version}`, {
      hasInstructions: !!skill.manifest.instructions,
    });
  }

  unregister(skillName: string): void {
    this.skills.delete(skillName);
    log.info(`Skill unregistered: ${skillName}`);
  }

  get(skillName: string): SkillInstance | undefined {
    return this.skills.get(skillName);
  }

  list(): SkillManifest[] {
    return [...this.skills.values()].map(s => s.manifest);
  }

  getInstructionsForSkills(skillNames: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (skill?.manifest.instructions) {
        result.set(name, skill.manifest.instructions);
      }
    }
    return result;
  }
}
