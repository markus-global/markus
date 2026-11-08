import { describe, it, expect } from 'vitest';
import {
  emptyDraft, insertChip, removeChip, removeChipAt, reconcileEdit, serializeDraft,
  serializeDraftForSend, trimDraft, chipSegments, chipDisplayText, appendChips,
  type ChipDraft, type DraftChip,
} from './chatChipDraft.ts';
import type { ChatChip } from './chatChips.ts';

const fileChip = (id = 'c1'): ChatChip => ({
  id, kind: 'file', label: 'a.md', content: '[file]\nPath: /tmp/a.md',
});
const taskChip = (id = 'c2'): ChatChip => ({
  id, kind: 'task', label: 'T1', content: '[task]\nID: t1',
});

describe('chipDisplayText', () => {
  it('renders icon + label inside a bracketed token (display only)', () => {
    expect(chipDisplayText(fileChip())).toBe('[📄 a.md]');
    expect(chipDisplayText(taskChip())).toBe('[✅ T1]');
  });

  it('never emits a newline — a multi-line selection becomes one line', () => {
    const selection: ChatChip = {
      id: 'c9',
      kind: 'terminal',
      label: 'total 4\n-rw-r--r-- 1 me  staff  12 Nov  8 a.txt',
      content: '[terminal-selection]\nTerminal: bash (t1)\n"""\ntotal 4\n-rw-r--r-- 1 me  staff  12 Nov  8 a.txt\n"""',
    };
    const token = chipDisplayText(selection);
    expect(token).not.toContain('\n');
    // Column alignment (runs of spaces) collapses too: the pill is a title, not a table.
    expect(token).toBe('[⌘ total 4 -rw-r--r-- 1 me staff 12 Nov 8 a.txt]');
  });
});

describe('insertChip', () => {
  it('inserts at the caret, not at the end', () => {
    const base: ChipDraft = { text: 'hello world', chips: [] };
    const { draft, caret } = insertChip(base, fileChip(), 5);
    // Exactly one space on each side — the token must not create a double gap.
    expect(draft.text).toBe('hello [📄 a.md] world');
    expect(draft.chips).toHaveLength(1);
    expect(draft.chips[0]!.start).toBe(6);
    expect(draft.text.slice(draft.chips[0]!.start, draft.chips[0]!.end)).toBe('[📄 a.md]');
    // Caret lands right after the token, before the trailing space.
    expect(draft.text.slice(caret)).toBe(' world');
  });

  it('shifts existing chips that sit after the insertion point', () => {
    const first = insertChip(emptyDraft(), fileChip(), 0).draft;
    const { draft } = insertChip(first, taskChip(), 0);
    expect(draft.chips.map(c => c.id)).toEqual(['c2', 'c1']);
    expect(draft.text.slice(draft.chips[0]!.start, draft.chips[0]!.end)).toBe('[✅ T1]');
    expect(draft.text.slice(draft.chips[1]!.start, draft.chips[1]!.end)).toBe('[📄 a.md]');
  });

  it('clamps a caret outside the text instead of throwing', () => {
    const { draft } = insertChip({ text: 'ab', chips: [] }, fileChip(), 99);
    expect(draft.text.endsWith('[📄 a.md] ')).toBe(true);
  });
});

describe('removeChip / removeChipAt', () => {
  it('removes the token text and shifts the chips after it', () => {
    let { draft } = insertChip(emptyDraft(), fileChip(), 0);
    draft = insertChip(draft, taskChip(), draft.text.length).draft;
    const out = removeChip(draft, 'c1').draft;
    expect(out.text).not.toContain('[📄 a.md]');
    expect(out.chips.map(c => c.id)).toEqual(['c2']);
    expect(out.text.slice(out.chips[0]!.start, out.chips[0]!.end)).toBe('[✅ T1]');
  });

  it('removeChipAt hit-tests a character index inside the token', () => {
    const { draft } = insertChip(emptyDraft(), fileChip(), 0);
    const inside = draft.chips[0]!.start + 2;
    expect(removeChipAt(draft, inside)?.draft.chips).toHaveLength(0);
    expect(removeChipAt(draft, 999)).toBeNull();
  });
});

