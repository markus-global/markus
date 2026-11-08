import type { ReactNode } from 'react';
import { chipSegments, type ChipSegment } from '../lib/chatChipDraft.ts';
import type { SentChip } from '../lib/chatChips.ts';
import { ChatChipPill } from './ChatChipPill.tsx';

/**
 * Render a SENT message body, re-highlighting the chips that travelled with it.
 *
 * The message text is the flat payload the model received (chip content inlined
 * at the position the user placed it). `chips` is the sidecar carrying each
 * chip's kind/label + offsets, so the bubble can show the same pill the composer
 * showed instead of a wall of `[terminal-selection] Terminal: …`.
 *
 * Two hard rules:
 *  1. Without a usable sidecar the caller's normal renderer is used unchanged —
 *     historical messages must look exactly as before (no regression, no error).
 *  2. When the sidecar does not fit the text (clipped content, foreign payload)
 *     `chipSegments` returns null and we fall back the same way. Nothing is ever
 *     reconstructed by searching the text for the label.
 */
export function ChatChipText({ text, chips, renderText, className }: {
  text: string;
  chips: SentChip[] | undefined;
  /** The message renderer the app already uses (mentions/highlighting). */
  renderText: (chunk: string) => ReactNode;
  className?: string;
}) {
  const segments: ChipSegment[] | null = chipSegments(text, chips);
  if (!segments) return <span className={className}>{renderText(text)}</span>;
  return (
    <span className={className} data-chips-rendered={segments.filter(s => s.type === 'chip').length}>
      {segments.map((seg, i) => (seg.type === 'text'
        ? <span key={`t${i}`}>{renderText(seg.text)}</span>
        : (
          <ChatChipPill
            key={`c${i}`}
            kind={seg.chip.kind}
            label={seg.chip.label}
            title={text.slice(seg.chip.offset, seg.chip.offset + seg.chip.length)}
            tone="ghost"
          />
        )))}
    </span>
  );
}
