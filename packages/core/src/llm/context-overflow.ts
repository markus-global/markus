/**
 * Turn a provider's "too many tokens" failure into something the agent can act on.
 *
 * The platform no longer predicts prompt size (the char heuristic measured 2x low
 * on real sessions, and a wrong number guarding a hard boundary is worse than no
 * guard). That trade-off is only acceptable if the failure it replaces is
 * ACTIONABLE: "报错就行" works when the error says what to do.
 *
 * A raw 400 from the provider does not. The agent sees `context_length_exceeded`
 * and retries the same request. So every context-overflow shape is recognised here
 * — one classifier, one wording — and re-thrown with the remedy named.
 */

/** Provider message shapes that mean "the prompt does not fit". */
const OVERFLOW_PATTERNS: RegExp[] = [
  // OpenAI / OpenRouter / most OpenAI-compatible gateways
  /context_length_exceeded/i,
  /maximum context length is/i,
  /reduce the length of the messages/i,
  /this model'?s maximum context length/i,
  // Anthropic
  /prompt is too long/i,
  /input length and `?max_tokens`? exceed/i,
  // Google / Gemini
  /exceeds the maximum number of tokens/i,
  // DeepSeek / Qwen / misc gateways
  /\bcontext (?:length|window)\b.*\b(exceed|too (?:long|large)|limit)/i,
  /\btoo many tokens\b/i,
  // Ollama / llama.cpp style
  /\bcontext size\b.*\bexceed/i,
];

function errorText(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Is this failure a context-window overflow? Pure, testable. */
export function isContextOverflowError(err: unknown): boolean {
  const text = errorText(err);
  if (!text) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(text));
}

/**
 * The wording the agent needs. It names the lever and states that nothing was
 * guessed away, so the agent does not go looking for a phantom auto-trim.
 */
export const CONTEXT_OVERFLOW_REMEDY =
  '[CONTEXT OVERFLOW] This prompt does not fit the model\'s context window. ' +
  'Nothing was trimmed automatically — the platform no longer predicts token counts. ' +
  'Recover by calling the `session` tool with operation:\'compact\' (optionally ' +
  'goal/done/next to keep your position), then retry. If you are mid-task, ' +
  "operation:'pin' the one fact you must not lose before compacting.";

/**
 * Wrap an overflow error with the remedy, or return `undefined` when the failure
 * is something else (network, auth, rate limit — those must keep their own text).
 */
export function asActionableContextOverflow(err: unknown): Error | undefined {
  if (!isContextOverflowError(err)) return undefined;
  const original = errorText(err).slice(0, 400);
  const wrapped = new Error(`${CONTEXT_OVERFLOW_REMEDY}\nProvider said: ${original}`);
  wrapped.name = 'ContextOverflowError';
  (wrapped as { cause?: unknown }).cause = err;
  return wrapped;
}
