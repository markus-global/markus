import { createLogger, readManifest } from '@markus/shared';
import type { SkillManifest, SkillInstance, SkillCategory } from './types.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const log = createLogger('skill-loader');

/**
 * Resolve ${SKILL_DIR} placeholders in MCP server args so skills can
 * reference bundled scripts relative to their own directory.
 */
function resolveMcpServerPaths(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined,
  skillDir: string,
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | undefined {
  if (!servers) return undefined;
  const resolved: typeof servers = {};
  for (const [name, cfg] of Object.entries(servers)) {
    resolved[name] = {
      ...cfg,
      args: cfg.args?.map(a => a.replaceAll('${SKILL_DIR}', skillDir)),
      env: cfg.env
        ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, v.replaceAll('${SKILL_DIR}', skillDir)]))
        : undefined,
    };
  }
  return resolved;
}

export interface SkillPackage {
  manifest: SkillManifest;
  readme?: string;
  path: string;
}

export interface SkillSearchResult {
  manifests: SkillManifest[];
  total: number;
}

export interface SkillLoadResult {
  loaded: SkillInstance[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Read SKILL.md from a skill directory, strip YAML frontmatter, return the instruction body.
 */
export function readSkillInstructions(skillDir: string): string | undefined {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return undefined;
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    return body || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads skills from a filesystem directory structure.
 * Each skill is a directory containing a SKILL.md (instructions) and/or manifest.json (metadata).
 */
export class SkillLoader {
  private loadedPackages = new Map<string, SkillPackage>();

  constructor(private skillDirs: string[] = []) {}

  addDirectory(dir: string): void {
    const resolved = resolve(dir);
    if (!this.skillDirs.includes(resolved)) {
      this.skillDirs.push(resolved);
    }
  }

  discoverSkills(): SkillPackage[] {
    const packages: SkillPackage[] = [];

    for (const dir of this.skillDirs) {
      if (!existsSync(dir)) {
        log.debug(`Skill directory does not exist: ${dir}`);
        continue;
      }

      const entries = readdirSync(dir, { withFileTypes: true });
      const fsHelper = { existsSync, readFileSync: (p: string, _enc: 'utf-8') => readFileSync(p, 'utf-8'), join };
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const pkg_ = readManifest(skillDir, 'skill', fsHelper);
        if (!pkg_ || pkg_.type !== 'skill') continue;

        try {
          const manifest: SkillManifest = {
            name: pkg_.name,
            version: pkg_.version,
            description: pkg_.description,
            author: pkg_.author ?? '',
            category: (pkg_.category ?? 'custom') as SkillCategory,
            tags: pkg_.tags,
            requiredPermissions: pkg_.skill?.requiredPermissions,
            mcpServers: resolveMcpServerPaths(pkg_.skill?.mcpServers, skillDir),
            sourcePath: skillDir,
          };

          const validation = this.validateManifest(manifest);

          if (!validation.valid) {
            log.warn(`Invalid manifest in ${skillDir}: ${validation.errors.join(', ')}`);
            continue;
          }

          const instructions = readSkillInstructions(skillDir);
          if (instructions) manifest.instructions = instructions;

          let readme: string | undefined;
          const readmePath = join(skillDir, 'README.md');
          if (existsSync(readmePath)) {
            readme = readFileSync(readmePath, 'utf-8');
          }

          const skillPkg: SkillPackage = { manifest, readme, path: skillDir };
          packages.push(skillPkg);
          this.loadedPackages.set(manifest.name, skillPkg);

          log.info(`Discovered skill: ${manifest.name} v${manifest.version}`, {
            category: manifest.category,
            hasInstructions: !!manifest.instructions,
          });
        } catch (err) {
          log.warn(`Failed to read skill at ${skillDir}`, { error: String(err) });
        }
      }
    }

    return packages;
  }

  validateManifest(manifest: SkillManifest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!manifest.name || typeof manifest.name !== 'string') errors.push('name is required');
    if (!manifest.version || typeof manifest.version !== 'string') errors.push('version is required');
    if (!manifest.description) errors.push('description is required');

    const validCategories: SkillCategory[] = ['development', 'devops', 'communication', 'data', 'productivity', 'browser', 'custom'];
    if (manifest.category && !validCategories.includes(manifest.category)) {
      errors.push(`category must be one of: ${validCategories.join(', ')}`);
    }

    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      errors.push('version must follow semver format (e.g. 1.0.0)');
    }

    return { valid: errors.length === 0, errors };
  }

  checkPermissions(manifest: SkillManifest, grantedPermissions: string[]): { allowed: boolean; missing: string[] } {
    const required = manifest.requiredPermissions ?? [];
    const missing = required.filter(p => !grantedPermissions.includes(p));
    return { allowed: missing.length === 0, missing };
  }

  checkEnvRequirements(manifest: SkillManifest): { satisfied: boolean; missing: string[] } {
    const required = manifest.requiredEnv ?? [];
    const missing = required.filter(v => !process.env[v]);
    return { satisfied: missing.length === 0, missing };
  }

  searchSkills(query?: { text?: string; category?: SkillCategory; tags?: string[] }): SkillSearchResult {
    let manifests = [...this.loadedPackages.values()].map(p => p.manifest);

    if (query?.category) {
      manifests = manifests.filter(m => m.category === query.category);
    }

    if (query?.tags?.length) {
      manifests = manifests.filter(m =>
        query.tags!.some(tag => m.tags?.includes(tag))
      );
    }

    if (query?.text) {
      const lower = query.text.toLowerCase();
      manifests = manifests.filter(m =>
        m.name.toLowerCase().includes(lower) ||
        m.description.toLowerCase().includes(lower) ||
        m.tags?.some(t => t.toLowerCase().includes(lower))
      );
    }

    return { manifests, total: manifests.length };
  }

  getPackage(name: string): SkillPackage | undefined {
    return this.loadedPackages.get(name);
  }

  listPackages(): SkillPackage[] {
    return [...this.loadedPackages.values()];
  }
}
