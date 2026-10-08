/**
 * Mailbox item "cancellable" derivation — single source of truth for whether
 * the ✕ 取消 button should render in 「运行与注意力」.
 *
 * Defect this fixes (docs/MESSAGE-STOP-CANCEL-FIX-PLAN.md §2.3b):
 * the button used to render whenever `item.status === 'processing'`, but core
 * cancel-processing is a no-op unless the item is ACTUALLY in-flight (current
 * focus of the attention loop). After stop/resend or a restart the DB row can
 * stay `processing` while the agent is idle → the button rendered but did
 * nothing on click ("取消按钮无效").
 *
 * Rule: cancellable ⇔ agent running ∧ DB status processing ∧ the item IS the
 * attention loop's current focus (an in-flight stream actually exists).
 * This keeps the UI's promise aligned with core's execution semantics:
 *  - stale processing (idle + DB row stuck on processing) → NO button
 *  - queued / completed / dropped → NO button
 *  - the in-flight item → button (core will accept the targeted cancel).
 *
 * Pure synchronization of an existing invariant — no behavior change for the
 * actually-cancellable case, only removal of the always-dead button.
 */
export function canCancelMailboxItem(opts: {
  agentRunning: boolean;
  itemId: string;
  /** mailboxItemId of the attention loop's current focus (undefined/null = idle). */
  currentFocusId: string | null | undefined;
  itemStatus: string;
}): boolean {
  if (!opts.agentRunning) return false;
  if (opts.itemStatus !== 'processing') return false;
  if (!opts.currentFocusId) return false;
  return opts.currentFocusId === opts.itemId;
}