/**
 * Inbox derivation — **the one place that answers "what does a human have to do
 * right now, and where do they do it"** (C9-D).
 *
 * ── Why this lives behind a pure function ────────────────────────────────
 * The same question used to be answered in the page body: `approvals`, unread
 * notifications, the task/requirement FSM and the board were each turned into
 * rows where they were rendered, with page-local dedupe. Then a second, third and
 * fourth client (mobile shell, bell history, CLI) needed the same list and each
 * got its own answer — four writers, one fact. This function is that fact.
 *
 * It stores nothing. A persisted inbox would be a second copy of the four sources
 * and would start drifting from them on the first write. Membership, dedupe,
 * precedence and the destination of every row are decided here and nowhere else.
 *
 * ── Contract (see docs/architecture/inbox-derivation.md) ─────────────────
 * 1. Identity is `subjectKind:subjectId:needKind`. Three sources pointing at the
 *    same subject and need produce ONE row carrying all three in `sources[]`.
 * 2. Rows are then folded per subject (`foldBySubject`): a list is scanned by
 *    object, not by verb, and the absorbed needs stay visible in `mergedNeeds`.
 * 3. Every row carries `action` (the concrete route that resolves it) and
 *    `blocking` (whether a named other party is waiting). **A row with no
 *    destination is dropped** and reported in `dropped[]` — an unactionable red
 *    light is worse than no light.
 * 4. Pure: no IO, no clock, no randomness. Time enters as data only.
 */

// ─── closed sets ─────────────────────────────────────────────────────────────

/**
 * What a to-do row can be about. `notification` means "the message itself is the
 * object" — two different messages never collapse into one row, because a row
 * that stands for three unrelated messages is a row the reader cannot act on.
 */
export const INBOX_SUBJECT_KINDS = ['task', 'requirement', 'approval', 'notification'] as const;
export type InboxSubjectKind = (typeof INBOX_SUBJECT_KINDS)[number];

/**
 * What the human must do — in **precedence order** (first = strongest). A row is
 * displayed as its strongest need; the others are folded into `mergedNeeds`.
 */
export const INBOX_NEED_KINDS = [
  'answer',
  'approve',
  'unblock',
  'resolve_failure',
  'review',
  'read',
] as const;
export type InboxNeedKind = (typeof INBOX_NEED_KINDS)[number];

/**
 * Does a *named other party* wait on this need?
 *
 * This is a property of the need, never a per-row heuristic: a question blocks the
 * agent's whole turn, an approval blocks the requested action, a human review
 * blocks completion, a declared `hold` blocks the task. A failure or a message
 * blocks nobody in particular. `foldBySubject` ORs the flag, so folding can only
 * reveal blocking, never hide it.
 */
export const NEED_BLOCKING: Readonly<Record<InboxNeedKind, boolean>> = {
  answer: true,
  approve: true,
  unblock: true,
  resolve_failure: false,
  review: true,
  read: false,
};

/**
 * List order among rows that have been waiting equally long and carry the same
 * priority. Carried over from the shipped queue (`attentionQueue.KIND_ORDER`) so
 * this refactor does not silently reorder a list the Owner already reads; a
 * requirement approval keeps its own slot (4) because it is a different decision
 * from an agent-blocking task approval.
 */
const NEED_ORDER: Readonly<Record<InboxNeedKind, number>> = {
  answer: 0,
  approve: 1,
  unblock: 2,
  resolve_failure: 3,
  review: 5,
  read: 6,
};
const REQUIREMENT_APPROVAL_ORDER = 4;

export type InboxWaitingBasis = 'requested' | 'created' | 'status' | 'approximate';

export interface InboxAction {
  page: 'WORK' | 'TEAM';
  params: Record<string, string>;
}

/** Which of the four sources contributed a row — the "why is this here" answer. */
export type InboxSourceKind = 'approval' | 'notification' | 'fsm' | 'stage';

