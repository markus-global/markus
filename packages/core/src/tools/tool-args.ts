/**
 * Tool argument naming contract — SINGLE OWNER.
 *
 * Two mechanisms used to hold their own opinion about "what is a valid argument name",
 * and they drifted apart in production:
 *
 *   1. the platform expands every call's args with camelCase AND snake_case aliases
 *      (`task_id` ⇒ also `taskId`) and injects reserved `_`-prefixed session keys;
 *   2. a tool-side strict validator compared the EXPANDED args against a bare
 *      snake_case whitelist.
 *
 * Result (2026-10-18): every multi-word argument was reported as "unknown" and all
 * three task/requirement write tools refused every call — a strict validator that
 * rejected the platform's own decorations. Two owners of one contract always drift;
 * the fix is to give the contract exactly one implementation and have both sides call
 * it. Never re-implement alias expansion or name normalization anywhere else.
 */

/** Argument names starting with this are reserved for platform-injected context. */
export const PLATFORM_ARG_PREFIX = '_';

/**
 * Canonical form of an argument name: snake_case.
 *
 * `taskId` and `task_id` denote the same argument, so validation must compare
 * canonical forms — never raw spellings.
 */
export function normalizeArgName(name: string): string {
  return name.replace(/([A-Z])/g, (_, c: string) => '_' + c.toLowerCase());
}

/**
 * Expand caller args with both casing variants so a tool (and downstream service code)
 * can be written in whichever convention it prefers. Platform-reserved keys are never
 * expanded, and an existing key is never overwritten.
 */
export function expandArgAliases(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return (args ?? {}) as Record<string, unknown>;
  }
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key.startsWith(PLATFORM_ARG_PREFIX)) continue;
    const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const snake = normalizeArgName(key);
    if (camel !== key && !(camel in out)) out[camel] = value;
    if (snake !== key && !(snake in out)) out[snake] = value;
  }
  return out;
}

/**
 * Caller-supplied argument names the tool cannot honour, compared in canonical form.
 *
 * Platform decorations are not caller mistakes: `_`-prefixed keys are injected context,
 * and the opposite-casing twin of a declared field is a legitimate alias of that field.
 * Only a name that maps to no declared field is a real unknown — that is the case worth
 * failing loud on (silent no-ops are the actual defect this guard exists for).
 */
export function findUnknownArgs(
  args: Record<string, unknown>,
  allowed: readonly string[]
): string[] {
  const allowedCanonical = new Set(allowed.map(normalizeArgName));
  return Object.keys(args).filter(key => {
    if (key.startsWith(PLATFORM_ARG_PREFIX)) return false;
    return !allowedCanonical.has(normalizeArgName(key));
  });
}
