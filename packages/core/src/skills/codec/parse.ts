/**
 * Parse external skill directories into the normalized intermediate
 * representation (NormalizedSkill). Every parser is pure — it only reads the
 * source directory and returns data; no files are written.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  ExternalSkillFormat,
  NormalizedSkill,
  SkillImportOptions,
} from './types.js';
import type { SkillCategory, SkillMcpServerConfig } from '../types.js';
import {
  detectSkillPackageFormat,
  nodeDetectFs,
  readSkillMd,
  defaultNameFromPath,
  type DetectFs,
} from './detect.js';
import { parseSkillMarkdown } from './frontmatter.js';
import { kebab } from '@markus/shared';

// ── Category inference ───────────────────────────────────────────────────────

const CATEGORY_HINTS: Array<[SkillCategory, string[]]> = [
  ['development', ['code', 'develop', 'program', 'software', 'sdk', 'api', 'git', 'cli', 'docker', 'kubernetes', 'python', 'javascript', 'typescript', 'react', 'frontend', 'backend', 'test', 'debug', 'ide', 'database', 'sql', 'terminal']],
  ['devops', ['deploy', 'ci/cd', 'pipeline', 'infra', 'infrastructure', 'monitoring', 'observability', 'terraform', 'ansible', 'k8s', 'kubernetes', 'cloud', 'aws', 'gcp', 'azure', 'server', 'ops']],
  ['communication', ['email', 'slack', 'teams', 'message', 'chat', 'meeting', 'calendar', 'translate', 'translation', 'language', 'notify', 'notification']],
  ['data', ['data', 'database', 'sql', 'excel', 'csv', 'json', 'analytics', 'analys', 'pandas', 'report', 'visualization', 'chart', 'etl', 'scrape', 'crawl']],
  ['productivity', ['product', 'document', 'note', 'task', 'todo', 'calendar', 'research', 'writing', 'write', 'summar', 'organiz', 'manage', 'workflow', 'automation']],
  ['browser', ['browser', 'chrome', 'web page', 'webpage', 'selenium', 'playwright', 'puppeteer', 'crawler', 'http']],
  ['creative', ['design', 'image', 'video', 'audio', 'art', 'draw', 'creative', 'brand', 'marketing', 'social', 'content', 'music']],
];

function inferCategory(text: string, tags?: string[]): SkillCategory {
  const haystack = `${text} ${(tags ?? []).join(' ')}`.toLowerCase();
  for (const [cat, hints] of CATEGORY_HINTS) {
    if (hints.some(h => haystack.includes(h))) return cat;
  }
  return 'custom';
}

// ── Permission mapping ───────────────────────────────────────────────────────

const TOOL_TO_PERMISSION: Array<[RegExp, 'shell' | 'file' | 'network' | 'browser']> = [
  [/^(shell|bash|zsh|sh|powershell|cmd|terminal|exec)/i, 'shell'],
  [/^(file|read|write|read_file|write_file|edit|glob|grep|ls|cp|mv|rm|mkdir)/i, 'file'],
  [/^(web|fetch|http|url|request|search|scrape)/i, 'network'],
  [/^(browser|chrome|playwright|puppeteer|selenium)/i, 'browser'],
];

export function mapAllowedToolsToPermissions(allowedTools?: string[]): ('shell' | 'file' | 'network' | 'browser')[] {
  if (!allowedTools || allowedTools.length === 0) return [];
  const perms = new Set<'shell' | 'file' | 'network' | 'browser'>();
  for (const tool of allowedTools) {
    for (const [re, perm] of TOOL_TO_PERMISSION) {
      if (re.test(tool.trim())) {
        perms.add(perm);
        break;
      }
    }
  }
  return [...perms];
}

// ── JSON5-ish cleanup for OpenClaw config.json5 ──────────────────────────────

/**
 * Strip comments + trailing commas so config.json5 can be parsed as JSON.
 * Handles block comments and // comments (including heredoc-free basic cases).
 */
export function json5ToJson(content: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < content.length) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < content.length && content[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  const noTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  return quoteJson5Keys(noTrailingCommas);
}

