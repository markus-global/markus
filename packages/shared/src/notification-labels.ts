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

  // ── Approval requests ──────────────────────────────────────────────────────
  // The sentence a chat app shows on the approval card. These were authored as
  // English literals at the gates that open an approval, so the in-app card read
  // Chinese (the UI rebuilds the sentence from `details.subType`) while the very
  // same approval read English in Feishu.
  //
  // `{{tail}}` carries **content that must never be translated** — the review
  // gate appends the task description and its deliverables after the sentence.
  'notifications.approvalDesc.requirementProposed': {
    en: 'Agent "{{agentName}}" proposed requirement "{{title}}" (priority: {{priority}}).',
    zh: '智能体「{{agentName}}」提出了需求「{{title}}」（优先级：{{priority}}）。',
    es: 'El agente "{{agentName}}" propuso el requisito "{{title}}" (prioridad: {{priority}}).',
  },
  'notifications.approvalDesc.requirementResubmitted': {
    en: 'Agent "{{agentName}}" resubmitted requirement "{{title}}" (priority: {{priority}}).',
    zh: '智能体「{{agentName}}」重新提交了需求「{{title}}」（优先级：{{priority}}）。',
    es: 'El agente "{{agentName}}" reenvió el requisito "{{title}}" (prioridad: {{priority}}).',
  },
  'notifications.approvalDesc.taskCreate': {
    en: 'Agent "{{agentName}}" wants to create task "{{title}}" (priority: {{priority}}).',
    zh: '智能体「{{agentName}}」想创建任务「{{title}}」（优先级：{{priority}}）。',
    es: 'El agente "{{agentName}}" quiere crear la tarea "{{title}}" (prioridad: {{priority}}).',
  },
  'notifications.approvalDesc.taskReview': {
    en: 'Task "{{title}}" has been submitted for your review.{{tail}}',
    zh: '任务「{{title}}」已提交审核。{{tail}}',
    es: 'La tarea "{{title}}" fue enviada para tu revisión.{{tail}}',
  },

  // ── Stale-task detector ────────────────────────────────────────────────────
  'notifications.titles.staleReview': {
    en: 'Stale review',
    zh: '审核停滞',
    es: 'Revisión estancada',
  },
  'notifications.titles.stuckTask': {
    en: 'Stuck task',
    zh: '任务卡住',
    es: 'Tarea atascada',
  },
  'notifications.titles.unstartedTask': {
    en: 'Unstarted task',
    zh: '任务未启动',
    es: 'Tarea sin iniciar',
  },
  'notifications.bodies.staleTaskInProgress': {
    en: 'Task "{{title}}" has been in_progress for {{hours}}h',
    zh: '任务「{{title}}」已进行 {{hours}} 小时',
    es: 'La tarea "{{title}}" lleva {{hours}} h en curso',
  },
  'notifications.bodies.staleTaskInReview': {
    en: 'Task "{{title}}" has been in review for {{hours}}h with no action',
    zh: '任务「{{title}}」已待审核 {{hours}} 小时且无动作',
    es: 'La tarea "{{title}}" lleva {{hours}} h en revisión sin acción',
  },
  'notifications.bodies.staleTaskUnstarted': {
    en: 'Task "{{title}}" awaiting approval for {{hours}}h',
    zh: '任务「{{title}}」已等待审批 {{hours}} 小时',
    es: 'La tarea "{{title}}" lleva {{hours}} h esperando aprobación',
  },

  // ── Escalation and the activity feed ───────────────────────────────────────
  'notifications.titles.agentNeedsHelp': {
    en: 'Agent needs help',
    zh: '智能体需要帮助',
    es: 'El agente necesita ayuda',
  },
  'notifications.titles.taskComment': {
    en: 'Comment on task {{title}}',
    zh: '任务「{{title}}」有新评论',
    es: 'Comentario en la tarea {{title}}',
  },

  // ── Enum parameters ────────────────────────────────────────────────────────
  // A value *inside* a sentence can be an enum the reader also needs translated
  // (`（优先级：normal）`). Kept in the same table so the renderer that owns the
  // language can resolve it; see `priorityLabel`.
  'common.priority.low': { en: 'Low', zh: '低', es: 'Baja' },
  'common.priority.normal': { en: 'Normal', zh: '普通', es: 'Normal' },
  'common.priority.high': { en: 'High', zh: '高', es: 'Alta' },
  'common.priority.urgent': { en: 'Urgent', zh: '紧急', es: 'Urgente' },

  // Status words, same reason: `状态已变为 completed` is still English inside a
  // Chinese sentence. Kept verbatim from the UI's `common.status` table.
  'common.status.pending': { en: 'Pending', zh: '待处理', es: 'Pendiente' },
  'common.status.approved': { en: 'Approved', zh: '已批准', es: 'Aprobado' },
  'common.status.inProgress': { en: 'In Progress', zh: '进行中', es: 'En curso' },
  'common.status.completed': { en: 'Completed', zh: '已完成', es: 'Completado' },
  'common.status.failed': { en: 'Failed', zh: '失败', es: 'Fallido' },
  'common.status.blocked': { en: 'Blocked', zh: '已阻塞', es: 'Bloqueado' },
  'common.status.review': { en: 'Review', zh: '待审核', es: 'Revisión' },
  'common.status.rejected': { en: 'Rejected', zh: '已拒绝', es: 'Rechazado' },
  'common.status.cancelled': { en: 'Cancelled', zh: '已取消', es: 'Cancelado' },
  'common.status.active': { en: 'Active', zh: '活跃', es: 'Activo' },
  'common.status.idle': { en: 'Idle', zh: '空闲', es: 'Inactivo' },
  'common.status.working': { en: 'Working', zh: '工作中', es: 'Trabajo' },
  'common.status.offline': { en: 'Offline', zh: '离线', es: 'Sin conexión' },
  'common.status.paused': { en: 'Paused', zh: '已暂停', es: 'En pausa' },
  'common.status.error': { en: 'Error', zh: '错误', es: 'Error' },
  'common.status.online': { en: 'Online', zh: '在线', es: 'En línea' },
  'common.status.verified': { en: 'Verified', zh: '已验证', es: 'Verificado' },
  'common.status.outdated': { en: 'Outdated', zh: '已过期', es: 'Desactualizado' },
  'common.status.expired': { en: 'Expired', zh: '已过期', es: 'Gastos' },
};

