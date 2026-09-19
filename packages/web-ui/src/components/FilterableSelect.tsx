import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small combobox: dropdown selection **and** type-to-filter on the same field.
 *
 * Why not a native `<select>`: model ids are long (`claude-sonnet-4-5-20250929`)
 * and a provider can expose dozens of them, so scrolling a native list is the
 * slow path. With a filterable field the user types three characters and hits
 * Enter.
 *
 * Why not the existing `ModelSelect`: that one is a routing picker — its value
 * is `provider/modelId` and its options are grouped by provider. Here we have a
 * flat list of ids for a *single* provider, plus an "empty value" row (meaning
 * "use the provider default"). Reusing it would have meant lying about the
 * value shape. This component is the generic primitive instead.
 *
 * Behaviour worth knowing (all covered by `test/FilterableSelect.test.tsx`):
 *   • Clicking (`onMouseDown`) an option selects it — selection must happen
 *     before the input blurs, otherwise the closing menu swallows the click.
 *   • Opening selects the whole text so the first keystroke replaces it; the
 *     pre-filled text is NOT treated as a query until the user actually edits.
 *   • Escape / Tab / clicking away revert the field to the current selection —
 *     a half-typed query never becomes a value by accident.
 *   • When `customHint` is given, a free-form row is offered for typed text that
 *     matches no option, so ids missing from the catalog can still be used.
 *   • The menu is portalled to `document.body` with fixed positioning. It has to
 *     be: the settings provider cards are `rounded-xl overflow-hidden`, so an
 *     in-flow dropdown gets clipped at the card edge. Fixed coordinates also
 *     survive the page being long and scrollable (tracked via scroll/resize).
 */

export type FilterableSelectOption =
  | string
  | { value: string; label?: string; hint?: string };

