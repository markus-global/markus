import {
  createLogger,
  type UserInputQuestion,
  type UserInputAnswer,
  type ApprovalDirection,
  type NotificationI18n,
} from '@markus/shared';
import type { OrganizationService } from './org-service.js';

const log = createLogger('hitl');

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  /** 打回 — the decision is "changes requested", *not* a terminal rejection. */
  | 'changes_requested'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/**
 * The single decision vocabulary every gate consumes. Derived from the response
 * payload (boolean / option id) — never stored as memory-only state, so a process
 * restart cannot lose it.
 */
export type ApprovalIntent = 'approve' | 'request_changes' | 'reject' | 'needs_adjustment';

/**
 * Layer 1 of the two-layer normalization: the **global** intent closure. A token
 * that (after normalization) resolves here is a decision in its own right and
 * never falls back to the boolean.
 */
const GLOBAL_INTENT_TOKENS: Readonly<Record<string, ApprovalIntent>> = {
  approve: 'approve',
  approved: 'approve',
  request_changes: 'request_changes',
  requestchanges: 'request_changes',
  changes_requested: 'request_changes',
  revision: 'request_changes',
  needs_adjustment: 'needs_adjustment',
  needsadjustment: 'needs_adjustment',
  reject: 'reject',
  rejected: 'reject',
};

/**
 * Per-gate option-id aliases (still layer 1 — these are *known* tokens whose
 * meaning is gate-scoped). The review gate is the only gate that ships `options`,
 * and its option id is literally `reject` while its label is "Request Changes":
 * in the `task_review` domain that token means 打回 and must never be a terminal
 * rejection (the task FSM has no `review → rejected` edge).
 */
const GATE_OPTION_ALIASES: Readonly<Record<string, Readonly<Record<string, ApprovalIntent>>>> = {
  task_review: { reject: 'request_changes' },
};

function normalizeIntentToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Map a resolved intent onto the approval entity's own state machine. */
export function intentToApprovalStatus(intent: ApprovalIntent): ApprovalStatus {
  if (intent === 'approve') return 'approved';
  if (intent === 'reject') return 'rejected';
  return 'changes_requested';
}

export interface ResolvedApprovalIntent {
  intent: ApprovalIntent;
  /**
   * Set **only** when the token was outside the global closure (layer 2): the
   * decision then falls back to the boolean and the raw token is recorded for
   * diagnosis. Deliberately not "not among this gate's `options`" — a gate with
   * no `options` still carries closure tokens.
   */
  unknownOption?: string;
}

/**
 * The **only** intent parser in the platform.
 *
 * Layer 1: `selectedOption` (after normalization) against the global intent
 * closure plus the gate's option-id aliases. Layer 2: values outside that closure
 * fall back to the legacy boolean, keeping old callers byte-for-byte compatible.
 */
export function resolveApprovalIntent(input: {
  subType?: string;
  selectedOption?: string;
  approved: boolean;
}): ResolvedApprovalIntent {
  const raw = input.selectedOption?.trim();
  if (raw) {
    const token = normalizeIntentToken(raw);
    const gate = input.subType ? GATE_OPTION_ALIASES[input.subType] : undefined;
    const gateAlias = gate?.[token];
    if (gateAlias) return { intent: gateAlias };
    const intent = GLOBAL_INTENT_TOKENS[token];
    if (intent) return { intent };
    // Only a gate that *declares* option aliases can call an id “unknown”. An open
    // request (`custom` / no gate) carries option ids the **agent authored** — they
    // cannot be aliased by definition, so flagging them is a false alarm on every
    // such tap (2026-10-28: `unknownOption: tap_second` on a perfectly valid choice).
    return gate
      ? { intent: input.approved ? 'approve' : 'reject', unknownOption: raw }
      : { intent: input.approved ? 'approve' : 'reject' };
  }
  // Legacy payloads carry a boolean only — behaviour stays exactly as before.
  return { intent: input.approved ? 'approve' : 'reject' };
}

/**
 * The value a resolved approval hands to its gate. Extends the legacy boolean
 * payload additively (`intent` / `approvalId` / `unknownOption`), so existing
 * consumers keep working field-for-field.
 */
export interface ApprovalResponse {
  approval: ApprovalRequest;
  /** The single resolved decision — consumers route on this, never on the boolean. */
  decision: ResolvedApprovalIntent;
}

export interface ApprovalDecision {
  approved: boolean;
  intent: ApprovalIntent;
  approvalId: string;
  comment?: string;
  selectedOption?: string;
  answers?: UserInputAnswer[];
  respondedBy?: string;
  unknownOption?: string;
}
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationType =
  | 'approval_request'
  | 'task_created'
  | 'task_completed'
  | 'task_review'
  | 'task_failed'
  | 'requirement_created'
  | 'requirement_decision'
  | 'agent_report'
  | 'direct_message'
  | 'group_message'
  | 'system';

