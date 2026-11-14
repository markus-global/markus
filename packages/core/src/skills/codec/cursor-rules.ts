import { join } from 'node:path';
import type { NormalizedSkill } from './types.js';
import { splitFrontmatter } from './frontmatter.js';
import { defaultNameFromPath, nodeDetectFs, type DetectFs } from './detect.js';

export interface CursorFieldMapping { from: string; to: string; transform?: (v: unknown) => unknown; }
export const CURSOR_RULES_MAPPING: CursorFieldMapping[] = [
  { from: 'description', to: 'description' },
  { from: 'globs', to: 'tags', transform: (v) => Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined },
  { from: 'alwaysApply', to: 'tags', transform: (v) => v === true || v === 'true' ? ['always-apply'] : undefined },
];

export function isCursorRulesPackage(dir: string, fs: DetectFs = nodeDetectFs()): boolean {
  const rules = join(dir, '.cursor', 'rules');
  return fs.isDirectory(rules) && fs.listDir(rules).some((n) => n.endsWith('.mdc'));
}

export function parseCursorRules(dir: string, fs: DetectFs = nodeDetectFs()): { skill: NormalizedSkill; warnings: string[] } {
  const rules = join(dir, '.cursor', 'rules');
  const file = fs.listDir(rules).find((n) => n.endsWith('.mdc'));
  const raw = file ? fs.readFileSync(join(rules, file), 'utf-8') : '';
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = frontmatter as Record<string, unknown>;
  const mapped = new Set(CURSOR_RULES_MAPPING.map((m) => m.from));
  const warnings = Object.keys(fm).filter((k) => !mapped.has(k)).map((k) => `未映射字段: ${k}`);
  const tags = CURSOR_RULES_MAPPING.filter((m) => m.to === 'tags')
    .flatMap((m) => (m.transform?.(fm[m.from]) ?? []) as string[]);
  return {
    skill: {
      name: typeof fm.name === 'string' ? fm.name : defaultNameFromPath(dir),
      description: typeof fm.description === 'string' ? fm.description : body.slice(0, 200),
      source: 'cursor-rules', sourceUrl: '', tags, instructions: body, body, content: body,
    } as unknown as NormalizedSkill,
    warnings,
  };
}
