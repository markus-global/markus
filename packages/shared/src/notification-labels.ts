/**
 * The **notification vocabulary** — the words a notification is made of, and the
 * one place they are written.
 *
 * Why this exists (2026-10-16): the same notification reached two renderers and
 * only one of them could translate it.
 *   · the in-app bell read the producer's structured `metadata.i18n`
 *     (`titleKey` + params) and rendered `任务已完成：…`;
 *   · the outbound dispatcher ignored that metadata and sent the raw `title`
 *     field — the English string the producer had to bake in as a fallback — to
 *     Feishu. So one decision read `Task completed: …` in the chat app and
 *     `任务已完成：…` in the product.
 *
 * Neither surface owned the wording: the producer wrote English, the bell read a
 * locale file, the dispatcher copied whatever it was handed. This module gives the
 * vocabulary **one writer**, so every surface renders the same sentence in the
 * same language — and a new locale is one entry here, not an edit in every gate.
 *
 * Consumers:
 *   · `comms/gateway/dispatcher` — localizes a notification on its way to a chat
 *     app, from the same `metadata.i18n` the bell uses;
 *   · `web-ui` i18n bootstrap — merges {@link notificationResources} into the
 *     `team` namespace, so `t('team:notifications.titles.…')` keeps working with
 *     the keys deleted from the locale JSON files (no second copy to drift).
 */
import { normalizeLanguage } from './locale.js';

/** The structured i18n metadata a producer attaches to a notification. */
export interface NotificationI18n {
  titleKey?: string;
  titleParams?: Record<string, unknown>;
  bodyKey?: string;
  bodyParams?: Record<string, unknown>;
}

/**
 * Read the structured i18n metadata off a notification's `metadata`, if present.
 * Tolerant by design: older records carry none, and a malformed one must never
 * break rendering (callers fall back to the raw text).
 */
