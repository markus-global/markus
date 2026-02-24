import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoleTemplate, HeartbeatTask, Policy, RoleCategory } from '@markus/shared';
import { generateId } from '@markus/shared';

interface RoleFiles {
  role: string;
  skills?: string;
  heartbeat?: string;
  policies?: string;
  context?: string;
}

export class RoleLoader {
  private templateDirs: string[];

  constructor(templateDirs?: string[]) {
    this.templateDirs = templateDirs ?? [resolve(process.cwd(), 'templates', 'roles')];
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

  loadRole(roleNameOrPath: string): RoleTemplate {
    const files = this.resolveRoleFiles(roleNameOrPath);

    const roleContent = files.role;
    const name = this.extractTitle(roleContent) || roleNameOrPath;
    const category = this.inferCategory(roleNameOrPath);

    return {
      id: generateId('role'),
      name,
      description: this.extractDescription(roleContent),
      category,
      systemPrompt: roleContent,
      defaultSkills: files.skills ? this.parseSkillsList(files.skills) : [],
      defaultHeartbeatTasks: files.heartbeat ? this.parseHeartbeatTasks(files.heartbeat) : [],
      defaultPolicies: files.policies ? this.parsePolicies(files.policies) : [],
      builtIn: true,
    };
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
      skills: read('SKILLS.md'),
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

  private parseSkillsList(content: string): string[] {
    return content
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  private parseHeartbeatTasks(content: string): HeartbeatTask[] {
    const tasks: HeartbeatTask[] = [];
    const sections = content.split(/^##\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0]?.trim();
      if (!name || name.startsWith('#')) continue;
      const description = lines
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
      tasks.push({ name, description, enabled: true });
    }

    return tasks;
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
