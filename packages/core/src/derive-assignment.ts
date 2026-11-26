/**
 * A2 — "what am I on the hook for", as a **derived view** (no stored copy).
 *
 * Why this file exists: an agent used to learn its own obligations only by
 * accident.
 *   - `## Task Board` lists tasks *assigned* to me. A card parked in `review`
 *     where I am the **reviewer** therefore read as somebody else's work; the
 *     one line that says "a decision is waiting on you" did not exist.
 *   - Callbacks were worse: `rest` / `background_exec` / `schedule_wakeup`
 *     register a wakeup, and nothing told the agent it was waiting — so a later
 *     turn either polled blind or forgot the wait entirely.
 *
 * The fix is NOT a field on `AgentConfig`. `assignedTasks` stored there would be
 * a **second writer** next to `tasks.assigned_agent_id`, and the two would drift
 * the first time a card changed hands. This module derives instead, from rows
 * that already exist.
 *
 * Judgement (the design's own test): every emitted line must trace back to an
 * existing column. If a line needed a newly stored field to compute, the design
 * would be wrong. That rule is what removed the `requirements` axis below.
 *
 * Sources — the only three that actually exist:
 *   - `tasks.assigned_agent_id = me`, status not closed   -> mine to do
 *   - `tasks.reviewer_agent_id = me`, status = 'review'   -> mine to decide
 *   - `pendingCallbackRegistry.getByAgentId(me)`          -> mine to wait for
 *
 * Deliberately absent: **requirements awaiting my approval**. The `requirements`
 * table has no reviewer column (only `created_by` / `approved_by`, and a pending
 * requirement's `approved_by` is by definition still NULL), so that line is not
 * derivable. Requirement approval is a human gate in this platform; inventing an
 * agent-side approval queue here would have been a mechanism with no table
 * behind it.
 *
 * Pure: no IO, no clock reads unless the caller injects one. Rendering lives here
 * too, so there is exactly one definition of the prompt format.
 */

/** Closed statuses mirror `TASK_TRANSITIONS`' terminal set; a closed card is never owed. */
const CLOSED_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'archived',
  'rejected',
]);

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'];

export type AssignmentSource = 'tasks' | 'pending_callbacks';

export type AssignmentKind = 'assigned' | 'review' | 'callback';

export interface AssignmentLine {
  /** Which existing table this line came from — the traceability proof. */
  source: AssignmentSource;
  kind: AssignmentKind;
  id: string;
  /** Rendered form. Built once here so the prompt format has a single owner. */
  text: string;
}

export interface AssignmentTaskRow {
  id: string;
  title: string;
  status: string;
  priority?: string;
  assignedAgentId?: string;
  reviewerAgentId?: string;
}

export interface AssignmentCallbackRow {
  id: string;
  type: string;
  note?: string;
  command?: string;
  correlationId?: string;
  registeredAt?: number;
  originScenario?: string;
}

export interface AssignmentInput {
  agentId: string;
  tasks?: AssignmentTaskRow[];
  callbacks?: AssignmentCallbackRow[];
  /** Injectable for deterministic age rendering in tests. Defaults to Date.now(). */
  now?: number;
}

export interface Assignment {
  /** Cards assigned to me and still open. */
  assigned: AssignmentLine[];
  /** Cards where I am the reviewer and the card is waiting for my verdict. */
  review: AssignmentLine[];
  /** Registered wakeups that belong to me and have not resolved. */
  callbacks: AssignmentLine[];
  /** All three, in the order above — the canonical iteration order. */
  lines: AssignmentLine[];
  counts: { assigned: number; review: number; callbacks: number };
}

function priorityRank(p: string | undefined): number {
  const i = PRIORITY_ORDER.indexOf(p ?? 'medium');
  return i === -1 ? PRIORITY_ORDER.length : i;
}

