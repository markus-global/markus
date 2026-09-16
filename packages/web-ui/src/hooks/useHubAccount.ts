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
  const [credits, setCredits] = useState<CreditSummary | null>(null);

  const refresh = useCallback((opts?: { validate?: boolean }) => {
    setUser(getHubUser());
    if (!hubApi.isAuthenticated()) {
      setConnected(false);
      setCredits(null);
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
    if (!active || !hubApi.isAuthenticated()) return;
    let cancelled = false;
    hubApi.user.plan()
      .then(p => { if (!cancelled) setCredits(resolveCreditSummary(p)); })
      .catch(() => { if (!cancelled) setCredits(null); });
    return () => { cancelled = true; };
  }, [active, connected]);

  return { connected, user, credits, refresh };
}
