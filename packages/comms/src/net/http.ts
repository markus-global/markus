/**
 * The single outbound-HTTP seam for every platform client in this package.
 *
 * Why this exists
 * ---------------
 * A platform client must never call the global `fetch` directly. On a machine
 * behind a proxy (a rule-based local proxy is the norm on macOS/Windows), bare
 * `fetch` cannot reach a blocked network — so IM traffic would silently bypass
 * the proxy that the rest of the platform already honours. The failure mode is
 * vicious: the same machine reaches the LLM provider (which goes through
 * `proxyFetch`) while every IM platform reports "connection failed", which
 * looks like a bad token rather than a missing route.
 *
 * So: every call site in `comms` goes through {@link httpFetch}, and the host
 * application installs the platform's proxy-aware implementation **once** at
 * bootstrap via {@link setHttpFetch}. That keeps one implementation of proxy
 * resolution (in core) instead of a second copy drifting here.
 *
 * The default stays the global `fetch`, resolved *lazily* on each call, so a
 * test that stubs `globalThis.fetch` after module load still takes effect.
 */

/**
 * The subset of the global `fetch` signature platform clients actually use:
 * a URL plus init. Deliberately narrower than `typeof fetch` (no `Request`
 * overload) so it stays assignable from the host's proxy-aware fetch, which
 * takes the same two arguments.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let installed: FetchLike | null = null;

/**
 * Install the host's fetch implementation (e.g. one that routes through the
 * configured proxy). Pass `null` to restore the default. Bootstrap-only.
 */
export function setHttpFetch(impl: FetchLike | null): void {
  installed = impl;
}

/** The fetch implementation in force; falls back to the global `fetch`. */
export function getHttpFetch(): FetchLike {
  if (installed) return installed;
  return (input, init) =>
    globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], init);
}

/** Drop-in `fetch` replacement for platform clients. */
export function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return getHttpFetch()(input, init);
}

/**
 * Transport-level failure codes we treat as "cannot reach the network", as
 * opposed to "the platform rejected our credentials". They are the ones a
 * blocked/unroutable host actually produces: DNS refusal, connect timeout,
 * reset, or an undici-level socket error.
 */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
]);

/**
 * The user-facing verdict of a failed probe.
 *
 * `network_unreachable` is a *structural* fact (no route to the host) and must
 * be distinguishable from an authentication failure, because the remedy is
 * completely different: configure a proxy, not fix the token. Consumers switch
 * on `code` and localise; the `error` string stays as the technical detail.
 */
export type ProbeFailureCode = 'network_unreachable';

export interface ProbeFailure {
  code: ProbeFailureCode;
  /** Underlying errno/message, for logs and for showing next to the verdict. */
  detail: string;
}

/**
 * Classify a thrown fetch error into an actionable {@link ProbeFailure}, or
 * `null` when it is not a transport-level failure (i.e. let the caller report
 * the platform's own error).
 */
export function classifyFetchFailure(error: unknown): ProbeFailure | null {
  const err = error as { code?: unknown; cause?: { code?: unknown; message?: unknown }; name?: unknown };
  const detail =
    (error instanceof Error ? error.message : String(error)) ||
    (typeof err?.cause?.message === 'string' ? err.cause.message : '');

  const codes = [err?.code, err?.cause?.code].filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => UNREACHABLE_CODES.has(c))) {
    return { code: 'network_unreachable', detail: codes[0] ?? detail };
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { code: 'network_unreachable', detail: 'timeout' };
  }
  // undici collapses every transport failure into `TypeError: fetch failed`
  // with the real errno on `cause`; some runtimes drop the cause entirely, so
  // match the message as a last resort.
  if (/fetch failed|network|timed out|socket hang up|other side closed/i.test(detail)) {
    return { code: 'network_unreachable', detail: detail || 'fetch failed' };
  }
  return null;
}