function formatAge(registeredAt: number | undefined, now: number): string {
  if (!registeredAt || !Number.isFinite(registeredAt)) return '';
  const ms = now - registeredAt;
  if (ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `background_exec` renders its command, `rest` renders its note, both fall back to the type. */
function describeCallback(cb: AssignmentCallbackRow): string {
  const detail = cb.command ?? cb.note;
  const label = detail ? `\`${detail.length > 60 ? `${detail.slice(0, 57)}...` : detail}\`` : '';
  return label ? `${cb.type} ${label}` : cb.type;
}

export function deriveAssignment(input: AssignmentInput): Assignment {
  const { agentId } = input;
  const now = input.now ?? Date.now();
  const tasks = input.tasks ?? [];
  const callbacks = input.callbacks ?? [];

  const assigned: AssignmentLine[] = tasks
    .filter((t) => t.assignedAgentId === agentId && !CLOSED_STATUSES.has(t.status))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .map((t) => ({
      source: 'tasks' as const,
      kind: 'assigned' as const,
      id: t.id,
      text: `[${t.status.toUpperCase()}] **${t.title}** (\`${t.id}\`, ${t.priority ?? 'medium'})`,
    }));

  const review: AssignmentLine[] = tasks
    .filter((t) => t.reviewerAgentId === agentId && t.status === 'review')
    // Someone is blocked until I decide; highest priority first, but every entry
    // is already actionable, so priority is the only meaningful ordering.
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .map((t) => ({
      source: 'tasks' as const,
      kind: 'review' as const,
      id: t.id,
      text: `**${t.title}** (\`${t.id}\`) — submitted by another agent, awaiting your verdict`,
    }));

  const cbLines: AssignmentLine[] = callbacks
    // `getByAgentId` already filters, but filtering here keeps the function
    // correct for any caller and makes the invariant impossible to violate.
    .filter((cb) => (cb as { agentId?: string }).agentId === undefined || (cb as { agentId?: string }).agentId === agentId)
    .map((cb) => {
      const age = formatAge(cb.registeredAt, now);
      const described = describeCallback(cb);
      const corr = cb.correlationId ? ` [${cb.correlationId}]` : '';
      return {
        source: 'pending_callbacks' as const,
        kind: 'callback' as const,
        id: cb.id,
        text: `${described}${corr}${age ? ` — registered ${age}` : ''}`,
      };
    });

  return {
    assigned,
    review,
    callbacks: cbLines,
    lines: [...assigned, ...review, ...cbLines],
    counts: { assigned: assigned.length, review: review.length, callbacks: cbLines.length },
  };
}

export interface RenderAssignmentOptions {
  /** Per-bucket display cap. Overflow is announced, never silently dropped. */
  limit?: number;
  /**
   * Which buckets this caller wants. Defaults to all three.
   *
   * The task board already lists `assigned` as its "My Tasks" bucket, so the
   * prompt builder passes `{ assigned: false }` — the section then carries only
   * the two axes the board cannot express. Rendering the same tasks twice would
   * spend tokens to say one thing, which is the failure this section exists to
   * avoid.
   */
  include?: { assigned?: boolean; review?: boolean; callbacks?: boolean };
}

/**
 * Render the prompt block. Returns an empty array when nothing is owed, so the
 * caller can skip the section entirely (a permanent "nothing owed" header is the
 * "always-on warning" failure mode this codebase has been bitten by).
 */
export function renderAssignmentPrompt(
  assignment: Assignment,
  opts: RenderAssignmentOptions = {},
): string[] {
  const limit = opts.limit ?? 5;
  const { counts } = assignment;
  if (counts.assigned === 0 && counts.review === 0 && counts.callbacks === 0) return [];

  const include = { assigned: true, review: true, callbacks: true, ...opts.include };
  const visible = [
    ...(include.review ? assignment.review : []),
    ...(include.assigned ? assignment.assigned : []),
    ...(include.callbacks ? assignment.callbacks : []),
  ];
  if (visible.length === 0) return [];

  const out: string[] = [];
  out.push('\n## My Assignment');
  out.push('_Derived each turn from `tasks` + the callback registry. Nothing here is stored twice — acting on a line is what clears it._');

  const bucket = (heading: string, lines: AssignmentLine[]) => {
    if (lines.length === 0) return;
    out.push(`### ${heading} (${lines.length}):`);
    for (const line of lines.slice(0, limit)) out.push(`- ${line.text}`);
    if (lines.length > limit) {
      out.push(`_(${lines.length - limit} more not shown — \`task_list\` / \`task_get\` for the rest)_`);
    }
  };

  if (include.review) bucket('Awaiting my verdict — someone is blocked until I decide', assignment.review);
  if (include.assigned) bucket('Waiting on me', assignment.assigned);
  if (include.callbacks) bucket("Callbacks I'm still waiting for", assignment.callbacks);

  return out;
}