export interface InboxSourceRef {
  kind: InboxSourceKind;
  /** Stable id inside that source (approval id / notification id / subject id). */
  ref: string;
}

export interface InboxItem {
  /** `${subjectKind}:${subjectId}:${needKind}` — the identity this row was derived from. */
  key: string;
  subjectKind: InboxSubjectKind;
  subjectId: string;
  needKind: InboxNeedKind;
  /** Needs that were folded into this row (strongest first). Never silently dropped. */
  mergedNeeds: readonly InboxNeedKind[];
  title: string;
  priority: string;
  waitingSince: string;
  waitingBasis: InboxWaitingBasis;
  /** Concrete destination. Present on every returned row: no action ⇒ dropped. */
  action: InboxAction;
  blocking: boolean;
  sources: readonly InboxSourceRef[];
  /** The source that makes this row what it is; the UI turns it into a stable key. */
  anchor: InboxSourceRef;
  /** Unread notification ids folded in, in input order (one click marks them read). */
  noticeIds: readonly string[];
  isNew: boolean;
  meta?: string;
}

export interface InboxDropped {
  source: InboxSourceKind;
  ref: string;
  reason: 'no_action';
}

export interface InboxResult {
  items: InboxItem[];
  /** Withheld rows, so "nothing to do" can be audited instead of merely believed. */
  dropped: InboxDropped[];
}

// ─── input rows (structural: the caller passes what the API already gave it) ──

export interface InboxApprovalRow {
  id: string;
  title: string;
  status: string;
  requestedAt?: string;
  agentId?: string;
  agentName?: string;
  /** Non-empty ⇒ this is a blocking *question*, not a signature request. */
  questions?: readonly unknown[];
  details?: { taskId?: string; requirementId?: string; sessionId?: string } & Record<string, unknown>;
}

export interface InboxNotificationRow {
  id: string;
  title: string;
  type?: string;
  priority?: string;
  read: boolean;
  createdAt: string;
  actionType?: string;
  actionTarget?: string;
  metadata?: Record<string, unknown>;
}

