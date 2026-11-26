/**
 * C10-F — external signals: the pure part of the settings surface.
 *
 * Two facts live here instead of in the component, because both are things a
 * component gets subtly wrong and no snapshot test would notice:
 *
 *  1. **The URL is only real when it is reachable.** A webhook path printed
 *     against `localhost` looks exactly as convincing as one printed against a
 *     tunnel hostname, and the user finds out it was never reachable when the
 *     first delivery fails. So the join returns `external: false` and the UI is
 *     forced to say so, instead of us hoping someone remembers to.
 *  2. **The policy is a closed set with closed consequences.** The label and the
 *     consequence sentence come from the same table, so a state can never be
 *     rendered with another state's meaning.
 */

export type ExternalIngressPolicy = 'off' | 'observe' | 'accept';

export const EXTERNAL_INGRESS_POLICIES: readonly ExternalIngressPolicy[] = ['off', 'observe', 'accept'];

/** Runtime narrowing for values crossing the API boundary. */
export function isExternalIngressPolicy(value: unknown): value is ExternalIngressPolicy {
  return value === 'off' || value === 'observe' || value === 'accept';
}

export interface ExternalSourceView {
  id: string;
  kind: string;
  address: string;
  enabled: boolean;
  urlPath: string | null;
  hasSecret: boolean;
  secretPreview: string | null;
  feedUrl: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface ExternalSourcesResponse {
  policy: ExternalIngressPolicy;
  sources: ExternalSourceView[];
}

export interface ExternalIngressUrl {
  /** What to paste into the outside system. */
  url: string;
  /** False ⇒ this address is only reachable from this machine. */
  external: boolean;
}

/**
 * Join the tunnel base with a source path.
 *
 * `publicUrl` comes from the remote-access wizard and may be null (no tunnel) or
 * arrive with a trailing slash. Both are normalised here — never at call sites,
 * because two call sites would eventually disagree about the slash.
 */
export function externalIngressUrl(publicUrl: string | null, urlPath: string): ExternalIngressUrl {
  const base = (publicUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return { url: urlPath, external: false };
  return { url: `${base}${urlPath}`, external: true };
}

/**
 * Three answers, not two.
 *
 * `publicUrl === null` used to carry two different meanings — "no tunnel is
 * configured" (a fact about the machine) and "we could not read the tunnel
 * status" (the absence of a fact) — and the screen printed the first sentence
 * for both. Telling someone "no tunnel is configured" because a request failed
 * is worse than saying nothing: they go configure a tunnel they may already
 * have, and they stop trusting the other warnings on the page.
 */
export type TunnelState =
  | { kind: 'url'; url: string }
  | { kind: 'none' }
  | { kind: 'unknown' };

export function tunnelStateFor(
  status: { publicUrl: string | null } | null | undefined,
): TunnelState {
  if (!status) return { kind: 'unknown' };
  const url = (status.publicUrl ?? '').trim();
  return url ? { kind: 'url', url } : { kind: 'none' };
}

/** Whether a source can currently receive anything, and why not. */
export function sourceDeliveryState(
  source: Pick<ExternalSourceView, 'enabled'>,
  policy: ExternalIngressPolicy,
): 'delivering' | 'paused' | 'blocked_by_policy' {
  if (policy === 'off') return 'blocked_by_policy';
  if (!source.enabled) return 'paused';
  return 'delivering';
}
