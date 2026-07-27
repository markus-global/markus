// ─── Unified Package Manifest ────────────────────────────────────────────────
//
// Every builder artifact (agent, team, skill) uses this format as its
// single source of truth.  The file lives at {package-dir}/agent.json,
// team.json, or skill.json depending on the package type.

export type PackageType = 'agent' | 'team' | 'skill';

export type PackageCategory =
  | 'development'
  | 'devops'
  | 'management'
  | 'productivity'
  | 'browser'
  | 'custom'
  | 'general';

export interface PackageSource {
  type: 'local' | 'hub' | 'skillhub' | 'skillssh';
  url?: string;
  hubItemId?: string;
}

export interface PackageDependencies {
  skills?: string[];
  env?: string[];
}

// ─── Type-specific sections ─────────────────────────────────────────────────

export interface AgentSection {
  roleName?: string;
  agentRole: 'manager' | 'worker';
  llmProvider?: string;
  llmModel?: string;
  temperature?: number;
}

export interface TeamMemberSection {
  name: string;
  role: 'manager' | 'worker';
  roleName?: string;
  count: number;
  description?: string;
  skills?: string[];
}

export interface StarterTaskDef {
  title: string;
  description: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface TeamSection {
  members: TeamMemberSection[];
  /** Pre-built tasks created when the team is first set up (for onboarding) */
  starterTasks?: StarterTaskDef[];
  /** Workflow template YAML files relative to the package root, e.g. ["workflows/content-publishing.yaml"] */
  workflows?: string[];
}

export interface SkillSection {
  skillFile: string;
  requiredPermissions?: ('shell' | 'file' | 'network' | 'browser')[];
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** MCP server isolation mode. 'per-agent' spawns a separate MCP process per agent (needed for stateful tools like browser). */
  isolation?: 'shared' | 'per-agent';
  /** If true, instructions are auto-injected into every agent (not just available for discovery) */
  alwaysOn?: boolean;
}

// ─── Top-level manifest ─────────────────────────────────────────────────────

export interface MarkusPackageManifest {
  type: PackageType;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  category: PackageCategory;
  tags: string[];
  icon?: string;
  thumbnail?: string;
  screenshots?: string[];
  source?: PackageSource;
  dependencies?: PackageDependencies;

  /** Localized strings keyed by locale (e.g. 'zh-CN') */
  i18n?: Record<string, { displayName?: string; name?: string; description?: string }>;
  /** If true, hide from store/marketplace listing (still usable programmatically) */
  hidden?: boolean;

