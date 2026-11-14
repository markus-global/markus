import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { LLMMessage } from '@markus/shared';
import {
  TURN_DELTA_HEADER_PREFIX,
  TURN_DELTA_MAX_CHARS,
  TURN_DELTA_MAX_ITEMS,
  buildTurnDeltaSegment,
  classifyTurnDelta,
  turnDeltaMessage,
  type TurnDeltaRow,
} from '../src/turn-delta.js';

/**
 * C8-B contract tests.
 *
 * These are byte-level assertions on a pure function — no clock, no DB, no
 * source-text inspection. Every assertion here can go red by changing the
 * implementation's *behaviour* (that is the point of the card).
 */

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function row(over: Partial<TurnDeltaRow> & Pick<TurnDeltaRow, 'id' | 'sourceType'>): TurnDeltaRow {
  return {
    seq: 1,
    workUnitRef: 'task_tsk_1_r1',
    payload: { summary: over.id, content: over.id },
    ...over,
  } as TurnDeltaRow;
}

describe('C8-B turn delta — classification (structural only)', () => {
  it('an envelope that says it invalidates the premise is a contradiction', () => {
    const r = row({
      id: 'mbx_cancel',
      sourceType: 'task_status_update',
      envelope: { intent: 'deliver', invalidatesPremise: true, supersedes: null },
    });
    expect(classifyTurnDelta(r)).toBe('contradiction');
  });

  it('a non-empty supersedes chain is a contradiction even without the boolean', () => {
    const r = row({
      id: 'mbx_correct',
      sourceType: 'requirement_update',
      envelope: { intent: 'deliver', invalidatesPremise: false, supersedes: ['mbx_old'] },
    });
    expect(classifyTurnDelta(r)).toBe('contradiction');
  });

  it('an authoritative intent is authoritative', () => {
    const r = row({
      id: 'mbx_auth',
      sourceType: 'task_status_update',
      envelope: { intent: 'trigger_execution', invalidatesPremise: false, supersedes: null },
    });
    expect(classifyTurnDelta(r)).toBe('authoritative');
  });

  it('a formal state-machine record about the same entity is a decision', () => {
    expect(classifyTurnDelta(row({ id: 'mbx_c1', sourceType: 'task_comment' }))).toBe('decision');
    expect(classifyTurnDelta(row({ id: 'mbx_r1', sourceType: 'review_request' }))).toBe('decision');
  });

  it('ambient/system noise has no class at all (queue only)', () => {
    for (const t of ['heartbeat', 'daily_report', 'memory_consolidation', 'system_event'] as const) {
      expect(classifyTurnDelta(row({ id: `mbx_${t}`, sourceType: t }))).toBeNull();
    }
  });
});

