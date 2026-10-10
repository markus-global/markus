/**
 * The one on/off switch for the whole app.
 *
 * Why this exists
 * ---------------
 * Switch state used to be coloured ad hoc at each call site — typically
 * `on ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'`. Two facts made that
 * pair unreadable in dark mode:
 *
 *  1. this app themes via a **class** on `<html>` (`useTheme` adds `.dark`),
 *     but Tailwind v4's `dark:` variant means `prefers-color-scheme`, so
 *     `dark:bg-gray-600` followed the *OS*, not the app theme; and
 *  2. the base `brand-600` token is only `oklch(0.52 0.04 250)` — chroma 0.04,
 *     i.e. essentially grey — so ON and OFF were near-identical mid greys.
 *
 * So the fix is not a nicer colour at one site; it is to stop choosing colours
 * at call sites. The track/knob colours come from the `switch-on` /
 * `switch-off` / `switch-knob` theme tokens (index.css), which resolve from the
 * active theme — one definition, correct in dark, light, system, cyberpunk and
 * mono. There is no `dark:` utility here on purpose.
 */
import type { ReactNode } from 'react';

export type SwitchSize = 'sm' | 'md' | 'lg';

/** Track + knob geometry per size; kept here so no call site re-derives it. */
const GEOMETRY: Record<SwitchSize, { track: string; knob: string; on: string; off: string }> = {
  sm: { track: 'w-9 h-5', knob: 'w-4 h-4', on: 'translate-x-4', off: 'translate-x-0.5' },
  md: { track: 'w-10 h-5', knob: 'w-4 h-4', on: 'translate-x-5', off: 'translate-x-0.5' },
  lg: { track: 'w-12 h-6', knob: 'w-5 h-5', on: 'translate-x-6', off: 'translate-x-0.5' },
};

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name — required, because the control renders no text. */
  label: string;
  disabled?: boolean;
  size?: SwitchSize;
  testId?: string;
  /** Extra classes for the track (layout only — not a colour override). */
  className?: string;
  /** Optional visible label rendered next to the switch. */
  children?: ReactNode;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'md',
  testId,
  className = '',
  children,
}: SwitchProps) {
  const on = checked === true;
  const geo = GEOMETRY[size];

  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!on)}
      className={`relative ${geo.track} shrink-0 rounded-full transition-colors duration-200 ${
        on ? 'bg-switch-on' : 'bg-switch-off'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 block ${geo.knob} rounded-full bg-switch-knob shadow transition-transform duration-200 ${
          on ? geo.on : geo.off
        }`}
      />
    </button>
  );

  if (!children) return control;
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
      <span className="text-xs text-fg-secondary">{children}</span>
      {control}
    </label>
  );
}
