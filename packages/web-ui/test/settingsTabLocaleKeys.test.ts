/**
 * Guard: every registered settings tab must be fully named in every locale.
 *
 * ── The defect this exists to prevent ────────────────────────────────────────
 *
 * `SETTINGS_TABS` entries carry a `labelKey` that the sidebar and the page
 * heading resolve with `t('settings:' + labelKey)`. The C10-F tab registered
 * `nav.externalSignals`, but no locale defined it — so the nav item AND the H1
 * rendered the literal string `nav.externalSignals` in English, Chinese and
 * Spanish alike.
 *
 * `localeParity.test.ts` cannot catch this: it compares locales *against each
 * other*, and a key missing from all three is perfectly parity-clean. A key
 * that is missing everywhere is still a key nobody can read. The contract is
 * therefore "registered tab ⇒ named in every locale", asserted here.
 *
 * The lookup below mirrors i18next's own resolution for these keys (namespace
 * `settings`, dot-separated path, no interpolation, no plurals): a missing path
 * makes i18next return the key itself, which is exactly what `value === key`
 * rejects.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_TABS, SETTINGS_TAB_GROUPS, SETTINGS_TAB_ICONS } from '../src/pages/Settings.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'src', 'locales');
const LOCALES = readdirSync(localesDir).filter((entry) => !entry.startsWith('.'));

function settingsNamespace(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Resolve a dot path to a string, or `undefined` when any segment is absent. */
function resolve(tree: Record<string, unknown>, path: string): string | undefined {
  let node: unknown = tree;
  for (const segment of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' && node.trim() ? node : undefined;
}

describe('settings tabs are named in every locale', () => {
  for (const locale of LOCALES) {
    const messages = settingsNamespace(locale);

    it(`${locale}: every tab labelKey resolves to real copy`, () => {
      const unresolved = SETTINGS_TABS.filter((tab) => {
        // `labelKey` is already namespaced-free (`nav.appearance`) and the file
        // below IS the `settings` namespace — prefixing it again would find
        // nothing anywhere and prove nothing.
        const value = resolve(messages, tab.labelKey);
        return value === undefined || value === tab.labelKey;
      }).map((tab) => `${tab.id} → ${tab.labelKey}`);
      expect(unresolved, `missing nav copy in ${locale}`).toEqual([]);
    });

    it(`${locale}: every tab group label resolves`, () => {
      const unresolved = SETTINGS_TAB_GROUPS.filter(
        (group) => resolve(messages, group.labelKey) === undefined,
      ).map((group) => group.labelKey);
      expect(unresolved, `missing group copy in ${locale}`).toEqual([]);
    });

    it(`${locale}: every tab has a one-line description`, () => {
      // A tab with no `tabDesc` renders a title and nothing under it — it looks
      // like a half-built screen, and the fix is always one string, so there is
      // no reason for a registered tab to be missing it.
      const undescribed = SETTINGS_TABS.filter(
        (tab) => resolve(messages, `tabDesc.${tab.id}`) === undefined,
      ).map((tab) => tab.id);
      expect(undescribed, `missing tabDesc in ${locale}`).toEqual([]);
    });
  }

  it('every tab carries its own mark, not the default dot', () => {
    // Same invariant as above, one layer down: `_default` is a fallback that
    // renders *something*, so a tab with no icon looks slightly bland rather
    // than broken — and nobody files a bug for "bland". The external-signals
    // tab shipped exactly that way.
    const iconless = SETTINGS_TABS.filter((tab) => {
      const path = SETTINGS_TAB_ICONS[tab.id];
      return !path || path === SETTINGS_TAB_ICONS._default;
    }).map((tab) => tab.id);
    expect(iconless, 'tab fell back to the default dot').toEqual([]);
  });
});
