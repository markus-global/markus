/**
 * `deriveInbox` — exactly-once to-do derivation (C9-D).
 *
 * Every case below is written to fail if the corresponding rule is deleted, not to
 * exercise a happy path:
 *   · delete the `if (!action) continue` line  → "no destination ⇒ dropped" goes red;
 *   · key the fold on anything but the subject  → the over-dedupe case goes red;
 *   · drop `mergedNeeds`                        → the fold case goes red;
 *   · read the wall clock                       → the determinism case goes red.
 *
 * No repo is mocked anywhere in this file — there is nothing to mock: the function
 * is pure, and the two ports are plain functions over plain objects.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveInbox,
  dedupeKey,
  NEED_BLOCKING,
  INBOX_NEED_KINDS,
  type InboxAction,
  type InboxSnapshot,
  type InboxPorts,
  type InboxApprovalRow,
  type InboxNotificationRow,
  type InboxTaskRow,
  type InboxRequirementRow,
} from './deriveInbox.ts';

// ─── fixtures (structural rows, i.e. what the API already hands us) ───────────

const approval = (over: Partial<InboxApprovalRow> = {}): InboxApprovalRow => ({
  id: 'a1',
  title: 'Approve the migration',
  status: 'pending',
  requestedAt: '2026-11-02T00:00:00.000Z',
  agentId: 'ag1',
  agentName: 'Payments Agent',
  details: {},
  ...over,
});

const notice = (over: Partial<InboxNotificationRow> = {}): InboxNotificationRow => ({
  id: 'n1',
  title: 'Report ready',
  type: 'agent_report',
  priority: 'medium',
  read: false,
  createdAt: '2026-11-03T00:00:00.000Z',
  ...over,
});

const task = (over: Partial<InboxTaskRow> = {}): InboxTaskRow => ({
  id: 't1',
  title: 'Ship the widget',
  status: 'review',
  priority: 'medium',
  reviewerType: 'human',
  statusChangedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const requirement = (over: Partial<InboxRequirementRow> = {}): InboxRequirementRow => ({
  id: 'r1',
  title: 'Refactor slicing',
  status: 'pending',
  priority: 'high',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const emptySnapshot = (over: Partial<InboxSnapshot> = {}): InboxSnapshot => ({
  approvals: [],
  notifications: [],
  tasks: [],
  requirements: [],
  ...over,
});

/**
 * Ports are *required* named functions. The two resolvers are the existing single
 * discriminators elsewhere in the repo (`notifyNavigate.notificationTarget` and
 * `lib/blockedReason.blockedReasonOf`); here they are expressed as the smallest
 * faithful stand-ins so this file proves the derivation, not the routing.
 */
const ports = (over: Partial<InboxPorts> = {}): InboxPorts => ({
  resolveNotificationTarget: (n): InboxAction | null => {
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    const taskId = typeof meta['taskId'] === 'string' ? meta['taskId'] : undefined;
    if (taskId) return { page: 'WORK', params: { openTask: taskId } };
    const reqId = typeof meta['requirementId'] === 'string' ? meta['requirementId'] : undefined;
    if (reqId) return { page: 'WORK', params: { openRequirement: reqId } };
    const agentId = typeof meta['agentId'] === 'string' ? meta['agentId'] : undefined;
    if (agentId) return { page: 'TEAM', params: { agentId, preferMain: '1' } };
    return null; // no entity, no agent ⇒ nowhere to act
  },
  resolveBlockedReason: t => t.blockedReason ?? 'deps',
  ...over,
});

// ─── identity: the dedupe key ────────────────────────────────────────────────

