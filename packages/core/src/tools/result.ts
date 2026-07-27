/**
 * Canonical tool result helpers.
 *
 * Convention (consumed by `isToolErrorResult` and the activity UI):
 *   success → `{ status: 'success', success: true, ...payload }`
 *   failure → `{ status: 'error', error: '<message>', ...hints }`
 *
 * Prefer these over ad-hoc `{ error: ... }` / `{ success: false }` shapes so
 * the UI, the agent loop, and the model all see a consistent envelope.
 */

export function toolOk(data: Record<string, unknown> = {}): string {
  // Canonical fields last so a payload key like `status` cannot overwrite them.
  return JSON.stringify({ ...data, status: 'success', success: true });
}

export function toolErr(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, status: 'error', error });
}

/**
 * Returns true when a tool returned a structured failure.
 *
 * Tools are still inconsistent, so we recognise all conventions in use:
 *   - `{ status: 'error' | 'denied' | 'rejected' }`  (shell, settings, HITL)
 *   - `{ success: false }`                           (gui, explicit flag)
 *   - `{ error: <truthy> }` with no `success: true`  (legacy multimodal / unknown-tool)
 *   - non-JSON plain-text error strings (e.g. `"Error: ..."`, `"Failed to ..."`) so a
 *     thrown-string failure is not mistaken for a successful result by the loop detector
 *     and the activity UI.
 */
export function isToolErrorResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.status === 'error' || parsed.status === 'denied' || parsed.status === 'rejected') {
      return true;
    }
    if (parsed.success === false) return true;
    // A truthy top-level `error` field means failure, unless the tool also
    // explicitly reported success (defensive against `{ success: true, error: null }`).
    if (parsed.error && parsed.success !== true) return true;
    return false;
  } catch {
    // Not JSON: conservatively detect obvious plain-text error strings. Anchored at the
    // start (optionally after whitespace) so ordinary prose mentioning "error" mid-sentence
    // is not misclassified. Also matches `XxxError:` (e.g. `TypeError:`).
    return PLAIN_TEXT_ERROR_RE.test(result);
  }
}

const PLAIN_TEXT_ERROR_RE =
  /^\s*(?:\w*error\b|err\b|failed\b|failure\b|exception\b|traceback\b|fatal\b|cannot\b|unable to\b|denied\b|rejected\b|panic\b)/i;
