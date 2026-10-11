/**
 * Locale completeness — external IM integration settings.
 *
 * The Settings page shipped with the Chinese UI showing English strings: the
 * components called `t('settings:instances.*')` for keys that existed in **no**
 * locale file, so i18next fell through to the hard-coded `defaultValue` and the
 * user saw `ROUTING` / `Not bound` / `1 bot(s)` in an otherwise Chinese page.
 *
 * This file makes that class of bug impossible to reintroduce silently:
 *   • every `settings:*` key the integration components actually call must exist
 *     in **both** locales (the scan reads the components, so it cannot drift);
 *   • the `instances` namespace must stay structurally identical across locales
 *     (plural suffixes excluded — Chinese has no `_one`);
 *   • the keys that went missing are pinned by name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(testDir, '..');
const componentsDir = join(uiRoot, 'src', 'components', 'integrations');
const localesDir = join(uiRoot, 'src', 'locales');

function loadSettings(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

/** Resolve a dotted path (`instances.addBot.name`) inside a locale object. */
function lookup(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

/** Every dot-path in an object; plural suffixes are keys too, so keep them. */
function dottedKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...dottedKeys(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** i18next plural suffixes — a locale only needs the categories its language has. */
const PLURAL = /_(zero|one|two|few|many|other)$/;

/** Static `t('settings:…')` keys used by every integration component. */
function keysUsedByComponents(): string[] {
  const used = new Set<string>();
  for (const file of readdirSync(componentsDir)) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(join(componentsDir, file), 'utf8');
    for (const match of src.matchAll(/\bt\(\s*'([^']+)'/g)) {
      if (match[1].startsWith('settings:')) used.add(match[1].slice('settings:'.length));
    }
  }
  return [...used].sort();
}

describe('locale completeness — external IM integration settings', () => {
  it('every settings:* key the components call exists in zh-CN and en', () => {
    const used = keysUsedByComponents();
    // Guard the scan itself: if the regexp or the directory ever stops matching,
    // this test must not pass vacuously.
    expect(used.length).toBeGreaterThan(30);

    const zh = loadSettings('zh-CN');
    const en = loadSettings('en');
    expect(used.filter((key) => lookup(zh, key) === undefined)).toEqual([]);
    expect(used.filter((key) => lookup(en, key) === undefined)).toEqual([]);
  });

  it('the instances namespace is structurally identical in zh-CN and en', () => {
    const zh = loadSettings('zh-CN')['instances'];
    const en = loadSettings('en')['instances'];
    expect(zh).toBeDefined();
    expect(en).toBeDefined();

    const strip = (keys: string[]) => [...new Set(keys.map((k) => k.replace(PLURAL, '')))].sort();
    expect(strip(dottedKeys(zh))).toEqual(strip(dottedKeys(en)));
  });

  it('pins the keys that were missing (the English-in-Chinese-UI defect)', () => {
    const required = [
      'instances.subtitle',
      'instances.botCount',
      'instances.noBots',
      'instances.boundAgent',
      'instances.addBot.create',
      'instances.addBot.label',
      'instances.addBot.labelRequired',
      'instances.addBot.name',
      'instances.addBot.namePlaceholder',
      'instances.routing.title',
      'instances.routing.hint',
      'instances.routing.notifyTarget',
      'instances.routing.notifyTargetHint',
      'instances.routing.chats',
      'instances.routing.unsupported',
      'instances.routing.chatAgent',
      'instances.routing.searchChats',
      'instances.routing.save',
      'instances.routing.agentRequired',
      'integrations.agentSelect.none',
      'integrations.agentSelect.search',
      'integrations.agentSelect.empty',
    ];
    const zh = loadSettings('zh-CN');
    const en = loadSettings('en');
    for (const locale of [zh, en]) {
      expect(required.filter((key) => lookup(locale, key) === undefined)).toEqual([]);
    }
  });

  it('translates the bot count instead of leaking the English plural form', () => {
    const zh = loadSettings('zh-CN')['instances'] as Record<string, unknown>;
    // Chinese has a single plural category; `botCount_other` is what i18next
    // resolves for any count, and it must not say "bot(s)".
    const zhCount = String(zh['botCount_other'] ?? zh['botCount'] ?? '');
    expect(zhCount).toContain('个机器人');
    expect(zhCount).not.toContain('bot');
  });
});