describe('subjectKind:subjectId:needKind — one row per (subject, need)', () => {
  it('three sources, same subject, same need ⇒ exactly one row, all sources kept', () => {
    const result = deriveInbox(
      emptySnapshot({
        // two duplicate approval rows (the approvals table really does produce these)
        approvals: [
          approval({ id: 'a1', details: { taskId: 't1' } }),
          approval({ id: 'a2', details: { taskId: 't1' } }),
        ],
        // and a notification that is the same need about the same task
        notifications: [
          notice({ id: 'n1', type: 'approval_request', metadata: { taskId: 't1' } }),
        ],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.key).toBe(dedupeKey('task', 't1', 'approve'));
    expect(item.key).toBe('task:t1:approve');
    // "why is this here" is answerable, and it is what one click marks read
    expect(item.sources.map(s => s.kind).sort()).toEqual(['approval', 'approval', 'notification']);
    expect(item.noticeIds).toEqual(['n1']);
  });

  it('three sources, three different subjects ⇒ three rows (no over-dedupe)', () => {
    const result = deriveInbox(
      emptySnapshot({
        approvals: [
          approval({ id: 'a1', details: { taskId: 't1' } }),
          approval({ id: 'a2', details: { taskId: 't2' } }),
        ],
        notifications: [notice({ id: 'n1', metadata: { taskId: 't3' } })],
      }),
      ports(),
    );

    expect(result.items.map(i => i.subjectId).sort()).toEqual(['t1', 't2', 't3']);
    expect(new Set(result.items.map(i => i.key)).size).toBe(3);
  });

  it('the key is structural — nothing time-derived leaks into it', () => {
    const build = (requestedAt: string) =>
      deriveInbox(
        emptySnapshot({ approvals: [approval({ details: { taskId: 't1' }, requestedAt })] }),
        ports(),
      );
    expect(build('2026-11-02T00:00:00.000Z').items[0]!.key).toBe(
      build('2030-01-01T00:00:00.000Z').items[0]!.key,
    );
  });
});

// ─── folding by subject ──────────────────────────────────────────────────────

describe('fold by subject — the list is scanned by object, not by verb', () => {
  it('a task awaiting review plus an approval about it is ONE row, both needs recorded', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'review', reviewerType: 'human' })],
        approvals: [approval({ id: 'a1', details: { taskId: 't1' } })],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    // `approve` outranks `review`
    expect(item.needKind).toBe('approve');
    expect(item.mergedNeeds).toContain('review');
    expect(item.sources.map(s => s.kind).sort()).toEqual(['approval', 'fsm']);
  });

  it('folding never hides blocking: read + review on one subject stays blocking', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'review', reviewerType: 'human' })],
        notifications: [notice({ id: 'n1', type: 'task_review', metadata: { taskId: 't1' } })],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.blocking).toBe(true);
  });

  it('a facts-derived stage corroborates a row instead of inventing a second one', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'in_progress', reviewerType: 'human' })],
        approvals: [approval({ id: 'a1', details: { taskId: 't1' }, questions: [{ prompt: 'ok?' }] })],
        stages: [{ subjectKind: 'task', subjectId: 't1', stage: 'waiting_human' }],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.needKind).toBe('answer');
    expect(result.items[0]!.sources.some(s => s.kind === 'stage')).toBe(true);
  });

  it('stage=failed for a task the FSM still calls running ⇒ a resolve_failure row', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'in_progress' })],
        stages: [{ subjectKind: 'task', subjectId: 't1', stage: 'failed' }],
      }),
      ports(),
    );

    expect(result.items.map(i => [i.needKind, i.subjectId])).toEqual([['resolve_failure', 't1']]);
  });

  it('stage=running / in_verification adds nothing — those are not human needs', () => {
    const result = deriveInbox(
      emptySnapshot({
        stages: [
          { subjectKind: 'task', subjectId: 't1', stage: 'running' },
          { subjectKind: 'task', subjectId: 't2', stage: 'in_verification' },
          { subjectKind: 'task', subjectId: 't3', stage: 'needs_evidence' },
        ],
      }),
      ports(),
    );
    expect(result.items).toEqual([]);
  });
});

// ─── action & blocking are mandatory ────────────────────────────────────────

describe('no action ⇒ dropped, and the drop is on the record', () => {
  it('an approval with no entity and no agent has nowhere to go — dropped, not shown', () => {
    const result = deriveInbox(
      emptySnapshot({ approvals: [approval({ id: 'a1', agentId: '', details: {} })] }),
      ports(),
    );

    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ source: 'approval', ref: 'a1', reason: 'no_action' }]);
  });

  it('an unread broadcast that resolves to no entity is dropped, but still counted as withheld', () => {
    const result = deriveInbox(
      emptySnapshot({
        notifications: [
          notice({ id: 'n1', type: 'system', metadata: {} }),
          notice({ id: 'n2', type: 'system', metadata: { agentId: 'ag9' } }),
        ],
      }),
      ports(),
    );

    expect(result.items.map(i => i.sources[0]!.ref)).toEqual(['n2']);
    expect(result.dropped).toEqual([{ source: 'notification', ref: 'n1', reason: 'no_action' }]);
  });

  it('every returned row carries a concrete destination', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [
          task({ id: 't1', status: 'review', reviewerType: 'human' }),
          task({ id: 't2', status: 'failed' }),
          task({ id: 't3', status: 'blocked', blockedReason: 'hold' }),
        ],
        requirements: [requirement({ id: 'r1' })],
        notifications: [notice({ id: 'n1', metadata: { agentId: 'ag1' } })],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(5);
    for (const item of result.items) {
      expect(item.action.page === 'WORK' || item.action.page === 'TEAM').toBe(true);
      expect(Object.keys(item.action.params).length).toBeGreaterThan(0);
    }
  });

  it('blocking is a property of the need, not a per-row guess', () => {
    expect(NEED_BLOCKING.answer).toBe(true);
    expect(NEED_BLOCKING.approve).toBe(true);
    expect(NEED_BLOCKING.review).toBe(true);
    expect(NEED_BLOCKING.unblock).toBe(true);
    expect(NEED_BLOCKING.resolve_failure).toBe(false);
    expect(NEED_BLOCKING.read).toBe(false);

    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'failed' })],
        notifications: [notice({ id: 'n1', metadata: { agentId: 'ag1' }, type: 'system' })],
      }),
      ports(),
    );
    const failed = result.items.find(i => i.needKind === 'resolve_failure')!;
    const read = result.items.find(i => i.needKind === 'read')!;
    expect(failed.blocking).toBe(false);
    expect(read.blocking).toBe(false);
  });
});