export type NotificationActionType = 'none' | 'navigate' | 'open_chat';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  type: 'action' | 'expense' | 'access' | 'deployment' | 'custom';
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  respondedAt?: string;
  respondedBy?: string;
  responseComment?: string;
  expiresAt?: string;
  options?: ApprovalOption[];
  allowFreeform?: boolean;
  selectedOption?: string;
  /**
   * Idempotency marker for "this decision has been applied to its target".   * Persisted on the approval entity (the only single writer) so the flag — and
   * therefore the guard — survives a restart.
   */
  appliedAt?: string;
  /** The intent that was applied, kept for audit/diagnosis (see {@link claimApply}). */
  appliedIntent?: ApprovalIntent;
  /** One or more structured questions (request_user_input). When present, the UI renders a multi-question form. */
  questions?: UserInputQuestion[];
  /** Aggregated answers to `questions`, filled on response. */
  answers?: UserInputAnswer[];
  /** When set, only these users (plus admins/owners) see and may respond to the approval in the API. */
  approverUserIds?: string[];
  /** The intended recipient; used for visibility filtering when approverUserIds is not set. */
  targetUserId?: string;
}


export interface Notification {
  id: string;
  targetUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  priority: NotificationPriority;
  read: boolean;
  actionType: NotificationActionType;
  actionTarget?: string;
  actionUrl?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRepo {
  insert(n: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): void;
  list(userId: string, opts?: { unreadOnly?: boolean; limit?: number; offset?: number; type?: string }): Array<{
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
  count(userId: string, unreadOnly?: boolean): number;
  markRead(id: string): boolean;
  markAllRead(userId: string): number;
  /** Mark read all unread approval_request rows for an approval, across every user_id. */
  markReadByApprovalId?(approvalId: string): number;
  /** One-time self-heal for unread rows whose approval is no longer pending. */
  reconcileResolvedApprovalNotifications?(): number;
}

/**
 * One choice offered on an approval.
 *
 * `direction` is the **structure** — what the choice *means* — and is what a
 * renderer localizes into the recipient's language. `label` is the author's own
 * wording and stays the fallback, so an LLM-authored option (or a legacy caller)
 * is passed through verbatim rather than reinterpreted.
 */
export interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  direction?: ApprovalDirection;
  /**
   * This choice cannot be recorded without a written reason. A surface that
   * cannot collect free text must not offer it (see
   * `OutboundAction.requiresComment`).
   */
  requiresComment?: boolean;
  /**
   * Tapping this choice is **not yet an answer** — the decision needs typed input
   * too (“give you the numbers” means nothing without the numbers). A surface that
   * cannot collect text must not offer it as a one-tap button, and a tap that
   * arrives without the text is refused rather than accepted as a decision
   * (see {@link assessResponseCompleteness}).
   */
  requiresFreeform?: boolean;
}

/**
 * How many approvals the service mirrors into memory at startup. Memory is the
 * live working set only; full history is paged from the repo (listApprovalsPage).
 */
export const APPROVALS_IN_MEMORY_CAP = 200;

/** One persisted approval row, as returned by {@link ApprovalRepo.list}. */
type ApprovalRepoRow = ReturnType<ApprovalRepo['list']>[number];

export interface ApprovalRepo {
  upsert(a: {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: ApprovalOption[];
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
    appliedAt?: string;
    appliedIntent?: string;
  }): void;
  /**
   * Time-ordered page of persisted approvals (newest first).
   *
   * `limit`/`offset` exist because history is READ from here: the in-memory map
   * only mirrors the newest APPROVALS_IN_MEMORY_CAP rows, so paging from memory
   * can never reach real history. Omitting `limit` means "no implicit cap" — the
   * old hardcoded `LIMIT 200` silently made 2300+ approvals unreachable.
   */
  list(opts?: { status?: string; limit?: number; offset?: number }): Array<{
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: ApprovalOption[];
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
    appliedAt?: string;
    appliedIntent?: string;
  }>;
  /** Total rows matching `status`, so a paged caller can report a real total. */
  count?(status?: string): number;
  get(id: string): {
    id: string;
    agentId: string;
    agentName: string;
    type: string;
    title: string;
    description: string;
    details: Record<string, unknown>;
    status: string;
    requestedAt: string;
    respondedAt?: string;
    respondedBy?: string;
    responseComment?: string;
    expiresAt?: string;
    options?: ApprovalOption[];
    allowFreeform?: boolean;
    selectedOption?: string;
    questions?: UserInputQuestion[];
    answers?: UserInputAnswer[];
    approverUserIds?: string[];
    targetUserId?: string;
    appliedAt?: string;
    appliedIntent?: string;
  } | undefined;
}

type NotificationHandler = (notification: Notification) => void;

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

/**
 * 把「卡片点击」归一成表单的答案形状 —— **同一份答案只能有一个口径**。
 *
 * 卡片（飞书/短信）只能带 `selectedOption` + `comment`，表单带 `answers[]`；
 * 完整性判定若只认 `answers[]`，则“可点击的问题”永远答不完 —— 实测 2026-10-28：
 * 飞书点对了选项，却被校验当成“没回答”，卡片还显示“已超时”。
 *
 * 只在真正能被一次点击答完时归一（单问题 / 单选 / 选项不是 `requiresFreeform`），
 * 否则返回 undefined：表单本就不可能被一次点击答完。
 */
export function answersFromTap(
  approval: { questions?: UserInputQuestion[]; options?: ApprovalOption[] },
  selectedOption?: string,
  comment?: string,
): UserInputAnswer[] | undefined {
  const questions = approval.questions ?? [];
  if (questions.length !== 1) return undefined;
  const question = questions[0]!;
  if (question.inputType !== 'choice' || question.allowMultiple === true) return undefined;
  if (!selectedOption) return undefined;
  // `approve` / `reject` 是渠道合成的方向，不属于该题的选项。
  const ids = (question.options ?? []).map((o) => o.id);
  if (!ids.includes(selectedOption)) return undefined;
  const text = (comment ?? '').trim();
  return [
    {
      questionId: question.id,
      selectedOptionIds: [selectedOption],
      ...(text ? { text } : {}),
    },
  ];
}

/** 一个回答缺少它要回答的那个事实时，哪里缺了。 */
export interface IncompleteResponse {
  incomplete: true;
  /** e.g. `option:give_numbers` / `question:q2:unanswered` —— 供 UI/API 写成可行动提示。 */
  missing: string[];
}

/**
 * 这个请求能否被**一次点击**完整回答？ —— 唯一判定点（纯函数）。
 *
 * 一个只能点、不能打字的面（短信、IM 卡片按钮）只有在“问题本身就是一个选择”时
 * 才是完整的回答通道：
 *   · 没有 questions/options（纯审批）→ 是（同意/拒绝就是问题）；
 *   · 恰好一个单选 choice，且每个选项都自带完整含义 → 是；
 *   · 多问题、多选、文本题、或任一选项 `requiresFreeform` → **不是**。
 *
 * 后一种情况不得把“同意/拒绝”当成按钮提供 —— 否则人类点一下就把一个表单“批准”了，
 * agent 收到的是一个没有内容的允许（2026-10-28 实测）。渲染器用它决定要不要发按钮，
 * CLI 用它决定要不要把问题的选项提到渠道层。
 */
export function isAnswerableByTap(
  questions?: UserInputQuestion[],
  options?: ApprovalOption[],
): boolean {
  if (!questions || questions.length === 0) {
    return !options || options.every((o) => o.requiresFreeform !== true);
  }
  if (questions.length > 1) return false;
  const q = questions[0]!;
  if (q.inputType !== 'choice') return false;
  if (q.allowMultiple === true) return false;
  return (q.options ?? []).every((o) => o.requiresFreeform !== true);
}

/**
 * 一个「回答」是否真的回答了问题 —— **单一判定点**（纯函数）。
 *
 * 两条规则，一起构成“完整性”：
 *   1. **每个问题都要被回答**（多问题表单里跳过一问，就不是一个回答）；
 *   2. **选了“选它还不是答案”的选项，必须同时给出文字**（`requiresFreeform`）。
 *
 * 2026-10-28 实测：选项写的是「直接给你数字」，老板在飞书点「同意」——那个渠道
 * 收不到文字；agent 收到一个没有数字的「批准」，只能自己按默认值执行。
 * 决策被渠道的表达能力偷偷改写了，而它以为那是老板的意思。
 */
export function assessResponseCompleteness(
  approval: { options?: ApprovalOption[]; questions?: UserInputQuestion[] },
  selectedOption?: string,
  comment?: string,
  answers?: UserInputAnswer[],
): IncompleteResponse | undefined {
  const commentText = (comment ?? '').trim();
  const missing: string[] = [];

  // 1) 顶层选项（单问题简写 / 审批按钮）
  const selected = selectedOption
    ? approval.options?.find((o) => o.id === selectedOption)
    : undefined;
  if (selected?.requiresFreeform && commentText.length === 0) {
    missing.push(`option:${selected.id}`);
  }

  // 2) 每个问题都必须被回答（不是“至少有一个回答”）
  const byQuestion = new Map((answers ?? []).map((a) => [a.questionId, a]));
  for (const question of approval.questions ?? []) {
    const answer = byQuestion.get(question.id);
    const picked = answer?.selectedOptionIds ?? [];
    // 文字属于**这一个**问题；别的问题的回答不能代它交差。
    const text = (answer?.text ?? '').trim();

    if (question.inputType === 'text') {
      if (text.length === 0) missing.push(`question:${question.id}:text`);
      continue;
    }

    if (picked.length === 0 && text.length === 0) {
      missing.push(`question:${question.id}:unanswered`);
      continue;
    }

    for (const id of picked) {
      const opt = question.options?.find((o) => o.id === id);
      if (opt?.requiresFreeform && text.length === 0) {
        missing.push(`question:${question.id}:option:${opt.id}:text`);
      }
    }
  }

  return missing.length > 0 ? { incomplete: true, missing } : undefined;
}

export class HITLService {
  private approvals = new Map<string, ApprovalRequest>();
  private pendingResolvers = new Map<
    string,
    (result: ApprovalDecision) => void
  >();
  /**
   * The router that drives a **recorded decision** to its gate.
   *
   * Set once by the composition root. Deliberately owned by this service rather
   * than by any inbound surface: recording a decision and applying it must not be
   * two independent obligations, because a surface that honours only the first
   * one fails **silently** — the 2026-10-16 Feishu card tap that recorded
   * "approved" while the task stayed `pending`, because the only thing that knew
   * how to apply it was an in-memory promise that had died with the last restart.
   * Routing at the single point where a decision is written makes that omission
   * unrepresentable for every surface, present and future.
   */
  private decisionRouter?: (response: ApprovalResponse) => void;
  private notificationHandlers: NotificationHandler[] = [];
  /**
   * Channel-level consumers — the outbound gateway. Deliberately a **separate**
   * list from {@link notificationHandlers}: the two answer different questions.
   * "Who should see this in their bell" is per *person* (N emissions for
   * `targetUserId:'all'`); "one channel message per logical notification" is per
   * *channel* (exactly one). Sharing one list is the granularity confusion that
   * made a single notification reach a Feishu group N times (req_d25dc9b9).
   */
  private channelNotificationHandlers: NotificationHandler[] = [];
  /**
   * Approval-lifecycle consumers. A terminal transition (approved / rejected /
   * cancelled / expired) is a change to authoritative state that **every**
   * derived surface must observe — the in-app chat banner, the bell, any other
   * client. Deliberately separate from the notification streams: notifications
   * answer "tell this person", this one answers "the state changed".
   *
   * The emission lives at the transition itself (not at each call site) because
   * a decision can be written from ≥3 places — the HTTP API, the in-process
   * platform-action path, and the expiry timer. Wiring only the HTTP path is
   * exactly how the chat banner used to linger forever after an approval was
   * settled from Feishu (the resolving surface was not the one polling).
   */
  private approvalChangeHandlers: Array<(approval: ApprovalRequest) => void> = [];
  private notificationRepo?: NotificationRepo;
  private approvalRepo?: ApprovalRepo;
  private orgService?: OrganizationService;

