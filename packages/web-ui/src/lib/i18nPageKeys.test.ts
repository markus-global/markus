import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard: a `page.*` key used in code must exist in every locale file.
 *
 * The bug this exists for: the mobile chat "more" menu rendered a hardcoded
 * Chinese word in the English UI. The cause was not a missing translation —
 * `t('page.findTitle', { defaultValue: '搜索' })` pointed at a key that had
 * NEVER been defined, so the Chinese `defaultValue` was the only string that
 * could ever render. The same class leaked the other way too: keys whose
 * `defaultValue` was English showed English in the Chinese and Spanish UIs.
 *
 * A `defaultValue` is a safety net for one odd case, not a source of copy. If a
 * literal key has a defaultValue but no locale entry, that is a defect and this
 * test fails on it — otherwise the net silently becomes the product copy.
 *
 * Dynamic keys (`t(`page.x.${y}`)`) are not checked: the value is only known at
 * runtime. They are the one legitimate use of `defaultValue`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(here, '..');
const LOCALES_ROOT = path.resolve(SRC_ROOT, 'locales');
const LANGS = ['en', 'zh-CN', 'es'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Literal `t('page.some.key')` / t("page.some.key") — dynamic templates excluded by construction. */
function usedPageKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of walk(SRC_ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*['"](page\.[A-Za-z0-9_.]+)['"]/g)) {
      const key = m[1]!;
      if (!used.has(key)) used.set(key, []);
      const rel = path.relative(SRC_ROOT, file);
      const bucket = used.get(key)!;
      if (!bucket.includes(rel)) bucket.push(rel);
    }
  }
  return used;
}

function lookup(tree: unknown, key: string): string | undefined {
  let cur: unknown = tree;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

describe('i18n: page.* keys', () => {
  const used = usedPageKeys();
  const locales = Object.fromEntries(
    LANGS.map(lang => [lang, JSON.parse(fs.readFileSync(path.join(LOCALES_ROOT, lang, 'team.json'), 'utf8'))]),
  ) as Record<(typeof LANGS)[number], unknown>;

  it('finds the keys in use (guard against a silently empty scan)', () => {
    expect(used.size).toBeGreaterThan(50);
  });

  it('every literal page.* key is defined in every locale', () => {
    const missing: string[] = [];
    for (const [key, files] of used) {
      for (const lang of LANGS) {
        if (lookup(locales[lang], key) === undefined) {
          missing.push(`${key} → missing in ${lang} (used in ${files.join(', ')})`);
        }
      }
    }
    expect(missing, `Keys referenced in code but absent from the locale files:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no locale is missing a key another locale has', () => {
    // Same check from the other direction: catch a key added to en only.
    //
    // Compared at the KEY level, not the leaf level. Plural suffixes
    // (`_one`/`_other`/…) and array elements legitimately differ per language:
    // plural rules are not shared, and a list of greeting variants may have a
    // different length in Spanish. Comparing leaves would demand parity that
    // the grammar itself forbids, and the usual repair for such a test is a
    // suppression list — a copy of the truth that drifts. Presence of the key
    // is the invariant that actually holds.
    const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
    const collect = (tree: unknown, prefix = '', out: Set<string> = new Set()): Set<string> => {
      if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return out;
      for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
        const next = prefix ? `${prefix}.${k.replace(PLURAL_SUFFIX, '')}` : k.replace(PLURAL_SUFFIX, '');
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) collect(v, next, out);
        else out.add(next);
      }
      return out;
    };

    const perLang = Object.fromEntries(LANGS.map(lang => [lang, collect(locales[lang])])) as
      Record<(typeof LANGS)[number], Set<string>>;
    const allKeys = new Set<string>(LANGS.flatMap(lang => [...perLang[lang]]));

    const gaps: string[] = [];
    for (const key of allKeys) {
      for (const lang of LANGS) {
        if (!perLang[lang].has(key)) gaps.push(`${key} missing in ${lang}`);
      }
    }
    expect(gaps, gaps.join('\n')).toEqual([]);
  });
});