export interface InboxTaskRow {
  id: string;
  title: string;
  status: string;
  priority?: string;
  reviewerType?: string;
  blockedReason?: 'deps' | 'hold' | 'workflow' | null;
  blockedBy?: string[];
  statusChangedAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface InboxRequirementRow {
  id: string;
  title: string;
  status: string;
  priority?: string;
  createdAt?: string;
}

export interface InboxStageRow {
  subjectKind: 'task' | 'requirement';
  subjectId: string;
  stage: string;
}

export interface InboxSnapshot {
  approvals: readonly InboxApprovalRow[];
  notifications: readonly InboxNotificationRow[];
  tasks: readonly InboxTaskRow[];
  requirements: readonly InboxRequirementRow[];
  /** Facts-derived stages (C9-C). Corroborate a row; they never invent a need. */
  stages?: readonly InboxStageRow[];
}

/**
 * The two things this module must not re-implement.
 *
 * Both are **required**, not optional: an omitted `resolveNotificationTarget`
 * would silently make every message undeliverable (and every row vanish), and an
 * omitted `resolveBlockedReason` would silently turn dependency waits into human
 * work. Silent defaults on an injection port are how "no port" becomes a value.
 */
export interface InboxPorts {
  /** Existing single discriminator: `web-ui/lib/notifyNavigate.notificationTarget`. */
  resolveNotificationTarget: (n: InboxNotificationRow) => InboxAction | null;
  /** Existing single discriminator: `web-ui/lib/blockedReason.blockedReasonOf`. */
  resolveBlockedReason: (t: InboxTaskRow) => string;
  /** Optional i18n renderer for notification titles (shared stays locale-free). */
  renderNotificationTitle?: (n: InboxNotificationRow) => string;
}

export interface InboxOptions {
  /** Everything that entered "waiting" after this instant is marked new. */
  lastSeenAt?: string | null;
  /** Unread messages are part of the inbox by default (Owner 2026-11-08). */
  includeUnread?: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** The only place the identity string is built. */
export function dedupeKey(
  subjectKind: InboxSubjectKind,
  subjectId: string,
  needKind: InboxNeedKind,
): string {
  return `${subjectKind}:${subjectId}:${needKind}`;
}

/** Fallback timestamp when a row carries no usable time. A constant, never a clock. */
const NO_TIME = '1970-01-01T00:00:00.000Z';

const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3 };

function priorityRank(p: string | undefined): number {
  return PRIORITY_RANK[(p ?? '').toLowerCase()] ?? 4;
}

function iso(value: string | undefined | null): string {
  return value && value.length > 0 ? value : NO_TIME;
}

function needsRank(need: InboxNeedKind, subjectKind: InboxSubjectKind): number {
  if (need === 'approve' && subjectKind === 'requirement') return REQUIREMENT_APPROVAL_ORDER;
  return NEED_ORDER[need];
}

function isAgentQuestion(a: InboxApprovalRow): boolean {
  return Array.isArray(a.questions) && a.questions.length > 0;
}

/** A candidate before folding: one source's contribution. */
interface Candidate {
  subjectKind: InboxSubjectKind;
  subjectId: string;
  need: InboxNeedKind;
  title: string;
  priority: string;
  waitingSince: string;
  waitingBasis: InboxWaitingBasis;
  action: InboxAction;
  source: InboxSourceRef;
  noticeId?: string;
  meta?: string;
  /** Messages are "new" by the server's read flag, not by a local timestamp. */
  alwaysNew?: boolean;
}

/**
 * A notification's need is always `read` — never the state it talks about.
 *
 * This started out mapping `type = 'task_review'` → need `review`, which looked
 * tidy and was **wrong**. The very first dual run over the live DB (2026-11-15,
 * `docs/records/cut9-inbox-dual-run-diff-2026-11-15.md`) showed three `task_review`
 * notifications whose tasks were already `completed`: the payload said "review
 * me" while the FSM said "done". Deriving a need out of a notification is the
 * same defect as deriving "the agent is busy" out of "a message exists" (C8-E).
 *
 * So: the notification only ever contributes *unreadness* and its destination.
 * The state comes from the row that owns it (the FSM / approval loop below), and
 * because rows fold by subject the unreadness still lands on that row.
 */
function noticeNeed(): InboxNeedKind {
  return 'read';
}

/** Subject of a notification: an entity when it names one, else the message itself. */
function noticeSubject(n: InboxNotificationRow, action: InboxAction): { kind: InboxSubjectKind; id: string } {
  const task = action.params['openTask'];
  if (task) return { kind: 'task', id: task };
  const req = action.params['openRequirement'];
  if (req) return { kind: 'requirement', id: req };
  return { kind: 'notification', id: n.id };
}

// ─── the derivation ──────────────────────────────────────────────────────────

export function deriveInbox(
  snapshot: InboxSnapshot,
  ports: InboxPorts,
  options: InboxOptions = {},
): InboxResult {
  const { lastSeenAt = null, includeUnread = true } = options;
  const candidates: Candidate[] = [];
  const dropped: InboxDropped[] = [];

  const titleOfTask = (id: string) => snapshot.tasks.find(t => t.id === id)?.title ?? id;
  const titleOfRequirement = (id: string) => snapshot.requirements.find(r => r.id === id)?.title ?? id;

  // ① pending approvals — a human decision the platform is blocked on
  for (const a of snapshot.approvals) {
    if (a.status !== 'pending') continue;
    const details = a.details ?? {};
    const params: Record<string, string> = {};
    let page: InboxAction['page'] = 'TEAM';
    let subjectKind: InboxSubjectKind = 'approval';
    let subjectId = a.id;
    if (details.taskId) {
      page = 'WORK';
      params['openTask'] = details.taskId;
      subjectKind = 'task';
      subjectId = details.taskId;
    } else if (details.requirementId) {
      page = 'WORK';
      params['openRequirement'] = details.requirementId;
      subjectKind = 'requirement';
      subjectId = details.requirementId;
    }
    if (a.agentId) params['agentId'] = a.agentId;
    // No entity → the agent's main session, where the answer modal lives.
    if (page === 'TEAM') params['preferMain'] = '1';

    const action: InboxAction | null = page === 'WORK' ? { page, params } : a.agentId ? { page, params } : null;
    if (!action) {
      dropped.push({ source: 'approval', ref: a.id, reason: 'no_action' });
      continue;
    }

    candidates.push({
      subjectKind,
      subjectId,
      need: isAgentQuestion(a) ? 'answer' : 'approve',
      title: a.title,
      priority: 'none',
      waitingSince: iso(a.requestedAt),
      waitingBasis: 'requested',
      action,
      source: { kind: 'approval', ref: a.id },
      ...(a.agentName ? { meta: a.agentName } : {}),
    });
  }

  // ② pending requirements — a governance gate nobody can bypass
  for (const r of snapshot.requirements) {
    if (r.status !== 'pending') continue;
    candidates.push({
      subjectKind: 'requirement',
      subjectId: r.id,
      need: 'approve',
      title: r.title,
      priority: r.priority ?? 'none',
      waitingSince: iso(r.createdAt),
      waitingBasis: 'created',
      action: { page: 'WORK', params: { openRequirement: r.id } },
      source: { kind: 'fsm', ref: r.id },
    });
  }

  // ③ the task FSM — review / hold / failed
  for (const t of snapshot.tasks) {
    let need: InboxNeedKind | null = null;
    let basis: InboxWaitingBasis = 'approximate';
    let since = iso(t.statusChangedAt ?? t.updatedAt ?? t.createdAt);
    if (t.status === 'review' && t.reviewerType === 'human') {
      need = 'review';
      basis = t.statusChangedAt ? 'status' : 'approximate';
    } else if (t.status === 'blocked' && ports.resolveBlockedReason(t) === 'hold') {
      need = 'unblock';
      basis = t.statusChangedAt ? 'status' : 'approximate';
    } else if (t.status === 'failed') {
      need = 'resolve_failure';
      basis = t.statusChangedAt ? 'status' : 'approximate';
    }
    if (!need) continue;
    since = iso(t.statusChangedAt ?? t.updatedAt ?? t.createdAt);
    candidates.push({
      subjectKind: 'task',
      subjectId: t.id,
      need,
      title: t.title,
      priority: t.priority ?? 'none',
      waitingSince: since,
      waitingBasis: basis,
      action: { page: 'WORK', params: { openTask: t.id } },
      source: { kind: 'fsm', ref: t.id },
    });
  }

  // ④ facts-derived stages — corroboration, never a need of their own
  for (const s of snapshot.stages ?? []) {
    let need: InboxNeedKind | null = null;
    if (s.stage === 'waiting_human') need = 'answer';
    else if (s.stage === 'failed') need = 'resolve_failure';
    if (!need) continue;
    const action: InboxAction =
      s.subjectKind === 'task'
        ? { page: 'WORK', params: { openTask: s.subjectId } }
        : { page: 'WORK', params: { openRequirement: s.subjectId } };
    candidates.push({
      subjectKind: s.subjectKind,
      subjectId: s.subjectId,
      need,
      title: s.subjectKind === 'task' ? titleOfTask(s.subjectId) : titleOfRequirement(s.subjectId),
      priority: 'none',
      waitingSince: NO_TIME,
      waitingBasis: 'approximate',
      action,
      source: { kind: 'stage', ref: s.subjectId },
    });
  }

  // ⑤ unread messages — the duplicate of ①/③ half the time, and their own object the rest
  if (includeUnread) {
    for (const n of snapshot.notifications) {
      if (n.read) continue;
      const action = ports.resolveNotificationTarget(n);
      if (!action) {
        dropped.push({ source: 'notification', ref: n.id, reason: 'no_action' });
        continue;
      }
      const subject = noticeSubject(n, action);
      candidates.push({
        subjectKind: subject.kind,
        subjectId: subject.id,
        need: noticeNeed(),
        title: ports.renderNotificationTitle ? ports.renderNotificationTitle(n) : n.title,
        priority: n.priority ?? 'none',
        waitingSince: iso(n.createdAt),
        waitingBasis: 'created',
        action,
        source: { kind: 'notification', ref: n.id },
        noticeId: n.id,
        alwaysNew: true,
      });
    }
  }

  // ⑥ identity: one row per (subject, need)
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = dedupeKey(c.subjectKind, c.subjectId, c.need);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(c);
    else byKey.set(key, [c]);
  }

