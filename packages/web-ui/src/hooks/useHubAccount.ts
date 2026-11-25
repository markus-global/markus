/**
 * Shared Hub account state for the surfaces that show "am I connected, as whom,
 * and how many credits do I have": the desktop account popover and the mobile
 * drawer.
 *
 * Both used to carry their own copy of the validate / focus / hub-auth dance.
 * They had already drifted — the popover computed credits from the
 * monthly+bonus+purchased column sum while the overview bar used
 * `creditsBudgetCu` — so the same account showed two different balances. The
 * fetch and the derivation now live here and in `lib/hubCredits.ts` respectively,
 * and callers only decide *when* to fetch (popover/drawer open) and how to draw it.
 */
import { useCallback, useEffect, useState } from 'react';
import { getHubUser, hubApi, validateHubSession, type HubUser } from '../api.ts';
import { resolveCreditSummary, type CreditSummary } from '../lib/hubCredits.ts';

export interface HubAccountState {
  /** Live-validated: a stale token in localStorage does not count as connected. */
  connected: boolean;
  user: HubUser | null;
  /**
   * `null` until the plan resolves, and stays null when not connected or the
   * call fails — callers omit the row rather than render a fake 0.
   *
   * Always the *self-managed* answer (no org metadata is fetched). A member
   * capped by an org admin therefore sees their org-level balance here; the
   * authoritative, cap-aware breakdown is Settings → Account.
   */
  credits: CreditSummary | null;
  /** Re-read local cache; `validate` also probes the token against the Hub. */
  refresh: (opts?: { validate?: boolean }) => void;
}

/**
 * @param active fetch the credit balance only while this is true (e.g. the
 *   popover/drawer is open). The Hub plan call is cheap but not free, and
 *   neither surface polls.
 */
export function useHubAccount(active: boolean): HubAccountState {
  const [connected, setConnected] = useState(() => hubApi.isAuthenticated());
  const [user, setUser] = useState<HubUser | null>(() => getHubUser());
  // Seed from the last known balance so the badge has a number to show before the
  // network answers. Without this the popover opened on `—` and became a value a
  // moment later, on every cold start, for a number that usually had not changed.
  const [credits, setCredits] = useState<CreditSummary | null>(
    () => readCachedCredits(getHubUser()?.id ?? null),
  );

  const refresh = useCallback((opts?: { validate?: boolean }) => {
    setUser(getHubUser());
    if (!hubApi.isAuthenticated()) {
      setConnected(false);
      setCredits(null);
      // Signed out: drop the cached balance rather than let it resurface for the
      // next account that signs in on this machine.
      writeCachedCredits(null, null);
      return;
    }
    if (!opts?.validate) {
      setConnected(true);
      return;
    }
    // The focus / mount probe is async by design — a stale token must not show green.
    void validateHubSession().then(ok => {
      setConnected(ok);
      setUser(getHubUser());
    });
  }, []);

  useEffect(() => {
    refresh({ validate: true });
    // hub-auth means the local cache already changed — read it, do not re-validate
    // (validate → saveHubAuth → hub-auth was an infinite loop).
    const onAuth = () => refresh();
    const onFocus = () => refresh({ validate: true });
    window.addEventListener('markus:hub-auth', onAuth);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('markus:hub-auth', onAuth);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!hubApi.isAuthenticated()) return;
    // `active` used to gate the FIRST fetch (`if (!active) return`), which meant the
    // balance existed only after the user opened the menu — the sidebar badge stayed
    // blank until then. The number belongs on screen before any interaction, so the
    // fetch runs on mount; flipping `active` re-runs this effect, which is exactly the
    // "re-check when the popover opens" behaviour we want.
    let cancelled = false;
    hubApi.user.plan()
      .then(p => {
        if (cancelled) return;
        const summary = resolveCreditSummary(p);
        setCredits(summary);
        writeCachedCredits(getHubUser()?.id ?? null, summary);
      })
      // A failed refresh must not blank a number that is still the best answer we
      // have. Keep the cached value and let the next focus event retry.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, connected]);

  return { connected, user, credits, refresh };
}

/**
 * Last known balance, so the sidebar badge can render a number before the network
 * answers. Scoped by Hub user id: a balance cached under one account must never be
 * rendered for another — that would be a *wrong* number, which is worse than a
 * pending one.
 */
const CREDITS_CACHE_KEY = 'markus:hub:credits';

function readCachedCredits(userId: string | null): CreditSummary | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(CREDITS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: string; credits?: CreditSummary };
    if (parsed.userId !== userId || !parsed.credits) return null;
    return parsed.credits;
  } catch {
    return null;
  }
}

function writeCachedCredits(userId: string | null, credits: CreditSummary | null): void {
  try {
    if (!userId || !credits) {
      localStorage.removeItem(CREDITS_CACHE_KEY);
      return;
    }
    localStorage.setItem(CREDITS_CACHE_KEY, JSON.stringify({ userId, credits }));
  } catch {
    /* private mode / quota — caching is an optimisation, never a requirement */
  }
}
