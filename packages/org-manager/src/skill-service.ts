import { join, resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger, buildManifest, manifestFilename } from '@markus/shared';
import { discoverSkillsInDir, type SkillRegistry } from '@markus/core';

const log = createLogger('skill-service');

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillSearchResult {
  name: string;
  description: string;
  source: 'skillhub' | 'skillssh';
  slug?: string;
  author?: string;
  category?: string;
  version?: string;
  homepage?: string;
  githubRepo?: string;
  githubSkillPath?: string;
  installs?: string;
}

export interface SkillInstallRequest {
  name: string;
  source?: string;
  slug?: string;
  sourceUrl?: string;
  description?: string;
  category?: string;
  version?: string;
  githubRepo?: string;
  githubSkillPath?: string;
}

export interface SkillInstallResult {
  installed: boolean;
  name: string;
  path: string;
  method: string;
}

// ── Registry search cache ────────────────────────────────────────────────────

const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL_MS = 600_000; // 10 min
const SKILLHUB_CACHE_TTL_MS = 3_600_000; // 1 hour

// ── Search functions ─────────────────────────────────────────────────────────

export async function searchSkillHub(query: string): Promise<SkillSearchResult[]> {
  const cacheKey = 'skillhub-data';
  const now = Date.now();
  const cached = cache.get(cacheKey) as {
    data: {
      skills: Array<{
        slug: string; name: string; description: string; description_zh?: string;
        version: string; homepage: string; tags: string[];
        downloads: number; stars: number; installs: number; score: number;
      }>;
    };
    ts: number;
  } | undefined;

  let allData = cached && now - cached.ts < SKILLHUB_CACHE_TTL_MS ? cached.data : null;
  if (!allData) {
    const dataUrl = 'https://cloudcache.tencentcs.com/qcloud/tea/app/data/skills.66a05e01.json';
    const resp = await fetch(dataUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];
    allData = await resp.json() as NonNullable<typeof allData>;
    cache.set(cacheKey, { data: allData, ts: now });
  }

  let skills = allData!.skills;
  if (query) {
    const lower = query.toLowerCase();
    skills = skills.filter(s =>
      s.name.toLowerCase().includes(lower) ||
      s.slug.toLowerCase().includes(lower) ||
      (s.description_zh ?? s.description ?? '').toLowerCase().includes(lower)
    );
  }
  skills.sort((a, b) => b.score - a.score);

  return skills.slice(0, 15).map(s => ({
    name: s.name,
    description: s.description_zh ?? s.description,
    source: 'skillhub' as const,
    slug: s.slug,
    version: s.version,
    homepage: s.homepage,
    installs: String(s.installs),
  }));
}

export async function searchSkillsSh(query: string): Promise<SkillSearchResult[]> {
  const cacheKey = `skillssh-${query || 'leaderboard'}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.data as SkillSearchResult[];
  }

  const fetchUrl = query
    ? `https://skills.sh/search?q=${encodeURIComponent(query)}`
    : 'https://skills.sh/';
  const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return [];
  const html = await resp.text();

  const results: SkillSearchResult[] = [];
  const seen = new Set<string>();
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

    const nameMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/);
    const name = nameMatch?.[1]?.trim() ?? parts[2]!;

    const installMatches = [...block.matchAll(/<span[^>]*font-mono[^>]*>([\d.]+[KMB]?)<\/span>/g)];
    const installs = installMatches.length > 0 ? installMatches[installMatches.length - 1]![1] ?? '' : '';

    const key = `${author}/${repo}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      description: '',
      source: 'skillssh',
      author,
      githubRepo: repo,
      githubSkillPath: name,
      installs,
      homepage: `https://skills.sh/${fullPath}`,
    });
  }

  // Fetch descriptions for top results
  const toFetch = results.slice(0, 10);
  if (toFetch.length > 0) {
    const descResults = await Promise.allSettled(
      toFetch.map(async s => {
        const pageResp = await fetch(s.homepage!, { signal: AbortSignal.timeout(8000) });
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
        const skill = results.find(s => s.name === r.value.name);
        if (skill) skill.description = r.value.desc;
      }
    }
  }

  const final = results.slice(0, 15);
  cache.set(cacheKey, { data: final, ts: now });
  return final;
}

/**
 * Search both SkillHub and skills.sh registries, merge and deduplicate results.
 */
export async function searchRegistries(query: string): Promise<SkillSearchResult[]> {
  const [hubResults, sshResults] = await Promise.allSettled([
    searchSkillHub(query),
    searchSkillsSh(query),
  ]);
  const all: SkillSearchResult[] = [];
  const seen = new Set<string>();

  for (const r of [hubResults, sshResults]) {
    if (r.status === 'fulfilled') {
      for (const s of r.value) {
        const key = s.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          all.push(s);
        }
      }
    }
  }
  return all.slice(0, 20);
}

// ── Install function ─────────────────────────────────────────────────────────