  // ⑦ fold per subject: the object is the unit a human scans by
  const bySubject = new Map<string, { subjectKind: InboxSubjectKind; subjectId: string; members: Candidate[] }>();
  for (const bucket of byKey.values()) {
    const head = bucket[0]!;
    const subjectKey = `${head.subjectKind}:${head.subjectId}`;
    const group = bySubject.get(subjectKey);
    if (group) group.members.push(...bucket);
    else bySubject.set(subjectKey, { subjectKind: head.subjectKind, subjectId: head.subjectId, members: [...bucket] });
  }

  const items: InboxItem[] = [];
  for (const group of bySubject.values()) {
    // Strongest need wins; among equal strength the earliest source wins, which
    // keeps the anchor (and therefore the React key) stable across renders.
    const ordered = [...group.members].sort(
      (a, b) => needsRank(a.need, a.subjectKind) - needsRank(b.need, b.subjectKind),
    );
    const dominant = ordered[0]!;
    const sources: InboxSourceRef[] = [];
    const noticeIds: string[] = [];
    const mergedNeeds: InboxNeedKind[] = [];
    let waitingSince = dominant.waitingSince;
    let blocking = false;
    let meta = dominant.meta;
    for (const m of ordered) {
      if (!sources.some(s => s.kind === m.source.kind && s.ref === m.source.ref)) sources.push(m.source);
      if (m.noticeId && !noticeIds.includes(m.noticeId)) noticeIds.push(m.noticeId);
      if (m.need !== dominant.need && !mergedNeeds.includes(m.need)) mergedNeeds.push(m.need);
      if (m.waitingSince < waitingSince) waitingSince = m.waitingSince;
      if (NEED_BLOCKING[m.need]) blocking = true;
      if (!meta && m.meta) meta = m.meta;
    }

    items.push({
      key: dedupeKey(dominant.subjectKind, dominant.subjectId, dominant.need),
      subjectKind: dominant.subjectKind,
      subjectId: dominant.subjectId,
      needKind: dominant.need,
      mergedNeeds: mergedNeeds.sort((a, b) => needsRank(a, dominant.subjectKind) - needsRank(b, dominant.subjectKind)),
      title: dominant.title,
      priority: dominant.priority,
      waitingSince,
      waitingBasis: waitingSince === dominant.waitingSince ? dominant.waitingBasis : 'approximate',
      action: dominant.action,
      blocking,
      sources,
      anchor: dominant.source,
      noticeIds,
      // Messages are new by the server's read flag; everything else by lastSeenAt.
      isNew: dominant.alwaysNew === true
        ? true
        : lastSeenAt !== null && dominant.waitingSince > lastSeenAt,
      ...(meta ? { meta } : {}),
    });
  }

  // ⑧ total order over data: longest wait → priority → need → key
  items.sort((a, b) => {
    if (a.waitingSince !== b.waitingSince) return a.waitingSince < b.waitingSince ? -1 : 1;
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const nr = needsRank(a.needKind, a.subjectKind) - needsRank(b.needKind, b.subjectKind);
    if (nr !== 0) return nr;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return { items, dropped };
}
