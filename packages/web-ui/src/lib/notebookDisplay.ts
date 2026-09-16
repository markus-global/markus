/**
 * Notebook display helpers (pure — unit-testable without a DOM).
 *
 * The Team Chat "Agent overview" panel renders the notebook inline. A real
 * notebook reached 26 entries / 33 KB, which (a) overwhelmed the panel and
 * (b) pushed the page far past a comfortable scroll. Display is therefore
 * bounded and collapsed by default; this module owns the boundedness so it can
 * be tested without instantiating React (this package has no jsdom /
 * @testing-library/react — see packages/web-ui/src/api.test.ts:3-4).
 *
 * NOTE the limit is a DISPLAY convention and is deliberately equal to the
 * storage cap (`NOTEBOOK_MAX_ENTRIES = 16` in @markus/shared). If the storage cap
 * ever changes, this constant must follow — the two exist so that the panel never
 * silently hides entries the agent still believes are resident in its prompt.
 */

export const NOTEBOOK_DISPLAY_LIMIT = 16;

export interface NotebookDisplayEntry {
  key: string;
  text: string;
  updatedAt: number;
  managed?: string;
}

export interface NotebookDisplaySlice<T extends NotebookDisplayEntry> {
  /** Entries to render right now. */
  visible: T[];
  /** How many entries the current view hides (0 when everything fits). */
  hiddenCount: number;
  /** True when a "show more" affordance is warranted. */
  collapsible: boolean;
}

/**
 * Bound a notebook entry list for display.
 *
 * Order is preserved as received (the backend already ranks most-recent-first),
 * so "the first N" means "the N most recent" — the entries the agent is actually
 * acting on.
 */
export function sliceNotebookForDisplay<T extends NotebookDisplayEntry>(
  entries: readonly T[] | undefined | null,
  expanded: boolean,
  limit: number = NOTEBOOK_DISPLAY_LIMIT,
): NotebookDisplaySlice<T> {
  const all = entries ?? [];
  if (all.length <= limit) {
    return { visible: [...all], hiddenCount: 0, collapsible: false };
  }
  if (expanded) {
    return { visible: [...all], hiddenCount: 0, collapsible: true };
  }
  return {
    visible: all.slice(0, limit),
    hiddenCount: all.length - limit,
    collapsible: true,
  };
}

export type NotebookAgeUnit = 'seconds' | 'minutes' | 'hours';

/**
 * Bucket an entry's age into an i18n-friendly unit + count.
 *
 * Mirrors the backend's quantization intent (agent.ts `ageLabel`): boundaries are
 * coarse so the label does not change on every render. Returns the raw pieces
 * rather than a string so both locales (and any future locale) share one rule.
 */
export function formatNotebookAge(
  updatedAt: number,
  now: number = Date.now(),
): { unit: NotebookAgeUnit; count: number } {
  const ageMs = Math.max(0, now - (Number.isFinite(updatedAt) ? updatedAt : now));
  if (ageMs < 60_000) return { unit: 'seconds', count: Math.round(ageMs / 1000) };
  if (ageMs < 3_600_000) return { unit: 'minutes', count: Math.round(ageMs / 60_000) };
  return { unit: 'hours', count: Math.round((ageMs / 3_600_000) * 10) / 10 };
}
