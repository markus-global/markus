/**
 * The sent-bubble side of card 7 ⑩: a message that travelled with a chip sidecar
 * must render the SAME pill the composer showed, and a message without one must
 * render exactly as before.
 *
 * These assertions are deliberately about rendered output (kind word + title in
 * the DOM), not about "did we call a function" — a regression that drops the
 * sidecar or mis-places the offsets has to turn these red.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => {
  const t = (key: string, opts?: unknown) => {
    const fallback = (opts as { defaultValue?: string } | undefined)?.defaultValue ?? key;
    return fallback;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

import { ChatChipText } from '../src/components/ChatChipText.tsx';
import { serializeDraft, serializeDraftForSend, insertChip } from '../src/lib/chatChipDraft.ts';
import { normalizeSentChips } from '../src/lib/chatChips.ts';

const plain = (chunk: string) => chunk;

const fileChip = (id = 'c1') => ({
  id, kind: 'file' as const, label: 'a.ts', content: '[file]\nPath: /a.ts',
});

describe('ChatChipText — sent bubble re-highlights chips from the sidecar', () => {
  it('renders the chip pill (kind + title) instead of the raw payload', () => {
    const chip = { id: 'c1', kind: 'file' as const, label: 'a.md', content: '[file]\nPath: /tmp/a.md' };
    const { draft } = insertChip({ text: 'please check', chips: [] }, chip, 0);
    const sent = serializeDraft(draft);

    const { container } = render(<ChatChipText text={sent.text} chips={sent.chips} renderText={plain} />);

    // The pill is present, with its kind word and title…
    expect(container.querySelector('[data-chip-kind="file"]')).not.toBeNull();
    // The kind is rendered as a WORD (CSS uppercases it; DOM text is the fallback).
    expect(screen.getByText(/^file$/i)).toBeTruthy();
    expect(screen.getByText('a.md')).toBeTruthy();
    // …and the raw marker is NOT dumped into the bubble as text.
    const shown = container.textContent ?? '';
    expect(shown).not.toContain('[file]');
    expect(shown).toContain('please check');
    expect(container.querySelector('[data-chips-rendered]')?.getAttribute('data-chips-rendered')).toBe('1');
  });

  it('renders the surrounding prose in order, around the chip', () => {
    const chip = { id: 'c1', kind: 'task' as const, label: 'T1', content: '[task]\nID: t1' };
    const { draft } = insertChip({ text: 'before after', chips: [] }, chip, 7);
    const sent = serializeDraft(draft);
    const { container } = render(<ChatChipText text={sent.text} chips={sent.chips} renderText={plain} />);
    const text = container.textContent ?? '';
    expect(text.indexOf('before')).toBeLessThan(text.indexOf('T1'));
    expect(text.indexOf('T1')).toBeLessThan(text.indexOf('after'));
  });

  it('falls back to plain text for a message without a sidecar (older rows)', () => {
    const { container } = render(
      <ChatChipText text={'hello [file]\nPath: /a.md'} chips={undefined} renderText={plain} />,
    );
    expect(container.querySelector('[data-chip-kind]')).toBeNull();
    // Byte-for-byte the old behaviour, markers included.
    expect(container.textContent).toBe('hello [file]\nPath: /a.md');
  });

  it('falls back when the sidecar does not fit the text (clipped/foreign payload)', () => {
    const { container } = render(
      <ChatChipText
        text="truncated"
        chips={[{ kind: 'file', label: 'a.md', offset: 5, length: 999 }]}
        renderText={plain}
      />,
    );
    expect(container.querySelector('[data-chip-kind]')).toBeNull();
    expect(container.textContent).toBe('truncated');
  });

  it('accepts a server round-trip: persisted placements are valid input again', () => {
    const chip = { id: 'c1', kind: 'web' as const, label: 'example.com', content: '[html-selection]\nText: "hi"' };
    const { draft } = insertChip({ text: 'look', chips: [] }, chip, 0);
    const sent = serializeDraft(draft);
    // What the server stores is plain JSON; what comes back is untrusted.
    const roundTripped = normalizeSentChips(JSON.parse(JSON.stringify(sent.chips)));
    const { container } = render(<ChatChipText text={sent.text} chips={roundTripped} renderText={plain} />);
    expect(container.querySelector('[data-chip-kind="web"]')).not.toBeNull();
  });
});

/**
 * The seam that shipped broken: `send()` normalises the draft before putting it on
 * the wire, so the sidecar offsets must be computed against the NORMALISED text.
 *
 * These drive the exact production path — `serializeDraftForSend` (what
 * useChatStream.send calls) → the transport's text → `chipSegments` → `ChatChipText`
 * — with drafts that start with whitespace, which is ordinary authoring (press
 * Enter first, paste indented text, start with a blank line) and was silently
 * corrupting both the offsets and the rendered pill title.
 */
describe('ChatChipText — offsets survive send-time normalisation', () => {
  const assertBubble = (draftText: string, caret: number) => {
    const { draft } = insertChip({ text: draftText, chips: [] }, fileChip(), caret);
    const sent = serializeDraftForSend(draft);

    // ── The wire, mirrored from useChatStream.send ────────────────────────────
    // `send()` puts `sent.text` on the wire. Historically it ALSO trimmed here,
    // which shifted every offset behind the sidecar's back. The helper owes us a
    // text that is already normalised, so this trim is a no-op — assert that, and
    // assert the offsets land on the content in the bytes actually transmitted.
    const wireText = sent.text.trim();
    expect(wireText).toBe(sent.text);
    for (const c of sent.chips) {
      expect(wireText.slice(c.offset, c.offset + c.length)).toBe(fileChip().content);
    }

    const { container } = render(<ChatChipText text={wireText} chips={sent.chips} renderText={plain} />);

    // (a) the pill exists and its title is the chip's content VERBATIM
    const pill = container.querySelector('[data-chip-kind="file"]');
    expect(pill).not.toBeNull();
    const title = pill!.getAttribute('title') ?? pill!.textContent ?? '';
    expect(title).toContain('[file]');
    expect(title).toContain('Path: /a.ts');
    expect(title).not.toMatch(/^le\]|a\.ts nd/); // the corrupt slice from the review
    // (b) the raw marker is not dumped into the bubble body
    expect(container.textContent ?? '').not.toContain('[file]');
    expect(container.querySelector('[data-chips-rendered]')).not.toBeNull();
  };

  it('leading newline (press Enter, then attach a chip)', () => {
    assertBubble('\n', 1);
  });

  it('leading spaces (indented paste, chip placed mid-line)', () => {
    assertBubble('   pasted code line and a trailing note', 20);
  });

  it('leading blank line with prose after the chip', () => {
    assertBubble('\n\nplease review this', 0);
  });
});