/**
 * Wrap bare JSON5 object keys with double quotes so the result is strict JSON.
 * Only keys outside string literals are touched.
 */
export function quoteJson5Keys(content: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < content.length) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    // Bare identifier directly before ':' → JSON5 key
    if (/[A-Za-z_$]/.test(ch)) {
      const rest = content.slice(i);
      const m = rest.match(/^[A-Za-z_$][\w$]*\s*:/);
      if (m && m[0].endsWith(':')) {
        const ident = m[0].slice(0, -1).trimEnd();
        out += `"${ident}":`;
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function parseJson5File(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(json5ToJson(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── License detection ────────────────────────────────────────────────────────

function detectLicense(fs: DetectFs, dir: string, fmLicense?: string): string | undefined {
  if (fmLicense && fmLicense !== 'unknown') return fmLicense;
  const names = fs.listDir(dir);
  for (const n of names) {
    if (/^license(\.|$)/i.test(n)) {
      // Common spdx short values
      const lower = n.toLowerCase();
      if (lower.includes('mit')) return 'MIT';
      if (lower.includes('apache')) return 'Apache-2.0';
      if (lower.includes('gpl')) return 'GPL-3.0';
      if (lower.includes('cc0')) return 'CC0-1.0';
      return 'SEE LICENSE IN ' + n;
    }
  }
  try {
    const pkgPath = join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { license?: string };
      if (pkg.license) return pkg.license;
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── MCP server config extraction ─────────────────────────────────────────────

function parseMcpServers(json: Record<string, unknown> | null): Record<string, SkillMcpServerConfig> | undefined {
  if (!json) return undefined;
  const servers = (json.mcpServers ?? json.mcp) as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return undefined;
  const result: Record<string, SkillMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const c = cfg as Record<string, unknown>;
    if (!c || typeof c !== 'object' || typeof c.command !== 'string') continue;
    result[name] = {
      command: c.command,
      args: Array.isArray(c.args) ? (c.args as unknown[]).map(String) : undefined,
      env: c.env && typeof c.env === 'object' ? c.env as Record<string, string> : undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Per-format parsers ───────────────────────────────────────────────────────

function parseClaudeStyle(
  dir: string,
  fs: DetectFs,
  opts: SkillImportOptions,
  format: ExternalSkillFormat,
): NormalizedSkill {
  const md = readSkillMd(fs, dir);
  const { frontmatter, body } = md ? parseSkillMarkdown(md) : { frontmatter: {}, body: '' };
  const name = kebab(opts.name ?? frontmatter.name ?? defaultNameFromPath(dir)) || 'skill';
  const description = frontmatter.description || `Skill: ${name}`;
  const tags = frontmatter.tags ?? [];
  const category = inferCategory(description, tags);
  const allowed = frontmatter.allowedTools;
  const requiredPermissions = mapAllowedToolsToPermissions(allowed);
  const license = detectLicense(fs, dir, frontmatter.license);

  const extraFiles: Array<{ from: string; to: string }> = [];
  for (const n of fs.listDir(dir)) {
    if (/^(SKILL\.md|skill\.md)$/i.test(n)) continue;
    const p = join(dir, n);
    if (fs.isDirectory(p)) continue;
    // carry README, icons, LICENSE, scripts, assets
    if (/^(README|LICENSE|icon|logo|screenshot)/i.test(n) || /\.(png|jpg|jpeg|svg|gif|py|mjs|js|ts|sh|json|yaml|yml)$/i.test(n)) {
      extraFiles.push({ from: n, to: n });
    }
  }

  return {
    name,
    displayName: frontmatter.name && frontmatter.name !== name ? frontmatter.name : undefined,
    version: frontmatter.version ?? '1.0.0',
    description,
    author: frontmatter.author,
    category,
    tags,
    license,
    source: format,
    requiredPermissions: requiredPermissions.length > 0 ? requiredPermissions : undefined,
    instructions: body || undefined,
    extraFiles,
  };
}

function parseMcpServer(dir: string, fs: DetectFs, opts: SkillImportOptions): NormalizedSkill {
  const names = fs.listDir(dir);
  const mcpFile = names.find(n => /^(\.?mcp\.json)$/i.test(n)) ?? names.find(n => /^mcpServer\.json$/i.test(n));
  const mcp = mcpFile ? parseMcpServers(JSON.parse(fs.readFileSync(join(dir, mcpFile), 'utf-8'))) : undefined;

  const md = readSkillMd(fs, dir);
  const { frontmatter, body } = md ? parseSkillMarkdown(md) : { frontmatter: {}, body: '' };
  const name = kebab(opts.name ?? frontmatter.name ?? defaultNameFromPath(dir)) || 'skill';
  const description = frontmatter.description
    ?? (mcp ? `MCP server skill — provides ${Object.keys(mcp).join(', ')}` : `Skill: ${name}`);
  const tags = frontmatter.tags ?? [];

  const extraFiles: Array<{ from: string; to: string }> = [];
  for (const n of names) {
    if (/^(\.?mcp\.json|SKILL\.md|skill\.md)$/i.test(n)) continue;
    const p = join(dir, n);
    if (fs.isDirectory(p)) continue;
    if (/^(README|LICENSE|server|handler)/i.test(n) || /\.(mjs|js|ts|py|sh|json|png|svg)$/i.test(n)) {
      extraFiles.push({ from: n, to: n });
    }
  }

  return {
    name,
    version: frontmatter.version ?? '1.0.0',
    description,
    author: frontmatter.author,
    category: inferCategory(description, tags),
    tags,
    license: detectLicense(fs, dir, frontmatter.license),
    source: 'mcp-server',
    requiredPermissions: mcp ? ['shell'] : undefined,
    mcpServers: mcp,
    instructions: body || (mcp
      ? `This skill provides the following MCP server(s): ${Object.keys(mcp).join(', ')}. Activate it with discover_tools and call the exposed tools by their exact names.`
      : undefined),
    extraFiles,
  };
}

function parseSoul(dir: string, fs: DetectFs, opts: SkillImportOptions): NormalizedSkill {
  const names = fs.listDir(dir);
  const soulFile = names.find(n => /^SOUL\.md$/i.test(n));
  const content = soulFile ? fs.readFileSync(join(dir, soulFile), 'utf-8') : '';
  const { frontmatter, body } = parseSkillMarkdown(content);
  const name = kebab(opts.name ?? frontmatter.name ?? defaultNameFromPath(dir)) || 'skill';
  const description = frontmatter.description || `OpenClaw soul: ${name}`;
  const tags = frontmatter.tags ?? [];
  return {
    name,
    version: frontmatter.version ?? '1.0.0',
    description,
    author: frontmatter.author,
    category: inferCategory(description, tags),
    tags,
    license: detectLicense(fs, dir, frontmatter.license),
    source: 'soul',
    // SOUL.md body is the persona/instructions — keep it whole.
    instructions: body || content || undefined,
  };
}

function parseOpenClaw(dir: string, fs: DetectFs, opts: SkillImportOptions): NormalizedSkill {
  const names = fs.listDir(dir);

  // 1) If there is a skills/ subdirectory, import the first (or named) skill inside.
  const skillsSub = names.find(n => n.toLowerCase() === 'skills' && fs.isDirectory(join(dir, n)));
  if (skillsSub) {
    const subEntries = fs.listDir(join(dir, skillsSub));
    const target = (opts.name
      ? subEntries.find(e => e.toLowerCase() === opts.name?.toLowerCase())
      : undefined) ?? subEntries.find(e => fs.isDirectory(join(dir, skillsSub, e)));
    if (target) {
      const found = detectSkillPackageFormat(join(dir, skillsSub, target), fs);
      if (found === 'claude' || found === 'markus' || found === 'mcp-server') {
        const inner = parseClaudeStyle(join(dir, skillsSub, target), fs, opts, found === 'markus' ? 'openclaw' : 'claude');
        if (found === 'mcp-server') {
          const mcpInner = parseMcpServer(join(dir, skillsSub, target), fs, opts);
          return { ...mcpInner, source: 'openclaw' };
        }
        return { ...inner, source: 'openclaw' };
      }
    }
  }

  // 2) OpenClaw skill folders: SKILL.md root with optional config.json5.
  const md = readSkillMd(fs, dir);
  const { frontmatter, body } = md ? parseSkillMarkdown(md) : { frontmatter: {}, body: '' };

  let mcp: Record<string, SkillMcpServerConfig> | undefined;
  const cfgFile = names.find(n => /^config\.json5$/i.test(n) || /^config\.json$/i.test(n));
  if (cfgFile) {
    const cfg = parseJson5File(join(dir, cfgFile));
    mcp = parseMcpServers(cfg);
  }

  const name = kebab(opts.name ?? frontmatter.name ?? defaultNameFromPath(dir)) || 'skill';
  const description = frontmatter.description || `OpenClaw skill: ${name}`;
  const tags = frontmatter.tags ?? [];
  const allowed = frontmatter.allowedTools;

  const extraFiles: Array<{ from: string; to: string }> = [];
  for (const n of names) {
    if (/^(SKILL\.md|skill\.md|config\.json5?)$/i.test(n)) continue;
    const p = join(dir, n);
    if (fs.isDirectory(p)) continue;
    if (/\.(md|png|jpg|svg|py|mjs|js|ts|sh|json|yaml|yml)$/i.test(n)) {
      extraFiles.push({ from: n, to: n });
    }
  }

  return {
    name,
    displayName: frontmatter.name && frontmatter.name !== name ? frontmatter.name : undefined,
    version: frontmatter.version ?? '1.0.0',
    description,
    author: frontmatter.author,
    category: inferCategory(description, tags),
    tags,
    license: detectLicense(fs, dir, frontmatter.license),
    source: 'openclaw',
    requiredPermissions: mapAllowedToolsToPermissions(allowed).length > 0
      ? mapAllowedToolsToPermissions(allowed)
      : (mcp ? ['shell'] : undefined),
    mcpServers: mcp,
    instructions: body || undefined,
    extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
  };
}

function parseSkillhub(dir: string, fs: DetectFs, opts: SkillImportOptions): NormalizedSkill {
  // A ClawHub packet: SKILL.md at root, or skills/<skill>/SKILL.md entries.
  const names = fs.listDir(dir);
  if (hasRootSkillMd(names)) {
    return parseClaudeStyle(dir, fs, opts, 'skillhub');
  }
  const skillsSub = names.find(n => n.toLowerCase() === 'skills' && fs.isDirectory(join(dir, n)));
  if (skillsSub) {
    const subEntries = fs.listDir(join(dir, skillsSub));
    const target = (opts.name
      ? subEntries.find(e => e.toLowerCase() === opts.name?.toLowerCase())
      : undefined) ?? subEntries.find(e => fs.isDirectory(join(dir, skillsSub, e)));
    if (target) {
      const targetDir = join(dir, skillsSub, target);
      const found = detectSkillPackageFormat(targetDir, fs);
      if (found === 'claude' || found === 'markus' || found === 'mcp-server') {
        const inner = found === 'mcp-server'
          ? parseMcpServer(targetDir, fs, opts)
          : parseClaudeStyle(targetDir, fs, opts, 'skillhub');
        return { ...inner, source: 'skillhub' };
      }
    }
  }
  // Fall back to root instructions regardless.
  return parseClaudeStyle(dir, fs, opts, 'skillhub');
}

function hasRootSkillMd(names: string[]): boolean {
  return names.some(n => /^(SKILL\.md|skill\.md)$/i.test(n));
}

function parseAgentScope(dir: string, fs: DetectFs, opts: SkillImportOptions): NormalizedSkill {
  const names = fs.listDir(dir);
  const readmeName = names.find(n => /^(README\.md|desc\.md|description\.md)$/i.test(n));
  const readme = readmeName ? fs.readFileSync(join(dir, readmeName), 'utf-8') : '';
  const name = kebab(opts.name ?? defaultNameFromPath(dir)) || 'skill';

  const pyFiles = names.filter(n => n.endsWith('.py'));
  const firstToolFn = (() => {
    for (const n of pyFiles) {
      try {
        const src = fs.readFileSync(join(dir, n), 'utf-8');
        const m = src.match(/@tool\s*(?:\([^)]*\))?\s*\ndef\s+(\w+)/);
        if (m?.[1]) return m[1];
      } catch { /* ignore */ }
    }
    return undefined;
  })();

  const description = readme
    ? readme.replace(/^#+\s*.*$/m, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' ').slice(0, 200)
    : `AgentScope tool skill: ${name}`;

  const instructions = [
    readme ? `## 技能说明\n\n${readme.trim()}` : '',
    pyFiles.length > 0 ? `## 工具函数\n\n本技能提供以下 Python 工具脚本（@tool 装饰器）：\n${pyFiles.map(f => `- \`${f}\``).join('\n')}${firstToolFn ? `\n\n首个工具函数示例：\`${firstToolFn}\`` : ''}` : '',
    firstToolFn ? `\n激活后请按需调用 \`${firstToolFn}\` 等工具函数（在 AgentScope 环境中）。` : '',
  ].filter(Boolean).join('\n\n');

  const extraFiles: Array<{ from: string; to: string }> = names
    .filter(n => n.endsWith('.py') || /\.(json|yaml|yml)$/i.test(n))
    .map(n => ({ from: n, to: n }));

  return {
    name,
    version: '1.0.0',
    description: description || `Skill: ${name}`,
    category: inferCategory(description, [name]),
    source: 'agentscope',
    requiredPermissions: pyFiles.length > 0 ? ['shell'] : undefined,
    instructions,
    extraFiles,
  };
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Parse a skill package directory into a NormalizedSkill.
 * Format is auto-detected unless `format` is passed explicitly.
 */
export function parseSkillPackage(
  dir: string,
  opts: SkillImportOptions = {},
  format?: ExternalSkillFormat,
): NormalizedSkill {
  const fs = nodeDetectFs();
  const fmt = format ?? detectSkillPackageFormat(dir, fs);
  switch (fmt) {
    case 'markus': {
      // Rewrite a Markus skill into normalized form (used by export).
      const inner = parseClaudeStyle(dir, fs, opts, 'markus');
      // Re-read mcp servers from skill.json if present
      const skillMf = fs.listDir(dir).find(n => n.toLowerCase() === 'skill.json');
      if (skillMf) {
        try {
          const mf = JSON.parse(fs.readFileSync(join(dir, skillMf), 'utf-8')) as {
            name?: string; displayName?: string; version?: string; description?: string;
            author?: string; category?: string; tags?: string[]; license?: string;
            skill?: { requiredPermissions?: string[]; mcpServers?: Record<string, Record<string, unknown>>; isolation?: string };
            i18n?: Record<string, { displayName?: string; description?: string }>;
          };
          return {
            ...inner,
            name: kebab(opts.name ?? mf.name ?? inner.name) || inner.name,
            displayName: mf.displayName ?? inner.displayName,
            version: mf.version ?? inner.version,
            description: mf.description ?? inner.description,
            author: mf.author ?? inner.author,
            category: (mf.category as SkillCategory) ?? inner.category,
            tags: mf.tags ?? inner.tags,
            license: mf.license ?? inner.license,
            requiredPermissions: (mf.skill?.requiredPermissions as NormalizedSkill['requiredPermissions']) ?? inner.requiredPermissions,
            mcpServers: parseMcpServers({ mcpServers: mf.skill?.mcpServers } as Record<string, unknown>) ?? inner.mcpServers,
            isolation: mf.skill?.isolation as NormalizedSkill['isolation'],
            i18n: mf.i18n,
          };
        } catch { /* keep claude-style parse */ }
      }
      return inner;
    }
    case 'claude': return parseClaudeStyle(dir, fs, opts, 'claude');
    case 'skillhub': return parseSkillhub(dir, fs, opts);
    case 'openclaw': return parseOpenClaw(dir, fs, opts);
    case 'soul': return parseSoul(dir, fs, opts);
    case 'agentscope': return parseAgentScope(dir, fs, opts);
    case 'mcp-server': return parseMcpServer(dir, fs, opts);
  }
}