  setOrgService(service: OrganizationService): void {
    this.orgService = service;
  }

  setNotificationRepo(repo: NotificationRepo): void {
    this.notificationRepo = repo;
    // One-time self-heal. Rows left unread by the old user-enumeration approach
    // (and approvals resolved before this fix) would otherwise advertise unread
    // notifications that the list hides — the "unread (1) over an empty list" bug.
    try {
      const healed = repo.reconcileResolvedApprovalNotifications?.() ?? 0;
      if (healed > 0) log.info(`Reconciled ${healed} stale unread approval notification(s)`);
    } catch (err) {
      log.warn('Failed to reconcile stale approval notifications', { error: String(err) });
    }
  }

  /**
   * Wire the router that applies a recorded decision to its gate. Called once by
   * the composition root; see {@link decisionRouter} for why it lives here.
   */
  setDecisionRouter(router: (response: ApprovalResponse) => void): void {
    this.decisionRouter = router;
  }

  setApprovalRepo(repo: ApprovalRepo): void {
    this.approvalRepo = repo;
    // Restore persisted approvals into memory on startup.
    //
    // Memory is a WORKING SET (pending + recently resolved), not the history
    // store: history is read from the repo page by page (see listApprovalsPage).
    // The cap is explicit here instead of hidden inside the repo query — the old
    // silent `LIMIT 200` made 2300+ of this org's 2521 approvals unreachable.
    try {
      const rows = repo.list({ limit: APPROVALS_IN_MEMORY_CAP });
      for (const row of rows) {
        if (!this.approvals.has(row.id)) this.approvals.set(row.id, this.rowToApproval(row));
      }
      log.info(`Restored ${rows.length} approvals from storage`);
    } catch (err) {
      log.warn('Failed to restore approvals from storage', { error: String(err) });
    }
  }

