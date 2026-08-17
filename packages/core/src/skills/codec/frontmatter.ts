/**
 * Minimal YAML-ish frontmatter parser/serializer for SKILL.md files and
 * SOUL.md headers. We intentionally parse only the small set of scalar and
 * list fields used by Claude Code / skills.sh / OpenClaw skills — no full YAML
 * dependency is needed in the core package.
 */
import type { SkillFrontmatter } from './types.js';

const SCALAR_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'version', 'license', 'author', 'source', 'homepage',
]);

/** List-valued keys. */
const LIST_KEYS: ReadonlySet<string> = new Set(['allowed-tools', 'allowed_tools', 'tags']);

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Extract YAML frontmatter from a markdown document.
 * Returns { frontmatter, body } where body is the document without the
 * leading `---` block (if any). When no frontmatter exists, returns empty
 * frontmatter and the original content.
 */
export function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1] ?? '';
  const body = content.slice(match[0].length);
  const lines = raw.split('\n');
  const out: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('%')) continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!key) continue;
    let value = trimmed.slice(colon + 1).trim();

    if (LIST_KEYS.has(key)) {
      // Support `key: a, b, c` and `key: [a, b]`.
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
      }
      out[key] = value
        .split(/[,;]/)
        .map(s => unquote(s))
        .filter(Boolean);
      continue;
    }

    if (!value || value === 'null') {
      // Possibly a nested block — only handle a flat quoted inline value.
      out[key] = undefined;
      continue;
    }

    if (SCALAR_KEYS.has(key) || /^["']/.test(value)) {
      out[key] = unquote(value);
    } else {
      out[key] = value;
    }
  }

  return { frontmatter: out, body };
}

const KEY_ALIASES: Record<string, keyof SkillFrontmatter> = {
  'allowed-tools': 'allowedTools',
  allowed_tools: 'allowedTools',
};

/** Convert raw frontmatter object into a typed SkillFrontmatter. */
export function normalizeFrontmatter(raw: Record<string, unknown>): SkillFrontmatter {
  const fm: SkillFrontmatter = {};
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (typeof v === 'string' && v) return v;
    return undefined;
  };
  fm.name = str('name');
  fm.description = str('description');
  fm.version = str('version');
  fm.license = str('license');
  fm.author = str('author');
  const tags = Array.isArray(raw['tags']) ? (raw['tags'] as unknown[]).map(String) : undefined;
  if (tags && tags.length > 0) fm.tags = tags;

  for (const [rawKey, prop] of Object.entries(KEY_ALIASES)) {
    if (prop === 'allowedTools') {
      if (Array.isArray(raw[rawKey])) {
        fm.allowedTools = (raw[rawKey] as unknown[]).map(String).filter(Boolean);
      }
    }
  }
  return fm;
}

/** Parse a full markdown skill file into frontmatter + instruction body. */
export function parseSkillMarkdown(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const { frontmatter: raw, body } = splitFrontmatter(content);
  return { frontmatter: normalizeFrontmatter(raw), body };
}

function quoteIfNeeded(s: string): string {
  if (/[:#\[\]{},"']|\n/.test(s)) return JSON.stringify(s.replace(/\\/g, '\\\\'));
  return s;
}

/**
 * Serialize typed frontmatter to the YAML-ish block used by SKILL.md files.
 * Keys that cannot be represented in the minimal format are dropped.
 */
export function renderFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = ['---'];
  const pushScalar = (key: string, value: string | undefined) => {
    if (value) lines.push(`${key}: ${quoteIfNeeded(value)}`);
  };
  pushScalar('name', fm.name);
  pushScalar('description', fm.description);
  pushScalar('version', fm.version);
  pushScalar('license', fm.license);
  pushScalar('author', fm.author);
  if (fm.tags && fm.tags.length > 0) lines.push(`tags: ${fm.tags.join(', ')}`);
  if (fm.allowedTools && fm.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${fm.allowedTools.join(', ')}`);
  }
  lines.push('---');
  return lines.join('\n');
}