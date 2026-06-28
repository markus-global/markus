import { resolve } from 'node:path';
import { discoverSkillsInDir, WELL_KNOWN_SKILL_DIRS } from '@markus/core';
import { installSkill } from '../skill-service.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

export async function handleSkillsRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    if (path === '/api/skills' && req.method === 'GET') {
      // Skills from in-memory registry
      const registrySkills = (server.skillRegistry?.list() ?? [])
        .map(s => ({
          name: s.name,
          version: s.version,
          description: s.description,
          author: s.author,
          category: s.category,
          tags: s.tags,
          hasInstructions: !!s.instructions,
          sourcePath: s.builtIn ? undefined : s.sourcePath,
          type: (s.builtIn ? 'builtin' : s.sourcePath ? 'filesystem' : 'registry') as string,
        }));
      const seen = new Set(registrySkills.map(s => s.name));

      // Live filesystem scan for any skills not yet in registry
      const fsSkills: Array<{ name: string; version: string; description?: string; author?: string; category?: string; tags?: string[]; hasInstructions: boolean; sourcePath: string; type: string }> = [];
      for (const dir of WELL_KNOWN_SKILL_DIRS) {
        for (const discovered of discoverSkillsInDir(dir)) {
          if (seen.has(discovered.manifest.name)) continue;
          seen.add(discovered.manifest.name);
          fsSkills.push({
            name: discovered.manifest.name,
            version: discovered.manifest.version,
            description: discovered.manifest.description,
            author: discovered.manifest.author,
            category: discovered.manifest.category,
            tags: discovered.manifest.tags,
            hasInstructions: !!discovered.manifest.instructions,
            sourcePath: discovered.path,
            type: 'filesystem',
          });
        }
      }

      const imported: Array<{ name: string; description: string; category: string; version: string; tags: string[]; hasInstructions: boolean; type: string }> = [];

      const agents = server.orgService.getAgentManager().listAgents();
      const skillAgents: Record<string, string[]> = {};
      for (const agent of agents) {
        for (const skillName of agent.skills) {
          if (!skillAgents[skillName]) skillAgents[skillName] = [];
          skillAgents[skillName]!.push(agent.id);
        }
      }
      const all = [
        ...registrySkills.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
        ...fsSkills.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
        ...imported.map(s => ({ ...s, agentIds: skillAgents[s.name] ?? [] })),
      ];
      server.json(res, 200, { skills: all });
      return true;
    }

    // Built-in skills — list templates/skills/
    if (path === '/api/skills/builtin' && req.method === 'GET') {
      const builtinDir = resolve(process.env['MARKUS_TEMPLATES_DIR'] ?? resolve(process.cwd(), 'templates'), 'skills');
      const found = discoverSkillsInDir(builtinDir);
      const installedSkills = new Map(
        (server.skillRegistry?.list() ?? []).map(s => [s.name, s])
      );
      // Read raw manifests to get i18n/hidden fields
      const rawManifests = new Map<string, Record<string, unknown>>();
      try {
        const { readdirSync, readFileSync, existsSync } = await import('node:fs');
        for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sjPath = resolve(builtinDir, entry.name, 'skill.json');
          if (existsSync(sjPath)) {
            try { rawManifests.set(entry.name, JSON.parse(readFileSync(sjPath, 'utf-8'))); } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
      const skills = found
        .filter(({ manifest }) => {
          const raw = rawManifests.get(manifest.name);
          return !(raw as Record<string, unknown>)?.hidden;
        })
        .map(({ manifest, path: p }) => {
          const inst = installedSkills.get(manifest.name);
          const raw = rawManifests.get(manifest.name);
          return {
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author,
            category: manifest.category,
            tags: manifest.tags ?? [],
            hasMcpServers: !!manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0,
            hasInstructions: !!manifest.instructions,
            instructions: manifest.instructions ?? undefined,
            requiredPermissions: manifest.requiredPermissions ?? [],
            sourcePath: p,
            installed: !!inst,
            installedVersion: inst?.version ?? null,
            i18n: (raw as Record<string, unknown>)?.i18n ?? undefined,
          };
        });
      server.json(res, 200, { skills });
      return true;
    }

    if (path.match(/^\/api\/skills\/[^/]+$/) && !path.startsWith('/api/skills/registry') && req.method === 'GET') {
      const skillName = decodeURIComponent(path.split('/')[3]!);
      if (!server.skillRegistry) {
        server.json(res, 404, { error: 'Skill registry not configured' });
        return true;
      }
      const skill = server.skillRegistry.get(skillName);
      if (!skill) {
        server.json(res, 404, { error: `Skill not found: ${skillName}` });
        return true;
      }
      const manifest = skill.manifest;
      server.json(res, 200, {
        skill: {
          ...manifest,
          hasInstructions: !!manifest.instructions,
          instructionsPreview: manifest.instructions?.slice(0, 500),
        },
      });
      return true;
    }

    // Third-party skill registry — fetch from GitHub repos and cache
    if (path === '/api/skills/registry' && req.method === 'GET') {
      const source = url.searchParams.get('source') ?? 'openclaw';
      const now = Date.now();
      const cacheKey = `skill-registry-${source}`;
      const cached = server.registryCache?.get(cacheKey);
      if (cached && now - cached.ts < 600_000) {
        server.json(res, 200, { skills: cached.data, source, cached: true });
        return true;
      }

      try {
        const skills: Array<{ name: string; description: string; category: string; source: string; sourceUrl: string; author: string; addedAt?: string }> = [];

        if (source === 'openclaw') {
          const resp = await fetch('https://raw.githubusercontent.com/LeoYeAI/openclaw-master-skills/main/README.md');
          if (resp.ok) {
            const readme = await resp.text();
            const tableLines = readme.split('\n').filter(l => l.startsWith('| ['));
            for (const line of tableLines) {
              const cols = line.split('|').map(c => c.trim()).filter(Boolean);
              if (cols.length >= 4) {
                const nameMatch = cols[0]?.match(/\[([^\]]+)\]/);
                const name = nameMatch?.[1] ?? '';
                const description = cols[1]?.replace(/\.\.\.$/, '').trim() ?? '';
                const category = cols[2]?.trim() ?? 'Other';
                const srcMatch = cols[3]?.match(/\[GitHub\]\(([^)]+)\)/);
                const addedAt = cols[4]?.trim();
                if (name) {
                  skills.push({
                    name,
                    description,
                    category,
                    source: 'openclaw',
                    sourceUrl: srcMatch?.[1] ?? `https://github.com/LeoYeAI/openclaw-master-skills/tree/main/skills/${name}`,
                    author: 'Community',
                    addedAt,
                  });
                }
              }
            }
          }
        }

        if (!server.registryCache) server.registryCache = new Map();
        server.registryCache.set(cacheKey, { data: skills, ts: now });
        server.json(res, 200, { skills, source, cached: false });
      } catch (err) {
        server.json(res, 500, { error: `Failed to fetch registry: ${String(err)}` });
      }
      return true;
    }

    // Install a skill: download to ~/.markus/skills/ and register
    if (path === '/api/skills/install' && req.method === 'POST') {
      const body = await server.readBody(req);
      const skillName = body['name'] as string;
      if (!skillName) {
        server.json(res, 400, { error: 'name is required' });
        return true;
      }

      try {
        const result = await installSkill({
          name: skillName,
          source: body['source'] as string | undefined,
          slug: body['slug'] as string | undefined,
          sourceUrl: body['sourceUrl'] as string | undefined,
          description: body['description'] as string | undefined,
          category: body['category'] as string | undefined,
          version: body['version'] as string | undefined,
          githubRepo: body['githubRepo'] as string | undefined,
          githubSkillPath: body['githubSkillPath'] as string | undefined,
        }, server.skillRegistry);

        server.json(res, 201, result);
        return true;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        const status = msg.includes('Download failed') ? 502 : 500;
        server.json(res, status, { error: msg });
        return true;
      }
    }

    // Uninstall a skill: delete from filesystem and/or DB
    if (path.startsWith('/api/skills/installed/') && req.method === 'DELETE') {
      const skillName = decodeURIComponent(path.slice('/api/skills/installed/'.length));
      if (!skillName) {
        server.json(res, 400, { error: 'skill name is required' });
        return true;
      }

      let deletedFs = false;

      // Try delete from filesystem (~/.markus/skills/)
      const skillsDir = join(homedir(), '.markus', 'skills');
      const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const targetDir = join(skillsDir, safeName);
      if (existsSync(targetDir)) {
        try {
          execSync(`rm -rf "${targetDir}"`, { timeout: 10000 });
          deletedFs = true;
        } catch (err) {
          console.warn(`[skills/uninstall] fs delete failed: ${String(err)}`);
        }
      }

      if (!deletedFs) {
        server.json(res, 404, { error: `Skill "${skillName}" not found` });
        return true;
      }

      // Unregister from runtime SkillRegistry
      if (server.skillRegistry) {
        server.skillRegistry.unregister(skillName);
      }

      // Remove from all agents that had this skill assigned
      const agentMgr = server.orgService.getAgentManager();
      const affectedAgents: string[] = [];
      for (const agentInfo of agentMgr.listAgents()) {
        try {
          const agent = agentMgr.getAgent(agentInfo.id);
          if (agent.config.skills.includes(skillName)) {
            agent.config.skills = agent.config.skills.filter(s => s !== skillName);
            affectedAgents.push(agentInfo.id);
            if (server.storage) {
              try { await server.storage.agentRepo.updateConfig(agentInfo.id, { skills: agent.config.skills }); }
              catch (e) { log.warn('Failed to persist skill removal from agent after uninstall', { agentId: agentInfo.id, error: String(e) }); }
            }
          }
        } catch { /* agent not accessible */ }
      }

      server.json(res, 200, { deleted: true, name: skillName, deletedFs, removedFromAgents: affectedAgents });
      return true;
    }

    // ── Builder Artifacts: directory-based package management ──────────────

    // GET /api/builder/artifacts — scan all builder artifacts
    if (path === '/api/builder/artifacts' && req.method === 'GET') {
      try {
        const artifacts = server.builderService
          ? server.builderService.listArtifacts()
          : [];
        server.json(res, 200, { artifacts });
      } catch (err) {
        server.json(res, 500, { error: `Scan failed: ${String(err)}` });
      }
      return true;
    }

    // GET /api/builder/artifacts/:type/:name — read one artifact (all files)
    {
      const artMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)$/);
      if (artMatch && req.method === 'GET') {
        const rawType = artMatch[1]!;
        const name = decodeURIComponent(artMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        if (!existsSync(artDir)) {
          server.json(res, 404, { error: 'Artifact not found' });
          return true;
        }
        try {
          const files: Record<string, string> = {};
          const readDir = (dir: string, prefix: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                readDir(join(dir, entry.name), relPath);
              } else {
                try { files[relPath] = readFileSync(join(dir, entry.name), 'utf-8'); } catch { /* skip binary */ }
              }
            }
          };
          readDir(artDir, '');
          const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill';
          server.json(res, 200, { type, name, path: artDir, files });
        } catch (err) {
          server.json(res, 500, { error: `Read failed: ${String(err)}` });
        }
        return true;
      }
    }

    // GET /api/builder/artifacts/installed — detect which artifacts have been installed
    if (path === '/api/builder/artifacts/installed' && req.method === 'GET') {
      try {
        const installed: Record<string, { agentId?: string; agentIds?: string[]; teamId?: string }> = {};
        const agentManager = server.orgService.getAgentManager();
        const dataDir = agentManager.getDataDir();

        // Scan agents for .role-origin.json markers
        for (const agentInfo of agentManager.listAgents()) {
          const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
          if (existsSync(originPath)) {
            try {
              const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
              if (origin.source === 'builder-artifact' && origin.artifact) {
                const artName = origin.artifact as string;
                let artType = origin.artifactType as string | undefined;
                if (!artType) {
                  try {
                    const agentObj = agentManager.getAgent(agentInfo.id);
                    artType = agentObj.config.teamId ? 'team' : 'agent';
                  } catch { artType = 'agent'; }
                }
                if (artType === 'team') {
                  const teamKey = `team/${artName}`;
                  if (!installed[teamKey]) installed[teamKey] = { agentIds: [] };
                  installed[teamKey].agentIds!.push(agentInfo.id);
                  if (!installed[teamKey].teamId) {
                    try {
                      const agentObj = agentManager.getAgent(agentInfo.id);
                      if (agentObj.config.teamId) installed[teamKey].teamId = agentObj.config.teamId;
                    } catch { /* skip */ }
                  }
                } else {
                  installed[`agent/${artName}`] = { agentId: agentInfo.id };
                }
              }
            } catch { /* skip invalid */ }
          }
        }

        // Scan skills: check builder-artifacts paired with installed skills
        const skillArtDir = join(homedir(), '.markus', 'builder-artifacts', 'skills');
        const skillsDir = join(homedir(), '.markus', 'skills');
        if (existsSync(skillArtDir)) {
          try {
            for (const entry of readdirSync(skillArtDir, { withFileTypes: true })) {
              if (entry.isDirectory() && existsSync(join(skillsDir, entry.name))) {
                installed[`skill/${entry.name}`] = {};
              }
            }
          } catch { /* ignore */ }
        }
        // Also detect skills installed directly (skillhub/skillssh/builtin) without builder-artifacts
        if (existsSync(skillsDir)) {
          try {
            for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
              const key = `skill/${entry.name}`;
              if (entry.isDirectory() && !installed[key]) {
                installed[key] = {};
              }
            }
          } catch { /* ignore */ }
        }

        server.json(res, 200, { installed });
      } catch (err) {
        server.json(res, 500, { error: `Scan failed: ${String(err)}` });
      }
      return true;
    }

    // POST /api/builder/artifacts/save — save JSON artifact as directory-based package
    if (path === '/api/builder/artifacts/save' && req.method === 'POST') {
      const body = await server.readBody(req);
      const mode = body['mode'] as string;
      const artifact = body['artifact'] as Record<string, unknown>;
      if (!mode || !['agent', 'team', 'skill'].includes(mode) || !artifact) {
        server.json(res, 400, { error: 'mode must be agent|team|skill and artifact is required' });
        return true;
      }

      try {
        const typeDir = mode === 'agent' ? 'agents' : mode === 'team' ? 'teams' : 'skills';
        const pkgType = mode as PackageType;
        const manifest = buildManifest(pkgType, artifact);
        if (!manifest.source) manifest.source = { type: 'local' };
        const mfName = manifestFilename(pkgType);
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, manifest.name);
        mkdirSync(artDir, { recursive: true });
        writeFileSync(join(artDir, mfName), JSON.stringify(manifest, null, 2), 'utf-8');

        // Write content files from `files` map
        const artFiles = artifact.files as Record<string, string> | undefined;
        if (artFiles) {
          for (const [fn, c] of Object.entries(artFiles)) {
            if (fn === mfName) continue;
            const filePath = join(artDir, fn);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, c, 'utf-8');
          }
        }

        // Team: extract announcement, norms, and member role files from config
        if (mode === 'team') {
          const fileSet = new Set(artFiles ? Object.keys(artFiles) : []);

          // Write ANNOUNCEMENT.md / NORMS.md from config fields if not already in files
          const announcement = artifact.announcement as string | undefined;
          if (announcement && !fileSet.has('ANNOUNCEMENT.md')) {
            writeFileSync(join(artDir, 'ANNOUNCEMENT.md'), announcement, 'utf-8');
          }
          const norms = artifact.norms as string | undefined;
          if (norms && !fileSet.has('NORMS.md')) {
            writeFileSync(join(artDir, 'NORMS.md'), norms, 'utf-8');
          }

          // Write member role files from config if not already written via files map
          const rawMembers = (Array.isArray((artifact.team as Record<string, unknown>)?.members)
            ? (artifact.team as Record<string, unknown>).members
            : Array.isArray(artifact.members) ? artifact.members : []) as Array<Record<string, unknown>>;
          for (const [idx, m] of rawMembers.entries()) {
            const mName = (m.name as string) ?? 'Agent';
            const slug = kebab(mName, 'member-' + idx);
            const memberDir = join(artDir, 'members', slug);
            const roleContent = (m.roleContent as string) || (m.role_md as string);
            const policiesContent = (m.policiesContent as string) || (m.policies_md as string);
            const contextContent = (m.contextContent as string) || (m.context_md as string);
            if (roleContent && !fileSet.has(`members/${slug}/ROLE.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'ROLE.md'), roleContent, 'utf-8');
            }
            if (policiesContent && !fileSet.has(`members/${slug}/POLICIES.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'POLICIES.md'), policiesContent, 'utf-8');
            }
            if (contextContent && !fileSet.has(`members/${slug}/CONTEXT.md`)) {
              mkdirSync(memberDir, { recursive: true });
              writeFileSync(join(memberDir, 'CONTEXT.md'), contextContent, 'utf-8');
            }
          }

          // Legacy: write explicit memberFiles if provided in JSON
          const memberFiles = artifact.memberFiles as Record<string, Record<string, string>> | undefined;
          if (memberFiles) {
            for (const [slug, files] of Object.entries(memberFiles)) {
              const memberDir = join(artDir, 'members', slug);
              mkdirSync(memberDir, { recursive: true });
              for (const [fn, c] of Object.entries(files)) writeFileSync(join(memberDir, fn), c, 'utf-8');
            }
          }
        }

        if (server.deliverableService) {
          server.deliverableService.create({
            type: 'file',
            title: `${mode.charAt(0).toUpperCase() + mode.slice(1)}: ${manifest.displayName}`,
            summary: (artifact.description as string) ?? manifest.description ?? `${mode} saved via Builder`,
            reference: artDir,
            artifactType: mode as 'agent' | 'team' | 'skill',
            artifactData: artifact,
            tags: ['builder', mode],
          }).catch(err => log.warn('Failed to create deliverable for builder artifact', { error: String(err) }));
        }

        server.json(res, 201, { type: mode, name: manifest.name, path: artDir });
      } catch (err) {
        server.json(res, 500, { error: `Save failed: ${String(err)}` });
      }
      return true;
    }

    // POST /api/builder/artifacts/import — write a bundle of files directly to artifact directory
    if (path === '/api/builder/artifacts/import' && req.method === 'POST') {
      const body = await server.readBody(req);
      const type = body['type'] as string;
      const name = body['name'] as string;
      const files = body['files'] as Record<string, string> | undefined;
      const source = body['source'] as { type: string; hubItemId?: string; url?: string } | undefined;
      if (!type || !['agent', 'team', 'skill'].includes(type) || !name || !files) {
        server.json(res, 400, { error: 'type (agent|team|skill), name, and files are required' });
        return true;
      }
      try {
        const typeDir = type === 'agent' ? 'agents' : type === 'team' ? 'teams' : 'skills';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        mkdirSync(artDir, { recursive: true });
        for (const [fn, content] of Object.entries(files)) {
          const filePath = join(artDir, fn);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, content, 'utf-8');
        }

        // Write source tracking into manifest if source provided
        if (source) {
          const mfName = manifestFilename(type as PackageType);
          const mfPath = join(artDir, mfName);
          if (existsSync(mfPath)) {
            try {
              const mf = JSON.parse(readFileSync(mfPath, 'utf-8'));
              mf.source = source;
              writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf-8');
            } catch { /* skip if manifest invalid */ }
          }
        }

        server.json(res, 201, { type, name, path: artDir });
      } catch (err) {
        server.json(res, 500, { error: `Import failed: ${String(err)}` });
      }
      return true;
    }

    // POST /api/builder/artifacts/:type/:name/install — deploy from package to runtime
    {
      const installMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/install$/);
      if (installMatch && req.method === 'POST') {
        const rawType = installMatch[1]!;
        const name = decodeURIComponent(installMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = (typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill') as 'agent' | 'team' | 'skill';

        if (!server.builderService) {
          server.json(res, 500, { error: 'BuilderService not initialized' });
          return true;
        }

        if (type === 'team' && server.licenseService) {
          const limits = server.licenseService.getLimits();
          if (limits.maxTeams > 0) {
            const existingTeams = await server.orgService.listTeams('default');
            if (existingTeams.length >= limits.maxTeams) {
              server.json(res, 403, { error: `Team limit reached (${limits.maxTeams}). Upgrade to Enterprise for unlimited teams.` });
              return true;
            }
          }
        }

        try {
          const result = await server.builderService.installArtifact(type, name);
          server.json(res, 201, result);
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err);
          const status = msg.includes('not found') ? 404 : msg.includes('Invalid manifest') || msg.includes('No ') ? 400 : 500;
          server.json(res, status, { error: msg });
        }
        return true;
      }
    }

    // POST /api/builder/artifacts/:type/:name/uninstall — remove deployed artifact from runtime
    {
      const uninstallMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/uninstall$/);
      if (uninstallMatch && req.method === 'POST') {
        const rawType = uninstallMatch[1]!;
        const name = decodeURIComponent(uninstallMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill';

        try {
          const agentManager = server.orgService.getAgentManager();
          const dataDir = agentManager.getDataDir();
          const removedAgents: string[] = [];
          let removedTeamId: string | undefined;

          if (type === 'agent') {
            for (const agentInfo of agentManager.listAgents()) {
              const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
              if (existsSync(originPath)) {
                try {
                  const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
                  if (origin.artifact === name && (!origin.artifactType || origin.artifactType === 'agent')) {
                    await server.orgService.fireAgent(agentInfo.id);
                    removedAgents.push(agentInfo.id);
                  }
                } catch { /* skip */ }
              }
            }
          } else if (type === 'team') {
            const teamAgentIds: string[] = [];
            let teamId: string | undefined;
            for (const agentInfo of agentManager.listAgents()) {
              const originPath = join(dataDir, agentInfo.id, 'role', '.role-origin.json');
              if (existsSync(originPath)) {
                try {
                  const origin = JSON.parse(readFileSync(originPath, 'utf-8'));
                  if (origin.artifact === name && origin.artifactType === 'team') {
                    teamAgentIds.push(agentInfo.id);
                    if (!teamId) {
                      try {
                        const agentObj = agentManager.getAgent(agentInfo.id);
                        teamId = agentObj.config.teamId;
                      } catch { /* skip */ }
                    }
                  }
                } catch { /* skip */ }
              }
            }
            // Fallback: find team by matching member agent IDs
            if (!teamId && teamAgentIds.length > 0) {
              const teams = server.orgService.listTeams('default');
              for (const t of teams) {
                if (teamAgentIds.some(aid => t.memberAgentIds.includes(aid))) {
                  teamId = t.id;
                  break;
                }
              }
            }
            if (teamId) {
              await server.orgService.deleteTeam(teamId, true);
              removedTeamId = teamId;
            } else {
              for (const aid of teamAgentIds) {
                await server.orgService.fireAgent(aid);
              }
            }
            removedAgents.push(...teamAgentIds);
          } else if (type === 'skill') {
            const skillDir = join(homedir(), '.markus', 'skills', name);
            if (existsSync(skillDir)) {
              rmSync(skillDir, { recursive: true, force: true });
              if (server.skillRegistry) {
                try { server.skillRegistry.unregister(name); } catch { /* skip */ }
              }
            }
          }

          server.json(res, 200, { uninstalled: true, type, name, removedAgents, removedTeamId });
        } catch (err) {
          server.json(res, 500, { error: `Uninstall failed: ${String(err)}` });
        }
        return true;
      }
    }

    // DELETE /api/builder/artifacts/:type/:name — remove artifact
    {
      const delMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)$/);
      if (delMatch && req.method === 'DELETE') {
        const rawType = delMatch[1]!;
        const name = decodeURIComponent(delMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        if (!existsSync(artDir)) {
          server.json(res, 404, { error: 'Artifact not found' });
          return true;
        }
        try {
          rmSync(artDir, { recursive: true, force: true });
          server.json(res, 200, { deleted: true, type: typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill', name });
        } catch (err) {
          server.json(res, 500, { error: `Delete failed: ${String(err)}` });
        }
        return true;
      }
    }

    // POST /api/builder/artifacts/:type/:name/images — upload image
    {
      const imgPostMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/images$/);
      if (imgPostMatch && req.method === 'POST') {
        const rawType = imgPostMatch[1]!;
        const name = decodeURIComponent(imgPostMatch[2]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill' as const;
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        if (!existsSync(artDir)) { server.json(res, 404, { error: 'Artifact not found' }); return; }

        try {
          const imagesDir = join(artDir, 'images');
          if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          const body = Buffer.concat(chunks);

          const contentType = req.headers['content-type'] ?? '';
          if (contentType.includes('multipart/form-data')) {
            const boundary = contentType.split('boundary=')[1]?.split(';')[0];
            if (!boundary) { server.json(res, 400, { error: 'Missing boundary' }); return; }

            const bodyStr = body.toString('latin1');
            const parts = bodyStr.split('--' + boundary).filter(p => p.includes('Content-Disposition'));
            for (const part of parts) {
              const nameMatch = part.match(/filename="([^"]+)"/);
              if (!nameMatch) continue;
              const filename = nameMatch[1]!.replace(/[^a-zA-Z0-9._-]/g, '_');
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd < 0) continue;
              const fileContent = part.slice(headerEnd + 4).replace(/\r\n$/, '').replace(/\r\n--$/, '');
              const filePath = join(imagesDir, filename);
              writeFileSync(filePath, Buffer.from(fileContent, 'latin1'));

              const manifestFile = join(artDir, `${type}.json`);
              if (existsSync(manifestFile)) {
                try {
                  const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
                  const screenshots: string[] = manifest.screenshots ?? [];
                  const relPath = `images/${filename}`;
                  if (!screenshots.includes(relPath)) {
                    screenshots.push(relPath);
                    manifest.screenshots = screenshots;
                    if (!manifest.thumbnail) manifest.thumbnail = relPath;
                    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
                  }
                } catch { /* skip manifest update */ }
              }

              server.json(res, 200, { filename, path: `images/${filename}` });
              return true;
            }
            server.json(res, 400, { error: 'No image file found in upload' });
          } else {
            server.json(res, 400, { error: 'Expected multipart/form-data' });
          }
        } catch (err) {
          server.json(res, 500, { error: `Upload failed: ${String(err)}` });
        }
        return true;
      }
    }

    // GET /api/builder/artifacts/:type/:name/images/:filename — serve image
    {
      const imgGetMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/images\/([^/]+)$/);
      if (imgGetMatch && req.method === 'GET') {
        const rawType = imgGetMatch[1]!;
        const name = decodeURIComponent(imgGetMatch[2]!);
        const filename = decodeURIComponent(imgGetMatch[3]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const filePath = join(homedir(), '.markus', 'builder-artifacts', typeDir, name, 'images', filename);
        if (!existsSync(filePath)) { server.json(res, 404, { error: 'Image not found' }); return; }

        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
        res.end(readFileSync(filePath));
        return true;
      }
    }

    // DELETE /api/builder/artifacts/:type/:name/images/:filename — remove image
    {
      const imgDelMatch = path.match(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/images\/([^/]+)$/);
      if (imgDelMatch && req.method === 'DELETE') {
        const rawType = imgDelMatch[1]!;
        const name = decodeURIComponent(imgDelMatch[2]!);
        const filename = decodeURIComponent(imgDelMatch[3]!);
        const typeDir = rawType.endsWith('s') ? rawType : rawType + 's';
        const type = typeDir === 'agents' ? 'agent' : typeDir === 'teams' ? 'team' : 'skill' as const;
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, name);
        const filePath = join(artDir, 'images', filename);
        if (!existsSync(filePath)) { server.json(res, 404, { error: 'Image not found' }); return; }

        try {
          rmSync(filePath);
          const manifestFile = join(artDir, `${type}.json`);
          if (existsSync(manifestFile)) {
            try {
              const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));
              const relPath = `images/${filename}`;
              if (Array.isArray(manifest.screenshots)) {
                manifest.screenshots = manifest.screenshots.filter((s: string) => s !== relPath);
              }
              if (manifest.thumbnail === relPath) {
                manifest.thumbnail = manifest.screenshots?.[0] ?? undefined;
              }
              writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
            } catch { /* skip */ }
          }
          server.json(res, 200, { deleted: true, filename });
        } catch (err) {
          server.json(res, 500, { error: `Delete failed: ${String(err)}` });
        }
        return true;
      }
    }

    // Skills registry: SkillHub (skillhub.tencent.com) — static JSON from Tencent CDN
    if (path === '/api/skills/registry/skillhub' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const category = url.searchParams.get('category') ?? '';
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = parseInt(url.searchParams.get('limit') ?? '24', 10);
      const sort = url.searchParams.get('sort') ?? 'score';

      const cacheKey = 'skillhub-data';
      const now = Date.now();
      const cached = server.registryCache?.get(cacheKey) as { data: { total: number; generated_at: string; featured: string[]; categories: Record<string, string[]>; skills: Array<{ slug: string; name: string; description: string; description_zh?: string; version: string; homepage: string; tags: string[]; downloads: number; stars: number; installs: number; updated_at: number; score: number }> }; ts: number } | undefined;

      try {
        let allData = cached && now - cached.ts < 3_600_000 ? cached.data : null;
        if (!allData) {
          const dataUrl = 'https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.66a05e01.json';
          const resp = await fetch(dataUrl);
          if (!resp.ok) {
            server.json(res, 502, { error: `SkillHub CDN returned ${resp.status}` });
            return true;
          }
          allData = await resp.json() as typeof cached extends undefined ? never : NonNullable<typeof cached>['data'];
          if (!server.registryCache) server.registryCache = new Map();
          server.registryCache.set(cacheKey, { data: allData, ts: now });
        }

        let skills = allData!.skills;
        const categoryMap = allData!.categories ?? {};

        if (category && categoryMap[category]) {
          const catTags = new Set(categoryMap[category]!.map(t => t.toLowerCase()));
          skills = skills.filter(s => s.tags?.some(t => catTags.has(t.toLowerCase())));
        }

        if (q) {
          const lower = q.toLowerCase();
          skills = skills.filter(s =>
            s.name.toLowerCase().includes(lower) ||
            s.slug.toLowerCase().includes(lower) ||
            (s.description_zh ?? s.description ?? '').toLowerCase().includes(lower)
          );
        }

        if (sort === 'downloads') skills.sort((a, b) => b.downloads - a.downloads);
        else if (sort === 'stars') skills.sort((a, b) => b.stars - a.stars);
        else if (sort === 'installs') skills.sort((a, b) => b.installs - a.installs);
        else skills.sort((a, b) => b.score - a.score);

        const total = skills.length;
        const start = (page - 1) * limit;
        const pageSkills = skills.slice(start, start + limit);

        // Enrich homepage URLs: CDN data often has `clawhub.ai/{slug}` instead of `clawhub.ai/{owner}/{slug}`
        if (!server.registryCache) server.registryCache = new Map();
        const ownerCacheKey = 'skillhub-owner-map';
        const ownerMap: Map<string, string> = (server.registryCache.get(ownerCacheKey) as { data: Map<string, string> } | undefined)?.data ?? new Map();
        const needsEnrich = pageSkills.filter(s => {
          const hp = s.homepage ?? '';
          const hpPath = hp.replace(/^https?:\/\/clawhub\.ai\/?/, '');
          return hpPath && !hpPath.includes('/') && !ownerMap.has(s.slug);
        });
        if (needsEnrich.length > 0) {
          await Promise.allSettled(
            needsEnrich.map(async s => {
              try {
                const resp = await fetch(`https://wry-manatee-359.convex.site/api/v1/skills/${encodeURIComponent(s.slug)}`, { signal: AbortSignal.timeout(5000) });
                if (resp.ok) {
                  const detail = await resp.json() as { owner?: { handle?: string } };
                  if (detail.owner?.handle) {
                    ownerMap.set(s.slug, detail.owner.handle);
                  }
                }
              } catch { /* skip — will use original homepage */ }
            })
          );
          server.registryCache.set(ownerCacheKey, { data: ownerMap, ts: now });
        }
        const enrichedSkills = pageSkills.map(s => {
          const hp = s.homepage ?? '';
          const hpPath = hp.replace(/^https?:\/\/clawhub\.ai\/?/, '');
          if (hpPath && !hpPath.includes('/') && ownerMap.has(s.slug)) {
            return { ...s, homepage: `https://clawhub.ai/${ownerMap.get(s.slug)}/${s.slug}` };
          }
          return s;
        });

        server.json(res, 200, {
          skills: enrichedSkills,
          total,
          page,
          limit,
          categories: Object.keys(categoryMap),
          featured: allData!.featured,
          cached: !!(cached && now - cached.ts < 3_600_000),
        });
      } catch (err) {
        server.json(res, 500, { error: `SkillHub fetch failed: ${String(err)}` });
      }
      return true;
    }

    // Skills registry: Proxy fetch from skills.sh leaderboard
    if (path === '/api/skills/registry/skillssh' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const cacheKey = `skillssh-${q || 'leaderboard'}`;
      const now = Date.now();
      const cached = server.registryCache?.get(cacheKey);
      if (cached && now - cached.ts < 600_000) {
        server.json(res, 200, { skills: cached.data, cached: true });
        return true;
      }
      try {
        const fetchUrl = q
          ? `https://skills.sh/search?q=${encodeURIComponent(q)}`
          : 'https://skills.sh/';
        const resp = await fetch(fetchUrl);
        if (!resp.ok) {
          server.json(res, 502, { error: `skills.sh returned ${resp.status}` });
          return true;
        }
        const html = await resp.text();
        const skills: Array<{ name: string; author: string; repo: string; installs: string; url: string; description?: string }> = [];
        const seen = new Set<string>();

        // Parse the leaderboard HTML: each skill is an <a> block with h3 (name), p (author/repo), span (installs)
        const blockRegex = /<a[^>]*href="\/([\w-]+\/[\w.-]+\/[\w][\w.-]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const IGNORED_PREFIXES = new Set(['_next', 'static', 'api', 'assets', 'images', 'fonts', 'css', 'js']);
        let match: RegExpExecArray | null;
        while ((match = blockRegex.exec(html)) !== null) {
          const fullPath = match[1]!;
          const parts = fullPath.split('/');
          if (parts.length < 3) continue;
          if (IGNORED_PREFIXES.has(parts[0]!)) continue;

          const author = parts[0]!;
          const repo = `${parts[0]}/${parts[1]}`;
          const block = match[2]!;

          // Extract skill name from <h3>
          const nameMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/);
          const name = nameMatch?.[1]?.trim() ?? parts[2]!;

          // Extract install count from last <span class="font-mono ...">
          const installMatches = [...block.matchAll(/<span[^>]*font-mono[^>]*>([\d.]+[KMB]?)<\/span>/g)];
          const installs = installMatches.length > 0 ? installMatches[installMatches.length - 1]![1] ?? '' : '';

          const key = `${author}/${repo}/${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          skills.push({ name, author, repo, installs, url: `https://skills.sh/${fullPath}` });
        }

        // Fetch descriptions for top skills in parallel (batch of first 20)
        const toFetch = skills.slice(0, 20).filter(s => !s.description);
        if (toFetch.length > 0) {
          const descResults = await Promise.allSettled(
            toFetch.map(async (s) => {
              const pageResp = await fetch(s.url, { signal: AbortSignal.timeout(8000) });
              if (!pageResp.ok) return { name: s.name, desc: '' };
              const pageHtml = await pageResp.text();
              const pMatch = pageHtml.match(/<p[^>]*class="[^"]*text-muted[^"]*"[^>]*>(.*?)<\/p>/);
              if (pMatch) return { name: s.name, desc: pMatch[1]!.replace(/<[^>]+>/g, '').trim() };
              const firstP = pageHtml.match(/<article[^>]*>[\s\S]*?<p[^>]*>(.*?)<\/p>/);
              if (firstP) return { name: s.name, desc: firstP[1]!.replace(/<[^>]+>/g, '').trim() };
              return { name: s.name, desc: '' };
            })
          );
          for (const r of descResults) {
            if (r.status === 'fulfilled' && r.value.desc) {
              const skill = skills.find(s => s.name === r.value.name);
              if (skill) skill.description = r.value.desc;
            }
          }
        }

        if (!server.registryCache) server.registryCache = new Map();
        server.registryCache.set(cacheKey, { data: skills, ts: now });
        server.json(res, 200, { skills, cached: false });
      } catch (err) {
        server.json(res, 500, { error: `skills.sh fetch failed: ${String(err)}` });
      }
      return true;
    }
  return false;
}