  agent?: AgentSection;
  team?: TeamSection;
  skill?: SkillSection;
  /** Pre-built tasks created when the team is first set up (for onboarding) */
  starterTasks?: StarterTaskDef[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** @deprecated Use manifestFilename(type) instead */
export const MARKUS_MANIFEST_FILENAME = 'markus.json';

const MANIFEST_FILENAMES: Record<PackageType, string> = {
  agent: 'agent.json',
  team: 'team.json',
  skill: 'skill.json',
};

/** Return the manifest filename for a given package type. */
export function manifestFilename(type: PackageType): string {
  return MANIFEST_FILENAMES[type] ?? `${type}.json`;
}

/**
 * Build a MarkusPackageManifest from loose artifact data (the JSON blob
 * that builder agents produce).  Normalises field types and fills defaults.
 */
export function buildManifest(
  type: PackageType,
  raw: Record<string, unknown>,
): MarkusPackageManifest {
  const toArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return (v as string[]).map(s => String(s).trim()).filter(Boolean);
    if (typeof v === 'string' && v) return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  };

  // `name` is the package slug — must already be (or normalize to) English kebab-case.
  // Non-ASCII names are left as-is so validateManifest can reject them (no silent pkg-* hash).
  const rawName = String((raw.name as string) || '').trim();
  const name = toPackageSlug(rawName) ?? rawName;
  const displayName = (raw.displayName as string) || rawName || name;

  const rawAuthor = raw.author;
  const author: string = typeof rawAuthor === 'string' ? rawAuthor
    : (rawAuthor && typeof rawAuthor === 'object' && 'name' in rawAuthor) ? String((rawAuthor as Record<string, unknown>).name)
    : '';

  const base: MarkusPackageManifest = {
    type,
    name,
    displayName,
    version: (raw.version as string) ?? '1.0.0',
    description: (raw.description as string) ?? '',
    author,
    category: ((raw.category as string) ?? 'general') as PackageCategory,
    tags: toArr(raw.tags),
    icon: (raw.icon as string) || undefined,
    thumbnail: (raw.thumbnail as string) || undefined,
    screenshots: Array.isArray(raw.screenshots) ? (raw.screenshots as string[]) : undefined,
    source: raw.source as PackageSource | undefined,
    dependencies: undefined,
  };

  const skills = toArr(raw.skills);
  const env = toArr(raw.requiredEnv);
  if (skills.length > 0 || env.length > 0) {
    base.dependencies = { skills: skills.length > 0 ? skills : undefined, env: env.length > 0 ? env : undefined };
  }

  if (type === 'agent') {
    const agentRaw = (raw.agent as Record<string, unknown>) ?? raw;
    base.agent = {
      roleName: (agentRaw.roleName as string) || (raw.roleName as string) || undefined,
      agentRole: ((agentRaw.agentRole as string) ?? (raw.agentRole as string) ?? 'worker') as 'manager' | 'worker',
      llmProvider: (agentRaw.llmProvider as string) || (raw.llmProvider as string) || undefined,
      llmModel: (agentRaw.llmModel as string) || (raw.llmModel as string) || undefined,
      temperature: typeof agentRaw.temperature === 'number' ? agentRaw.temperature : typeof raw.temperature === 'number' ? raw.temperature : undefined,
    };
    const depsRaw = (raw.dependencies as Record<string, unknown>) ?? raw;
    const depSkills = toArr(depsRaw.skills);
    const depEnv = toArr(depsRaw.env);
    if (depSkills.length > 0 || depEnv.length > 0) {
      base.dependencies = { skills: depSkills.length > 0 ? depSkills : undefined, env: depEnv.length > 0 ? depEnv : undefined };
    }
  } else if (type === 'team') {
    const teamRaw = raw.team as Record<string, unknown> | undefined;
    const rawMembers = Array.isArray(teamRaw?.members) ? teamRaw!.members as Array<Record<string, unknown>>
      : Array.isArray(raw.members) ? raw.members as Array<Record<string, unknown>> : [];
    base.team = {
      members: rawMembers.map(m => ({
        name: (m.name as string) ?? 'Agent',
        role: ((m.role as string) ?? 'worker') as 'manager' | 'worker',
        roleName: (m.roleName as string) || undefined,
        count: (m.count as number) ?? 1,
        skills: toArr(m.skills).length > 0 ? toArr(m.skills) : undefined,
      })),
    };
  } else if (type === 'skill') {
    const agentSection = raw.agent as Record<string, unknown> | undefined;
    const skillSection = raw.skill as Record<string, unknown> | undefined;
    base.skill = {
      skillFile: (skillSection?.skillFile as string) ?? (raw.skillFile as string) ?? 'SKILL.md',
      requiredPermissions: (skillSection?.requiredPermissions ?? raw.requiredPermissions) as SkillSection['requiredPermissions'],
      mcpServers: (skillSection?.mcpServers ?? raw.mcpServers) as SkillSection['mcpServers'],
      isolation: (skillSection?.isolation ?? raw.isolation) as SkillSection['isolation'],
    };
    // Pull version/author from raw if present
    if (!base.version || base.version === '1.0.0') {
      base.version = (raw.version as string) ?? '1.0.0';
    }
    // Skills don't have agent section
    if (agentSection) delete (base as unknown as Record<string, unknown>).agent;
  }

  return base;
}

/**
 * Read the manifest (agent.json / team.json / skill.json) from a package directory.
 * When `type` is provided, reads that specific file.
 * When omitted, tries all three filenames and returns the first that exists.
 */
export function readManifest(artDir: string, typeOrFs: PackageType | {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf-8') => string;
  join: (...parts: string[]) => string;
}, fs?: {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf-8') => string;
  join: (...parts: string[]) => string;
}): MarkusPackageManifest | null {
  let type: PackageType | undefined;
  let _fs: typeof fs;
  if (typeof typeOrFs === 'string') {
    type = typeOrFs;
    _fs = fs;
  } else {
    _fs = typeOrFs;
  }
  if (!_fs) return null;

  const tryRead = (filename: string): MarkusPackageManifest | null => {
    const p = _fs!.join(artDir, filename);
    if (!_fs!.existsSync(p)) return null;
    try { return JSON.parse(_fs!.readFileSync(p, 'utf-8')) as MarkusPackageManifest; } catch { return null; }
  };

  if (type) return tryRead(manifestFilename(type));

  for (const t of ['agent', 'team', 'skill'] as PackageType[]) {
    const m = tryRead(manifestFilename(t));
    if (m) return m;
  }
  return null;
}

/**
 * Validate a manifest, returning an array of error strings.
 * Empty array = valid.
 */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') return ['Manifest must be a non-null object'];
  const o = m as Record<string, unknown>;

