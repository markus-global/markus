/**
 * Approval-card rewrite scheduling (CLI side of design §6.5).
 *
 * Defect it fixes: the first version rewrote the card **inside** the card-action
 * handler, so the PATCH raced the callback response. Feishu's contract (处理卡片
 * 回调 / 常见问题) is that the callback response re-renders the tapper's client
 * with the *clicked-time* card, and an interactive-card update must happen after
 * the callback response — otherwise the update is visually clobbered. Observed
 * 2026-10-13: the server kept the resolved card (verified via GET message) while
 * the tapper's client snapped back to the button state; later taps still landed
 * and were idempotently ignored.
 *
 * Two guarantees live here, together, because they share the one invariant —
 * *the card must converge to the approval's authoritative state*:
 * 1. `buildApprovalCardResolution` — the ONE place that turns an approval record
 *    (+ the tap's display hints) into a {@link CardResolution}. Title/body are
 *    re-used verbatim from the record; nothing is re-parsed out of card text.
 * 2. `scheduleCardRewrite` — runs the rewrite **after** the callback ack
 *    (CARD_REWRITE_DELAY_MS later). Best-effort by contract: a failure here is
 *    logged upstream, never fatal, and never rolls the approval back.
 */
import type { CardResolution } from '@markus/comms';

/** Renderable states of a resolved approval card. */
export type TerminalApprovalStatus = NonNullable<CardResolution['status']>;

/** Post-ack delay before the card PATCH. Long enough for the ack round-trip to
 *  win the race it is supposed to win; short enough to feel instant. */
export const CARD_REWRITE_DELAY_MS = 1_000;

const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'cancelled', 'expired']);

/**
 * Build the card resolution from the approval record — the authoritative source.
 * The recorded decision-maker wins (a re-tap on an already-terminal approval
 * must not rewrite history); the tap's actor/option only fill in for records
 * that lack them.
 */
export function buildApprovalCardResolution(
  approval: {
    status: string;
    title: string;
    description: string;
    respondedBy?: string;
    selectedOption?: string;
    respondedAt?: string;
  },
  tap: { actorId?: string; actorName?: string; tappedOption?: string },
): CardResolution {
  return {
    status: (TERMINAL_STATUSES.has(approval.status)
      ? approval.status
      // A request that is still pending (e.g. the tap was refused because the form
      // needs an answer in the app) must NOT be rendered as `expired` — that says
      // the request died, which is false and invites a duplicate.
      : 'pending') as TerminalApprovalStatus,
    title: approval.title,
    body: approval.description,
    actorId: approval.respondedBy ?? tap.actorId,
    // Presentational only — absent ⇒ the card shows the raw id.
    actorName: tap.actorName,
    selectedOption: approval.selectedOption ?? tap.tappedOption,
    at: approval.respondedAt,
  };
}

/**
 * Run a card rewrite after the callback ack, best-effort. Never rejects (a
 * rejection must not become an unhandled one on a timer); failures are handed
 * to `onError` so the caller keeps its log line without turning the tap into
 * an error.
 */
export function scheduleCardRewrite(
  rewrite: () => Promise<unknown>,
  onError?: (error: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(rewrite)
        .catch((error: unknown) => onError?.(error))
        .finally(resolve);
    }, CARD_REWRITE_DELAY_MS);
    // Never hold process shutdown for a cosmetic card edit.
    timer.unref?.();
  });
}
