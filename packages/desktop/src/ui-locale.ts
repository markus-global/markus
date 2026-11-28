/**
 * The desktop's view of "which language is this user in?".
 *
 * `resolveUiLocale` (shared) owns the *rule* — stored choice, else OS, else
 * English. This module owns the *storage* of that choice, because the main
 * process has to know the answer BEFORE the web UI exists (the splash screen is
 * painted first, and the menu is built before any renderer runs).
 *
 * The renderer writes the choice here through `app:set-ui-locale` whenever the
 * user changes the language in Settings; nothing else writes it.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveUiLocale, SUPPORTED_UI_LOCALES, type UiLocale } from '@markus/shared';

interface StoredUiLocale {
  locale: string;
}

function storePath(): string {
  const dir = join(homedir(), '.markus');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'desktop-ui.json');
}

function readStored(): string | null {
  try {
    const raw = readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as StoredUiLocale;
    return typeof parsed.locale === 'string' ? parsed.locale : null;
  } catch {
    return null; // absent or corrupt ⇒ fall back to the OS locale
  }
}

/**
 * Locale for every native surface (splash, menu, OS notifications).
 *
 * Resolved once per call rather than cached: the user can change it in Settings
 * while the app is running, and the menu is rebuilt on that event.
 */
export function getUiLocale(): UiLocale {
  let osLocale: string | null = null;
  try {
    osLocale = app.getLocale();
  } catch { /* not ready yet — resolveUiLocale falls back to 'en' */ }
  return resolveUiLocale(readStored(), osLocale);
}

/** Persist the user's explicit choice. Returns the locale actually stored. */
export function setStoredUiLocale(locale: unknown): UiLocale {
  const next = typeof locale === 'string' && (SUPPORTED_UI_LOCALES as readonly string[]).includes(locale)
    ? (locale as UiLocale)
    // A tag we do not ship (e.g. 'fr') must not be stored: it would silently
    // resolve to English on the next boot and look like the setting was lost.
    : getUiLocale();
  try {
    writeFileSync(storePath(), `${JSON.stringify({ locale: next }, null, 2)}\n`, 'utf-8');
  } catch {
    /* best-effort: the in-memory renderer choice still applies for this run */
  }
  return next;
}
