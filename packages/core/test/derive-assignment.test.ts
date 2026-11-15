import { describe, it, expect } from 'vitest';
import {
  deriveAssignment,
  renderAssignmentPrompt,
  type AssignmentTaskRow,
  type AssignmentCallbackRow,
} from '../src/derive-assignment.js';

const ME = 'agt_me';

const task = (over: Partial<AssignmentTaskRow> = {}): AssignmentTaskRow => ({
  id: 'tsk_1',
  title: 'Task',
  status: 'in_progress',
  priority: 'medium',
  assignedAgentId: ME,
  ...over,
});

describe('deriveAssignment — traceability (the design doc\'s own judgement)', () => {
  it('every emitted line traces back to an existing table row', () => {
    const tasks = [
      task({ id: 'tsk_mine' }),
      task({ id: 'tsk_review', assignedAgentId: 'agt_other', reviewerAgentId: ME, status: 'review' }),
      task({ id: 'tsk_theirs', assignedAgentId: 'agt_other', reviewerAgentId: 'agt_other' }),
    ];
    const callbacks: AssignmentCallbackRow[] = [{ id: 'cb_1', type: 'background_exec' }];

    const seg = deriveAssignment({ agentId: ME, tasks, callbacks });
    const ids = new Set([...tasks.map((t) => t.id), ...callbacks.map((c) => c.id)]);

    for (const line of seg.lines) {
      // The proof of "no new field was needed": each line is an existing row.
      expect(ids.has(line.id)).toBe(true);
      expect(line.source).toMatch(/^(tasks|pending_callbacks)$/);
    }
    // Nothing is invented for someone else's work.
    expect(seg.lines.map((l) => l.id)).not.toContain('tsk_theirs');
  });
});

describe('deriveAssignment — the review axis (the line that did not exist before)', () => {
  it('surfaces a card where I am the reviewer, even though someone else owns it', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: [
        task({ id: 'tsk_review', title: 'C8 验证', assignedAgentId: 'agt_other', reviewerAgentId: ME, status: 'review' }),
      ],
    });
    expect(seg.counts.review).toBe(1);
    expect(seg.review[0].id).toBe('tsk_review');
    expect(seg.review[0].text).toContain('awaiting your verdict');
    // It must NOT be double-counted as work I owe myself.
    expect(seg.counts.assigned).toBe(0);
  });

  it('a review card of someone else\'s chain is not mine to decide', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: [task({ id: 'tsk_x', assignedAgentId: 'agt_a', reviewerAgentId: 'agt_b', status: 'review' })],
    });
    expect(seg.lines).toHaveLength(0);
  });

  it('reviewer of a card that already left review is not pending', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: [task({ id: 'tsk_done', assignedAgentId: 'agt_other', reviewerAgentId: ME, status: 'completed' })],
    });
    expect(seg.counts.review).toBe(0);
  });
});

describe('deriveAssignment — assigned bucket', () => {
  it('excludes every closed status (a closed card is never owed)', () => {
    const closed = ['completed', 'cancelled', 'failed', 'archived', 'rejected'];
    const seg = deriveAssignment({
      agentId: ME,
      tasks: closed.map((s, i) => task({ id: `tsk_${i}`, status: s })),
    });
    expect(seg.counts.assigned).toBe(0);
  });

  it('orders by priority so the loudest obligation is first', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: [
        task({ id: 'tsk_low', priority: 'low' }),
        task({ id: 'tsk_urgent', priority: 'critical' }),
        task({ id: 'tsk_mid', priority: 'medium' }),
      ],
    });
    expect(seg.assigned.map((l) => l.id)).toEqual(['tsk_urgent', 'tsk_mid', 'tsk_low']);
  });
});

describe('deriveAssignment — callbacks I am still waiting for', () => {
  it('renders age from an injected clock (deterministic, no Date.now in the test)', () => {
    const now = 1_000_000_000;
    const seg = deriveAssignment({
      agentId: ME,
      callbacks: [{ id: 'cb_1', type: 'background_exec', command: 'npm test', registeredAt: now - 5 * 60_000 }],
      now,
    });
    expect(seg.counts.callbacks).toBe(1);
    expect(seg.callbacks[0].text).toContain('npm test');
    expect(seg.callbacks[0].text).toContain('5m ago');
  });

  it('keeps the correlation id, which is how a completion finds its way back', () => {
    const seg = deriveAssignment({
      agentId: ME,
      callbacks: [{ id: 'cb_2', type: 'rest', correlationId: 'conv_42' }],
    });
    expect(seg.callbacks[0].text).toContain('conv_42');
  });

  it('does not claim another agent\'s callback', () => {
    const seg = deriveAssignment({
      agentId: ME,
      callbacks: [{ id: 'cb_x', type: 'rest', agentId: 'agt_other' } as AssignmentCallbackRow],
    });
    expect(seg.counts.callbacks).toBe(0);
  });
});

describe('renderAssignmentPrompt', () => {
  it('renders nothing at all when nothing is owed (no permanent empty header)', () => {
    const seg = deriveAssignment({ agentId: ME, tasks: [], callbacks: [] });
    expect(renderAssignmentPrompt(seg)).toEqual([]);
  });

  it('announces overflow instead of silently truncating', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: Array.from({ length: 9 }, (_, i) => task({ id: `tsk_${i}` })),
    });
    const out = renderAssignmentPrompt(seg, { limit: 3 }).join('\n');
    expect(out).toContain('9)');            // the true count is stated
    expect(out).toContain('6 more not shown'); // and so is how many are hidden
  });

  it('puts the blocking axis first: a verdict someone waits on beats my own queue', () => {
    const seg = deriveAssignment({
      agentId: ME,
      tasks: [
        task({ id: 'tsk_mine' }),
        task({ id: 'tsk_review', assignedAgentId: 'agt_other', reviewerAgentId: ME, status: 'review' }),
      ],
    });
    const out = renderAssignmentPrompt(seg).join('\n');
    expect(out.indexOf('Awaiting my verdict')).toBeLessThan(out.indexOf('Waiting on me'));
  });
});
