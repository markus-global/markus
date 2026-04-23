import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync, statSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  createLogger,
  kebab,
  readManifest,
  manifestFilename,
  validateManifest,
  type PackageType,
  type MarkusPackageManifest,
} from '@markus/shared';
import {
  discoverSkillsInDir,
  WELL_KNOWN_SKILL_DIRS,
  type SkillCategory,
  type SkillRegistry,
} from '@markus/core';
import type { OrganizationService } from './org-service.js';

const log = createLogger('builder-service');

export interface ArtifactInfo {
  type: string;
  name: string;
  description?: string;
  meta: Record<string, unknown>;
  path: string;
  updatedAt: string;
}

export interface InstallResult {
  type: string;
  installed: unknown;
}

export interface WSBroadcastFn {
  (msg: { type: string; payload: unknown; timestamp: string }): void;
}

const FS_HELPER = {
  existsSync,
  readFileSync: (p: string, _enc: 'utf-8') => readFileSync(p, 'utf-8'),
  join,
};

export class BuilderService {
  constructor(
    private orgService: OrganizationService,
    private skillRegistry?: SkillRegistry,
    private wsBroadcast?: WSBroadcastFn,
  ) {}

  private get baseDir(): string {
    return join(homedir(), '.markus', 'builder-artifacts');
  }

  listArtifacts(type?: 'agent' | 'team' | 'skill'): ArtifactInfo[] {
    const types = type
      ? [type === 'agent' ? 'agents' : type === 'team' ? 'teams' : 'skills'] as const
      : (['agents', 'teams', 'skills'] as const);
    const artifacts: ArtifactInfo[] = [];

    for (const typeDir of types) {
      const dir = join(this.baseDir, typeDir);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const artDir = join(dir, entry.name);
        const artType = (typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill') as PackageType;
        const manifest = readManifest(artDir, artType, FS_HELPER);
        const meta: Record<string, unknown> = manifest ? { ...manifest } : { name: entry.name };
        let updatedAt = new Date().toISOString();
        try { updatedAt = statSync(artDir).mtime.toISOString(); } catch { /* ignore */ }
        artifacts.push({
          type: artType,
          name: entry.name,
          description: (manifest?.description as string) ?? undefined,
          meta,
          path: artDir,
          updatedAt,
        });
      }
    }

    artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return artifacts;
  }