/** The task priority words, for a param embedded in a sentence. */
export function priorityLabel(value: string | undefined, locale?: string): string | undefined {
  return value ? notificationLabel(`common.priority.${value}`, locale) : undefined;
}

/**
 * The status word, for a param embedded in a sentence.
 *
 * Tries the value as written, then its camelCase form: task statuses are
 * `in_progress` while the string table is keyed `inProgress`, and a plain lookup
 * silently misses — leaving `状态已变为 in_progress` in a Chinese sentence.
 */
export function statusLabel(value: string | undefined, locale?: string): string | undefined {
  if (!value) return undefined;
  const camel = value.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return notificationLabel(`common.status.${value}`, locale)
    ?? (camel !== value ? notificationLabel(`common.status.${camel}`, locale) : undefined);
}

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
export function notificationResources(locale?: string): Record<string, Record<string, string>> {
  const lang = normalizeLanguage(locale);
  const out: Record<string, Record<string, string>> = {};
  for (const [key, entry] of Object.entries(VOCABULARY)) {
    if (!key.startsWith('notifications.')) continue;
    const rest = key.slice('notifications.'.length);
    const dot = rest.indexOf('.');
    if (dot === -1) continue;
    const text = entry[lang] ?? entry['en'];
    if (text === undefined) continue;
    ((out[rest.slice(0, dot)] ??= {})[rest.slice(dot + 1)] = text);
  }
  return out;
}
