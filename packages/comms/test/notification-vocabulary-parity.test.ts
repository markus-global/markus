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
 * Mirrors `locale-manifest-coverage.test.ts`, which guards the other set of strings
 * that arrive from the backend.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationVocabularyKeys, notificationResources } from '@markus/shared';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', '..', 'web-ui', 'src', 'locales');

const LOCALES = ['en', 'zh-CN', 'es'] as const;

interface TeamFile {
  notifications?: { titles?: Record<string, string>; bodies?: Record<string, string> };
}

const teamFor = (locale: string): TeamFile =>
  JSON.parse(readFileSync(join(localesDir, locale, 'team.json'), 'utf8')) as TeamFile;

/** `notifications.titles.taskCompleted` → `[titles, taskCompleted]`. */
function split(key: string): [string, string] {
  const parts = key.split('.');
  return [parts[1]!, parts[2]!];
}

describe('notification vocabulary — the backend and the UI cannot drift', () => {
  const keys = notificationVocabularyKeys();

  it('finds the vocabulary (guards against a vacuous pass)', () => {
    expect(keys.length).toBeGreaterThan(10);
  });

  for (const locale of LOCALES) {
    it(`every sentence matches the shipped locale file in ${locale}`, () => {
      const team = teamFor(locale);
      const mismatched: string[] = [];

      for (const key of keys) {
        const [section, short] = split(key);
        const shared = (notificationResources(locale) as Record<string, Record<string, string>>)[section]?.[short];
        const bundled = team.notifications?.[section as 'titles' | 'bodies']?.[short];
        if (bundled === undefined) {
          mismatched.push(`${key}  → missing from ${locale}/team.json (backend: "${shared ?? ''}")`);
        } else if (bundled !== shared) {
          mismatched.push(`${key}  → backend: "${shared ?? ''}"  ≠  UI: "${bundled}"`);
        }
      }

      expect(mismatched).toEqual([]);
    });

    it(`the locale file adds no notification sentence the backend cannot render in ${locale}`, () => {
      // An extra key means a producer emits something the dispatcher cannot
      // translate — the UI would show Chinese and the chat app English.
      const team = teamFor(locale);
      const shared = notificationResources(locale) as Record<string, Record<string, string>>;
      const orphaned: string[] = [];
      for (const section of ['titles', 'bodies'] as const) {
        for (const short of Object.keys(team.notifications?.[section] ?? {})) {
          if (shared[section]?.[short] === undefined) orphaned.push(`notifications.${section}.${short}`);
        }
      }
      expect(orphaned).toEqual([]);
    });
  }
});
