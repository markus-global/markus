import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoleTemplate, Policy, RoleCategory } from '@markus/shared';
import { generateId } from '@markus/shared';

interface RoleFiles {
  role: string;
  heartbeat?: string;
  policies?: string;
  context?: string;
}

export class RoleLoader {
  private templateDirs: string[];

  constructor(templateDirs?: string[]) {
    this.templateDirs = templateDirs ?? [resolve(process.cwd(), 'templates', 'roles')];
  }

  getTemplateDirs(): string[] {
    return this.templateDirs;
  }

  listAvailableRoles(): string[] {
    const roles: string[] = [];
    for (const dir of this.templateDirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'ROLE.md'))) {
          roles.push(entry.name);
        }
      }
    }
    return roles;
  }

  /**
   * Resolve the template directory for a given role name or path.
   * Returns the absolute path to the role's template directory, or undefined if not found.
   */
  resolveTemplateDir(roleNameOrPath: string): string | undefined {
    if (existsSync(join(roleNameOrPath, 'ROLE.md'))) {
      return roleNameOrPath;
    }
    for (const dir of this.templateDirs) {
      const candidate = join(dir, roleNameOrPath);
      if (existsSync(join(candidate, 'ROLE.md'))) {
        return candidate;
      }
    }
    return undefined;
  }

  loadRole(roleNameOrPath: string): RoleTemplate {
    const files = this.resolveRoleFiles(roleNameOrPath);

    const roleContent = files.role;
    const name = this.extractTitle(roleContent) || roleNameOrPath;
    const category = this.inferCategory(roleNameOrPath);

    // Append shared instructions (SHARED.md in the roles root) to every role's prompt
    const sharedContent = this.loadSharedInstructions();
    const systemPrompt = sharedContent ? `${roleContent}\n\n${sharedContent}` : roleContent;

    return {
      id: generateId('role'),
      name,
      description: this.extractDescription(roleContent),
      category,
      systemPrompt,
      defaultSkills: [],
      heartbeatChecklist: files.heartbeat ?? '',
      defaultPolicies: files.policies ? this.parsePolicies(files.policies) : [],
      builtIn: true,
    };
  }

  private loadSharedInstructions(): string | undefined {
    for (const dir of this.templateDirs) {
      const p = join(dir, 'SHARED.md');
      if (existsSync(p)) return readFileSync(p, 'utf-8');
    }
    return undefined;
  }

  private resolveRoleFiles(nameOrPath: string): RoleFiles {
    let roleDir: string | undefined;

    if (existsSync(join(nameOrPath, 'ROLE.md'))) {
      roleDir = nameOrPath;
    } else {
      for (const dir of this.templateDirs) {
        const candidate = join(dir, nameOrPath);
        if (existsSync(join(candidate, 'ROLE.md'))) {
          roleDir = candidate;
          break;
        }
      }
    }

    if (!roleDir) {
      throw new Error(`Role not found: ${nameOrPath}`);
    }

    const read = (file: string) => {
      const p = join(roleDir, file);
      return existsSync(p) ? readFileSync(p, 'utf-8') : undefined;
    };

    return {
      role: readFileSync(join(roleDir, 'ROLE.md'), 'utf-8'),
      heartbeat: read('HEARTBEAT.md'),
      policies: read('POLICIES.md'),
      context: read('CONTEXT.md'),
    };
  }

  private extractTitle(md: string): string {
    const match = md.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? '';
  }

  private extractDescription(md: string): string {
    const lines = md.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) return trimmed;
    }
    return '';
  }

  private inferCategory(name: string): RoleCategory {
    const lower = name.toLowerCase();
    if (lower.includes('develop') || lower.includes('engineer')) return 'engineering';
    if (lower.includes('product')) return 'product';
    if (lower.includes('operation') || lower.includes('ops') || lower.includes('manager')) return 'operations';
    if (lower.includes('market')) return 'marketing';
    if (lower.includes('customer') || lower.includes('support')) return 'customer_service';
    if (lower.includes('financ') || lower.includes('account')) return 'finance';
    if (lower.includes('legal') || lower.includes('compliance')) return 'legal';
    return 'custom';
  }

  private parsePolicies(content: string): Policy[] {
    const policies: Policy[] = [];
    const sections = content.split(/^##\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0]?.trim();
      if (!name || name.startsWith('#')) continue;
      const rules = lines
        .slice(1)
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);
      policies.push({ name, description: '', rules });
    }

    return policies;
  }
}