// ─── the four sources in, exactly the human needs out ──────────────────────

describe('source semantics', () => {
  it('blocked because of dependencies is NOT a human need', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [
          task({ id: 'deps', status: 'blocked', blockedReason: 'deps' }),
          task({ id: 'hold', status: 'blocked', blockedReason: 'hold' }),
        ],
      }),
      ports(),
    );
    expect(result.items.map(i => i.subjectId)).toEqual(['hold']);
    expect(result.items[0]!.needKind).toBe('unblock');
  });

  it('a task awaiting an agent reviewer is not a human need', () => {
    const result = deriveInbox(
      emptySnapshot({ tasks: [task({ id: 't1', status: 'review', reviewerType: 'agent' })] }),
      ports(),
    );
    expect(result.items).toEqual([]);
  });

  it('a question approval is `answer`, a plain approval is `approve`', () => {
    const result = deriveInbox(
      emptySnapshot({
        approvals: [
          approval({ id: 'a1', details: { taskId: 't1' }, questions: [{ prompt: 'which db?' }] }),
          approval({ id: 'a2', details: { taskId: 't2' } }),
        ],
      }),
      ports(),
    );
    expect(result.items.map(i => i.needKind)).toEqual(['answer', 'approve']);
  });

  it('resolved approvals and requirements are ignored', () => {
    const result = deriveInbox(
      emptySnapshot({
        approvals: [approval({ id: 'a1', status: 'approved', details: { taskId: 't1' } })],
        requirements: [requirement({ id: 'r1', status: 'approved' })],
        notifications: [notice({ id: 'n1', read: true, metadata: { agentId: 'ag1' } })],
      }),
      ports(),
    );
    expect(result.items).toEqual([]);
  });

  it('waiting-basis is honest: exact source field, else `approximate`', () => {
    const result = deriveInbox(
      emptySnapshot({
        approvals: [approval({ id: 'a1', details: { taskId: 't1' }, requestedAt: '2026-11-02T00:00:00.000Z' })],
        tasks: [task({ id: 't2', status: 'review', reviewerType: 'human', statusChangedAt: undefined, updatedAt: undefined, createdAt: undefined })],
        requirements: [requirement({ id: 'r1', createdAt: '2026-11-01T00:00:00.000Z' })],
      }),
      ports(),
    );
    const bySubject = (id: string) => result.items.find(i => i.subjectId === id)!;
    expect(bySubject('t1').waitingBasis).toBe('requested');
    expect(bySubject('r1').waitingBasis).toBe('created');
    expect(bySubject('t2').waitingBasis).toBe('approximate');
  });
});

// ─── purity, determinism, order ─────────────────────────────────────────────