describe('reconcileEdit — one edit region, structural consequences', () => {
  const base = (): ChipDraft => {
    const a = insertChip({ text: 'one two three', chips: [] }, fileChip(), 3).draft;
    return a;
  };

  it('keeps chips untouched for an edit before them (and shifts them)', () => {
    const start = base();
    const next = `XX${start.text}`;
    const out = reconcileEdit(start, next);
    expect(out.chips).toHaveLength(1);
    expect(out.chips[0]!.start).toBe(start.chips[0]!.start + 2);
    expect(out.text.slice(out.chips[0]!.start, out.chips[0]!.end)).toBe('[📄 a.md]');
  });

  it('eats the WHOLE chip when one character inside it is deleted (backspace)', () => {
    const start = base();
    const chip = start.chips[0]!;
    // Simulate backspace on the character right after the token start.
    const next = start.text.slice(0, chip.start + 1) + start.text.slice(chip.start + 2);
    const out = reconcileEdit(start, next);
    expect(out.chips).toHaveLength(0);
    expect(out.text).not.toContain('📄');
  });

  it('leaves chips alone for a plain edit elsewhere', () => {
    const start = base();
    const out = reconcileEdit(start, `${start.text}!`);
    expect(out.chips).toHaveLength(1);
    expect(out.text.slice(out.chips[0]!.start, out.chips[0]!.end)).toBe('[📄 a.md]');
  });

  it('is idempotent for an unchanged text (same object, no churn)', () => {
    const start = base();
    expect(reconcileEdit(start, start.text)).toBe(start);
  });

  it('never leaves a chip whose range no longer fits the text', () => {
    const start = base();
    const out = reconcileEdit(start, '');
    expect(out.chips).toHaveLength(0);
    expect(out.text).toBe('');
  });
});

describe('serializeDraft', () => {
  it('substitutes chip content IN PLACE and reports offsets in the sent text', () => {
    const { draft } = insertChip({ text: 'look at this please', chips: [] }, fileChip(), 8);
    const out = serializeDraft(draft);
    // The token is replaced in place — the user's trailing words survive it.
    expect(out.text).toBe('look at [file]\nPath: /tmp/a.md this please');
    expect(out.text).toContain('[file]');
    expect(out.chips).toHaveLength(1);
    const chip = out.chips[0]!;
    expect(out.text.slice(chip.offset, chip.offset + chip.length)).toBe('[file]\nPath: /tmp/a.md');
  });

  it('gives the session title the user words only — never the chip payload', () => {
    const { draft } = insertChip({ text: 'explain  this', chips: [] }, fileChip(), 8);
    const out = serializeDraft(draft);
    expect(out.titleSource).toBe('explain this');
    expect(out.titleSource).not.toContain('[file]');
  });

  it('keeps order and offsets correct for two chips', () => {
    let { draft } = insertChip({ text: 'A B', chips: [] }, fileChip(), 0);
    draft = insertChip(draft, taskChip(), draft.text.length).draft;
    const out = serializeDraft(draft);
    expect(out.chips).toHaveLength(2);
    expect(out.chips[0]!.kind).toBe('file');
    expect(out.chips[1]!.kind).toBe('task');
    expect(out.chips[0]!.offset).toBeLessThan(out.chips[1]!.offset);
    for (const c of out.chips) {
      const body = c.kind === 'file' ? '[file]\nPath: /tmp/a.md' : '[task]\nID: t1';
      expect(out.text.slice(c.offset, c.offset + c.length)).toBe(body);
    }
  });

  it('produces plain text unchanged when there is no chip', () => {
    const out = serializeDraft({ text: 'just words', chips: [] });
    expect(out).toEqual({ text: 'just words', titleSource: 'just words', chips: [] });
  });
});

