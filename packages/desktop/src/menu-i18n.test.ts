/**
 * Guard: the native menu must ship the SAME key set in every locale.
 *
 * Why: a missing key does not throw. `t[key]` is simply `undefined`, and Electron
 * renders a menu item with an empty label — a silently broken menu in exactly the
 * language nobody on the team reads. Adding Spanish here was the moment to make
 * that structurally visible instead of hoping the next translator counts to 37.
 *
 * Also pins that the locale the platform resolves is one the table actually has:
 * `getUiLocale()` can return 'es', and if the table lacked it the whole menu
 * would go blank at runtime.
 */
import { describe, it, expect } from 'vitest';
import { i18n } from './menu.js';

const locales = Object.keys(i18n);

describe('menu label table', () => {
  it('ships every locale the UI can resolve (en, zh, es)', () => {
    expect(locales.sort()).toEqual(['en', 'es', 'zh']);
  });

  it('has an identical key set in every locale — no half-translated menu', () => {
    const reference = Object.keys(i18n['en']).sort();
    expect(reference.length).toBeGreaterThan(30); // sanity: the table is real
    for (const locale of locales) {
      expect(Object.keys(i18n[locale]).sort(), `${locale} keys differ from en`).toEqual(reference);
    }
  });

  it('has no empty label in any locale', () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(i18n[locale])) {
        expect(value.trim().length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });
});