export async function installSkill(
  request: SkillInstallRequest,
  skillRegistry?: SkillRegistry,
): Promise<SkillInstallResult> {
  const { name: skillName, source, slug, sourceUrl, description, category, version, githubRepo, githubSkillPath } = request;

  const skillsDir = join(homedir(), '.markus', 'skills');
  const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const targetDir = join(skillsDir, safeName);

  mkdirSync(skillsDir, { recursive: true });

  let installed = false;
  let installMethod = 'metadata-only';

  // Strategy 0: Built-in skill — copy from templates/skills/
  if (source === 'builtin') {
    const builtinDir = resolve(process.cwd(), 'templates', 'skills', safeName);
    if (existsSync(builtinDir)) {
      mkdirSync(targetDir, { recursive: true });
      for (const file of readdirSync(builtinDir)) {
        copyFileSync(join(builtinDir, file), join(targetDir, file));
      }
      installed = true;
      installMethod = 'builtin-copy';
    }
  }

  // Strategy 1: SkillHub/ClawHub — download ZIP via Convex API
  if (!installed && source === 'skillhub' && slug) {
    try {
      const zipUrl = `https://wry-manatee-359.convex.site/api/v1/download?slug=${encodeURIComponent(slug)}`;
      const zipResp = await fetch(zipUrl, { signal: AbortSignal.timeout(20000) });
      if (zipResp.ok) {
        const tmpZip = join(skillsDir, `_tmp_${safeName}.zip`);
        const buffer = Buffer.from(await zipResp.arrayBuffer());
        writeFileSync(tmpZip, buffer);
        mkdirSync(targetDir, { recursive: true });
        try {
          execSync(`unzip -o "${tmpZip}" -d "${targetDir}"`, { timeout: 30000 });
          installed = true;
          installMethod = 'clawhub-zip';
        } catch {
          log.warn('unzip failed for skill', { skillName });
        }
        try { execSync(`rm -f "${tmpZip}"`); } catch { /* cleanup */ }
      }
    } catch (err) {
      log.warn(`ClawHub download failed for ${slug}`, { error: String(err) });
    }
  }

  // Strategy 2: skills.sh — try to download SKILL.md from GitHub
  if (!installed && source === 'skillssh' && githubRepo) {
    try {
      const rawBase = `https://raw.githubusercontent.com/${githubRepo}/refs/heads/main`;
      const skillPath = githubSkillPath || safeName;
      const skillMdUrl = `${rawBase}/${skillPath}/SKILL.md`;
      const mdResp = await fetch(skillMdUrl, { signal: AbortSignal.timeout(15000) });
      if (mdResp.ok) {
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(targetDir, 'SKILL.md'), await mdResp.text(), 'utf-8');
        installed = true;
        installMethod = 'github-skillmd';
      }
    } catch (err) {
      log.warn(`GitHub SKILL.md download failed`, { error: String(err) });
    }

    if (!installed) {
      try {
        const rawBase = `https://raw.githubusercontent.com/${githubRepo}/refs/heads/main`;
        const rootMd = `${rawBase}/SKILL.md`;
        const mdResp = await fetch(rootMd, { signal: AbortSignal.timeout(15000) });
        if (mdResp.ok) {
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(join(targetDir, 'SKILL.md'), await mdResp.text(), 'utf-8');
          installed = true;
          installMethod = 'github-root-skillmd';
        }
      } catch { /* fallthrough */ }
    }
  }

  // Strategy 3: Try ClawHub ZIP as fallback
  if (!installed) {
    const trySlug = slug || safeName;
    try {
      const zipUrl = `https://wry-manatee-359.convex.site/api/v1/download?slug=${encodeURIComponent(trySlug)}`;
      const zipResp = await fetch(zipUrl, { signal: AbortSignal.timeout(20000) });
      if (zipResp.ok) {
        const tmpZip = join(skillsDir, `_tmp_${safeName}.zip`);
        const buffer = Buffer.from(await zipResp.arrayBuffer());
        writeFileSync(tmpZip, buffer);
        mkdirSync(targetDir, { recursive: true });
        try {
          execSync(`unzip -o "${tmpZip}" -d "${targetDir}"`, { timeout: 30000 });
          installed = true;
          installMethod = 'clawhub-zip-fallback';
        } catch {
          log.warn('unzip failed (fallback)', { skillName });
        }
        try { execSync(`rm -f "${tmpZip}"`); } catch { /* cleanup */ }
      }
    } catch {
      log.warn(`ClawHub fallback failed for ${trySlug}`);
    }
  }

  if (!installed) {
    throw new Error(`Download failed for "${skillName}". Source: ${sourceUrl ?? slug ?? 'unknown'}`);
  }

  // Supplement skill.json from metadata if download didn't include one
  const skillMfPath = join(targetDir, manifestFilename('skill'));
  const skillSource = { type: (source as 'skillhub' | 'skillssh' | 'local') ?? 'local', url: sourceUrl ?? '' };
  if (!existsSync(skillMfPath)) {
    const raw: Record<string, unknown> = {
      name: skillName,
      version: version ?? '1.0.0',
      description: description ?? `Skill: ${skillName}`,
      category: category ?? 'custom',
    };
    const manifest = buildManifest('skill', raw);
    manifest.source = skillSource;
    writeFileSync(skillMfPath, JSON.stringify(manifest, null, 2), 'utf-8');
  } else {
    try {
      const mf = JSON.parse(readFileSync(skillMfPath, 'utf-8'));
      if (!mf.source) { mf.source = skillSource; writeFileSync(skillMfPath, JSON.stringify(mf, null, 2), 'utf-8'); }
    } catch { /* skip */ }
  }

  // Register into runtime SkillRegistry
  if (skillRegistry) {
    try {
      const discovered = discoverSkillsInDir(skillsDir).find(
        d => d.manifest.name === skillName || d.path === targetDir
      );
      if (discovered && !skillRegistry.get(discovered.manifest.name)) {
        discovered.manifest.sourcePath = discovered.path;
        skillRegistry.register({ manifest: discovered.manifest });
      }
    } catch (regErr) {
      log.warn('Failed to register installed skill into runtime registry', { error: String(regErr) });
    }
  }

  return { installed: true, name: skillName, path: targetDir, method: installMethod };
}
