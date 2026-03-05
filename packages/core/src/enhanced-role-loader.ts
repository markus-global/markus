import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoleTemplate, HeartbeatTask, Policy, RoleCategory } from '@markus/shared';
import { generateId } from '@markus/shared';
import { OpenClawConfigParser } from './openclaw-config-parser.js';

interface RoleFiles {
  role: string;
  skills?: string;
  heartbeat?: string;
  policies?: string;
  context?: string;
}

export interface EnhancedRoleTemplate extends RoleTemplate {
  sourceFormat: 'markus' | 'openclaw';
  sourcePath?: string;
  openclawMetadata?: {
    memoryConfig?: Record<string, unknown>;
    knowledgeBase?: string[];
    externalAgentId?: string;
  };
}

export class EnhancedRoleLoader {
  private templateDirs: string[];
  private openclawParser: OpenClawConfigParser;

  constructor(templateDirs?: string[]) {
    this.templateDirs = templateDirs ?? [resolve(process.cwd(), 'templates', 'roles')];
    this.openclawParser = new OpenClawConfigParser();
  }

  getTemplateDirs(): string[] {
    return this.templateDirs;
  }

  /**
   * List all available roles, including OpenClaw configurations
   */
  listAvailableRoles(): Array<{ name: string; format: 'markus' | 'openclaw' }> {
    const roles: Array<{ name: string; format: 'markus' | 'openclaw' }> = [];
    
    for (const dir of this.templateDirs) {
      if (!existsSync(dir)) continue;
      
      // Look for Markus-style role directories
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const rolePath = join(dir, entry.name);
          
          // Check for Markus format (ROLE.md)
          if (existsSync(join(rolePath, 'ROLE.md'))) {
            roles.push({ name: entry.name, format: 'markus' });
          }
          // Check for OpenClaw format (single .md file)
          else if (existsSync(join(rolePath, 'openclaw.md')) || existsSync(join(rolePath, 'config.md'))) {
            roles.push({ name: entry.name, format: 'openclaw' });
          }
        }
      }
      
      // Look for standalone OpenClaw .md files
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = join(dir, entry.name);
          const content = readFileSync(filePath, 'utf-8');
          
