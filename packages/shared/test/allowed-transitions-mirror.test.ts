/**
 * Contract test across the build boundary: the web-ui transition mirror must equal
 * the shared matrices. This is the guard the previous "kept in sync manually"
 * comment never had — the comment even claimed a mirror test existed; it did not.
 */
import { describe, it, expect } from 'vitest';
import { TASK_TRANSITIONS } from '../src/types/task.js';
import { REQ_TRANSITIONS } from '../src/types/requirement.js';
import {
  TASK_ALLOWED_TRANSITIONS,
  REQ_ALLOWED_TRANSITIONS,
} from '../../web-ui/src/constants/allowedTransitions.js';

function driftOf(
  shared: Record<string, ReadonlySet<string>>,
  mirror: Record<string, ReadonlySet<string>>,
): string[] {
  const drift: string[] = [];
  for (const [from, tos] of Object.entries(shared)) {
    const m = mirror[from];
    if (!m) { drift.push(`${from}: missing from mirror`); continue; }
    const a = [...tos].sort().join(',');
    const b = [...m].sort().join(',');
    if (a !== b) drift.push(`${from}: shared=[${a}] mirror=[${b}]`);
  }
  for (const from of Object.keys(mirror)) {
    if (!(from in shared)) drift.push(`${from}: extra state in mirror`);
  }
  return drift;
}

describe('web-ui transition matrices mirror @markus/shared', () => {
  it('TASK_ALLOWED_TRANSITIONS === TASK_TRANSITIONS', () => {
    expect(driftOf(TASK_TRANSITIONS as unknown as Record<string, ReadonlySet<string>>, TASK_ALLOWED_TRANSITIONS)).toEqual([]);
  });

  it('REQ_ALLOWED_TRANSITIONS === REQ_TRANSITIONS', () => {
    expect(driftOf(REQ_TRANSITIONS as unknown as Record<string, ReadonlySet<string>>, REQ_ALLOWED_TRANSITIONS)).toEqual([]);
  });
});