  if (!o.type || !['agent', 'team', 'skill'].includes(o.type as string))
    errors.push('type must be "agent", "team", or "skill"');
  if (!o.name || typeof o.name !== 'string' || o.name.trim().length === 0)
    errors.push('name is required');
  else if (!isValidPackageSlug(o.name))
    errors.push(PACKAGE_SLUG_ERROR);
  if (!o.version || typeof o.version !== 'string')
    errors.push('version is required');
  if (typeof o.version === 'string' && !/^\d+\.\d+\.\d+/.test(o.version))
    errors.push('version must be semver (e.g. 1.0.0)');
  if (o.author !== undefined && typeof o.author !== 'string')
    errors.push('author must be a string (e.g. "Your Name"), not an object');
  if (o.category !== undefined && typeof o.category !== 'string')
    errors.push('category must be a string');
  if (o.tags !== undefined && !Array.isArray(o.tags))
    errors.push('tags must be an array of strings');
  if (o.description !== undefined && typeof o.description !== 'string')
    errors.push('description must be a string');

  if (o.type === 'agent' && o.agent) {
    const a = o.agent as Record<string, unknown>;
    if (a.roleName !== undefined && typeof a.roleName !== 'string')
      errors.push('agent.roleName must be a string if provided');
  }

  if (o.type === 'team' && o.team) {
    const t = o.team as Record<string, unknown>;
    if (!Array.isArray(t.members) || t.members.length === 0)
      errors.push('team.members must be a non-empty array');
  }

  return errors;
}

/** English kebab-case package slug: `code-reviewer`, `frontend-squad` (2–64 chars). */
export const PACKAGE_SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const PACKAGE_SLUG_ERROR =
  'name must be an English kebab-case slug (e.g. "code-reviewer"): 2–64 chars, lowercase letters/digits/hyphens only, must start with a letter. Chinese, spaces, and underscores are rejected. Put the human-readable title in displayName.';

export function isValidPackageSlug(s: string): boolean {
  return typeof s === 'string' && s.length >= 2 && s.length <= 64 && PACKAGE_SLUG_RE.test(s);
}

/**
 * Normalize a string toward a package slug. Returns null when the input cannot
 * become a valid English kebab-case slug (e.g. Chinese-only names).
 */
export function toPackageSlug(s: string): string | null {
  const result = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return isValidPackageSlug(result) ? result : null;
}

/**
 * Ensure a package slug is valid. ASCII names normalize to kebab-case;
 * non-ASCII (e.g. Chinese) get a stable `pkg-<hash>` slug so legacy artifacts
 * can still be shared without manual rename.
 */
export function ensurePackageSlug(raw: string): { slug: string; converted: boolean } {
  const input = String(raw || '').trim();
  if (isValidPackageSlug(input)) return { slug: input, converted: false };
  const normalized = toPackageSlug(input);
  if (normalized) return { slug: normalized, converted: normalized !== input };
  return { slug: kebab(input || 'package'), converted: true };
}

/**
 * Convert a string to a kebab-case slug safe for filesystem paths and URLs.
 * Prefer `toPackageSlug` for package `name` / Hub publish slugs — this helper
 * may invent a `pkg-*` hash for non-ASCII input and must not be used to bypass validation.
 */
export function kebab(s: string, fallback?: string): string {
  const normalized = toPackageSlug(s);
  if (normalized) return normalized;
  if (fallback && isValidPackageSlug(fallback)) return fallback;
  if (fallback) {
    const fb = toPackageSlug(fallback);
    if (fb) return fb;
  }
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return `pkg-${Math.abs(hash).toString(36)}`;
}
