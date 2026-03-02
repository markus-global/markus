import { createLogger } from '@markus/shared';
import type { SkillManifest, SkillInstance, SkillCategory } from './types.js';
import type { AgentToolHandler } from '../agent.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const log = createLogger('skill-loader');

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
 * Loads skills from a filesystem directory structure.
 * Each skill is a directory containing a manifest.json and tool implementations.
 *
 * Expected structure:
 *   skills-dir/
 *     my-skill/
 *       manifest.json     — SkillManifest
 *       README.md          — optional description
 *       tools.js           — default export: (manifest) => AgentToolHandler[]
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

  /**
   * Scan configured directories and discover all valid skill packages.
   */
  discoverSkills(): SkillPackage[] {
    const packages: SkillPackage[] = [];

    for (const dir of this.skillDirs) {
      if (!existsSync(dir)) {
        log.debug(`Skill directory does not exist: ${dir}`);
        continue;
      }

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const manifestPath = join(skillDir, 'manifest.json');

        if (!existsSync(manifestPath)) continue;

        try {
          const raw = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw) as SkillManifest;
          const validation = this.validateManifest(manifest);

          if (!validation.valid) {
            log.warn(`Invalid manifest in ${skillDir}: ${validation.errors.join(', ')}`);
            continue;
          }

          let readme: string | undefined;
          const readmePath = join(skillDir, 'README.md');
          if (existsSync(readmePath)) {
            readme = readFileSync(readmePath, 'utf-8');
          }

          const pkg: SkillPackage = { manifest, readme, path: skillDir };
          packages.push(pkg);
          this.loadedPackages.set(manifest.name, pkg);

          log.info(`Discovered skill: ${manifest.name} v${manifest.version}`, {
            category: manifest.category,
            tools: manifest.tools.length,
          });
        } catch (err) {
          log.warn(`Failed to read skill at ${skillDir}`, { error: String(err) });
        }
      }
    }

    return packages;
  }

  /**
   * Validate a skill manifest against required fields and constraints.
   */
  validateManifest(manifest: SkillManifest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!manifest.name || typeof manifest.name !== 'string') errors.push('name is required');
    if (!manifest.version || typeof manifest.version !== 'string') errors.push('version is required');
    if (!manifest.description) errors.push('description is required');
    if (!manifest.author) errors.push('author is required');

    const validCategories: SkillCategory[] = ['development', 'devops', 'communication', 'data', 'productivity', 'browser', 'custom'];
    if (!validCategories.includes(manifest.category)) {
      errors.push(`category must be one of: ${validCategories.join(', ')}`);
    }

    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
      errors.push('at least one tool is required');
    } else {
      for (const tool of manifest.tools) {
        if (!tool.name) errors.push(`tool missing name`);
        if (!tool.description) errors.push(`tool ${tool.name ?? '?'} missing description`);
      }
    }

    if (manifest.name && !/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('name must contain only lowercase letters, numbers, and hyphens');
    }

    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      errors.push('version must follow semver format (e.g. 1.0.0)');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check whether required permissions are satisfied.
   */
  checkPermissions(manifest: SkillManifest, grantedPermissions: string[]): { allowed: boolean; missing: string[] } {
    const required = manifest.requiredPermissions ?? [];
    const missing = required.filter(p => !grantedPermissions.includes(p));
    return { allowed: missing.length === 0, missing };
  }

  /**
   * Check whether required environment variables are available.
   */
  checkEnvRequirements(manifest: SkillManifest): { satisfied: boolean; missing: string[] } {
    const required = manifest.requiredEnv ?? [];
    const missing = required.filter(v => !process.env[v]);
    return { satisfied: missing.length === 0, missing };
  }

  /**
   * Search discovered skills by query (name, description, tags, category).
   */
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

/**
 * Create stub tool handlers from a skill manifest.
 * Used when a skill's tools.js module cannot be loaded but the manifest is valid.
 */
export function createStubToolsFromManifest(manifest: SkillManifest): AgentToolHandler[] {
  return manifest.tools.map(toolDef => ({
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    async execute(): Promise<string> {
      return JSON.stringify({ error: `Skill '${manifest.name}' tool '${toolDef.name}' has no implementation loaded` });
    },
  }));
}