export function readNotificationI18n(metadata?: Record<string, unknown>): NotificationI18n | undefined {
  const raw = metadata?.['i18n'];
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const meta: NotificationI18n = {};
  if (typeof m['titleKey'] === 'string') meta.titleKey = m['titleKey'];
  if (typeof m['bodyKey'] === 'string') meta.bodyKey = m['bodyKey'];
  if (m['titleParams'] && typeof m['titleParams'] === 'object') {
    meta.titleParams = m['titleParams'] as Record<string, unknown>;
  }
  if (m['bodyParams'] && typeof m['bodyParams'] === 'object') {
    meta.bodyParams = m['bodyParams'] as Record<string, unknown>;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Every notification sentence, keyed by the **full dotted key** producers already
 * emit (`notifications.titles.taskCompleted`). Keyed by the whole path on purpose:
 * that string is the contract between producer and renderer, so the dictionary can
 * be read straight off `metadata.i18n.titleKey` with no second mapping.
 *
 * `{{param}}` placeholders match i18next's default syntax, so the web UI can use
 * these through `t()` unchanged.
 */
const VOCABULARY: Record<string, Record<string, string>> = {
  'notifications.titles.taskCreated': {
    en: 'Task created: {{title}}',
    zh: '任务已创建：{{title}}',
    es: 'Tarea creada: {{title}}',
  },
  'notifications.titles.taskReadyForReview': {
    en: 'Task ready for review: {{title}}',
    zh: '任务待审核：{{title}}',
    es: 'Tarea lista para revisión: {{title}}',
  },
  'notifications.titles.taskCompleted': {
    en: 'Task completed: {{title}}',
    zh: '任务已完成：{{title}}',
    es: 'Tarea completada: {{title}}',
  },
  'notifications.titles.taskFailed': {
    en: 'Task failed: {{title}}',
    zh: '任务失败：{{title}}',
    es: 'Tarea fallida: {{title}}',
  },
  'notifications.titles.requirementApproved': {
    en: 'Requirement approved: {{title}}',
    zh: '需求已批准：{{title}}',
    es: 'Requisito aprobado: {{title}}',
  },
  'notifications.titles.requirementRejected': {
    en: 'Requirement rejected: {{title}}',
    zh: '需求已拒绝：{{title}}',
    es: 'Requisito rechazado: {{title}}',
  },
  'notifications.titles.requirementChangesRequested': {
    en: 'Requirement changes requested: {{title}}',
    zh: '需求已打回：{{title}}',
    es: 'Cambios solicitados en el requisito: {{title}}',
  },
  'notifications.titles.mentionedYou': {
    en: '{{authorName}} mentioned you',
    zh: '{{authorName}} 提到了你',
    es: '{{authorName}} te mencionó',
  },
  'notifications.titles.groupMessage': {
    en: '{{senderName}} in {{groupName}}',
    zh: '{{senderName}} 在 {{groupName}} 中',
    es: '{{senderName}} en {{groupName}}',
  },
  'notifications.bodies.agentCreatedTask': {
    en: 'Agent created task "{{title}}"',
    zh: '智能体创建了任务「{{title}}」',
    es: 'El agente creó la tarea "{{title}}"',
  },
  'notifications.bodies.taskStatusChanged': {
    en: 'Task "{{title}}" status changed to {{status}}',
    zh: '任务「{{title}}」状态已变为 {{status}}',
    es: 'La tarea "{{title}}" cambió de estado a {{status}}',
  },
  'notifications.bodies.requirementApprovedBody': {
    en: 'Requirement "{{title}}" has been approved and is now in progress.',
    zh: '需求「{{title}}」已批准，正在进行中。',
    es: 'El requisito "{{title}}" fue aprobado y ahora está en curso.',
  },
  'notifications.bodies.requirementRejectedBody': {
    en: 'Requirement "{{title}}" has been rejected.{{reason}}',
    zh: '需求「{{title}}」已被拒绝。{{reason}}',
    es: 'El requisito "{{title}}" fue rechazado.{{reason}}',
  },
  'notifications.bodies.requirementChangesRequestedBody': {
    en: 'Requirement "{{title}}" needs changes before approval — it is still pending.{{reason}}',
    zh: '需求「{{title}}」需修改后再审批 —— 仍处于待审批状态。{{reason}}',
    es: 'El requisito "{{title}}" necesita cambios antes de la aprobación; sigue pendiente.{{reason}}',
  },
  'notifications.bodies.mentionPreview': {
    en: '{{itemTitle}}: {{preview}}',
    zh: '{{itemTitle}}：{{preview}}',
    es: '{{itemTitle}}: {{preview}}',
  },
};

/** Every key this module can write. Exposed so a test can prove coverage. */
export function notificationVocabularyKeys(): string[] {
  return Object.keys(VOCABULARY);
}

/**
 * Fill `{{name}}` placeholders. A placeholder with no value is left **as-is** (it
 * is visible in the output on purpose) — silently deleting it is how a sentence
 * ends up reading "Task completed: " with the subject missing.
 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * The localized sentence for a vocabulary key, or `undefined` when the key is not
 * ours. Callers keep the raw text in that case: an unknown key means the producer
 * wrote something this module does not own, and inventing a string for it would be
 * worse than passing it through.
 */
export function notificationLabel(
  key: string | undefined,
  locale?: string,
  params?: Record<string, unknown>,
): string | undefined {
  if (!key) return undefined;
  const entry = VOCABULARY[key];
  if (!entry) return undefined;
  const template = entry[normalizeLanguage(locale)] ?? entry['en'];
  return template === undefined ? undefined : interpolate(template, params);
}

/**
 * The vocabulary as a nested resource for the web UI's i18next bootstrap, shaped
 * to drop into the `team` namespace (`{ titles, bodies }`). The UI therefore reads
 * the *same* module the outbound path does — one writer, no locale file to drift.
 */
export function notificationResources(locale?: string): { titles: Record<string, string>; bodies: Record<string, string> } {
  const lang = normalizeLanguage(locale);
  const titles: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  for (const [key, entry] of Object.entries(VOCABULARY)) {
    const text = entry[lang] ?? entry['en'];
    if (text === undefined) continue;
    const short = key.replace(/^notifications\.(titles|bodies)\./, '');
    if (key.startsWith('notifications.titles.')) titles[short] = text;
    else bodies[short] = text;
  }
  return { titles, bodies };
}
