/**
 * Proxy-aware fetch for LLM / OAuth / search traffic.
 *
 * Proxy resolution and the process-wide dispatcher moved to
 * `@markus/shared/net/egress` — this module is now only the compatibility surface
 * the rest of the platform imports. Keeping it means call sites that deliberately
 * want an explicit seam stay working, while the actual policy lives in one place.
 *
 * With the global dispatcher installed, `proxyFetch` behaves like `fetch`; when no
 * proxy is configured (or undici is unavailable) it is exactly `fetch`. There is no
 * silent per-call fallback to a different route: either the process is proxied or
 * it is not.
 */
import {
  installEgress,
  resolveEgress,
  egressStatus as sharedEgressStatus,
  type EgressStatus,
  type ProxySource,
} from '@markus/shared';

export type { ProxySource, EgressStatus };

export interface EffectiveProxy {
  url: string | undefined;
  source: ProxySource;
}

/**
 * Backwards-compatible accessor for the resolved proxy. Resolution order:
 * config → environment → system → direct, with `proxyEnabled: false` short-cutting
 * everything.
 */
export function getEffectiveProxy(): EffectiveProxy {
  const policy = resolveEgress();
  return { url: policy.url, source: policy.source };
}

/** Re-exported so hosts can install the policy at bootstrap. */
export { installEgress };

/** Current egress status, for settings and diagnostics. */
export function getEgressStatus(): EgressStatus {
  return sharedEgressStatus();
}

/**
 * Fetch through the process egress policy.
 *
 * Idempotent install: the first call sets the global dispatcher, later calls are
 * cheap. `fetch` (not a per-call ProxyAgent) is used on purpose — one dispatcher
 * means every other call site in the process is covered too.
 */
export async function proxyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  await installEgress();
  return fetch(url, init);
}
