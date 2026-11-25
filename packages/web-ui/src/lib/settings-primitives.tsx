/**
 * Settings design primitives — the visual language shared by every Settings tab.
 *
 * These used to live inside `pages/Settings.tsx`, back when there was only one
 * settings surface to style. Now several tabs compose from them, and keeping them
 * in a 4k-line page file meant a second tab could only reuse a primitive by
 * importing the whole page (dragging its state, its api calls and its i18n keys
 * along). They are extracted here so the page file is page logic only.
 *
 * Rule unchanged: if you find yourself hand-writing `bg-surface-elevated rounded-xl`
 * or a primary button, use one of these instead.
 *
 * NOT here: `PageHeader`, which reads the tab catalogue (`SETTINGS_TABS`,
 * `SettingsTabIcon`) and therefore stays with the page that owns it.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';

/** Base card surface — pair with a padding utility (usually `p-5`). */
export const CARD = 'bg-surface-elevated rounded-xl border border-border-default/40';

/* ── 排版与颜色 token ──────────────────────────────────────────────────
 * 设置界面只允许这几档字号、这几种文字颜色。页面里**不写魔法值**。
 *
 * 为什么要有这层：这页曾经同时存在 21 种「字号/字重/颜色」组合，原因不是
 * 谁写错了，而是每个块都自己写一句 `text-[13px] text-fg-muted` —— 没人看得见
 * 漂移，也没人拦得住下一个人写出第 22 种。token 把可选值收窄到枚举，
 * 要让字号多一档，必须先改这里，这就是拦截点。
 *
 * 层级只三级（页面 → 组 → 项）：pageTitle / groupTitle+groupDesc / label+hint。
 */
export const TYPE = {
  pageTitle:  'text-lg font-semibold',
  groupTitle: 'text-[13px] font-semibold',
  groupDesc:  'text-xs leading-relaxed',
  label:      'text-[13px] font-medium',
  body:       'text-[13px]',
  hint:       'text-[11px] leading-relaxed',
  badge:      'text-[11px] font-medium',
} as const;

export const FG = {
  strong: 'text-fg-primary',
  desc:   'text-fg-tertiary',
  ok:     'text-emerald-600 dark:text-emerald-400',
  warn:   'text-amber-600 dark:text-amber-400',
  brand:  'text-brand-600 dark:text-brand-400',
  danger: 'text-red-500',
} as const;

/** Standard text input / number input. Add width utils at the call site. */
export const FIELD_INPUT = 'px-3 py-2 text-[13px] bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder:text-fg-tertiary/50 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15 outline-none transition-colors';

/** Primary (commit) action. */
export const BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-[13px] font-medium bg-brand-600 hover:bg-brand-500 text-on-brand disabled:opacity-40 rounded-lg transition-colors';

/** Secondary / neutral action. */
export const BTN_SECONDARY = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium border border-border-default text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary disabled:opacity-40 rounded-lg transition-colors';

/** Status pill. Replaces five near-identical spans that each re-declared their own
 *  size and colour triplet — same thing, five writers, each free to drift. */
export function Badge({ tone = 'neutral', children, title }: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand';
  children: ReactNode;
  title?: string;
}) {
  const TONES = {
    neutral: 'bg-fg-tertiary/10 text-fg-tertiary',
    ok: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    danger: 'bg-red-500/15 text-red-500',
    brand: 'bg-brand-500/15 text-brand-500',
  } as const;
  return (
    <span title={title} className={`${TYPE.badge} rounded px-1.5 py-0.5 ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/**
 * One setting: label on the left, control on the right, on a single baseline.
 *
 * This is the settings surface's only layout primitive, and it exists because the
 * page had none. Every block used to invent its own arrangement — a paragraph here,
 * a segmented control stretched across the full width there, a save button at
 * whichever end the author happened to pick — so the eye had no vertical line to
 * follow, the same 「保存」 appeared at both extremes of one column, and "what can I
 * change here" could only be answered by reading the surrounding prose.
 *
 * Three constraints it enforces by construction, derived from what a settings page
 * is (a list of values the user inspects or changes):
 *  - one row = one setting, so the set of settings is countable at a glance;
 *  - the control is always right-aligned, so every control shares one right edge;
 *  - `hint` is 11px muted and sits under the label — the fourth level of detail is
 *    never allowed to compete with the label it describes.
 */
export function SettingRow({ label, hint, children }: {
  label?: ReactNode; hint?: ReactNode; children?: ReactNode;
}) {
  return (
    // Wraps instead of squeezing. The previous `shrink-0` control column could not
    // shrink and the row could not wrap, so as soon as the card narrowed the label was
    // compressed to ~46px (rendering 「代理地址」 vertically) while the controls kept
    // their full width — the row grew to 257px tall and read as a jumble. That happened
    // at a 548px card, i.e. on a laptop with the side panel open, not only on a phone.
    //
    // A `min-w` floor on the label column plus `flex-wrap` makes the控件 drop to their
    // own line before they can crush the label. Keyed on available width, not on a
    // viewport breakpoint: the card is narrow whenever the nav is open, whatever the
    // window size.
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-[7rem] flex-1">
        {label && <div className="text-[13px] font-medium text-fg-primary">{label}</div>}
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-fg-tertiary">{hint}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Section({ title, description, action, children }: {
  title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className={`${TYPE.groupTitle} ${FG.strong}`}>{title}</h3>
          {description && <p className={`mt-0.5 ${TYPE.groupDesc} ${FG.desc}`}>{description}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function CollapsibleSection({ title, description, children, defaultOpen = true }: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="space-y-6">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-start justify-between w-full group text-left"
      >
        <div className="min-w-0">
          <h3 className={`${TYPE.groupTitle} ${FG.strong}`}>{title}</h3>
          {description && <p className={`mt-0.5 ${TYPE.groupDesc} ${FG.desc}`}>{description}</p>}
        </div>
        <span className={`text-fg-tertiary mt-0.5 transition-transform group-hover:text-fg-secondary ${open ? '' : '-rotate-90'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </span>
      </button>
      {open && <div className="space-y-3">{children}</div>}
    </section>
  );
}
