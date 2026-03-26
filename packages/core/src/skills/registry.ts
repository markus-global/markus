import { createLogger } from '@markus/shared';
import type { SkillInstance, SkillManifest, SkillRegistry } from './types.js';

const log = createLogger('skill-registry');

export class InMemorySkillRegistry implements SkillRegistry {
  private skills = new Map<string, SkillInstance>();
  private aliases = new Map<string, string>();

  private static normalize(s: string): string {
    return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  register(skill: SkillInstance): void {
    const name = skill.manifest.name;
    if (this.skills.has(name)) {
      log.warn(`Skill ${name} already registered, overwriting`);
    }
    this.skills.set(name, skill);
    this.aliases.set(InMemorySkillRegistry.normalize(name), name);
    log.info(`Skill registered: ${name} v${skill.manifest.version}`, {
      hasInstructions: !!skill.manifest.instructions,
    });
  }

  unregister(skillName: string): void {
    this.skills.delete(skillName);
    this.aliases.delete(InMemorySkillRegistry.normalize(skillName));
    log.info(`Skill unregistered: ${skillName}`);
  }

  get(skillName: string): SkillInstance | undefined {
    return this.skills.get(skillName)
      ?? this.skills.get(this.aliases.get(InMemorySkillRegistry.normalize(skillName)) ?? '');
  }

  list(): SkillManifest[] {
    return [...this.skills.values()].map(s => s.manifest);
  }

  getInstructionsForSkills(skillNames: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const name of skillNames) {
      const skill = this.get(name);
      if (skill?.manifest.instructions) {
        result.set(name, skill.manifest.instructions);
      }
    }
    return result;
  }

  getBuiltinInstructions(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, skill] of this.skills) {
      if (skill.manifest.builtIn && skill.manifest.instructions) {
        result.set(name, skill.manifest.instructions);
      }
    }
    return result;
  }
}