  /**
   * Paged, time-ordered approval read — the ONE read path for the list API.
   *
   * Two defects this replaces (owner report 2026-10-18 "审批似乎没法加载历史"):
   *  - The map only mirrors the newest {@link APPROVALS_IN_MEMORY_CAP} rows, so
   *    slicing the map could never reach real history.
   *  - `slice(offset, offset+limit)` over the map followed INSERTION order, and
   *    the restore inserts the startup snapshot first — every approval requested
   *    after startup landed at the END of the map and never appeared on page 1.
   *    The pending approvals were literally invisible in the bell.
   */
  listApprovalsPage(opts: { status?: ApprovalStatus; limit: number; offset: number }): { approvals: ApprovalRequest[]; total: number } {
    const { status, limit, offset } = opts;
    if (this.approvalRepo) {
      try {
        const rows = this.approvalRepo.list({ status, limit, offset });
        const total = this.approvalRepo.count ? this.approvalRepo.count(status) : rows.length;
        return { approvals: rows.map(r => this.rowToApproval(r)), total };
      } catch (err) {
        log.warn('Approval repo paging failed — falling back to memory', { error: String(err) });
      }
    }
    const all = [...this.approvals.values()]
      .filter(a => !status || a.status === status)
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
    return { approvals: all.slice(offset, offset + limit), total: all.length };
  }

