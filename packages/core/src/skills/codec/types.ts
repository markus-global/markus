/**
 * Skill ecosystem codec — types for external skill format detection,
 * normalization, import, and export.
 *
 * The codec bridges Markus skill packages (skill.json + SKILL.md) with the
 * mainstream external skill ecosystems:
 *   - skills.sh / Claude Code SKILL.md (80k+ community skills)
 *   - SkillHub / ClawHub skill packets
 *   - OpenClaw / SOUL.md
 *   - AgentScope (tool-script style skills)
 *   - generic MCP-server skills (mcp.json / .mcp.json)
 */
import type { SkillCategory, SkillMcpServerConfig, SkillManifest } from '../types.js';

export type ExternalSkillFormat =
  | 'markus'       // Markus native (skill.json + SKILL.md)
  | 'claude'       // Claude Code / skills.sh SKILL.md with YAML frontmatter
  | 'skillhub'     // SkillHub / ClawHub skill packet (SKILL.md + assets, or skills/ dir)
  | 'openclaw'     // OpenClaw skill dir (config.json5 / AGENTS.md / skills/ subdir)
  | 'soul'         // OpenClaw SOUL.md soul pack
  | 'agentscope'   // AgentScope-style tool-script skill (README + @tool python)
  | 'mcp-server';  // generic MCP server skill (mcp.json / .mcp.json)

export const SUPPORTED_EXTERNAL_FORMATS: ExternalSkillFormat[] = [
  'claude',
  'skillhub',
  'openclaw',
  'soul',
  'agentscope',
  'mcp-server',
];

/** Fields supported by the minimal SKILL.md YAML frontmatter parser. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  license?: string;
  author?: string;
  /** Claude Code allowed-tools list — mapped to Markus requiredPermissions. */
  allowedTools?: string[];
  tags?: string[];
  [key: string]: unknown;
}

/** Normalized intermediate representation of an external skill package. */
export interface NormalizedSkill {
  name: string;                       // kebab-case package slug
  displayName?: string;
  version: string;                    // semver-ish (coerced to 1.0.0 when missing)
  description: string;
  author?: string;
  category: SkillCategory;
  tags?: string[];
  license?: string;
  /** Origin ecosystem: which format produced this skill. */
  source: ExternalSkillFormat;
  sourceUrl?: string;
  requiredPermissions?: ('shell' | 'file' | 'network' | 'browser')[];
  mcpServers?: Record<string, SkillMcpServerConfig>;
  isolation?: SkillManifest['isolation'];
  /** Full SKILL.md body (frontmatter stripped). */
  instructions?: string;
  /** i18n overrides, e.g. { 'zh-CN': { displayName, description } }. */
  i18n?: Record<string, { displayName?: string; description?: string }>;
  /** Extra files (relative paths) to carry over during import. */
  extraFiles?: Array<{ from: string; to: string }>;
}

export interface SkillImportOptions {
  /** Override the skill name (kebab-case). Defaults to detected name / dir name. */
  name?: string;
  /** Target directory for the normalized skill. Defaults to ~/.markus/skills/<name>. */
  targetDir?: string;
  /** Force overwrite of an existing target directory. Default false. */
  force?: boolean;
  /** Optional origin URL recorded in skill.json `source.url`. */
  sourceUrl?: string;
}

export interface SkillImportResult {
  format: ExternalSkillFormat;
  name: string;
  version: string;
  path: string;
  filesWritten: string[];
  warnings: string[];
}

export interface SkillExportOptions {
  /** Output directory; format subdirectory is created inside (default CWD). */
  outDir?: string;
  /** Overwrite existing output files. Default false. */
  overwrite?: boolean;
}

export interface SkillExportResult {
  format: Exclude<ExternalSkillFormat, 'markus'>;
  name: string;
  path: string;
  filesWritten: string[];
}

/** In-memory render output item. */
export interface RenderedFile {
  path: string;      // relative path within the output package dir
  content: string;   // UTF-8 text content
}