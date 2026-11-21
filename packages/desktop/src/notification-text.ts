/**
 * The **words** of a desktop OS notification, in the reader's language.
 *
 * Why this is a separate, electron-free module: the OS-notification bridge
 * (`notifications.ts`) used to bake English literals ('Task Completed', 'Review
 * Required') and, for a structured `notification` event, copy the producer's raw
 * `title`/`body` — the English fallback — straight to macOS Notification Center,
 * ignoring the `metadata.i18n` the in-app bell and the Feishu dispatcher both
 * render from. One fact (a task went to review) read 任务待审核 in the product and
 * "Task ready for review" in the OS. This module routes the desktop through the
 * SAME notification vocabulary (one writer), so every surface says the same
 * sentence in the same language.
 *
 * Pure by design: no electron import, so the localization is behavior-tested
 * directly (`notification-text.test.ts`) without mocking the native module.
 */
import {
  notificationLabel,
  readNotificationI18n,
  resolveNotificationEnumParams,
} from '@markus/shared';

/** The vocabulary key for a user-facing task status change. */
const TASK_STATUS_TITLE_KEY: Record<string, string> = {
  completed: 'notifications.titles.taskCompleted',
  failed: 'notifications.titles.taskFailed',
  review: 'notifications.titles.taskReadyForReview',
};

/**
 * OS-notification text for a `task:update` WS event. Returns null for a status
 * that is not user-facing (the bridge then shows nothing) or a title-less event
 * (an internal signal, not a notification). The title is the full localized
 * sentence — it already names the task — so the body is empty.
 */
export function taskUpdateOsText(
  status: string | undefined,
  title: string | undefined,
  locale?: string,
): { title: string; body: string } | null {
  if (!title) return null;
  const key = status ? TASK_STATUS_TITLE_KEY[status] : undefined;
  if (!key) return null;
  return { title: notificationLabel(key, locale, { title }) ?? title, body: '' };
}

/**
 * OS-notification text for a structured `notification` WS event, localized from
 * its `metadata.i18n` (the same path the in-app bell uses). Legacy records with no
 * metadata fall back to the raw title/body — never invent a sentence.
 */
export function notificationOsText(
  n: { title?: unknown; body?: unknown; metadata?: unknown } | undefined,
  locale?: string,
): { title: string; body: string } {
  const meta = (n?.metadata ?? {}) as Record<string, unknown>;
  const i18n = readNotificationI18n(meta);
  const rawTitle = typeof n?.title === 'string' ? n.title : 'Markus';
  const rawBody = typeof n?.body === 'string' ? n.body : '';
  const title =
    notificationLabel(i18n?.titleKey, locale, resolveNotificationEnumParams(i18n?.titleParams, locale)) ?? rawTitle;
  const body =
    notificationLabel(i18n?.bodyKey, locale, resolveNotificationEnumParams(i18n?.bodyParams, locale)) ?? rawBody;
  return { title, body };
}