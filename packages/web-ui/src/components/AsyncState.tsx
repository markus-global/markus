import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Unified async-state primitives.
 *
 * Why this file exists: every page used to invent its own loading text, its own
 * empty-state markup and its own spinner. Result: the same "waiting for data"
 * moment looked like five different products, and several pages rendered
 * "nothing here yet" *before* the first response arrived (a false empty state).
 *
 * Rules for callers:
 *  1. A list/panel that has not finished its FIRST fetch must render
 *     `ListLoading` (or `PageLoading`) — never `EmptyState`.
 *  2. `EmptyState` means "the server answered, and the answer is empty".
 *     Initialize `loading` to `true`, not `false`, so the empty state cannot
 *     paint for one frame before the request starts.
 *  3. Loading is not an error: never collapse both into one branch.
 */

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Single spinner implementation — three sizes, currentColor. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin shrink-0', className ?? 'w-3.5 h-3.5')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Full-page / full-panel loading: spinner + optional label, vertically centered. */
export function PageLoading({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cx(
        'flex-1 flex flex-col items-center justify-center gap-2.5 py-10 text-fg-tertiary',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Spinner className="w-5 h-5 text-brand-400" />
      <span className="text-xs">{label ?? t('loading')}</span>
    </div>
  );
}

/**
 * List/panel loading.
 *  - variant 'skeleton' (default): pulsing bars; use when layout is known.
 *  - variant 'text': one muted line; use inside tight panels/dialogs.
 */
export function ListLoading({
  rows = 3,
  label,
  variant = 'skeleton',
  className,
}: {
  rows?: number;
  label?: string;
  variant?: 'skeleton' | 'text';
  className?: string;
}) {
  const { t } = useTranslation('common');
  if (variant === 'text') {
    return (
      <div
        className={cx('flex items-center gap-2 px-1 py-2 text-xs text-fg-tertiary', className)}
        role="status"
        aria-live="polite"
      >
        <Spinner className="w-3 h-3" />
        <span>{label ?? t('loading')}</span>
      </div>
    );
  }
  return (
    <div className={cx('space-y-2.5 p-1', className)} role="status" aria-live="polite" aria-label={label ?? t('loading')}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="animate-pulse space-y-1.5">
          <div className="h-3.5 bg-surface-elevated rounded w-2/3" />
          <div className="h-2.5 bg-surface-elevated/70 rounded w-1/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * "Server answered, nothing here" — icon + title + hint (+ optional action).
 * Never render this while the first fetch is still in flight.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  size = 'md',
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; variant?: 'primary' | 'secondary' };
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const pad = size === 'sm' ? 'py-6' : size === 'lg' ? 'py-16' : 'py-10';
  const titleCls = size === 'sm' ? 'text-xs' : 'text-sm';
  return (
    <div className={cx('flex flex-col items-center justify-center text-center px-4', pad, className)}>
      {icon && <div className="mb-2.5 text-fg-muted">{icon}</div>}
      <div className={cx('font-medium text-fg-secondary', titleCls)}>{title}</div>
      {hint && <div className="mt-1 text-xs text-fg-tertiary max-w-xs leading-relaxed">{hint}</div>}
      {action && (
        <button
          onClick={action.onClick}
          className={cx(
            'mt-3 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            action.variant === 'secondary'
              ? 'border border-border-default text-fg-secondary hover:bg-surface-elevated'
              : 'bg-brand-600 hover:bg-brand-500 text-white',
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Inline, non-blocking error line with optional retry. */
export function InlineError({
  text,
  onRetry,
  retryLabel,
  className,
}: {
  text: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cx(
        'flex items-start gap-2 rounded-md bg-red-500/10 text-red-400 px-2.5 py-1.5 text-[11px] leading-relaxed',
        className,
      )}
      role="alert"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 underline underline-offset-2 hover:text-red-300">
          {retryLabel ?? t('retry', { defaultValue: 'Retry' })}
        </button>
      )}
    </div>
  );
}

/** Section-level shimmer used by dashboards that render no per-section text. */
export function SectionSkeleton({ className }: { className?: string }) {
  return (
    <div className={cx('animate-pulse space-y-3', className)} aria-hidden="true">
      <div className="h-4 bg-surface-elevated rounded w-1/3" />
      <div className="h-3 bg-surface-elevated/70 rounded w-full" />
      <div className="h-3 bg-surface-elevated/70 rounded w-5/6" />
    </div>
  );
}
