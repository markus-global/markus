/**
 * i18n conventions for the manifest-driven Integrations UI.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 *
 * The platform manifest is *data over HTTP*: a platform's label, its field
 * labels/help/placeholders and its select options all arrive as English strings
 * authored in the backend registry. The UI therefore used to render English
 * even in a fully localised app, and it could not translate them without
 * hard-coding a per-platform table — which would break the very promise the
 * manifest programme makes ("a new platform needs zero UI code").
 *
 * ── The convention ──────────────────────────────────────────────────────────
 *
 * Every human-visible string is looked up by **convention key** derived from the
 * platform id and the field key, with the server-provided English value as the
 * fallback:
 *
 *   settings:integrations.platforms.<id>.label
 *   settings:integrations.platforms.<id>.description
 *   settings:integrations.platforms.<id>.fields.<key>.label
 *   settings:integrations.platforms.<id>.fields.<key>.help
 *   settings:integrations.platforms.<id>.fields.<key>.placeholder
 *   settings:integrations.platforms.<id>.fields.<key>.options.<value>
 *   settings:integrations.platforms.<id>.guide.step<N>.title
 *   settings:integrations.platforms.<id>.guide.step<N>.desc
 *
 * Consequences that matter:
 *   • a platform with **no** translation still renders perfectly — in English,
 *     straight from the manifest (zero UI code, still true);
 *   • translating a platform is a pure content edit (locale files only) — no
 *     component knows a platform name;
 *   • a translated field never silently loses its meaning: adding a locale key
 *     is optional and per-field.
 *
 * The `defaultValue` passed to `t()` is the manifest string, so `t()` returns
 * it verbatim when no key exists — this is what makes the fallback free.
 */

import type { TFunction, i18n as I18n } from 'i18next';
import type { PlatformField, PlatformStatus } from './platformIntegrations.ts';

/** Root namespace-relative prefix for every per-platform string. */
const PLATFORMS = 'integrations.platforms';

const key = (platformId: string, suffix: string) => `settings:${PLATFORMS}.${platformId}.${suffix}`;

/**
 * Deep link to the vendor console where a platform's app/credentials live.
 *
 * URLs are *not* content and must not live in locale files, so they stay here.
 * A platform without an entry simply shows no "Open console" button — never a
 * broken link.
 */
export const PLATFORM_CONSOLE_URL: Readonly<Record<string, string>> = {
  feishu: 'https://open.feishu.cn/app',
  telegram: 'https://t.me/BotFather',
  slack: 'https://api.slack.com/apps',
  whatsapp: 'https://developers.facebook.com/apps',
  discord: 'https://discord.com/developers/applications',
};

export function consoleUrlFor(platformId: string): string | undefined {
  return PLATFORM_CONSOLE_URL[platformId];
}

/** The platform's display name, translated when a key exists, else as sent. */
export function platformLabel(t: TFunction, status: Pick<PlatformStatus, 'id' | 'label'>): string {
  return t(key(status.id, 'label'), { defaultValue: status.label });
}

/** Optional one-line description of what connecting the platform does. */
export function platformDescription(t: TFunction, platformId: string): string | undefined {
  const value = t(key(platformId, 'description'), { defaultValue: '' });
  return value.trim() === '' ? undefined : value;
}

export interface FieldText {
  label: string;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

/** Translated presentation for one manifest field, manifest strings as fallback. */
export function fieldText(t: TFunction, platformId: string, field: PlatformField): FieldText {
  const base = key(platformId, `fields.${field.key}`);
  return {
    label: t(`${base}.label`, { defaultValue: field.label }),
    help: field.help ? t(`${base}.help`, { defaultValue: field.help }) : undefined,
    placeholder: field.placeholder
      ? t(`${base}.placeholder`, { defaultValue: field.placeholder })
      : undefined,
    options: field.options?.map((opt) => ({
      value: opt.value,
      label: t(`${base}.options.${opt.value}`, { defaultValue: opt.label }),
    })),
  };
}

export interface GuideStep {
  title: string;
  desc?: string;
}

/**
 * The ordered setup steps for a platform, read from the locale files by
 * convention (`guide.step1.title`, `guide.step2.title`, …).
 *
 * Enumeration stops at the first missing `step<N>` — so adding a step is
 * appending a locale key, and a platform with no guide keys simply yields `[]`
 * (the card then falls back to a one-line hint + docs link). Numbering is
 * therefore contiguous by construction; a typo'd gap truncates visibly rather
 * than rendering an empty step.
 */
export function guideSteps(i18n: I18n, t: TFunction, platformId: string): GuideStep[] {
  const steps: GuideStep[] = [];
  const base = key(platformId, 'guide');
  for (let n = 1; n <= 20; n += 1) {
    const titleKey = `${base}.step${n}.title`;
    if (!i18n.exists(titleKey)) break;
    const descKey = `${base}.step${n}.desc`;
    const desc = i18n.exists(descKey) ? t(descKey) : undefined;
    steps.push({ title: t(titleKey), ...(desc ? { desc } : {}) });
  }
  return steps;
}

/** Heading for the setup guide, translatable once for all platforms. */
export function guideHeading(t: TFunction): string {
  return t('settings:integrations.guide.heading', { defaultValue: 'Setup guide' });
}
