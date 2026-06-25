/**
 * Auth middleware — validates the `X-Subscription-Key` header.
 *
 * In this skeleton the key is compared against a single statically
 * configured key (via secret / env var).  A future phase will replace
 * this with a KV lookup or API call to the Hub backend.
 */

import { unauthorized } from '../utils/errors.js';
import { unauthorized as unauthorizedResponse } from '../utils/response.js';

/** Routes that do NOT require authentication. */
const PUBLIC_ROUTES = new Set(['/health']);

export interface AuthOptions {
  /** Env var name that holds the expected subscription key. */
  keyEnvVar?: string;
}

/**
 * Auth middleware.  Returns a 401 Response if the request should be
 * authenticated but no valid key is provided; returns `null` to allow.
 */
export function handleAuth(
  request: Request,
  env: Record<string, unknown>,
): Response | null {
  const url = new URL(request.url);

  // Public routes skip auth.
  if (PUBLIC_ROUTES.has(url.pathname)) {
    return null;
  }

  const subscriptionKey = request.headers.get('x-subscription-key');

  if (!subscriptionKey) {
    return unauthorizedResponse(unauthorized('Missing X-Subscription-Key header'));
  }

  // TODO(Wave 2): Replace static key check with Hub API / KV lookup.
  const expectedKey = env.SUBSCRIPTION_KEY as string | undefined;
  if (expectedKey && subscriptionKey !== expectedKey) {
    return unauthorizedResponse(unauthorized('Invalid subscription key'));
  }

  return null; // authenticated
}
