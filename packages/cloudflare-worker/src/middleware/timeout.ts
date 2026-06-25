/**
 * Timeout middleware — aborts the request if it takes longer than
 * `TIMEOUT_MS` and returns a 504 Gateway Timeout.
 */

import { gatewayTimeout } from '../utils/errors.js';
import { gatewayTimeout as timeoutResponse } from '../utils/response.js';

/** Default timeout: 60 seconds (matching typical LLM providers). */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface TimeoutOptions {
  timeoutMs?: number;
}

/**
 * Wraps a request handler so that it rejects with a 504 if it exceeds
 * the configured timeout.
 */
export function withTimeout(
  handler: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<Response>,
  options?: TimeoutOptions,
): (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request, env, ctx) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await handler(request, env, ctx);
      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return timeoutResponse(gatewayTimeout('llm-provider'));
      }
      throw err; // re-throw unexpected errors
    } finally {
      clearTimeout(timer);
    }
  };
}