describe('purity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not read the clock or randomness', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('deriveInbox must not read the clock');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('deriveInbox must not be random');
    });

    const result = deriveInbox(
      emptySnapshot({
        approvals: [approval({ details: { taskId: 't1' } })],
        notifications: [notice({ id: 'n1', metadata: { taskId: 't2' } })],
      }),
      ports(),
      { lastSeenAt: '2026-11-02T12:00:00.000Z' },
    );

    expect(result.items).toHaveLength(2);
  });

  it('two calls on the same snapshot are byte-identical, and input order does not matter', () => {
    const snapshot = emptySnapshot({
      approvals: [
        approval({ id: 'a1', details: { taskId: 't1' } }),
        approval({ id: 'a2', details: { taskId: 't2' } }),
      ],
      tasks: [task({ id: 't3', status: 'failed' })],
    });
    const once = deriveInbox(snapshot, ports());
    const twice = deriveInbox(snapshot, ports());
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));

    const shuffled = deriveInbox(
      emptySnapshot({
        approvals: [...snapshot.approvals].reverse(),
        tasks: snapshot.tasks,
      }),
      ports(),
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(once));
  });

  it('longest wait first, then priority, then need — a total order, never reshuffling', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const result = deriveInbox(
      emptySnapshot({
        approvals: [approval({ id: 'a1', details: { taskId: 't0' }, requestedAt: at })],
        tasks: [
          task({ id: 'low', status: 'review', reviewerType: 'human', priority: 'low', statusChangedAt: at }),
          task({ id: 'urgent', status: 'review', reviewerType: 'human', priority: 'urgent', statusChangedAt: at }),
        ],
        requirements: [requirement({ id: 'reqUrgent', priority: 'urgent', createdAt: at })],
      }),
      ports(),
    );

    // Same instant ⇒ priority first (urgent before low before "none"), then need:
    // a requirement approval (rank 4) before a human review (rank 5).
    expect(result.items.map(i => i.subjectId)).toEqual(['reqUrgent', 'urgent', 'low', 't0']);
    for (const item of result.items) expect(item.waitingSince).toBe(at);
  });

  it('`isNew` follows lastSeenAt, except for messages (server owns that flag)', () => {
    const lastSeenAt = '2026-11-02T12:00:00.000Z';
    const result = deriveInbox(
      emptySnapshot({
        approvals: [
          approval({ id: 'old', details: { taskId: 't1' }, requestedAt: '2026-11-01T00:00:00.000Z' }),
          approval({ id: 'fresh', details: { taskId: 't2' }, requestedAt: '2026-11-03T00:00:00.000Z' }),
        ],
        notifications: [
          notice({ id: 'n1', createdAt: '2026-11-01T00:00:00.000Z', metadata: { agentId: 'ag1' } }),
        ],
      }),
      ports(),
      { lastSeenAt },
    );

    expect(result.items.find(i => i.subjectId === 't1')!.isNew).toBe(false);
    expect(result.items.find(i => i.subjectId === 't2')!.isNew).toBe(true);
    expect(result.items.find(i => i.needKind === 'read')!.isNew).toBe(true);
  });

  it('first use (no lastSeenAt) claims nothing is new', () => {
    const result = deriveInbox(
      emptySnapshot({ approvals: [approval({ details: { taskId: 't1' } })] }),
      ports(),
    );
    expect(result.items[0]!.isNew).toBe(false);
  });

  it('a notification never raises a need — a stale "review" notice stays a message', () => {
    // Real case from the live DB (2026-11-15): `task_review` notifications whose task is
    // already `completed`. Trusting the notification type would invent a blocking review.
    const result = deriveInbox(
      emptySnapshot({
        notifications: [notice({ id: 'n1', type: 'task_review', metadata: { taskId: 't-done' } })],
      }),
      ports(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.needKind).toBe('read');
    expect(result.items[0]!.blocking).toBe(false);
  });

  it('that same stale notice folds into the row when the FSM still says review', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'review', reviewerType: 'human' })],
        notifications: [notice({ id: 'n1', type: 'task_review', metadata: { taskId: 't1' } })],
      }),
      ports(),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.needKind).toBe('review');
    expect(result.items[0]!.sources.map(s => s.kind).sort()).toEqual(['fsm', 'notification']);
  });

  it('the need closed set is what the row can ever be', () => {
    const result = deriveInbox(
      emptySnapshot({
        approvals: [approval({ questions: [{ prompt: 'q' }], details: { taskId: 't1' } })],
        tasks: [
          task({ id: 't2', status: 'review', reviewerType: 'human' }),
          task({ id: 't3', status: 'blocked', blockedReason: 'hold' }),
          task({ id: 't4', status: 'failed' }),
        ],
        notifications: [notice({ id: 'n1', metadata: { agentId: 'ag1' }, type: 'system' })],
      }),
      ports(),
    );
    for (const item of result.items) expect(INBOX_NEED_KINDS).toContain(item.needKind);
  });
});

// ─── the adapter's contract ────────────────────────────────────────────────

describe('rendering contract carried by the derivation', () => {
  it('the anchor names the source that makes the row what it is (stable React key)', () => {
    const result = deriveInbox(
      emptySnapshot({
        tasks: [task({ id: 't1', status: 'review', reviewerType: 'human' })],
        notifications: [notice({ id: 'n1', type: 'task_review', metadata: { taskId: 't1' } })],
      }),
      ports(),
    );
    expect(result.items[0]!.anchor).toEqual({ kind: 'fsm', ref: 't1' });
  });

  it('includes an agent name for the row meta when the source has one', () => {
    const result = deriveInbox(
      emptySnapshot({ approvals: [approval({ agentName: 'Payments Agent', details: { taskId: 't1' } })] }),
      ports(),
    );
    expect(result.items[0]!.meta).toBe('Payments Agent');
  });

  it('a notification title renderer, when injected, wins over the raw title', () => {
    const result = deriveInbox(
      emptySnapshot({
        notifications: [notice({ id: 'n1', title: 'Task completed: ship', metadata: { agentId: 'ag1' } })],
      }),
      ports({ renderNotificationTitle: n => `已读：${n.id}` }),
    );
    expect(result.items[0]!.title).toBe('已读：n1');
  });
});
