/**
 * Guard: every static i18n key a component asks for must exist in every locale.
 *
 * Why this exists: 82 keys were used via `t('some.key', { defaultValue: '…' })`
 * but never added to `src/locales/*`. The inline default hid the gap — English
 * looked fine, Chinese/Spanish users got the English fallback, and keys passed
 * without any default rendered as the raw key string in every language.
 * (Owner 2026-11-21: "看看还有哪些地方没有正确地国际化".)
 *
 * A source scan is the right mechanism here: the invariant is "code keys ⊆
 * dictionary keys", a structural property of two file sets — not runtime
 * behaviour. The test fails the moment someone adds a `t('…')` call without the
 * dictionary entry, which is exactly what used to slip through review.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB_UI_ROOT = join(__dirname, '..', '..');
const SRC = join(WEB_UI_ROOT, 'src');
const LOCALES = ['en', 'zh-CN', 'es'] as const;

type Flat = Record<string, Record<string, string>>;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'locales') walk(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function loadLocale(lng: string): Flat {
  const dir = join(SRC, 'locales', lng);
  const out: Flat = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const flat: Record<string, string> = {};
    const flatten = (obj: unknown, prefix: string) => {
      if (obj === null || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object') flatten(v, key);
        else flat[key] = String(v);
      }
    };
    flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')), '');
    out[file.replace(/\.json$/, '')] = flat;
  }
  return out;
}

/** Static keys requested by source code: `t('key'…)` / `t('ns:key'…)`. */
function usedKeys(): Array<{ file: string; line: number; ns: string | null; key: string }> {
  const out: Array<{ file: string; line: number; ns: string | null; key: string }> = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const re = /\bt\(\s*(['"`])((?:[^'"`\\]|\\.)*?)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const raw = m[2];
      // template literals and sentence-like strings are not static keys
      if (!raw || raw.includes('${') || /\s/.test(raw)) continue;
      // `t('common:priority.' + p)` — a literal that is concatenated is a dynamic
      // key domain, not a static key. The domains the code actually builds are
      // asserted separately below.
      const afterLiteral = src.slice(m.index + m[0].length).trimStart();
      if (raw.endsWith('.') || afterLiteral.startsWith('+')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const colon = raw.indexOf(':');
      out.push({
        file: relative(WEB_UI_ROOT, file),
        line,
        ns: colon > 0 ? raw.slice(0, colon) : null,
        key: colon > 0 ? raw.slice(colon + 1) : raw,
      });
    }
  }
  return out;
}

describe('i18n key completeness', () => {
  const dicts = Object.fromEntries(LOCALES.map(l => [l, loadLocale(l)])) as Record<string, Flat>;
  const usages = usedKeys();

  it('scans a plausible number of call sites', () => {
    // If this drops to ~0 the regex or the source layout changed and the guard
    // below would pass vacuously — a silent no-op is worse than no guard.
    expect(usages.length).toBeGreaterThan(500);
  });

  for (const lng of LOCALES) {
    it(`every static t() key exists in ${lng}`, () => {
      const missing: string[] = [];
      for (const u of usages) {
        const ok = u.ns
          // explicit namespace: must live in that namespace
          ? Object.prototype.hasOwnProperty.call(dicts[lng][u.ns] ?? {}, u.key)
          // bare key: the bound namespace is decided at runtime (a TFunction is
          // often passed down), so any namespace satisfying it is acceptable
          : Object.values(dicts[lng]).some(ns => Object.prototype.hasOwnProperty.call(ns, u.key));
        if (!ok) missing.push(`${u.file}:${u.line} → ${u.ns ? `${u.ns}:` : ''}${u.key}`);
      }
      expect(missing, `${missing.length} key(s) missing from ${lng}:\n${missing.join('\n')}`).toEqual([]);
    });
  }

  it('covers the dynamic key domains the code builds by concatenation', () => {
    // `t('common:priority.' + p)` with p ∈ low|medium|high|urgent (Work.tsx).
    for (const lng of LOCALES) {
      for (const p of ['low', 'medium', 'high', 'urgent']) {
        expect(dicts[lng].common[`priority.${p}`], `${lng}: common.priority.${p}`).toBeTruthy();
      }
    }
  });
});
