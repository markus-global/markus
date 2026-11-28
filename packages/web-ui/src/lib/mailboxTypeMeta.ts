/**
 * Browser-side mirror of the mailbox type structure (`icon`, `category`).
 *
 * Why this file exists at all: the web bundle cannot import `@markus/shared`
 * (same constraint documented in `lib/modelCapabilities.ts` and
 * `constants/providers.ts`), so a runtime import of `MAILBOX_TYPE_REGISTRY` is
 * not available here. The previous answer to that constraint was a hand-written
 * map inside `pages/AgentProfile.tsx` plus a comment asking people to keep it in
 * sync — and it had already drifted: `workflow_update` and `callback_result`
 * were missing entirely, so two mailbox types rendered with no icon and fell
 * out of every category filter.
 *
 * The replacement rule: **the registry is still the only writer.** This file is
 * a projection of it, and `packages/shared/test/mailbox-type-mirror.test.ts`
 * fails the build when the two disagree. Hand-editing this file cannot silently
 * change behaviour — it only makes the test red.
 *
 * Scope is deliberately narrow:
 * - `icon` and `category` are structural facts → mirrored here.
 * - Display *labels* are NOT mirrored: the UI renders translated strings keyed by
 *   type, and copying English labels here would fight the i18n layer.
 *
 * To regenerate: run `node scripts/sync-mailbox-type-meta.mjs` (see repo scripts),
 * or edit both sides and let the drift test confirm they match.
 */

import type { IconName } from '../components/Icon.tsx';
export type MailboxTypeCategory = 'interaction' | 'task' | 'notification' | 'system';

export interface MailboxTypeStructure {
  icon: IconName;
  category: MailboxTypeCategory;
}

export const MAILBOX_TYPE_STRUCTURE: Readonly<Record<string, MailboxTypeStructure>> = {
  system_event:         { icon: 'gear', category: 'system' },
  human_chat:           { icon: 'message', category: 'interaction' },
  task_comment:         { icon: 'message', category: 'task' },
  mention:              { icon: 'mention', category: 'interaction' },
  session_reply:        { icon: 'reply', category: 'task' },
  task_status_update:   { icon: 'clipboard', category: 'task' },
  a2a_message:          { icon: 'link', category: 'interaction' },
  review_request:       { icon: 'eye', category: 'task' },
  requirement_comment:  { icon: 'message', category: 'task' },
  requirement_update:   { icon: 'pencil-line', category: 'notification' },
  daily_report:         { icon: 'bar-chart', category: 'system' },
  heartbeat:            { icon: 'heart', category: 'system' },
  memory_consolidation: { icon: 'brain', category: 'system' },
  workflow_update:      { icon: 'refresh', category: 'task' },
  callback_result:      { icon: 'reply', category: 'system' },
  external_signal:      { icon: 'signal', category: 'notification' },
};

/** Icon for a mailbox type; unknown types get a neutral dot instead of nothing. */
export function mailboxTypeIcon(sourceType: string | undefined): IconName {
  if (!sourceType) return 'dot';
  return MAILBOX_TYPE_STRUCTURE[sourceType]?.icon ?? 'dot';
}

/** Category buckets derived from the mirror — the filter bar reads this. */
export const MAILBOX_CATEGORY_TYPES: Readonly<Record<MailboxTypeCategory, readonly string[]>> =
  (['interaction', 'task', 'notification', 'system'] as const).reduce((acc, category) => {
    acc[category] = Object.entries(MAILBOX_TYPE_STRUCTURE)
      .filter(([, meta]) => meta.category === category)
      .map(([type]) => type);
    return acc;
  }, {} as Record<MailboxTypeCategory, readonly string[]>);
