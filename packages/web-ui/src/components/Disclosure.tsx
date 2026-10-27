/**
 * `Disclosure` — the ONLY expand/collapse primitive in the Work page.
 *
 * Why this exists (see the 2026-10-27 review of the workflow cards):
 * every collapsible block used to be a hand-rolled
 * `<div className="cursor-pointer" onClick>` with its own arrow, its own hit
 * area (24px on the card header, 15px on "recent runs") and no keyboard path at
 * all. Same bug, written twice, waiting to be written a third time.
 *
 * The rules this component makes structural rather than stylistic:
 *   1. **The whole summary row is a real `<button>`** — Enter/Space work,
 *      `focus-visible` is visible, `aria-expanded` / `aria-controls` are set.
 *   2. **A minimum 44px hit area** on touch, 36px on desktop, independent of how
 *      small the text inside is.
 *   3. **Actions live outside the button.** The old card put a "run" button and
 *      a chat deep-link *inside* the clickable header and needed
 *      `stopPropagation()` to survive. Here the summary button and the action
 *      cluster are siblings, so nested-interactive is impossible by structure.
 *   4. **Collapsed content is `inert`.** The panel stays mounted (so the height
 *      transition can run) but cannot be tabbed into or read by AT while closed.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';

export interface DisclosureProps {
  expanded: boolean;
  onToggle: () => void;
  /** Content of the summary button (left side). */
  summary: ReactNode;
  /** Action cluster (right side). Rendered as a `button` sibling, never inside it. */
  actions?: ReactNode;
  /** Panel content. Mounted on first open, then kept for the transition. */
  children: ReactNode;
  className?: string;
  summaryClassName?: string;
  panelClassName?: string;
  /** Test hook: `${testId}-toggle`, `${testId}-panel`. */
  testId?: string;
  disabled?: boolean;
  /** Accessible name for the panel region (summary is usually too terse). */
  panelLabel?: string;
}

export function Disclosure({
  expanded,
  onToggle,
  summary,
  actions,
  children,
  className = '',
  summaryClassName = '',
  panelClassName = '',
  testId,
  disabled = false,
  panelLabel,
}: DisclosureProps) {
  const id = useId();
  const buttonId = `${id}-toggle`;
  const panelId = `${id}-panel`;
  // Keep the panel mounted once opened so collapse can animate; before the first
  // open there is nothing to animate and nothing to fetch.
  const [everOpened, setEverOpened] = useState(expanded);
  useEffect(() => {
    if (expanded) setEverOpened(true);
  }, [expanded]);

  const handleToggle = useCallback(() => {
    if (!disabled) onToggle();
  }, [disabled, onToggle]);

  return (
    <div className={className}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          id={buttonId}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-disabled={disabled || undefined}
          onClick={handleToggle}
          data-testid={testId ? `${testId}-toggle` : undefined}
          className={`group flex min-h-[44px] flex-1 min-w-0 items-start gap-2 rounded-lg px-1 py-2 text-left transition-colors sm:min-h-[36px] hover:bg-surface-elevated/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 ${disabled ? 'cursor-default opacity-70' : 'cursor-pointer'} ${summaryClassName}`}
        >
          <svg
            aria-hidden="true"
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-tertiary transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="min-w-0 flex-1">{summary}</span>
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1.5 pt-1">{actions}</div> : null}
      </div>

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden" inert={!expanded || undefined} aria-hidden={!expanded || undefined}>
          <div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            aria-label={panelLabel}
            data-testid={testId ? `${testId}-panel` : undefined}
            className={panelClassName}
          >
            {everOpened ? children : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Disclosure;
