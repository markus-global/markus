export type { SkillManifest, SkillInstance, SkillRegistry, SkillCategory, SkillToolDef } from './types.js';
export { InMemorySkillRegistry } from './registry.js';
export { createGitSkill } from './builtin/git-skill.js';
export { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
export { createFeishuSkill } from './builtin/feishu-skill.js';
export { createBrowserSkill } from './builtin/browser-skill.js';
export { createGUISkill } from './builtin/gui-skill.js';
export { createAdvancedGUISkill } from './builtin/advanced-gui-skill.js';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createLogger } from '@markus/shared';
import { InMemorySkillRegistry } from './registry.js';
import { createGitSkill } from './builtin/git-skill.js';
import { createCodeAnalysisSkill } from './builtin/code-analysis-skill.js';
import { createFeishuSkill } from './builtin/feishu-skill.js';
import { createBrowserSkill } from './builtin/browser-skill.js';
import { createGUISkill } from './builtin/gui-skill.js';
import { createAdvancedGUISkill } from './builtin/advanced-gui-skill.js';
import { SkillLoader, createStubToolsFromManifest } from './loader.js';
import type { SkillManifest, SkillCategory, SkillInstance } from './types.js';

const log = createLogger('skill-registry');

export interface SkillRegistryOptions {
  containerId?: string;
  screenshotDir?: string;
  enableAdvancedGUI?: boolean;
  debug?: boolean;
  extraSkillDirs?: string[];
}

/**
 * Well-known skill directories scanned at startup:
 *   ~/.markus/skills/    — Markus native skills
 *   ~/.claude/skills/    — Claude Code skills (SKILL.md format)
 *   ~/.openclaw/skills/  — OpenClaw/ClawHub skills (manifest.json format)
 */
export const WELL_KNOWN_SKILL_DIRS = [
  join(homedir(), '.markus', 'skills'),
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];

/**
 * Parse a Claude Code SKILL.md file into a SkillManifest.
 * SKILL.md uses YAML frontmatter (name, description) + markdown body.
 */
function parseSkillMd(content: string, dirName: string): SkillManifest | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1]!;
  const getName = (s: string) => s.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  const getDesc = (s: string) => s.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';

  const name = getName(fm) || dirName;
  const description = getDesc(fm) || 'Claude Code skill';

  return {
    name,
    version: '1.0.0',
    description,
    author: 'community',
    category: 'custom' as SkillCategory,
    tags: ['claude-code'],
    tools: [],
  };
}

/**
 * Scan a single skill directory. Supports:
 *   - manifest.json (Markus / OpenClaw format)
 *   - SKILL.md (Claude Code format)
 */
export function discoverSkillsInDir(dir: string): Array<{ manifest: SkillManifest; path: string; source: string }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ manifest: SkillManifest; path: string; source: string }> = [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of names) {
    const skillDir = join(dir, name);
    try { if (!statSync(skillDir).isDirectory()) continue; } catch { continue; }

    // Markus / OpenClaw format: manifest.json
    const manifestPath = join(skillDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as SkillManifest;
        results.push({ manifest, path: skillDir, source: dir });
      } catch (err) {
        log.warn(`Invalid manifest.json in ${skillDir}: ${err}`);
      }
      continue;
    }

    // Claude Code format: SKILL.md
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (existsSync(skillMdPath)) {
      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const manifest = parseSkillMd(content, name);
        if (manifest) {
          results.push({ manifest, path: skillDir, source: dir });
        }
      } catch (err) {
        log.warn(`Invalid SKILL.md in ${skillDir}: ${err}`);
      }
      continue;
    }
  }

  return results;
}

export async function createDefaultSkillRegistry(options?: SkillRegistryOptions): Promise<InMemorySkillRegistry> {
  const registry = new InMemorySkillRegistry();
  registry.register(createGitSkill());
  registry.register(createCodeAnalysisSkill());
  registry.register(createBrowserSkill());
  
  if (options?.enableAdvancedGUI) {
    const advancedGuiSkill = await createAdvancedGUISkill(
      options?.containerId,
      options?.screenshotDir,
      { debug: options?.debug }
    );
    registry.register(advancedGuiSkill);
  } else {
    const guiSkill = await createGUISkill(options?.containerId, options?.screenshotDir);
    registry.register(guiSkill);
  }

  if (process.env['FEISHU_APP_ID'] && process.env['FEISHU_APP_SECRET']) {
    registry.register(createFeishuSkill());
  }

  // Scan well-known directories + any extra dirs
  const allDirs = [...WELL_KNOWN_SKILL_DIRS, ...(options?.extraSkillDirs ?? [])];
  for (const dir of allDirs) {
    const found = discoverSkillsInDir(dir);
    for (const { manifest, path: skillPath } of found) {
      if (registry.get(manifest.name)) {
        log.debug(`Skill ${manifest.name} already registered (builtin takes precedence), skipping ${skillPath}`);
        continue;
      }
      manifest.sourcePath = skillPath;
      const tools = manifest.tools.length > 0 ? createStubToolsFromManifest(manifest) : [];
      const instance: SkillInstance = { manifest, tools };
      registry.register(instance);
      log.info(`Loaded filesystem skill: ${manifest.name} from ${skillPath}`);
    }
  }

  return registry;
}
