/**
 * Version comparison + backend takeover decision for the desktop shell.
 *
 * Contract (single enforcement point for the "who owns port 8056" rule):
 * - A starting app REUSES a running server whose version is equal or NEWER.
 * - It TAKES OVER (stops the port owner, starts its own backend) only when it
 *   can PROVE the running server is strictly older — that is the upgrade path.
 * - Unknown / unparseable versions never justify killing a healthy server:
 *   the decision falls back to reuse.
 *
 * Why not strict equality (the pre-fix rule): a dev build (e.g. 0.12.3) and an
 * installed release (0.12.2) both judged each other "old" and killed each
 * other's backend on every launch — two apps open = a takeover war. Ordering
 * the versions makes the war structurally impossible: the newer side always
 * reuses, so at most one takeover happens and it converges.
 *
 * Pure module — no Electron imports, unit-testable.
 */

export interface ServerHealth {
  running: boolean;
  version?: string;
}

export type BackendAction = 'reuse' | 'takeover' | 'start';

/**
 * Compare dot-separated numeric versions (e.g. "0.12.3").
 * Returns -1 / 0 / 1, or null when either side is not a pure numeric
 * dot-version (missing, empty, suffixes like "-beta.1", non-numeric segments).
 * Missing trailing segments count as 0 ("1.2" == "1.2.0").
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    if (!v) return null;
    const parts = v.split('.');
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * Decide what a starting app should do about the server on its port.
 * `takeover` requires positive proof that the running server is older;
 * every other case (equal, newer, unknown version) reuses.
 */
export function decideBackendAction(health: ServerHealth, appVersion: string): BackendAction {
  if (!health.running) return 'start';
  const cmp = compareVersions(health.version ?? '', appVersion);
  if (cmp !== null && cmp < 0) return 'takeover';
  return 'reuse';
}
