import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChatScrollMemory,
  captureChatScrollAnchor,
  findRowTopInViewport,
  pickAnchorRow,
  readRenderedRowOffsets,
  rowCorrection,
  scrollMemoryKey,
  type RowOffset,
  type ScrollAnchor,
} from './chatScrollRestore.ts';

/** viewport helper — 1000px tall content window, scrolled `scrollTop` px down. */
function view(scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
  return { scrollTop, scrollHeight, clientHeight };
}

const rows: RowOffset[] = [
  { id: 'a', start: 0 },
  { id: 'b', start: 200 },
  { id: 'c', start: 500 },
];

describe('scrollMemoryKey', () => {
  it('separates session tabs of the same conversation', () => {
    expect(scrollMemoryKey('agt_1', 'sess_a')).not.toBe(scrollMemoryKey('agt_1', 'sess_b'));
  });

  it('tolerates a missing conversation key or session id', () => {
    expect(scrollMemoryKey('', null)).toBe('_::');
    expect(scrollMemoryKey('ch:#general', undefined)).toBe('ch:#general::');
  });
});

describe('pickAnchorRow', () => {
  it('returns the last row at or above the viewport top', () => {
    expect(pickAnchorRow(rows, 250)?.id).toBe('b');
    expect(pickAnchorRow(rows, 200)?.id).toBe('b');
  });

  it('falls back to the first row when the viewport sits above every row', () => {
    expect(pickAnchorRow(rows, -50)?.id).toBe('a');
  });

  it('returns null when nothing is measurable', () => {
    expect(pickAnchorRow([], 100)).toBeNull();
  });
});

describe('captureChatScrollAnchor', () => {
  it('records the bottom — not an offset — when the user is at the bottom', () => {
    // distance from bottom = 0 → the follow loop should own this view.
    expect(captureChatScrollAnchor(rows, view(600))).toEqual({ kind: 'bottom' });
  });

  it('treats the epsilon band above the bottom as the bottom', () => {
    expect(captureChatScrollAnchor(rows, view(595))).toEqual({ kind: 'bottom' });
  });

  it('anchors on the row under the viewport top with the scrolled-past amount', () => {
    // scrollTop 250 → row b (start 200) is 50px above the viewport top.
    expect(captureChatScrollAnchor(rows, view(250))).toEqual({ kind: 'row', id: 'b', delta: 50 });
  });

  it('falls back to the bottom when no rows are rendered', () => {
    expect(captureChatScrollAnchor([], view(250))).toEqual({ kind: 'bottom' });
  });
});

describe('rowCorrection', () => {
  it('is zero when the row already sits where it was captured', () => {
    expect(rowCorrection(-50, 50)).toBe(0);
  });

  it('asks for the drift once rows above have been measured taller', () => {
    // the row is now 120px above the viewport top but was 50px when captured
    expect(rowCorrection(-120, 50)).toBe(-70);
  });

  it('pushes down when the row drifted below the viewport top', () => {
    expect(rowCorrection(30, 50)).toBe(80);
  });
});

describe('ChatScrollMemory', () => {
  let mem: ChatScrollMemory;
  beforeEach(() => { mem = new ChatScrollMemory(3); });

  it('round-trips an anchor', () => {
    const anchor: ScrollAnchor = { kind: 'row', id: 'm1', delta: 12 };
    mem.save('k', anchor);
    expect(mem.get('k')).toEqual(anchor);
  });

  it('returns null for an unknown or empty key', () => {
    expect(mem.get('nope')).toBeNull();
    expect(mem.get('')).toBeNull();
  });

  it('overwrites without growing', () => {
    mem.save('k', { kind: 'bottom' });
    mem.save('k', { kind: 'row', id: 'm1', delta: 1 });
    expect(mem.size).toBe(1);
    expect(mem.get('k')).toEqual({ kind: 'row', id: 'm1', delta: 1 });
  });

  it('ignores an empty key', () => {
    mem.save('', { kind: 'bottom' });
    expect(mem.size).toBe(0);
  });

  it('evicts least-recently-used entries beyond capacity', () => {
    mem.save('a', { kind: 'bottom' });
    mem.save('b', { kind: 'bottom' });
    mem.save('c', { kind: 'bottom' });
    mem.save('d', { kind: 'bottom' });
    expect(mem.get('a')).toBeNull();
    expect(mem.get('d')).toEqual({ kind: 'bottom' });
    expect(mem.size).toBe(3);
  });

  it('counts a read as recent use', () => {
    mem.save('a', { kind: 'bottom' });
    mem.save('b', { kind: 'bottom' });
    mem.save('c', { kind: 'bottom' });
    mem.get('a');
    mem.save('d', { kind: 'bottom' });   // should evict b, not a
    expect(mem.get('a')).toEqual({ kind: 'bottom' });
    expect(mem.get('b')).toBeNull();
  });

  it('clears everything', () => {
    mem.save('a', { kind: 'bottom' });
    mem.clear();
    expect(mem.size).toBe(0);
  });
});