describe('chipSegments — the sent-bubble renderer contract', () => {
  it('splits prose and chips by the stored offsets', () => {
    const text = 'see [file]\nPath: /a.md then done';
    const body = '[file]\nPath: /a.md';
    const segs = chipSegments(text, [{ kind: 'file', label: 'a.md', offset: 4, length: body.length }]);
    expect(segs).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'chip', chip: { kind: 'file', label: 'a.md', offset: 4, length: body.length } },
      { type: 'text', text: ' then done' },
    ]);
  });

  it('round-trips what serializeDraft produced', () => {
    const { draft } = insertChip({ text: 'check this', chips: [] }, fileChip(), 6);
    const sent = serializeDraft(draft);
    const segs = chipSegments(sent.text, sent.chips)!;
    const rebuilt = segs.map(s => (s.type === 'text' ? s.text : sent.text.slice(s.chip.offset, s.chip.offset + s.chip.length))).join('');
    expect(rebuilt).toBe(sent.text);
    expect(segs.filter(s => s.type === 'chip')).toHaveLength(1);
  });

  it('refuses offsets that do not fit (caller falls back to plain text)', () => {
    expect(chipSegments('short', [{ kind: 'file', label: 'x', offset: 2, length: 99 }])).toBeNull();
    expect(chipSegments('short', [{ kind: 'file', label: 'x', offset: 9, length: 1 }])).toBeNull();
    expect(chipSegments('short', undefined)).toBeNull();
    expect(chipSegments('short', [])).toBeNull();
  });
});

describe('insertChip — the caret can land inside an existing token', () => {
  it('removes the straddled chip instead of leaving a stale range', () => {
    // Chip 1 occupies [6,15) in `hello [📄 a.md] `.
    const first = insertChip({ text: 'hello ', chips: [] }, fileChip(), 6);
    expect(first.draft.text.slice(first.draft.chips[0]!.start, first.draft.chips[0]!.end)).toBe('[📄 a.md]');
    // Drop a second chip at index 9 — INSIDE chip 1's token.
    const inside = first.draft.chips[0]!.start + 3;
    const second = insertChip(first.draft, taskChip(), inside);

    // Invariant 3 of the module: an edit touching a range removes the WHOLE chip.
    // A surviving-but-stale chip 1 is what produced `[file] a.ts] a.ts]` payloads.
    expect(second.draft.chips.map(c => c.id)).toEqual(['c2']);
    for (const c of second.draft.chips) {
      expect(second.draft.text.slice(c.start, c.end)).toBe(chipDisplayText(c));
    }
    // Serialisation must not emit a phantom second chip.
    const sent = serializeDraft(second.draft);
    expect(sent.chips).toHaveLength(1);
    expect(sent.text).not.toContain('📄');
  });

  it('still inserts normally at a chip boundary (before / after the token)', () => {
    const first = insertChip({ text: 'hello ', chips: [] }, fileChip(), 6);
    const chip = first.draft.chips[0]!;
    const before = insertChip(first.draft, taskChip(), chip.start);
    expect(before.draft.chips.map(c => c.id)).toEqual(['c2', 'c1']);
    for (const c of before.draft.chips) {
      expect(before.draft.text.slice(c.start, c.end)).toBe(chipDisplayText(c));
    }
  });
});

