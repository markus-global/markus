/**
 * The approval **decision vocabulary** and its display labels.
 *
 * Why this exists: an approval's buttons used to be baked as English literals at
 * the gate (`task-service.ts`: `Approve` / `Request Changes`) with a *different*
 * hardcoded Chinese pair as the dispatcher's fallback. A Chinese owner therefore
 * received an English card — and the two surfaces could not agree on wording
 * because neither owned it.
 *
 * The split that fixes it:
 *   · a **gate** declares the *direction* of a choice (structure) — `approve`,
 *     `request_changes`, `reject`;
 *   · this module owns the *label* for a direction (display).
 *
 * So the label has exactly one writer, and a new locale is one entry here rather
 * than an edit in every gate.
 */
import { normalizeLanguage } from './locale.js';

/** What a choice means. The decision vocabulary the whole platform shares. */
export type ApprovalDirection = 'approve' | 'request_changes' | 'reject';

const DIRECTIONS: readonly ApprovalDirection[] = ['approve', 'request_changes', 'reject'];

/** The button word per direction, per language subtag. */
const DIRECTION_LABELS: Record<ApprovalDirection, Record<string, string>> = {
  approve: { en: 'Approve', zh: '批准', es: 'Aprobar' },
  request_changes: { en: 'Request Changes', zh: '要求修改', es: 'Solicitar cambios' },
  reject: { en: 'Reject', zh: '拒绝', es: 'Rechazar' },
};

/**
 * The button's visual weight per direction. Carried with the label so a caller
 * cannot pair "Request Changes" with a destructive red: 打回 asks for revision, it
 * is not a rejection.
 */
const DIRECTION_STYLES: Record<ApprovalDirection, 'primary' | 'default' | 'danger'> = {
  approve: 'primary',
  request_changes: 'default',
  reject: 'danger',
};

export function isApprovalDirection(value: unknown): value is ApprovalDirection {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value);
}

/** The localized button word for a direction. Falls back to English. */
export function approvalDirectionLabel(direction: ApprovalDirection, locale?: string): string {
  const entry = DIRECTION_LABELS[direction];
  return entry[normalizeLanguage(locale)] ?? entry['en']!;
}

/** The visual weight for a direction. */
export function approvalDirectionStyle(direction: ApprovalDirection): 'primary' | 'default' | 'danger' {
  return DIRECTION_STYLES[direction];
}

/**
 * What a channel says when it has to withhold a choice that needs a written
 * reason. "Request changes" is not a state, it is a *comment plus resubmit* loop:
 * a 打回 with no reason sends the work back with nothing to act on, which is worse
 * than no button at all. A channel that cannot collect free text therefore
 * declines the job and points at the one that can.
 */
const COMMENT_REQUIRED_NOTES: Record<string, string> = {
  en: 'To request changes, open Markus — the reason has to be written there.',
  zh: '「要求修改」请在 Markus 中操作 —— 修改意见需要在那里填写。',
  es: 'Para solicitar cambios, ábrelo en Markus: el motivo debe escribirse allí.',
};

export function approvalCommentNote(locale?: string): string {
  return COMMENT_REQUIRED_NOTES[normalizeLanguage(locale)] ?? COMMENT_REQUIRED_NOTES['en']!;
}
