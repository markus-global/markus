/**
 * Map a classified egress-probe failure to the message the Settings page shows.
 *
 * Why a pure function: the backend already classifies (`comms/net/http.ts`
 * `classifyFetchFailure`) and serialises a `code`. The UI must not re-parse prose —
 * that would be a second classifier for the same fact, and the two would drift.
 * Keeping the code→message decision here means the mapping is unit-testable without
 * a browser, and exactly one place decides what the user is told.
 *
 * The property that matters: every branch names a REMEDY and a next action, never
 * the transport symptom. `TypeError: fetch failed` is what undici says internally;
 * "代理程序可能没在运行" is what the user can act on. Showing the former tells the
 * user nothing, which is how this mapping came to exist.
 */

/** Shape the settings API returns in the `failure` field (see api-server network/test). */
export interface ProbeFailureLike {
  code?: string | null;
  detail?: string | null;
}

export interface FailureMessage {
  /** i18n key relative to the settings namespace, e.g. `networkProxy.failRefused`. */
  key: string;
  params: Record<string, string>;
}

/** errno fragments that mean distinct remedies. Matched on the classifier's `detail`. */
const REFUSED = /ECONNREFUSED|EPIPE|ECONNRESET/i;
const DNS = /ENOTFOUND|EAI_AGAIN/i;
const TIMEOUT = /TIMEDOUT|timeout|ABORT_ERR|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i;

export function proxyFailureMessage(failure: ProbeFailureLike | null | undefined): FailureMessage {
  const raw = (failure?.detail ?? '').trim();
  const code = failure?.code ?? '';
  // Never hand i18n an empty {{detail}}: every message has a parenthesis slot, and a
  // blank one renders as `（ ）` — which looks like the app broke, not like the probe did.
  const detail = raw || code || 'unknown';

  // The chain reached the probe and got an HTTP answer. That is NOT a routing or
  // proxy failure — saying "check your proxy" here would send the user the wrong way.
  if (code === 'probe_http_error') {
    return { key: 'networkProxy.failProbeHttp', params: { detail } };
  }

  if (code === 'network_unreachable') {
    // Name the specific errno where we can: "proxy not running", "bad host" and
    // "timeout" have three different fixes, so collapsing them helps nobody.
    if (REFUSED.test(raw)) {
      return { key: 'networkProxy.failRefused', params: { detail } };
    }
    if (DNS.test(raw)) {
      return { key: 'networkProxy.failDns', params: { detail } };
    }
    if (TIMEOUT.test(raw)) {
      return { key: 'networkProxy.failTimeout', params: { detail } };
    }
    return { key: 'networkProxy.failUnreachable', params: { detail } };
  }

  return { key: 'networkProxy.failUnknown', params: { detail } };
}
