/**
 * Detect which external skill format a directory (or file) uses.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExternalSkillFormat } from './types.js';

export interface DetectFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf-8') => string;
  isDirectory: (p: string) => boolean;
  listDir: (p: string) => string[];
}

export function nodeDetectFs(): DetectFs {
  return {
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc),
    isDirectory: (p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch { return []; }
    },
  };
}

function fallbackListDir(fs: DetectFs, dir: string): string[] {
  // node:fs readdirSync is used by the real fs; detectFs.listDir is only used
  // by test double implementations that may not implement readdirSync.
  try {
    return fs.listDir(dir);
  } catch {
    return [];
  }
}

/** True when a file with the given name exists (case-insensitive). */
function findFile(fs: DetectFs, dir: string, candidates: string[]): string | undefined {
  const names = fallbackListDir(fs, dir);
  for (const n of names) {
    if (candidates.some(c => n.toLowerCase() === c.toLowerCase())) return n;
  }
  return undefined;
}

function hasMarkusManifest(fs: DetectFs, dir: string): boolean {
  const found = findFile(fs, dir, ['skill.json', 'manifest.json']);
  if (!found) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(join(dir, found), 'utf-8')) as { type?: string };
    if (raw.type === 'skill') return true;
    // OpenClaw manifest.json may use { "type": "agent" | "skill" } — accept only skill
    return false;
  } catch {
    return false;
  }
}

function hasMcpJson(fs: DetectFs, dir: string): boolean {
  const found = findFile(fs, dir, ['mcp.json', '.mcp.json']);
  if (!found) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(join(dir, found), 'utf-8')) as { mcpServers?: unknown };
    return !!raw.mcpServers;
  } catch {
    return false;
  }
}

function hasSoulMd(fs: DetectFs, dir: string): boolean {
  const found = findFile(fs, dir, ['SOUL.md']);
  return !!found;
}

function hasSkillMd(fs: DetectFs, dir: string): boolean {
  return !!findFile(fs, dir, ['SKILL.md', 'skill.md']);
}

/** Read SKILL.md content if present. */
export function readSkillMd(fs: DetectFs, dir: string): string | undefined {
  const found = findFile(fs, dir, ['SKILL.md', 'skill.md']);
  if (!found) return undefined;
  try {
    return fs.readFileSync(join(dir, found), 'utf-8');
  } catch {
    return undefined;
  }
}

function hasOpenClawSignals(fs: DetectFs, dir: string): boolean {
  const names = fallbackListDir(fs, dir);
  const lower = names.map(n => n.toLowerCase());
  if (lower.includes('config.json5')) return true;
  if (lower.includes('agents.md')) return true;
  if (lower.includes('tools.md') && (lower.includes('heartbeat.md') || lower.includes('config.json5'))) return true;
  if (lower.includes('agents') && fs.isDirectory(join(dir, 'agents'))) return true;
  return false;
}

function hasSkillhubSignals(fs: DetectFs, dir: string): boolean {
  const names = fallbackListDir(fs, dir);
  const lower = names.map(n => n.toLowerCase());
  // A SkillHub/ClawHub packet usually has SKILL.md at root or a skills/ subfolder.
  if (lower.includes('skills') && fs.isDirectory(join(dir, 'skills'))) return true;
  if (lower.includes('clawhub.json') || lower.includes('claw.json')) return true;
  return false;
}

function hasAgentScopeSignals(fs: DetectFs, dir: string): boolean {
  const names = fallbackListDir(fs, dir);
  const lower = names.map(n => n.toLowerCase());
  if (lower.includes('agentscope.json') || lower.includes('agent_scope.json')) return true;
  // @tool-decorated python scripts + a doc file (README.md / desc.md)
  if (names.some(n => n.endsWith('.py'))) {
    if (lower.some(n => n === 'readme.md' || n === 'desc.md' || n === 'description.md')) return true;
    try {
      for (const n of names) {
        if (!n.endsWith('.py')) continue;
        const src = fs.readFileSync(join(dir, n), 'utf-8');
        if (src.includes('@tool') || src.includes('def tool_')) return true;
      }
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Detect the format of a skill package directory.
 * Priority: markus → mcp-server → soul → openclaw → claude → skillhub → agentscope,
 * with a fallback to 'claude' when a bare SKILL.md / readable md exists.
 */
export function detectSkillPackageFormat(dir: string, fs?: DetectFs): ExternalSkillFormat {
  const fsx = fs ?? nodeDetectFs();
  if (!fsx.isDirectory(dir)) {
    // A single markdown file is treated as a Claude-style instruction skill.
    if (fsx.existsSync(dir) && /\.(md|markdown)$/i.test(dir)) return 'claude';
    return 'markus'; // unknown — normalized as markus handles empty/missing gracefully
  }

  if (hasMarkusManifest(fsx, dir)) return 'markus';
  if (hasMcpJson(fsx, dir)) return 'mcp-server';
  if (hasSoulMd(fsx, dir) && !hasSkillMd(fsx, dir)) return 'soul';
  if (hasOpenClawSignals(fsx, dir)) return 'openclaw';
  if (hasSkillMd(fsx, dir)) return 'claude';
  if (hasSkillhubSignals(fsx, dir)) return 'skillhub';
  if (hasAgentScopeSignals(fsx, dir)) return 'agentscope';

  // Fallback: any markdown doc in the dir → claude-style instructions.
  const names = fallbackListDir(fsx, dir);
  if (names.some(n => /\.(md|markdown)$/i.test(n))) return 'claude';
  return 'markus';
}

/** Human-readable label for a format (used by CLI / docs). */
export function formatLabel(format: ExternalSkillFormat): string {
  switch (format) {
    case 'markus': return 'Markus 原生';
    case 'claude': return 'Claude Code / skills.sh (SKILL.md)';
    case 'skillhub': return 'SkillHub / ClawHub 包';
    case 'openclaw': return 'OpenClaw (config.json5 / AGENTS.md)';
    case 'soul': return 'OpenClaw SOUL.md';
    case 'agentscope': return 'AgentScope 工具脚本技能';
    case 'mcp-server': return '通用 MCP-server 技能';
  }
}

/** Default basename of the source dir as a fallback skill name. */
export function defaultNameFromPath(dir: string): string {
  const base = basename(dir).replace(/\.(md|markdown)$/i, '');
  return base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}