          if (this.openclawParser.isOpenClawFormat(content)) {
            const name = entry.name.replace(/\.md$/, '');
            roles.push({ name, format: 'openclaw' });
          }
        }
      }
    }
    
    return roles;
  }

  /**
   * Load a role, automatically detecting format
   */
  loadRole(roleNameOrPath: string): EnhancedRoleTemplate {
    // Try to detect format and load accordingly
    const format = this.detectFormat(roleNameOrPath);
    
    if (format === 'openclaw') {
      return this.loadOpenClawRole(roleNameOrPath);
    } else {
      return this.loadMarkusRole(roleNameOrPath);
    }
  }

  /**
   * Load a role from a specific file path
   */
  loadRoleFromFile(filePath: string): EnhancedRoleTemplate {
    if (!existsSync(filePath)) {
      throw new Error(`Role file not found: ${filePath}`);
    }
    
    const content = readFileSync(filePath, 'utf-8');
    
    if (this.openclawParser.isOpenClawFormat(content)) {
      const role = this.openclawParser.parse(content) as EnhancedRoleTemplate;
      role.sourceFormat = 'openclaw';
      role.sourcePath = filePath;
      return role;
    } else {
      // Try to parse as Markus format
      const roleName = this.extractTitle(content) || filePath;
      const role = this.createMarkusRoleFromContent(content, roleName) as EnhancedRoleTemplate;
      role.sourceFormat = 'markus';
      role.sourcePath = filePath;
      return role;
    }
  }

  /**
   * Load an OpenClaw configuration from URL or external source
   */
  async loadOpenClawFromUrl(url: string): Promise<EnhancedRoleTemplate> {
    try {
      // In a real implementation, this would fetch from URL
      // For now, we'll simulate with a local file
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch OpenClaw config from ${url}: ${response.statusText}`);
      }
      
      const content = await response.text();
      const role = this.openclawParser.parse(content) as EnhancedRoleTemplate;
      role.sourceFormat = 'openclaw';
      role.sourcePath = url;
      return role;
    } catch (error) {
      throw new Error(`Failed to load OpenClaw config from ${url}: ${error}`);
    }
  }

  /**
   * Convert a role to OpenClaw format
   */
  exportToOpenClawFormat(role: EnhancedRoleTemplate): string {
    return this.openclawParser.toOpenClawFormat(role);
  }

  /**
   * Merge multiple role configurations (useful for inheritance/composition)
   */
  mergeRoles(baseRole: EnhancedRoleTemplate, overrideRole: Partial<EnhancedRoleTemplate>): EnhancedRoleTemplate {
    return {
      ...baseRole,
      ...overrideRole,
      defaultSkills: [...baseRole.defaultSkills, ...(overrideRole.defaultSkills || [])],
      defaultHeartbeatTasks: [...baseRole.defaultHeartbeatTasks, ...(overrideRole.defaultHeartbeatTasks || [])],
      defaultPolicies: [...baseRole.defaultPolicies, ...(overrideRole.defaultPolicies || [])],
      sourceFormat: overrideRole.sourceFormat || baseRole.sourceFormat,
    };
  }

  private detectFormat(nameOrPath: string): 'markus' | 'openclaw' {
    // Check if it's a path to a directory
    if (existsSync(nameOrPath)) {
      if (existsSync(join(nameOrPath, 'ROLE.md'))) {
        return 'markus';
      } else if (existsSync(join(nameOrPath, 'openclaw.md')) || existsSync(join(nameOrPath, 'config.md'))) {
        return 'openclaw';
      }
    }
    
    // Check in template directories
    for (const dir of this.templateDirs) {
      const candidate = join(dir, nameOrPath);
      
      if (existsSync(join(candidate, 'ROLE.md'))) {
        return 'markus';
      } else if (existsSync(join(candidate, 'openclaw.md')) || existsSync(join(candidate, 'config.md'))) {
        return 'openclaw';
      }
      
      // Check for standalone .md file
      const mdFile = join(dir, `${nameOrPath}.md`);
      if (existsSync(mdFile)) {
        const content = readFileSync(mdFile, 'utf-8');
        if (this.openclawParser.isOpenClawFormat(content)) {
          return 'openclaw';
        }
      }
    }
    
    // Default to Markus format
    return 'markus';
  }

  private loadOpenClawRole(nameOrPath: string): EnhancedRoleTemplate {
    let content: string | undefined;
    let sourcePath: string | undefined;
    
    // Check if it's a direct file path
    if (existsSync(nameOrPath) && nameOrPath.endsWith('.md')) {
      sourcePath = nameOrPath;
      content = readFileSync(nameOrPath, 'utf-8');
    } else {
      // Look in template directories
      for (const dir of this.templateDirs) {
        const candidateDir = join(dir, nameOrPath);
        const candidateFile = join(dir, `${nameOrPath}.md`);
        
        // Check for openclaw.md or config.md in directory
        if (existsSync(candidateDir)) {
          const openclawFile = join(candidateDir, 'openclaw.md');
          const configFile = join(candidateDir, 'config.md');
          
          if (existsSync(openclawFile)) {
            sourcePath = openclawFile;
            content = readFileSync(openclawFile, 'utf-8');
            break;
          } else if (existsSync(configFile)) {
            sourcePath = configFile;
            content = readFileSync(configFile, 'utf-8');
            break;
          }
        }
        
        // Check for standalone .md file
        if (existsSync(candidateFile)) {
          sourcePath = candidateFile;
          content = readFileSync(candidateFile, 'utf-8');
          if (this.openclawParser.isOpenClawFormat(content)) {
            break;
          }
        }
      }
    }
    
    if (!content || !sourcePath) {
      throw new Error(`OpenClaw role not found: ${nameOrPath}`);
    }
    
    const role = this.openclawParser.parse(content) as EnhancedRoleTemplate;
    role.sourceFormat = 'openclaw';
    role.sourcePath = sourcePath;
    return role;
  }

  private loadMarkusRole(nameOrPath: string): EnhancedRoleTemplate {
    const files = this.resolveRoleFiles(nameOrPath);

    const roleContent = files.role;
    const name = this.extractTitle(roleContent) || nameOrPath;
    const category = this.inferCategory(nameOrPath);

    // Append shared instructions (SHARED.md in the roles root) to every role's prompt
    const sharedContent = this.loadSharedInstructions();
    const systemPrompt = sharedContent ? `${roleContent}\n\n${sharedContent}` : roleContent;

    const role: EnhancedRoleTemplate = {
      id: generateId('role'),
      name,
      description: this.extractDescription(roleContent),
      category,
      systemPrompt,
      defaultSkills: files.skills ? this.parseSkillsList(files.skills) : [],
      defaultHeartbeatTasks: files.heartbeat ? this.parseHeartbeatTasks(files.heartbeat) : [],
      defaultPolicies: files.policies ? this.parsePolicies(files.policies) : [],
      builtIn: true,
      sourceFormat: 'markus',
      sourcePath: this.findRolePath(nameOrPath),
    };

    return role;
  }

  private createMarkusRoleFromContent(content: string, name: string): EnhancedRoleTemplate {
    const category = this.inferCategory(name);
    const sharedContent = this.loadSharedInstructions();
    const systemPrompt = sharedContent ? `${content}\n\n${sharedContent}` : content;

    return {
      id: generateId('role'),
      name,
      description: this.extractDescription(content),
      category,
      systemPrompt,
      defaultSkills: [],
      defaultHeartbeatTasks: [],
      defaultPolicies: [],
      builtIn: false,
      sourceFormat: 'markus',
    };
  }

  private findRolePath(nameOrPath: string): string | undefined {
    if (existsSync(join(nameOrPath, 'ROLE.md'))) {
      return nameOrPath;
    }
    
    for (const dir of this.templateDirs) {
      const candidate = join(dir, nameOrPath);
      if (existsSync(join(candidate, 'ROLE.md'))) {
        return candidate;
      }
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
      const p = join(roleDir!, file);
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

  private loadSharedInstructions(): string | undefined {
    for (const dir of this.templateDirs) {
      const p = join(dir, 'SHARED.md');
      if (existsSync(p)) return readFileSync(p, 'utf-8');
    }
    return undefined;
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