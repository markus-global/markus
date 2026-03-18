export type { SkillManifest, SkillMcpServerConfig, SkillInstance, SkillRegistry, SkillCategory, SkillToolDef } from './types.js';
export { InMemorySkillRegistry } from './registry.js';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createLogger, readManifest } from '@markus/shared';
import { InMemorySkillRegistry } from './registry.js';
import { readSkillInstructions } from './loader.js';
import type { SkillManifest, SkillCategory } from './types.js';

const log = createLogger('skill-registry');

export interface SkillRegistryOptions {
  extraSkillDirs?: string[];
}

/**
 * Well-known skill directories scanned at startup:
 *   ~/.markus/skills/    — Markus native skills
 *   ~/.claude/skills/    — Claude Code skills (SKILL.md format)
 *   ~/.openclaw/skills/  — OpenClaw/ClawHub skills
 */
export const WELL_KNOWN_SKILL_DIRS = [
  join(homedir(), '.markus', 'skills'),
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];

/**
 * Parse a Claude Code SKILL.md file into a SkillManifest.
 * Extracts name/description from YAML frontmatter, stores markdown body as instructions.
 */
function parseSkillMd(content: string, dirName: string): SkillManifest | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    // No frontmatter -- treat entire content as instructions
    return {
      name: dirName,
      version: '1.0.0',
      description: `Skill: ${dirName}`,
      author: 'community',
      category: 'custom' as SkillCategory,
      tags: [],
      instructions: content.trim() || undefined,
    };
  }

  const fm = fmMatch[1]!;
  const getName = (s: string) => s.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  const getDesc = (s: string) => s.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';

  const name = getName(fm) || dirName;
  const description = getDesc(fm) || `Skill: ${name}`;
  const body = content.slice(fmMatch[0].length).trim();

  return {
    name,
    version: '1.0.0',
    description,
    author: 'community',
    category: 'custom' as SkillCategory,
    tags: [],
    instructions: body || undefined,
  };
}

/**
 * Scan a single skill directory. Supports:
 *   - manifest.json (Markus / OpenClaw format) -- also reads sibling SKILL.md for instructions
 *   - SKILL.md (Claude Code format) -- parsed for frontmatter + instructions
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

    const fsHelper = { existsSync, readFileSync: (p: string, _enc: 'utf-8') => readFileSync(p, 'utf-8'), join };
    const pkg = readManifest(skillDir, 'skill', fsHelper);
    if (pkg && pkg.type === 'skill') {
      const instructions = readSkillInstructions(skillDir);
      const manifest: SkillManifest = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        author: pkg.author ?? '',
        category: (pkg.category ?? 'custom') as SkillCategory,
        tags: pkg.tags,
        instructions: instructions ?? undefined,
        requiredPermissions: pkg.skill?.requiredPermissions,
        mcpServers: pkg.skill?.mcpServers,
        sourcePath: skillDir,
      };
      results.push({ manifest, path: skillDir, source: dir });
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

/**
 * Create the default skill registry by scanning well-known directories.
 * Skills are prompt-based instruction packages (SKILL.md), not tool providers.
 */
export async function createDefaultSkillRegistry(options?: SkillRegistryOptions): Promise<InMemorySkillRegistry> {
  const registry = new InMemorySkillRegistry();

  const allDirs = [...WELL_KNOWN_SKILL_DIRS, ...(options?.extraSkillDirs ?? [])];
  for (const dir of allDirs) {
    const found = discoverSkillsInDir(dir);
    for (const { manifest, path: skillPath } of found) {
      if (registry.get(manifest.name)) {
        log.debug(`Skill ${manifest.name} already registered, skipping ${skillPath}`);
        continue;
      }
      manifest.sourcePath = skillPath;
      registry.register({ manifest });
      log.info(`Loaded skill: ${manifest.name} from ${skillPath}`, {
        hasInstructions: !!manifest.instructions,
      });
    }
  }

  return registry;
}