describe('trimDraft — ranges must survive normalisation', () => {
  it('shifts a chip left by the leading whitespace it removed', () => {
    const { draft } = insertChip({ text: '   hello', chips: [] }, fileChip(), 8);
    const trimmed = trimDraft(draft);
    expect(trimmed.text).toBe('hello [📄 a.md]');
    expect(trimmed.chips).toHaveLength(1);
    expect(trimmed.text.slice(trimmed.chips[0]!.start, trimmed.chips[0]!.end)).toBe('[📄 a.md]');
  });

  it('drops a chip whose range only partially survives (never half a pill)', () => {
    // A hand-built chip that the trim boundary cuts in half — the model has to
    // refuse it rather than highlight the wrong span.
    const draft: ChipDraft = {
      text: '  abc  ',
      chips: [{ id: 'x', kind: 'file', label: 'a', content: 'CONTENT', start: 1, end: 5 }],
    };
    expect(trimDraft(draft).chips).toHaveLength(0);
  });

  it('is a no-op (same object) when the text is already trimmed', () => {
    const draft: ChipDraft = { text: 'hello', chips: [] };
    expect(trimDraft(draft)).toBe(draft);
  });
});

describe('serializeDraftForSend — the ONE function send() calls', () => {
  const chipContent = '[file]\nPath: /tmp/a.md';

  const assertConsistent = (sent: ReturnType<typeof serializeDraftForSend>) => {
    // 1) The text is already normalised: any further trim would be a no-op, so the
    //    seam cannot shift the offsets behind our back.
    expect(sent.text).toBe(sent.text.trim());
    // 2) Every offset lands exactly on its chip's content.
    for (const c of sent.chips) {
      expect(sent.text.slice(c.offset, c.offset + c.length)).toBe(chipContent);
    }
  };

  it('leading NEWLINE (press Enter first, then add a chip) keeps offsets honest', () => {
    const { draft } = insertChip({ text: '\n', chips: [] }, fileChip(), 1);
    assertConsistent(serializeDraftForSend(draft));
    // The reviewer's repro: pre-fix this produced {offset:1,length:18} against an
    // 18-char text → offset+length > length → placement dropped on both sides.
    const sent = serializeDraftForSend(draft);
    expect(sent.chips[0]!.offset + sent.chips[0]!.length).toBeLessThanOrEqual(sent.text.length);
    // Segmentation must therefore succeed rather than fall back to raw text.
    expect(chipSegments(sent.text, sent.chips)).not.toBeNull();
  });

  it('leading SPACES (indented paste, then place a chip mid-line) keep offsets honest', () => {
    const { draft } = insertChip({ text: '   hello world and a long tail here', chips: [] }, fileChip(), 16);
    assertConsistent(serializeDraftForSend(draft));
    const sent = serializeDraftForSend(draft);
    expect(chipSegments(sent.text, sent.chips)).not.toBeNull();
    // The user's words on both sides of the chip survive in order.
    const segs = chipSegments(sent.text, sent.chips)!;
    const joined = segs.map(s => (s.type === 'text' ? s.text : '')).join('');
    expect(joined).toContain('hello world');
    expect(joined).toContain('long tail here');
  });

  it('leaves a clean draft byte-identical to serializeDraft', () => {
    const { draft } = insertChip({ text: 'a b', chips: [] }, fileChip(), 0);
    expect(serializeDraftForSend(draft)).toEqual(serializeDraft(draft));
  });

  it('trims whitespace-only prose but keeps titleSource free of chip payload', () => {
    const { draft } = insertChip({ text: '  ', chips: [] }, fileChip(), 2);
    const sent = serializeDraftForSend(draft);
    expect(sent.titleSource).toBe('');
    expect(sent.titleSource).not.toContain('[file]');
  });
});

describe('appendChips — right panel / navigation path', () => {
  it('appends each chip at the end on its own line', () => {
    const { draft } = appendChips({ text: 'hi there', chips: [] }, [fileChip()]);
    expect(draft.text).toBe('hi there\n[📄 a.md] ');
    expect(draft.chips).toHaveLength(1);
  });

  it('appends several chips in order', () => {
    const { draft } = appendChips(emptyDraft(), [fileChip(), taskChip()]);
    expect(draft.chips.map((c: DraftChip) => c.id)).toEqual(['c1', 'c2']);
    for (const c of draft.chips) {
      expect(draft.text.slice(c.start, c.end)).toBe(chipDisplayText(c));
    }
  });
});
