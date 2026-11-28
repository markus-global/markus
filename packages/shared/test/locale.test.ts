/**
 * Guard for the ONE rule that decides "which language is this user in"
 * (shared/locale.ts#resolveUiLocale). Every surface — web UI, splash, menu, OS
 * notifications — reads its answer from here, so a wrong answer is no longer a
 * cosmetic bug on one screen but a whole-app inconsistency.
 *
 * Rule as specified by the owner (2026-11-28): stored user choice → OS locale →
 * English. Falsified by flipping the first two arguments: the "choice wins over
 * OS" case goes red immediately.
 */
import { describe, it, expect } from 'vitest';
import { resolveUiLocale, splashStatus, SPLASH_COPY, SUPPORTED_UI_LOCALES } from '../src/locale.js';

describe('resolveUiLocale', () => {
  it('lets an explicit user choice beat the OS locale', () => {
    expect(resolveUiLocale('en', 'zh-CN')).toBe('en');
    expect(resolveUiLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveUiLocale('es', 'zh-CN')).toBe('es');
  });

  it('uses the OS locale on first run (no stored choice)', () => {
    expect(resolveUiLocale(null, 'zh-CN')).toBe('zh-CN');
    expect(resolveUiLocale(undefined, 'en-US')).toBe('en');
    expect(resolveUiLocale('', 'es-ES')).toBe('es');
  });

  it('maps OS tags onto the shipped set by language subtag', () => {
    expect(resolveUiLocale(null, 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveUiLocale(null, 'zh_TW')).toBe('zh-CN');
    expect(resolveUiLocale(null, 'es-419')).toBe('es');
  });

  it('falls back to English for languages we do not ship', () => {
    expect(resolveUiLocale(null, 'fr-FR')).toBe('en');
    expect(resolveUiLocale('de', 'ja-JP')).toBe('en');
    expect(resolveUiLocale(null, null)).toBe('en');
  });

  it('ignores a stored value that is not a shipped locale (never guesses)', () => {
    // e.g. a stale 'fr' from a build that briefly shipped French: the OS decides.
    expect(resolveUiLocale('fr', 'zh-CN')).toBe('zh-CN');
  });
});

describe('SPLASH_COPY', () => {
  it('covers every shipped locale with real (non-empty) copy and tips', () => {
    for (const locale of SUPPORTED_UI_LOCALES) {
      const copy = SPLASH_COPY[locale];
      expect(copy.subtitle.length).toBeGreaterThan(0);
      expect(copy.tips.length).toBeGreaterThan(0);
      for (const stage of ['boot', 'config', 'llm', 'services', 'ready'] as const) {
        expect(copy.statuses[stage].length).toBeGreaterThan(0);
      }
    }
  });

  it('renders the localized stage text, and falls back to boot for unknown stages', () => {
    expect(splashStatus('zh-CN', 'services')).not.toBe(splashStatus('en', 'services'));
    expect(splashStatus('en', 'no-such-stage')).toBe(SPLASH_COPY.en.statuses.boot);
  });
});