  /** Single mapping from persisted row → domain object (restore + paging share it). */
  private rowToApproval(row: ApprovalRepoRow): ApprovalRequest {
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      type: row.type as ApprovalRequest['type'],
      title: row.title,
      description: row.description,
      details: row.details,
      status: row.status as ApprovalStatus,
      requestedAt: row.requestedAt,
      respondedAt: row.respondedAt,
      respondedBy: row.respondedBy,
      responseComment: row.responseComment,
      expiresAt: row.expiresAt,
      options: row.options,
      allowFreeform: row.allowFreeform,
      selectedOption: row.selectedOption,
      appliedAt: row.appliedAt,
      appliedIntent: row.appliedIntent as ApprovalIntent | undefined,
      questions: row.questions,
      answers: row.answers,
      approverUserIds: row.approverUserIds,
      targetUserId: row.targetUserId,
    };
  }

  /**
   * Per-person stream. Fires **once per human recipient** — `targetUserId:'all'`
   * fans out to N emissions by design (the in-app bell / WS push is per person).
   * Consumers that address a concrete user subscribe here.
   */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const idx = this.notificationHandlers.indexOf(handler);
      if (idx >= 0) this.notificationHandlers.splice(idx, 1);
    };
  }

  /**
   * Channel-level stream — the single granularity the outbound gateway needs:
   * fires **exactly once per `notify()` call**, no matter how many humans the
   * notification fans out to. This is what structurally guarantees "one logical
   * notification ⇒ one channel message", instead of leaving the dispatcher to
   * de-duplicate N per-person emissions (req_d25dc9b9).
   */
  onChannelNotification(handler: NotificationHandler): () => void {
    this.channelNotificationHandlers.push(handler);
    return () => {
      const idx = this.channelNotificationHandlers.indexOf(handler);
      if (idx >= 0) this.channelNotificationHandlers.splice(idx, 1);
    };
  }

  /**
   * Approval-lifecycle stream. Fires exactly once per terminal transition,
   * whichever surface caused it (in-app modal, Feishu card tap, expiry timer).
   * Consumers invalidate their derived views from this — that is what makes an
   * approval decided in an external IM disappear from the in-app banner too.
   */
  onApprovalChanged(handler: (approval: ApprovalRequest) => void): () => void {
    this.approvalChangeHandlers.push(handler);
    return () => {
      const idx = this.approvalChangeHandlers.indexOf(handler);
      if (idx >= 0) this.approvalChangeHandlers.splice(idx, 1);
    };
  }

  private emit(n: Notification): void {
    for (const h of this.notificationHandlers) {
      try { h(n); } catch { /* ignore */ }
    }
  }

  private emitChannel(n: Notification): void {
    for (const h of this.channelNotificationHandlers) {
      try { h(n); } catch { /* ignore */ }
    }
  }

  private emitApprovalChanged(approval: ApprovalRequest): void {
    for (const h of this.approvalChangeHandlers) {
      try { h(approval); } catch { /* ignore */ }
    }
  }

  requestApproval(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: ApprovalOption[];
    allowFreeform?: boolean;
    questions?: UserInputQuestion[];
    approverUserIds?: string[];
    /**
     * The approval sentence as *structure* (which sentence, with which params) so
     * every renderer writes it in the reader's own language. Without it a gate can
     * only ship an English literal, and that literal is what a chat app shows on
     * the card.
     */
    i18n?: NotificationI18n;
  }): ApprovalRequest {
    const id = genId('apr');
    const now = new Date().toISOString();
    const approval: ApprovalRequest = {
      id,
      agentId: opts.agentId,
      agentName: opts.agentName,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      details: opts.details ?? {},
      status: 'pending',
      requestedAt: now,
      expiresAt: opts.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : undefined,
      options: opts.options,
      allowFreeform: opts.allowFreeform,
      questions: opts.questions,
      approverUserIds: opts.approverUserIds,
      targetUserId: opts.targetUserId,
    };
    this.approvals.set(id, approval);
    this.persistApproval(approval);
    log.info(`Approval requested: ${id} by ${opts.agentName}`);

    this.notify({
      targetUserId: opts.targetUserId ?? 'all',
      type: 'approval_request',
      title: opts.title,
      body: opts.description,
      priority: 'high',
      actionType: 'navigate',
      actionTarget: JSON.stringify({ path: `/approvals/${id}` }),
      // `agentId` travels with the notification so the outbound gateway can route
      // it to the producing agent's own channel before falling back to the global
      // default (G4, design §7.3).
      // `formOnly`：这张单子**一次点击答不完**（多问题 / 多选 / 文本题 / 需填字的选项）。
      // 渠道收到它就不得把「同意/拒绝」当答案按钮发出去，改说“请到应用内回答”。
      // 判定与校验同源（`isAnswerableByTap`），所以不存在“卡片能点、服务端却拒收”。
      metadata: {
        approvalId: id,
        agentId: opts.agentId,
        options: opts.options,
        i18n: opts.i18n,
        ...(isAnswerableByTap(opts.questions, opts.options) ? {} : { formOnly: true }),
      },
    });

    return approval;
  }

  async requestApprovalAndWait(opts: {
    agentId: string;
    agentName: string;
    type: ApprovalRequest['type'];
    title: string;
    description: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    expiresInMs?: number;
    options?: ApprovalOption[];
    allowFreeform?: boolean;
    questions?: UserInputQuestion[];
    approverUserIds?: string[];
    /** @see requestApproval — the sentence as structure, so it can be translated. */
    i18n?: NotificationI18n;
  }): Promise<ApprovalDecision> {
    const approval = this.requestApproval(opts);
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingResolvers.set(approval.id, resolve);
      if (opts.expiresInMs) {
        setTimeout(() => {
          if (this.pendingResolvers.has(approval.id)) {
            this.pendingResolvers.delete(approval.id);
            const a = this.approvals.get(approval.id);
            if (a && a.status === 'pending') {
              a.status = 'expired';
              a.respondedAt = new Date().toISOString();
              a.responseComment = 'Approval timed out';
              this.persistApproval(a);
              this.markApprovalNotificationsRead(a.id);
              this.emitApprovalChanged(a);
            }
            resolve({ approved: false, intent: 'reject', approvalId: approval.id, comment: 'Approval timed out' });
          }
        }, opts.expiresInMs);
      }
    });
  }

  respondToApproval(id: string, approved: boolean, respondedBy: string, comment?: string, selectedOption?: string, answers?: UserInputAnswer[]): ApprovalResponse | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    // A tap carries the same answer in a different shape. Normalize it FIRST, so the
    // completeness check has one vocabulary and one enforcement point.
    const resolvedAnswers = answers ?? answersFromTap(approval, selectedOption, comment);

    // A choice that needs typed input is not an answer on its own. This is the
    // writer-side backstop for the same predicate the UI/API check first: never
    // record a "decision" that is missing the fact it was supposed to decide on.
    const incompleteResponse = assessResponseCompleteness(approval, selectedOption, comment, resolvedAnswers);
    if (incompleteResponse) {
      log.warn('Refused an incomplete approval response — the chosen option needs typed input', {
        approvalId: id,
        selectedOption,
        missing: incompleteResponse.missing,
      });
      return undefined;
    }

    // Single parse point: the intent is resolved exactly once, here, from the
    // approval's own subType + the response payload. Every gate downstream reads
    // `intent` — none of them re-derives it from the boolean.
    const subType = approval.details['subType'] as string | undefined;
    const decision = resolveApprovalIntent({ subType, selectedOption, approved });

    approval.status = intentToApprovalStatus(decision.intent);
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = respondedBy;
    if (comment) approval.responseComment = comment;
    if (selectedOption) approval.selectedOption = selectedOption;
    if (resolvedAnswers && resolvedAnswers.length > 0) approval.answers = resolvedAnswers;
    if (decision.unknownOption) approval.details['unknownOption'] = decision.unknownOption;
    this.persistApproval(approval);
    log.info(`Approval ${id} ${approval.status} (intent=${decision.intent}) by ${respondedBy}`, {
      comment,
      selectedOption,
      unknownOption: decision.unknownOption,
      answerCount: resolvedAnswers?.length ?? 0,
    });

    this.markApprovalNotificationsRead(id);
    this.emitApprovalChanged(approval);

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({
        approved: decision.intent === 'approve',
        intent: decision.intent,
        approvalId: approval.id,
        comment,
        selectedOption,
        answers: resolvedAnswers,
        respondedBy,
        ...(decision.unknownOption ? { unknownOption: decision.unknownOption } : {}),
      });
    }

    // Route the recorded decision to its gate. Queued as a microtask so a live
    // waiter's callback — queued the instant `resolve` ran, just above — reaches
    // the applier's synchronous claim first; the router then loses the claim and
    // reports `already-applied`. Either way the target moves exactly once, and a
    // decision still moves it when the waiter died with an earlier process.
    const response: ApprovalResponse = { approval, decision };
    if (this.decisionRouter) {
      queueMicrotask(() => this.decisionRouter?.(response));
    }
    return response;
  }

  /**
   * Synchronous, check-and-set claim for "apply this approval decision to its
   * target". Both consumers (the promise chain and the API fallback) call this
   * before doing anything observable; only the winner may act.
   *
   * Deliberately keyed on the **approval entity** (persisted `appliedAt`):
   *   · target state is unusable — two of the three gates intentionally perform
   *     zero state transition, so a state-based guard would never fire;
   *   · `approval.status` is unusable — {@link respondToApproval} flips it first,
   *     which would make the *first* apply look like a duplicate.
   *
   * Synchronous by contract: no `await` between read and write, so the guard and
   * the microtask that follows a resolved promise can never interleave.
   */
  claimApply(id: string, intent: ApprovalIntent): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    if (approval.appliedAt) return false;
    approval.appliedAt = new Date().toISOString();
    approval.appliedIntent = intent;
    this.persistApproval(approval);
    log.info('Approval decision claimed for apply', { id, intent });
    return true;
  }

  cancelApproval(id: string, cancelledBy: string, comment?: string): ApprovalRequest | undefined {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;

    approval.status = 'cancelled';
    approval.respondedAt = new Date().toISOString();
    approval.respondedBy = cancelledBy;
    if (comment) approval.responseComment = comment;
    this.persistApproval(approval);
    log.info(`Approval ${id} cancelled by ${cancelledBy}`, { comment });

    this.markApprovalNotificationsRead(id);
    this.emitApprovalChanged(approval);

    const resolve = this.pendingResolvers.get(id);
    if (resolve) {
      this.pendingResolvers.delete(id);
      resolve({
        approved: false,
        intent: 'reject',
        approvalId: approval.id,
        comment: comment ?? 'Approval cancelled',
      });
    }
    return approval;
  }

  cancelApprovalsByDetail(key: string, value: unknown, cancelledBy: string, comment?: string): number {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.status === 'pending' && approval.details[key] === value) {
        this.cancelApproval(approval.id, cancelledBy, comment);
        count++;
      }
    }
    return count;
  }

  private persistApproval(approval: ApprovalRequest): void {
    if (!this.approvalRepo) return;
    try {
      this.approvalRepo.upsert({
        id: approval.id,
        agentId: approval.agentId,
        agentName: approval.agentName,
        type: approval.type,
        title: approval.title,
        description: approval.description,
        details: approval.details,
        status: approval.status,
        requestedAt: approval.requestedAt,
        respondedAt: approval.respondedAt,
        respondedBy: approval.respondedBy,
        responseComment: approval.responseComment,
        expiresAt: approval.expiresAt,
        options: approval.options,
        allowFreeform: approval.allowFreeform,
        selectedOption: approval.selectedOption,
        appliedAt: approval.appliedAt,
        appliedIntent: approval.appliedIntent,
        questions: approval.questions,
        answers: approval.answers,
        approverUserIds: approval.approverUserIds,
        targetUserId: approval.targetUserId,
      });
    } catch (err) {
      log.warn('Failed to persist approval', { id: approval.id, error: String(err) });
    }
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    return status ? all.filter(a => a.status === status) : all;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  listNotifications(userId?: string, unreadOnly = false, opts?: { limit?: number; offset?: number; type?: string }): Notification[] {
    if (this.notificationRepo && userId) {
      const rows = this.notificationRepo.list(userId, {
        unreadOnly,
        limit: opts?.limit,
        offset: opts?.offset,
        type: opts?.type,
      });
      return rows.map(r => this.rowToNotification(r));
    }
    return [];
  }

  countNotifications(userId: string, unreadOnly = false): { total: number; unread: number } {
    if (this.notificationRepo) {
      return {
        total: this.notificationRepo.count(userId, false),
        unread: this.notificationRepo.count(userId, true),
      };
    }
    return { total: 0, unread: 0 };
  }

  markNotificationRead(id: string): boolean {
    if (this.notificationRepo) {
      return this.notificationRepo.markRead(id);
    }
    return false;
  }

  markAllNotificationsRead(userId: string): number {
    if (this.notificationRepo) {
      return this.notificationRepo.markAllRead(userId);
    }
    return 0;
  }

  notify(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
    /**
     * Recipients to skip. The canonical use is "do not notify the actor about
     * their own action" — a reviewer should not get a bell for a decision they
     * just made. Kept here (the single fan-out point) so every caller shares one
     * rule instead of hand-filtering after the fact.
     */
    excludeUserIds?: string[];
  }): Notification {
    let targetUserIds: string[];
    if (opts.targetUserId === 'all') {
      if (this.orgService) {
        const humans = this.orgService.listHumanUsers('default');
        targetUserIds = humans.map(h => h.id);
        if (targetUserIds.length === 0) targetUserIds = ['all'];
      } else {
        targetUserIds = ['all'];
      }
    } else {
      targetUserIds = [opts.targetUserId];
    }

    if (opts.excludeUserIds?.length) {
      const skip = new Set(opts.excludeUserIds);
      targetUserIds = targetUserIds.filter(id => !skip.has(id));
    }

    // Everyone who could be reached is the actor → nothing to persist. Still emit
    // the single channel-level event ("one logical event ⇒ one channel message")
    // and hand back a built notification so callers keep a non-null return.
    if (targetUserIds.length === 0) {
      const n = this.buildNotification({ ...opts });
      this.emitChannel(n);
      return n;
    }

    let first: Notification | undefined;
    for (const targetUserId of targetUserIds) {
      const n = this.notifySingle({ ...opts, targetUserId });
      first ??= n;
    }

    // Channel-level stream: exactly ONE logical event per notify() call, for
    // consumers that address a *channel* rather than a person (the outbound
    // gateway). Emitted from the single source, so it is independent of the
    // per-person fan-out above (req_d25dc9b9).
    this.emitChannel(this.buildNotification({ ...opts }));

    return first!;
  }

  /**
   * Assemble the notification shape — the **single** place the fields are built,
   * shared by the persisted per-person row and the logical channel event.
   */
  private buildNotification(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    return {
      id: genId('ntf'),
      targetUserId: opts.targetUserId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      priority: opts.priority ?? 'normal',
      read: false,
      actionType: opts.actionType ?? 'none',
      actionTarget: opts.actionTarget,
      createdAt: new Date().toISOString(),
      metadata: opts.metadata,
    };
  }

  private notifySingle(opts: {
    targetUserId: string;
    type: NotificationType;
    title: string;
    body: string;
    priority?: NotificationPriority;
    actionType?: NotificationActionType;
    actionTarget?: string;
    metadata?: Record<string, unknown>;
  }): Notification {
    const notification = this.buildNotification(opts);

    if (this.notificationRepo) {
      try {
        this.notificationRepo.insert({
          id: notification.id,
          userId: notification.targetUserId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          priority: notification.priority,
          read: false,
          actionType: notification.actionType,
          actionTarget: notification.actionTarget ?? null,
          metadata: notification.metadata ?? null,
          createdAt: notification.createdAt,
        });
      } catch (err) {
        log.warn('Failed to persist notification', { error: String(err) });
      }
    }

    this.emit(notification);
    return notification;
  }

  /** Mark unread approval_request rows for this approval read, across every user_id. */
  private markApprovalNotificationsRead(approvalId: string): void {
    if (!this.notificationRepo) return;

    // Preferred path: key straight on metadata.approvalId — exact, unbounded, and
    // it cannot miss a user_id we forgot to enumerate.
    if (this.notificationRepo.markReadByApprovalId) {
      try {
        this.notificationRepo.markReadByApprovalId(approvalId);
        return;
      } catch (err) {
        log.warn('Failed to mark approval notifications read by approvalId', {
          approvalId, error: String(err),
        });
      }
    }

    // Fallback for repos without the keyed update. NOTE: this can miss rows sent
    // to user_ids outside the enumerated set and is capped at 200 rows per user —
    // exactly the gap the keyed path above closes.
    const userIds = new Set<string>(['all']);
    if (this.orgService) {
      for (const h of this.orgService.listHumanUsers('default')) {
        userIds.add(h.id);
      }
    }
    for (const userId of userIds) {
      try {
        const rows = this.notificationRepo.list(userId, { type: 'approval_request', limit: 200 });
        for (const row of rows) {
          if (row.metadata && (row.metadata as Record<string, unknown>).approvalId === approvalId && !row.read) {
            this.notificationRepo.markRead(row.id);
          }
        }
      } catch { /* best effort */ }
    }
  }

  private rowToNotification(r: {
    id: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    priority: string;
    read: boolean;
    actionType: string;
    actionTarget: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }): Notification {
    return {
      id: r.id,
      targetUserId: r.userId,
      type: r.type as NotificationType,
      title: r.title,
      body: r.body,
      priority: r.priority as NotificationPriority,
      read: r.read,
      actionType: r.actionType as NotificationActionType,
      actionTarget: r.actionTarget ?? undefined,
      createdAt: r.createdAt,
      metadata: r.metadata ?? undefined,
    };
  }
}
