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
  roleName: string;
  agentRole: 'manager' | 'worker';
  llmProvider?: string;
  llmModel?: string;
  temperature?: number;
}

export interface TeamMemberSection {
  name: string;
  role: 'manager' | 'worker';
  roleName: string;
  count: number;
  skills?: string[];
}

export interface TeamSection {
  members: TeamMemberSection[];
}

export interface SkillSection {
  skillFile: string;
  requiredPermissions?: ('shell' | 'file' | 'network' | 'browser')[];
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
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
  source?: PackageSource;
  dependencies?: PackageDependencies;

  agent?: AgentSection;
  team?: TeamSection;
  skill?: SkillSection;
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

  const rawName = (raw.name as string) || (raw.displayName as string) || 'unnamed';
  const name = kebab(rawName);
  const displayName = (raw.displayName as string) || (raw.name as string) || name;

  const base: MarkusPackageManifest = {
    type,
    name,
    displayName,
    version: (raw.version as string) ?? '1.0.0',
    description: (raw.description as string) ?? '',
    author: (raw.author as string) ?? '',
    category: ((raw.category as string) ?? 'general') as PackageCategory,
    tags: toArr(raw.tags),
    icon: (raw.icon as string) || undefined,
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
      roleName: (agentRaw.roleName as string) ?? (raw.roleName as string) ?? 'developer',
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
        roleName: (m.roleName as string) ?? 'developer',
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
  if (!o.version || typeof o.version !== 'string')
    errors.push('version is required');
  if (typeof o.version === 'string' && !/^\d+\.\d+\.\d+/.test(o.version))
    errors.push('version must be semver (e.g. 1.0.0)');

  if (o.type === 'agent' && o.agent) {
    const a = o.agent as Record<string, unknown>;
    if (!a.roleName || typeof a.roleName !== 'string')
      errors.push('agent.roleName is required');
  }

  if (o.type === 'team' && o.team) {
    const t = o.team as Record<string, unknown>;
    if (!Array.isArray(t.members) || t.members.length === 0)
      errors.push('team.members must be a non-empty array');
  }

  return errors;
}

function kebab(s: string): string {
  const result = s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (result) return result;
  // Non-ASCII names (e.g. Chinese) produce empty string — generate a stable hash-based slug
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return `pkg-${Math.abs(hash).toString(36)}`;
}
