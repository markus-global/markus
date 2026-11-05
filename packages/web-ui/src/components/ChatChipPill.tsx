import { useTranslation } from 'react-i18next';
import { CHIP_ICONS, chipKindI18nKey, type ChipKind } from '../lib/chatChips.ts';

/**
 * One chip pill: icon + TYPE WORD + title.
 *
 * The type used to be carried only by the emoji prefix inside the label, so the
 * reader had to memorise a glyph table. The word is now rendered from `kind`
 * (i18n, three locales) and the label stays purely a title. Used by the composer
 * strip, the sent bubble and the "send to chat" preview — one implementation, so
 * the three can never disagree about what a chip looks like.
 */
export function ChatChipPill({ kind, label, title, onRemove, removeLabel, tone = 'solid' }: {
  kind: ChipKind;
  label: string;
  /** Tooltip (usually the full chip payload). */
  title?: string;
  onRemove?: () => void;
  removeLabel?: string;
  /** `ghost` = read-only rendering inside a sent bubble. */
  tone?: 'solid' | 'ghost';
}) {
  const { t } = useTranslation(['team']);
  const kindWord = t(chipKindI18nKey(kind), { ns: 'team', defaultValue: kind });
  const toneClass = tone === 'solid'
    ? 'bg-brand-500/10 text-brand-500 border-brand-500/20'
    : 'bg-surface-secondary text-fg-secondary border-border-default';
  return (
    <span
      className={`inline-flex items-center gap-1 max-w-[260px] pl-2 pr-1 py-0.5 rounded-lg border text-xs ${toneClass}`}
      title={title}
      data-chip-kind={kind}
    >
      <span aria-hidden className="shrink-0 leading-none">{CHIP_ICONS[kind]}</span>
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide opacity-80">{kindWord}</span>
      <span className="truncate min-w-0">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="w-4 h-4 flex items-center justify-center rounded hover:bg-brand-500/20 shrink-0"
          aria-label={removeLabel}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      )}
    </span>
  );
}