interface Props {
  value: string;
  options: FilterableSelectOption[];
  onChange: (value: string) => void;
  /** Label of the empty-value row; its presence enables "back to default". */
  placeholder?: string;
  filterPlaceholder?: string;
  emptyText?: string;
  /** Renders the "use what I typed instead" row. Static text or a formatter. */
  customHint?: string | ((text: string) => string);
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface Row {
  value: string;
  label: string;
  hint?: string;
  custom?: boolean;
}

function normalize(opt: FilterableSelectOption): Row {
  return typeof opt === 'string'
    ? { value: opt, label: opt }
    : { value: opt.value, label: opt.label ?? opt.value, hint: opt.hint };
}

/**
 * Token AND-match (every whitespace-separated token must appear somewhere), so
 * `sonnet 4.5` still finds `claude-sonnet-4-5`. Prefix/word-boundary hits are
 * ranked above mid-string ones, which keeps the obvious candidate on top.
 */
function scoreRow(row: Row, tokens: string[], query: string): number | null {
  const label = row.label.toLowerCase();
  const value = row.value.toLowerCase();
  const hay = `${label} ${value} ${(row.hint ?? '').toLowerCase()}`;
  for (const token of tokens) {
    if (!hay.includes(token)) return null;
  }
  if (label.startsWith(query) || value.startsWith(query)) return 0;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[\\s./:_-])${escaped}`).test(label)) return 1;
  return 2;
}

export function FilterableSelect({
  value,
  options,
  onChange,
  placeholder,
  filterPlaceholder,
  emptyText,
  customHint,
  disabled,
  ariaLabel,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const selectedLabel = useMemo(() => {
    if (!value) return placeholder ?? '';
    return options.map(normalize).find(o => o.value === value)?.label ?? value;
  }, [value, options, placeholder]);

  useEffect(() => {
    if (!open) {
      setQuery(selectedLabel);
      setDirty(false);
    }
  }, [selectedLabel, open]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return; // the portalled menu is "inside"
      if (containerRef.current && !containerRef.current.contains(t)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  /**
   * Fixed coordinates from the input's rect, re-measured while open so the menu
   * follows scrolling and flips above the field when there is no room below.
   */
  function positionMenu() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 240);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const flipUp = spaceBelow < 180 && r.top > spaceBelow;
    setMenuStyle({
      position: 'fixed',
      left: r.left,
      width,
      maxHeight: Math.min(260, flipUp ? Math.max(r.top - 12, 120) : spaceBelow),
      ...(flipUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    const onScrollOrResize = () => positionMenu();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = options.map(normalize);
    const trimmed = query.trim();
    const tokens = dirty ? trimmed.toLowerCase().split(/\s+/).filter(Boolean) : [];

    const scored: Array<{ row: Row; score: number; idx: number }> = [];
    all.forEach((row, idx) => {
      const score = tokens.length ? scoreRow(row, tokens, trimmed.toLowerCase()) : 0;
      if (score !== null) scored.push({ row, score, idx });
    });
    scored.sort((a, b) => (a.score - b.score) || (a.idx - b.idx));

    const out: Row[] = [];
    if (placeholder !== undefined) {
      const defaultRow: Row = { value: '', label: placeholder };
      const score = tokens.length ? scoreRow(defaultRow, tokens, trimmed.toLowerCase()) : 0;
      if (score !== null) out.push(defaultRow);
    }
    out.push(...scored.map(s => s.row));

    const isNew = trimmed && !all.some(o => o.value.toLowerCase() === trimmed.toLowerCase());
    if (customHint && dirty && isNew) out.push({ value: trimmed, label: trimmed, custom: true });
    return out;
  }, [options, query, dirty, placeholder, customHint]);

  useEffect(() => {
    if (!open || focusIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${focusIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, open, rows.length]);

  function openMenu() {
    if (disabled) return;
    setQuery(selectedLabel);
    setDirty(false);
    setFocusIndex(rows.findIndex(r => r.value === value));
    setOpen(true);
    // Replace-on-type: the pre-filled label is a display value, not a query.
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function revert() {
    setOpen(false);
    setQuery(selectedLabel);
    setDirty(false);
    setFocusIndex(-1);
  }

  function select(row: Row) {
    onChange(row.value);
    setOpen(false);
    setQuery(row.value ? row.label : (placeholder ?? ''));
    setDirty(false);
    setFocusIndex(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setFocusIndex(i => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return Math.max(-1, Math.min(next, rows.length - 1));
      });
      return;
    }
    if (e.key === 'Enter') {
      if (!open) {
        e.preventDefault();
        openMenu();
        return;
      }
      const row = rows[focusIndex];
      if (row) {
        e.preventDefault();
        select(row);
      } else {
        revert();
      }
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation(); // the menu is the innermost Esc target
      revert();
      return;
    }
    if (e.key === 'Tab' && open) revert();
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        aria-activedescendant={open && focusIndex >= 0 ? `${listId}-opt-${focusIndex}` : undefined}
        disabled={disabled}
        value={open ? query : selectedLabel}
        placeholder={filterPlaceholder}
        onMouseDown={() => { if (!open) openMenu(); else setOpen(false); }}
        onChange={e => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
          setDirty(true);
          setFocusIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (open) revert(); }}
        className="w-full px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none truncate"
      />
      {open && createPortal(
        <div
          id={listId}
          role="listbox"
          ref={el => { listRef.current = el; menuRef.current = el; }}
          style={menuStyle}
          // Keep focus on the input for *every* click inside the menu — options,
          // padding, and (importantly) the scrollbar. Without this, mousedown on
          // anything but an option blurs the field and the blur handler closes
          // the list, so dragging the scrollbar would dismiss the menu.
          onMouseDown={e => e.preventDefault()}
          className="z-50 overflow-y-auto bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1"
        >
          {rows.map((row, i) => (
            <div
              key={`${row.custom ? 'custom:' : ''}${row.value}`}
              id={`${listId}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={row.value === value}
              onMouseDown={e => { e.preventDefault(); select(row); }}
              className={`px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2 ${
                i === focusIndex ? 'bg-brand-500/20' : row.value === value ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/50'
              }`}
            >
              <span className={`flex-1 truncate ${row.custom ? 'text-brand-500' : 'text-fg-primary'}`}>{row.label}</span>
              {row.hint && <span className="text-[10px] text-fg-tertiary shrink-0">{row.hint}</span>}
              {row.custom && customHint && (
                <span className="text-[10px] text-fg-tertiary shrink-0">
                  {typeof customHint === 'function' ? customHint(row.value) : customHint}
                </span>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-xs text-fg-tertiary text-center">{emptyText}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
