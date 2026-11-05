import { describe, it, expect } from 'vitest';
import { inferChipKind, normalizeChip, parseNavChips, isChipKind, type ChatChip } from './chatChips.ts';

const mkId = (() => {
  let n = 0;
  return () => `id_${++n}`;
})();

describe('inferChipKind', () => {
  it('reads the structured marker in content before any label prefix', () => {
    expect(inferChipKind('[deliverable]\nID: d1', '📄 任意标题')).toBe('deliverable');
    expect(inferChipKind('[file]\nPath: /a/b.ts', '📄 b.ts')).toBe('file');
    expect(inferChipKind('[terminal-selection]\nTerminal: bash', '⌘ ls')).toBe('terminal');
    expect(inferChipKind('[terminal-output]\nTerminal: bash', '⌘ ls')).toBe('terminal');
    expect(inferChipKind('[html-selection]\nText: "hi"', '🌐 hi')).toBe('web');
  });

  it('falls back to the legacy label prefix when no marker is present', () => {
    expect(inferChipKind('some raw text', '📄 notes.md')).toBe('file');
    expect(inferChipKind('some raw text', '⌘ ls -la')).toBe('terminal');
    expect(inferChipKind('some raw text', '🌐 example.com/page')).toBe('web');
    expect(inferChipKind('some raw text', '“quoted words”')).toBe('selection');
  });

  it('never guesses a kind out of thin air', () => {
    expect(inferChipKind('plain payload', 'plain label')).toBe('note');
    expect(inferChipKind('', '')).toBe('note');
  });

  it('does not let a marker deeper in the text override a real one earlier', () => {
    // [deliverable] is listed before [file]: the first recognised marker wins.
    expect(inferChipKind('[deliverable]\npath: [file]', '')).toBe('deliverable');
  });
});

describe('normalizeChip', () => {
  it('keeps an explicit kind and never re-derives it', () => {
    const chip = normalizeChip({ kind: 'task', label: '📄 misleading', content: '[file]\nx' }, mkId);
    expect(chip?.kind).toBe('task');
  });

  it('resolves a legacy chip exactly once, then carries kind', () => {
    const legacy = { label: '⌘ npm test', content: '[terminal-selection]\nTerminal: bash' };
    const chip = normalizeChip(legacy, mkId);
    expect(chip).toEqual({ id: expect.any(String), kind: 'terminal', label: '⌘ npm test', content: legacy.content });
    // A second pass must not change the answer.
    const again = normalizeChip(chip, mkId);
    expect(again?.kind).toBe('terminal');
  });

  it('rejects empty content instead of shipping an empty chip', () => {
    expect(normalizeChip({ label: 'x', content: '   ' }, mkId)).toBeNull();
    expect(normalizeChip(null, mkId)).toBeNull();
  });

  it('treats an unknown kind as missing (and infers)', () => {
    const chip = normalizeChip({ kind: 'bogus', label: '📄 a.md', content: 'x' }, mkId);
    expect(chip?.kind).toBe('file');
  });

  it('falls back to a readable label when the producer forgot one', () => {
    const chip = normalizeChip({ content: '[file]\nPath: /a' }, mkId);
    expect(chip?.label).toBe('Context');
  });
});

describe('parseNavChips', () => {
  it('parses a legacy JSON array (no kind) into normalised chips', () => {
    const raw = JSON.stringify([{ label: '📄 a.md', content: '[file]\nPath: /a.md' }]);
    const chips = parseNavChips(raw, mkId);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.kind).toBe('file');
  });

  it('preserves an explicit kind through navigation', () => {
    const raw = JSON.stringify([{ kind: 'requirement', label: 'req', content: '[requirement]\nID: r1' }]);
    expect(parseNavChips(raw, mkId)[0]!.kind).toBe('requirement');
  });

  it('returns [] for malformed input instead of throwing', () => {
    expect(parseNavChips('{not json', mkId)).toEqual([]);
    expect(parseNavChips(null, mkId)).toEqual([]);
    expect(parseNavChips(JSON.stringify({ nope: true }), mkId)).toEqual([]);
  });

  it('drops entries with no usable payload', () => {
    const raw = JSON.stringify([{ label: 'empty', content: '' }, { label: 'ok', content: 'x' }]);
    expect(parseNavChips(raw, mkId)).toHaveLength(1);
  });
});

describe('isChipKind', () => {
  it('accepts exactly the known kinds', () => {
    const chip: ChatChip = { id: '1', kind: 'web', label: 'l', content: 'c' };
    expect(isChipKind(chip.kind)).toBe(true);
    expect(isChipKind('nope')).toBe(false);
    expect(isChipKind(undefined)).toBe(false);
  });
});