// ─── DOM helpers ─────────────────────────────────────────────────────────────
// happy-dom has no layout engine, so these are driven by hand-rolled nodes: the
// helpers only ever read `scrollTop` / `getBoundingClientRect` / child lookups.

interface FakeRow { id: string; top: number }

/**
 * Minimal stand-in for the real row markup: rows are queried as `[data-index]`,
 * each containing the message node `[id^="msg-"]` that anchors are stored against.
 */
function fakeContainer(rowsIn: FakeRow[], scrollTop: number, containerTop = 0) {
  const rect = (top: number) => ({ top } as DOMRect);
  const msgNode = (row: FakeRow) => ({ id: `msg-${row.id}`, getBoundingClientRect: () => rect(row.top) });
  const rowNodes = rowsIn.map(row => ({
    id: `row-${row.id}`,
    getBoundingClientRect: () => rect(row.top),
    querySelector: (sel: string) => (sel.startsWith('[id^="msg-"]') ? msgNode(row) : null),
  }));
  // A row carrying no message label must be skipped — exercises the guard in
  // readRenderedRowOffsets.
  const unlabelled = {
    id: 'row-unlabelled',
    getBoundingClientRect: () => rect(999),
    querySelector: () => null,
  };
  return {
    scrollTop,
    getBoundingClientRect: () => rect(containerTop),
    querySelectorAll: (sel: string) =>
      sel === '[data-index]' ? [...rowNodes, unlabelled] : rowsIn.map(msgNode),
  } as unknown as HTMLElement;
}

describe('readRenderedRowOffsets', () => {
  it('converts viewport positions into content offsets and sorts them', () => {
    const el = fakeContainer([
      { id: 'b', top: 5 },      // 100px above the container top, 50px scrolled past
      { id: 'a', top: -95 },
    ], 150);
    expect(readRenderedRowOffsets(el)).toEqual([
      { id: 'a', start: 55 },
      { id: 'b', start: 155 },
    ]);
  });

  it('skips rows without a message label', () => {
    const el = fakeContainer([{ id: 'a', top: 0 }], 0);
    expect(readRenderedRowOffsets(el).map(r => r.id)).toEqual(['a']);
  });
});

describe('findRowTopInViewport', () => {
  it('finds a mounted anchor row', () => {
    const el = fakeContainer([{ id: 'a', top: -40 }, { id: 'b', top: 60 }], 100);
    expect(findRowTopInViewport(el, 'b')).toBe(60);
    expect(findRowTopInViewport(el, 'a')).toBe(-40);
  });

  it('returns null for a virtualized-away row', () => {
    const el = fakeContainer([{ id: 'a', top: 0 }], 0);
    expect(findRowTopInViewport(el, 'zz')).toBeNull();
  });
});

describe('capture → restore round trip', () => {
  it('re-derives the same visual position after the rows above grew', () => {
    // Captured: row 'a' sits 95px above the container top, view scrolled 150px.
    const elBefore = fakeContainer([{ id: 'a', top: -95 }], 150);
    const anchor = captureChatScrollAnchor(readRenderedRowOffsets(elBefore), view(150, 2000));
    expect(anchor).toEqual({ kind: 'row', id: 'a', delta: 95 });

    // Restored: everything above got measured 300px taller, so the row now sits
    // 205px BELOW the container top and the view has not moved yet. One pass must
    // pull the user back to exactly 95px into that row (150 + 300 = 450).
    const elAfter = fakeContainer([{ id: 'a', top: 205 }], 150);
    const correction = rowCorrection(findRowTopInViewport(elAfter, 'a')!, 95);
    expect(correction).toBe(300);
    expect(elAfter.scrollTop + correction).toBe(450);
  });

  it('a second pass is a no-op once the anchor is honoured', () => {
    const el = fakeContainer([{ id: 'a', top: -95 }], 450);
    expect(rowCorrection(findRowTopInViewport(el, 'a')!, 95)).toBe(0);
  });
});
