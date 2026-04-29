/**
 * procedural-memory.ts — Procedural Memory layer
 *
 * Manages skills, ROLE.md, and HEARTBEAT.md loading.
 * Provides on-demand discovery for the agent's procedural knowledge.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createLogger } from '@markus/shared';
import type {
  ProceduralMemoryConfig,
  SkillDef,
  ProceduralMemory,
} from './interfaces.js';

const log = createLogger('procedural-memory');

// =============================================================================
// ProceduralMemory — loading and discovery
// =============================================================================

/**
 * Load procedural memory from disk: ROLE.md, HEARTBEAT.md, and skill files.
 */
export async function loadProceduralMemory(
  config: ProceduralMemoryConfig,
): Promise<ProceduralMemory> {
  let role = '';
  let heartbeat = '';
  const skills: SkillDef[] = [];

  // Read ROLE.md
  try {
    if (existsSync(config.rolePath)) {
      role = readFileSync(config.rolePath, 'utf-8');
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Read HEARTBEAT.md
  try {
    if (existsSync(config.heartbeatPath)) {
      heartbeat = readFileSync(config.heartbeatPath, 'utf-8');
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Load skills from configured paths
  for (const sp of config.skillPaths) {
    try {
      if (existsSync(sp)) {
        const raw = readFileSync(sp, 'utf-8');
        const skill = parseSkillFile(sp, raw);
        if (skill) {
          skill.sourcePath = sp;
          skills.push(skill);
        }
      }
    } catch {
      // skip malformed files
    }
  }

  // Scan additional directories for skill manifests
  if (config.additionalScanDirs) {
    for (const dir of config.additionalScanDirs) {
      try {
        const scanned = await discoverSkillsInDir(dir);
        skills.push(...scanned);
      } catch {
        // skip unreachable directories
      }
    }
  }

  return { role, heartbeat, skills, config };
}

/**
 * Refresh procedural memory — reloads from disk.
 * Useful after ROLE.md or skill files have been updated.
 */
export async function refreshProceduralMemory(
  config: ProceduralMemoryConfig,
): Promise<ProceduralMemory> {
  return loadProceduralMemory(config);
}

// =============================================================================
// Skill discovery
// =============================================================================

/**
 * Discover skills by scanning a directory for manifest files.
 * Supports:
 * - SKILL.md (Markdown format with YAML frontmatter or headings)
 * - manifest.json (JSON format)
 */
export async function discoverSkillsInDir(
  dir: string,
): Promise<SkillDef[]> {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  try {
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir, { withFileTypes: true });
    const skills: SkillDef[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(dir, entry.name);

      // Check for SKILL.md
      const skillMdPath = join(skillDir, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        try {
          const raw = readFileSync(skillMdPath, 'utf-8');
          const skill = parseSkillMarkdown(raw);
          skill.name = skill.name || entry.name;
          skill.sourcePath = skillMdPath;
          skills.push(skill);
          continue;
        } catch {
          // fall through
        }
      }

      // Check for manifest.json
      const manifestPath = join(skillDir, 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const raw = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw);
          skills.push({
            name: manifest.name ?? entry.name,
            version: manifest.version,
            description: manifest.description ?? '',
            handler: manifest.handler,
            sourcePath: manifestPath,
          });
        } catch {
          // skip malformed manifests
        }
      }
    }

    return skills;
  } catch {
    return [];
  }
}

// =============================================================================
// File parsers
// =============================================================================

/**
 * Parse a skill file into a SkillDef.
 * Supports .json (manifest), .md (markdown), .yaml (simple key-value).
 */
function parseSkillFile(
  filePath: string,
  raw: string,
): SkillDef | null {
  if (filePath.endsWith('.json')) {
    try {
      const manifest = JSON.parse(raw);
      return {
        name: manifest.name ?? 'unknown',
        version: manifest.version,
        description: manifest.description ?? '',
        triggers: manifest.triggers,
        handler: manifest.handler,
      };
    } catch {
      return null;
    }
  }

  if (filePath.endsWith('.md') || filePath.endsWith('.yaml')) {
    return parseSkillMarkdown(raw);
  }

  return null;
}

/**
 * Parse a SKILL.md file (Markdown with optional YAML frontmatter).
 * Extracts name from first heading, description from frontmatter/body.
 */
function parseSkillMarkdown(raw: string): SkillDef {
  const name = raw.match(/^#\s+(.+)$/m)?.[1] ?? 'unknown';
  const description =
    raw.match(/description:\s*(.+)$/im)?.[1] ??
    raw.match(/^#\s+.+?\n\n(.+?)(?:\n##|\n$)/s)?.[1]?.trim() ??
    '';
  const triggersMatch = raw.match(/triggers:\s*\[(.*?)\]/s);
  const triggers = triggersMatch
    ? triggersMatch[1]!.split(',').map((t: string) => t.trim().replace(/['"]/g, ''))
    : undefined;

  return {
    name,
    description: description.replace(/['"]/g, '').trim(),
    triggers,
  };
}

/**
 * Filter skills by trigger keywords.
 * Useful for on-demand loading: only return skills relevant to the current query.
 */
export function filterSkillsByTrigger(
  skills: SkillDef[],
  keywords: string[],
): SkillDef[] {
  if (!keywords.length) return skills;
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  return skills.filter((skill) => {
    if (!skill.triggers || skill.triggers.length === 0) return false;
    return skill.triggers.some((t) =>
      lowerKeywords.some((k) => t.toLowerCase().includes(k)),
    );
  });
}

/**
 * Get all unique trigger words from a list of skills.
 */
export function getAllTriggers(skills: SkillDef[]): string[] {
  const triggerSet = new Set<string>();
  for (const skill of skills) {
    for (const t of skill.triggers ?? []) {
      triggerSet.add(t);
    }
  }
  return [...triggerSet];
}
