/**
 * The notification vocabulary has **two consumers in two processes**: the outbound
 * dispatcher (backend) and the in-app bell (browser bundle).
 *
 * The browser bundle cannot import `@markus/shared` — the UI's own provider
 * registry documents why (`web-ui/src/constants/providers.ts`: it fetches the
 * server's table instead, because the bundle cannot import the package). So the
 * words physically live in two places and cannot be made one without dragging node
 * dependencies into the bundle.
 *
 * That physical split is the risk: if one side is edited — a wording fix, a new
 * locale — the other silently keeps the old sentence, and the *same* notification
 * reads differently in Feishu than in the product. That is the exact defect this
 * whole change fixes, so the split is made safe by asserting the two copies agree,
 * by key and by language, here. Drift fails CI naming the key, the language and
 * both strings — it cannot reach main unnoticed.
 *
 * Three tables are covered:
 *   · `notifications.*`        → `<locale>/team.json`
 *   · `common.priority|status` → `<locale>/common.json` (enum words that appear
 *     *inside* a sentence: `（优先级：normal）`, `状态已变为 in_progress`)
 *
 * Mirrors `locale-manifest-coverage.test.ts`, which guards the other set of strings
 * that arrive from the backend.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationVocabularyKeys, notificationResources, notificationLabel } from '@markus/shared';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', '..', 'web-ui', 'src', 'locales');

const LOCALES = ['en', 'zh-CN', 'es'] as const;

type Table = Record<string, Record<string, string>>;

const readJson = (locale: string, file: string): Table =>
  JSON.parse(readFileSync(join(localesDir, locale, file), 'utf8')) as Table;

/** `notifications.titles.taskCompleted` → `[titles, taskCompleted]`. */
function split(key: string): [string, string] {
  const parts = key.split('.');
  return [parts[1]!, parts[2]!];
}

const allKeys = notificationVocabularyKeys();
const notificationKeys = allKeys.filter((k) => k.startsWith('notifications.'));
const enumKeys = allKeys.filter((k) => k.startsWith('common.'));

describe('notification vocabulary — the backend and the UI cannot drift', () => {
  it('finds the vocabulary (guards against a vacuous pass)', () => {
    expect(notificationKeys.length).toBeGreaterThan(10);
    expect(enumKeys.length).toBeGreaterThan(0);
  });

  for (const locale of LOCALES) {
    it(`every sentence matches the shipped locale file in ${locale}`, () => {
      const team = readJson(locale, 'team.json');
      const resources = notificationResources(locale);
      const mismatched: string[] = [];

      for (const key of notificationKeys) {
        const [section, short] = split(key);
        const shared = resources[section]?.[short];
        const bundled = team['notifications']?.[section]?.[short];
        if (bundled === undefined) {
          mismatched.push(`${key}  → missing from ${locale}/team.json (backend: "${shared ?? ''}")`);
        } else if (bundled !== shared) {
          mismatched.push(`${key}  → backend: "${shared ?? ''}"  ≠  UI: "${bundled}"`);
        }
      }

      expect(mismatched).toEqual([]);
    });

    it(`every enum word matches the shipped locale file in ${locale}`, () => {
      const common = readJson(locale, 'common.json');
      const mismatched: string[] = [];

      for (const key of enumKeys) {
        const [, section, short] = key.split('.');
        const shared = notificationLabel(key, locale);
        const bundled = common[section!]?.[short!];
        if (bundled === undefined) {
          mismatched.push(`${key}  → missing from ${locale}/common.json (backend: "${shared ?? ''}")`);
        } else if (bundled !== shared) {
          mismatched.push(`${key}  → backend: "${shared ?? ''}"  ≠  UI: "${bundled}"`);
        }
      }

      expect(mismatched).toEqual([]);
    });

  }
});

/**
 * The other direction: a **producer** that emits a key the vocabulary does not hold.
 * The UI would render its own Chinese string and the chat app the raw English
 * fallback — silently, because an unknown key is passed through by design (never
 * invent a sentence). Nothing at runtime can tell "not translated yet" from
 * "deliberately raw", so the only way to see it is to scan the producers: the key
 * is a string literal in their source.
 */
describe('every notification key a producer emits exists in the vocabulary', () => {
  it('has no untranslatable producer key', () => {
    const roots = [
      join(here, '..', '..', 'org-manager', 'src'),
      join(here, '..', '..', 'cli', 'src'),
    ];
    const referenced = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(/'notifications\.(?:titles|bodies|approvalDesc)\.[A-Za-z0-9_]+'/g)) {
            referenced.add(m[0].slice(1, -1));
          }
        }
      }
    };
    for (const root of roots) walk(root);

    const known = new Set(notificationVocabularyKeys());
    expect([...referenced].filter((k) => !known.has(k)).sort()).toEqual([]);
    // Guard against the vacuous pass: a broken scan finds nothing and "passes".
    expect(referenced.size).toBeGreaterThan(10);
  });
});