  async installArtifact(type: 'agent' | 'team' | 'skill', name: string): Promise<InstallResult> {
    const typeDir = type === 'agent' ? 'agents' : type === 'team' ? 'teams' : 'skills';
    const artDir = join(this.baseDir, typeDir, name);

    if (!existsSync(artDir)) {
      throw new Error(`Artifact not found: ${type}/${name}`);
    }

    const installType = type as PackageType;
    const manifest = readManifest(artDir, installType, FS_HELPER);
    if (!manifest) {
      throw new Error(`No ${manifestFilename(installType)} found in artifact package`);
    }

    const validationErrors = validateManifest(manifest);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid manifest: ${validationErrors.join('; ')}`);
    }

    const mfName = manifestFilename(installType);

    if (type === 'agent') {
      return this.installAgent(artDir, manifest, mfName, name);
    } else if (type === 'team') {
      return this.installTeam(artDir, manifest, mfName, name);
    } else {
      return this.installSkill(artDir, manifest, name);
    }
  }

  private async installAgent(
    artDir: string,
    manifest: MarkusPackageManifest,
    mfName: string,
    artifactName: string,
  ): Promise<InstallResult> {
    const agentManager = this.orgService.getAgentManager();
    const agentName = manifest.displayName ?? manifest.name ?? artifactName;
    const hasCustomRole = existsSync(join(artDir, 'ROLE.md'));
    const skills = manifest.dependencies?.skills ?? [];
    const agentRole = (manifest.agent?.agentRole ?? 'worker') as 'worker' | 'manager';

    const agent = await this.orgService.hireAgent({
      name: agentName,
      roleName: manifest.agent?.roleName || (hasCustomRole ? 'custom' : 'developer'),
      orgId: 'default',
      agentRole,
      skills,
      skipAutoStart: true,
      skipTemplateCopy: hasCustomRole,
    });

    const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
    mkdirSync(agentRoleDir, { recursive: true });
    for (const fname of readdirSync(artDir)) {
      if (fname === mfName) continue;
      const srcFile = join(artDir, fname);
      if (statSync(srcFile).isFile()) {
        copyFileSync(srcFile, join(agentRoleDir, fname));
      }
    }
    writeFileSync(
      join(agentRoleDir, '.role-origin.json'),
      JSON.stringify({ customRole: true, source: 'builder-artifact', artifact: artifactName, artifactType: 'agent' }),
    );
    agent.reloadRole();
    await agentManager.startAgent(agent.id);

    return {
      type: 'agent',
      installed: {
        id: agent.id,
        name: agent.config.name,
        role: agent.role.name,
        status: agent.getState().status,
      },
    };
  }

  private async installTeam(
    artDir: string,
    manifest: MarkusPackageManifest,
    mfName: string,
    artifactName: string,
  ): Promise<InstallResult> {
    const agentManager = this.orgService.getAgentManager();
    const teamName = manifest.displayName ?? manifest.name ?? artifactName;
    const team = await this.orgService.createTeam('default', teamName, manifest.description ?? '');

    this.wsBroadcast?.({
      type: 'chat:group_created',
      payload: { chatId: `group:${team.id}`, name: teamName, creatorId: '', creatorName: '' },
      timestamp: new Date().toISOString(),
    });

    const announcementPath = join(artDir, 'ANNOUNCEMENT.md');
    const normsPath = join(artDir, 'NORMS.md');
    const announcements = existsSync(announcementPath) ? readFileSync(announcementPath, 'utf-8') : '';
    const norms = existsSync(normsPath) ? readFileSync(normsPath, 'utf-8') : '';
    this.orgService.ensureTeamDataDir(team.id, announcements, norms);

    const members = manifest.team?.members ?? [];
    const createdAgents: Array<{ id: string; name: string; role: string }> = [];
    const usedMemberDirs = new Set<string>();

    for (const member of members) {
      const count = member.count ?? 1;
      const memberRole = (member.role ?? 'worker') as 'worker' | 'manager';
      const memberName = member.name ?? 'Agent';
      const memberSkills = member.skills ?? [];
      const memberFilesDir = this.findMemberDir(artDir, memberName, usedMemberDirs);
      const hasCustomRole = !!memberFilesDir && existsSync(join(memberFilesDir, 'ROLE.md'));
      if (memberFilesDir) usedMemberDirs.add(memberFilesDir);
      log.info('installTeam: member lookup', { memberName, memberFilesDir, hasCustomRole });

      for (let i = 0; i < count; i++) {
        const displayName = count > 1 ? `${memberName} ${i + 1}` : memberName;
        const agent = await this.orgService.hireAgent({
          name: displayName,
          roleName: member.roleName || (hasCustomRole ? 'custom' : 'developer'),
          orgId: 'default',
          teamId: team.id,
          agentRole: memberRole,
          skills: memberSkills.length > 0 ? memberSkills : undefined,
          skipAutoStart: true,
          skipTemplateCopy: hasCustomRole,
        });

        const agentRoleDir = join(agentManager.getDataDir(), agent.id, 'role');
        mkdirSync(agentRoleDir, { recursive: true });
        if (memberFilesDir && existsSync(memberFilesDir)) {
          for (const fname of readdirSync(memberFilesDir)) {
            const srcFile = join(memberFilesDir, fname);
            if (statSync(srcFile).isFile()) {
              copyFileSync(srcFile, join(agentRoleDir, fname));
            }
          }
        }
        writeFileSync(
          join(agentRoleDir, '.role-origin.json'),
          JSON.stringify({ customRole: true, source: 'builder-artifact', artifact: artifactName, artifactType: 'team' }),
        );
        agent.reloadRole();

        if (memberRole === 'manager') {
          await this.orgService.updateTeam(team.id, { managerId: agent.id, managerType: 'agent' });
        }
        await agentManager.startAgent(agent.id);
        createdAgents.push({ id: agent.id, name: agent.config.name, role: agent.role.name });
      }
    }

    return {
      type: 'team',
      installed: { team: { id: team.id, name: teamName }, agents: createdAgents },
    };
  }

  /**
   * Find the member directory under artDir/members/ by trying multiple slug strategies.
   * Returns the absolute path to the member directory, or null if not found.
   */
  private findMemberDir(artDir: string, memberName: string, usedDirs: Set<string>): string | null {
    const membersBase = join(artDir, 'members');
    if (!existsSync(membersBase)) return null;

    // Strategy 1: exact slug match (using the canonical kebab function)
    const slug = kebab(memberName, 'agent');
    const exact = join(membersBase, slug);
    if (existsSync(exact) && !usedDirs.has(exact)) return exact;

    // Strategy 3: scan directories for matching ROLE.md title
    try {
      for (const entry of readdirSync(membersBase, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidateDir = join(membersBase, entry.name);
        if (usedDirs.has(candidateDir)) continue;
        const rolePath = join(candidateDir, 'ROLE.md');
        if (!existsSync(rolePath)) continue;
        try {
          const content = readFileSync(rolePath, 'utf-8');
          const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
          if (title && title.toLowerCase() === memberName.toLowerCase()) return candidateDir;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    // Strategy 4: if only one unmatched directory remains, use it
    try {
      const remaining = readdirSync(membersBase, { withFileTypes: true })
        .filter(e => e.isDirectory() && !usedDirs.has(join(membersBase, e.name)));
      if (remaining.length === 1) return join(membersBase, remaining[0].name);
    } catch { /* skip */ }

    return null;
  }

  private async installSkill(
    artDir: string,
    manifest: MarkusPackageManifest,
    artifactName: string,
  ): Promise<InstallResult> {
    const skillDir = join(homedir(), '.markus', 'skills', artifactName);
    mkdirSync(skillDir, { recursive: true });
    for (const fname of readdirSync(artDir)) {
      const srcFile = join(artDir, fname);
      const destFile = join(skillDir, fname);
      if (statSync(srcFile).isFile()) {
        copyFileSync(srcFile, destFile);
      } else if (statSync(srcFile).isDirectory()) {
        cpSync(srcFile, destFile, { recursive: true });
      }
    }

    if (this.skillRegistry) {
      try {
        const skillFile = manifest.skill?.skillFile ?? 'SKILL.md';
        const instrPath = join(skillDir, skillFile);
        const instructions = existsSync(instrPath)
          ? readFileSync(instrPath, 'utf-8').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
          : undefined;
        this.skillRegistry.register({
          manifest: {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author ?? '',
            category: (manifest.category ?? 'custom') as SkillCategory,
            tags: manifest.tags,
            instructions,
            requiredPermissions: manifest.skill?.requiredPermissions,
            mcpServers: manifest.skill?.mcpServers,
            sourcePath: skillDir,
            source: 'builder',
          },
        });
      } catch (regErr) {
        log.warn('Failed to register skill into runtime registry', { error: String(regErr) });
      }
    }

    return {
      type: 'skill',
      installed: { name: artifactName, path: skillDir, status: 'registered' },
    };
  }
}