describe('C8-B turn delta — rendering is a stable byte shape', () => {
  it('no rows and "rows that do not qualify" render byte-identically, and both say count: 0', () => {
    const nothing = buildTurnDeltaSegment({ snapshotSeq: 7, rows: [] });
    const filtered = buildTurnDeltaSegment({
      snapshotSeq: 7,
      rows: [
        row({ id: 'mbx_hb', sourceType: 'heartbeat' }),
        row({ id: 'mbx_dr', sourceType: 'daily_report' }),
        row({ id: 'mbx_mc', sourceType: 'memory_consolidation' }),
      ],
    });

    // Criterion 3: the *bytes* must not depend on whether the delta was empty
    // because nothing arrived or because nothing qualified.
    expect(sha(nothing.text)).toBe(sha(filtered.text));
    // Criterion 4: the segment still exists — `count: 0` and `none`, never omitted.
    for (const seg of [nothing, filtered]) {
      expect(seg.text).toContain(`${TURN_DELTA_HEADER_PREFIX}7]`);
      expect(seg.text).toContain('count: 0');
      expect(seg.text).toContain('none');
      expect(seg.entries).toHaveLength(0);
      expect(seg.decision).toBe('continue');
    }
    // Criterion 4 (scope): ambient noise never leaks into the turn context.
    expect(filtered.text).not.toContain('heartbeat');
    expect(filtered.text).not.toContain('daily_report');
    expect(filtered.text).not.toContain('memory_consolidation');
  });

  it('renders the same bytes twice for the same logical input (no clock, no counter)', () => {
    const rows = [
      row({ id: 'mbx_a', sourceType: 'task_comment', seq: 3 }),
      row({
        id: 'mbx_b',
        sourceType: 'task_status_update',
        seq: 4,
        envelope: { intent: 'trigger_execution', invalidatesPremise: false, supersedes: null },
      }),
    ];
    const once = buildTurnDeltaSegment({ snapshotSeq: 2, rows });
    const twice = buildTurnDeltaSegment({ snapshotSeq: 2, rows });
    expect(sha(once.text)).toBe(sha(twice.text));
    expect(once.text).toBe(twice.text);
  });

  it('is a tail append: the messages prefix keeps its exact bytes (criterion 4)', () => {
    const base: LLMMessage[] = [
      { role: 'system', content: 'stable system prompt' },
      { role: 'user', content: 'the task' },
      { role: 'assistant', content: 'working', toolCalls: [{ id: 'tc1', name: 'shell_execute', arguments: { command: 'ls' } }] },
      { role: 'tool', content: 'ok', toolCallId: 'tc1' },
    ];
    const emptySeg = buildTurnDeltaSegment({ snapshotSeq: 11, rows: [] });
    const realSeg = buildTurnDeltaSegment({
      snapshotSeq: 11,
      rows: [row({ id: 'mbx_x', sourceType: 'task_comment', seq: 12 })],
    });

    const withoutInjection = JSON.stringify(base);
    const withEmpty = [...base, turnDeltaMessage(emptySeg)];
    const withReal = [...base, turnDeltaMessage(realSeg)];

    // The prefix (everything the provider can cache) is byte-identical in all
    // three cases — injection only ever appends.
    expect(sha(JSON.stringify(withEmpty.slice(0, base.length)))).toBe(sha(withoutInjection));
    expect(sha(JSON.stringify(withReal.slice(0, base.length)))).toBe(sha(withoutInjection));
    expect(withEmpty).toHaveLength(base.length + 1);
    expect(withReal).toHaveLength(base.length + 1);
  });

  it('truncates ten facts to three lines plus "+7 more" (criterion 5)', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `mbx_${i}`, sourceType: 'task_comment', seq: 100 + i }),
    );
    const seg = buildTurnDeltaSegment({ snapshotSeq: 50, rows });

    expect(seg.entries).toHaveLength(TURN_DELTA_MAX_ITEMS);
    expect(seg.omitted).toBe(7);
    // `count` is the number of facts that arrived (10), not the number rendered:
    // reporting 7 would tell the model "you are missing nothing" while hiding 7.
    expect(seg.text).toContain('count: 10');
    expect(seg.text).toContain('+7 more');
    // The four facts past the budget must not be rendered as item lines.
    expect(seg.text).not.toContain('mbx_4');
    expect(seg.text).toContain('mbx_0');
    expect(seg.text).toContain('mbx_2');
  });

  it('never exceeds the character budget', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({
        id: `mbx_long_${i}`,
        sourceType: 'task_comment',
        seq: 200 + i,
        payload: { summary: 'x'.repeat(400), content: 'y'.repeat(400) },
      }),
    );
    const seg = buildTurnDeltaSegment({ snapshotSeq: 60, rows });
    expect(seg.text.length).toBeLessThanOrEqual(TURN_DELTA_MAX_CHARS);
  });

  it('carries supersedes on the line and cancels the turn on a contradiction', () => {
    const contradiction = row({
      id: 'mbx_stop',
      sourceType: 'task_status_update',
      seq: 9,
      envelope: { intent: 'deliver', invalidatesPremise: true, supersedes: ['mbx_plan_v1', 'mbx_plan_v2'] },
    });
    const seg = buildTurnDeltaSegment({ snapshotSeq: 8, rows: [contradiction] });

    expect(seg.decision).toBe('cancel');
    expect(seg.decisive?.id).toBe('mbx_stop');
    expect(seg.text).toContain('contradiction');
    expect(seg.text).toContain('mbx_plan_v1');
    expect(seg.text).toContain('mbx_plan_v2');
  });

  it('an authoritative fact alone does not cancel the turn', () => {
    const seg = buildTurnDeltaSegment({
      snapshotSeq: 8,
      rows: [
        row({
          id: 'mbx_auth',
          sourceType: 'task_status_update',
          seq: 9,
          envelope: { intent: 'action_required', invalidatesPremise: false, supersedes: null },
        }),
      ],
    });
    expect(seg.decision).toBe('continue');
    expect(seg.decisive).toBeNull();
    expect(seg.text).toContain('authoritative');
    expect(seg.text).toContain('count: 1');
  });

  it('orders entries by seq, not by input order', () => {
    const seg = buildTurnDeltaSegment({
      snapshotSeq: 0,
      rows: [
        row({ id: 'mbx_late', sourceType: 'task_comment', seq: 30 }),
        row({ id: 'mbx_early', sourceType: 'task_comment', seq: 10 }),
      ],
    });
    expect(seg.entries.map(e => e.id)).toEqual(['mbx_early', 'mbx_late']);
  });
});
