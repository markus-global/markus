import { describe, it, expect } from 'vitest';
import { CHIP_ICONS, CHIP_KINDS, inferChipKind, normalizeChip, oneLineLabel, parseNavChips, isChipKind, type ChatChip } from './chatChips.ts';

const mkId = (() => {
  let n = 0;
  return () => `id_${++n}`;
})();

describe('一个标签只允许一个图标（类型只能由 kind 承载）', () => {
  it('旧式 `[图标类型] ` 前缀被去掉，label 只剩标题', () => {
    const chip = normalizeChip(
      { kind: 'deliverable', label: '[📦交付物] 交付说明：问题证据', content: '[deliverable]\nID: d1' },
      mkId,
    );
    expect(chip?.label).toBe('交付说明：问题证据');
    expect(chip?.kind).toBe('deliverable');
  });

  it('裸 emoji 前缀（📄 / ⌘ / 🌐 / “）同样被去掉', () => {
    expect(normalizeChip({ label: '📄 notes.md', content: '[file]\nPath: /a' }, mkId)?.label).toBe('notes.md');
    expect(normalizeChip({ label: '⌘ ls -la', content: '[terminal-output]\nT' }, mkId)?.label).toBe('ls -la');
    expect(normalizeChip({ label: '🌐 example.com', content: '[html-selection]\nx' }, mkId)?.label).toBe('example.com');
  });

  it('不是类型标记的方括号标题原样保留（[WIP] 不能被误吃）', () => {
    expect(normalizeChip({ label: '[WIP] 草稿', content: '[file]\nx' }, mkId)?.label).toBe('[WIP] 草稿');
  });

  it('每个 kind 都有图标 —— 映射必须是满射，读者不该靠记忆猜', () => {
    for (const kind of CHIP_KINDS) expect(CHIP_ICONS[kind], kind).toBeTruthy();
  });

  it('workflow / project / agent 是正式 kind，不再掉进 note', () => {
    expect(isChipKind('workflow')).toBe(true);
    expect(isChipKind('project')).toBe(true);
    expect(isChipKind('agent')).toBe(true);
    expect(inferChipKind('[deliverable]\nx', '')).toBe('deliverable');
  });
});

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
    // Kind is resolved from the legacy prefix; the label is cleaned at the same
    // boundary, because the pill renders icon + type word + title from `kind`.
    expect(chip).toEqual({ id: expect.any(String), kind: 'terminal', label: 'npm test', content: legacy.content });
    // A second pass must not change the answer (idempotent).
    const again = normalizeChip(chip, mkId);
    expect(again?.kind).toBe('terminal');
    expect(again?.label).toBe('npm test');
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

/**
 * Owner-reported (2026-11-08): a multi-line terminal selection produced a chip
 * whose label still held the newlines, so the `[⌘ …]` token in the composer wrapped
 * onto several lines. A label is a one-line title; the payload keeps the newlines.
 */
describe('a chip label is one line', () => {
  it('collapses every whitespace run to a single space', () => {
    expect(oneLineLabel('line one\nline two')).toBe('line one line two');
    expect(oneLineLabel('a\r\nb\tc   d')).toBe('a b c d');
    expect(oneLineLabel('\n\n  padded  \n')).toBe('padded');
  });

  it('keeps the payload untouched — only the display string is collapsed', () => {
    const content = '[terminal-selection]\nTerminal: bash\n"""\nls\npwd\n"""';
    const chip = normalizeChip({ kind: 'terminal', label: '⌘ ls\npwd', content }, mkId);
    expect(chip?.label).toBe('ls pwd');
    expect(chip?.content).toBe(content);
    expect(chip?.label).not.toContain('\n');
  });
});
