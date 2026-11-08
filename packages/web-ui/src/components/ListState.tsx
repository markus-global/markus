/**
 * 取数三态的**唯一渲染出口**（loading / error / empty / 有内容）。
 *
 * ── 为什么必须只有一个组件 ──────────────────────────────────────────────
 * 同一句谎话在仓库里被写了十几种：`items.length === 0 ? <空态/> : <列表/>`，
 * 其中 `items` 在 catch 里被置成 `[]`。修法不是把每种写法各改一遍，而是让
 * 「渲染哪一态」只有一个执行点 —— 调用方交出 `Resource` + 空态文案，
 * 由本组件问 `listView()`（`lib/resourceState.ts`）决定画什么。
 *
 * 契约（改它就是改语义）：
 *   1. **`state === 'error'` 时绝不渲染空态文案。** 空态是一句断言（「确实没有」），
 *      而读失败时我们不知道；这里画的是「读取失败 + 这不等于…」+ 可操作的重试。
 *   2. `empty` 只能来自 `listView().empty`，调用方不得自己传 `isEmpty`。
 *   3. 失败**且**手上有上一次的内容时：保留列表（陈旧）并在上方给出失败条 ——
 *      把一个已知有内容的列表清空成「一个都没有」是同一个谎话的另一种说法。
 *   4. 重试必须走**同一个取数口**（由调用方传 `onRetry`），不新开读路径。
 */
import type { ReactNode } from 'react';
import { listView, type Resource } from '../lib/resourceState.ts';

/**
 * 「读取失败」提示条：**全站唯一的错误表达**。
 *
 * `notEquals` 是必填的，且它不是装饰：它是这条提示存在的理由 ——
 * 明确说出「不能由此推断出的那个结论」，否则用户读到的仍是一个空界面。
 */
export function ReadErrorNotice({
  subject,
  error,
  notEquals,
  onRetry,
  retryLabel = '重试',
  hint,
  variant = 'bar',
}: {
  /** 读的是什么（例：「交付物」「会话消息」「模型目录」） */
  subject: string;
  /** 人话失败原因（`Resource.error`） */
  error: string;
  /** 读失败**不能**下的结论（例：「这个会话没有消息」） */
  notEquals: string;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
  /** 无重试入口时的可操作指引 */
  hint?: string;
  variant?: 'bar' | 'inline';
}) {
  const text = (
    <span className={variant === 'inline' ? 'text-[11px] text-rose-500' : 'text-xs text-rose-500'}>
      {subject}读取失败：{error}（这不等于「{notEquals}」）
    </span>
  );
  const actions = onRetry ? (
    <button
      type="button"
      onClick={onRetry}
      className="text-xs text-brand-500 hover:text-brand-400 shrink-0 cursor-pointer"
    >
      {retryLabel}
    </button>
  ) : hint ? (
    <span className="text-xs text-fg-tertiary shrink-0">{hint}</span>
  ) : null;

  if (variant === 'inline') {
    return (
      <div className="flex items-center gap-2 px-2 py-1" role="alert">
        {text}
        {actions}
      </div>
    );
  }
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2 border-b border-rose-500/30 bg-rose-500/10 shrink-0"
      role="alert"
    >
      {text}
      {actions}
    </div>
  );
}

/**
 * 三态渲染器。调用方只在 `children` 里写「有内容长什么样」。
 *
 * ```tsx
 * <ListState resource={items} subject="交付物" notEquals="没有任何交付物"
 *            onRetry={refresh} empty={<EmptyCopy/>}>
 *   {rows => rows.map(r => <Row key={r.id} item={r} />)}
 * </ListState>
 * ```
 */
export function ListState<T>({
  resource,
  subject,
  notEquals,
  onRetry,
  retryLabel,
  hint,
  loading,
  empty,
  children,
  noticeVariant,
}: {
  resource: Resource<T>;
  subject: string;
  notEquals: string;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | undefined;
  hint?: string | undefined;
  /** 首屏/切对象时画什么；缺省不画（保持页面原有骨架） */
  loading?: ReactNode;
  /** **确实**没有内容时画什么（只会在 `listView().empty` 为真时出现） */
  empty?: ReactNode;
  /** 有内容时的渲染（`rows` 已按 `listView()` 判过态，调用方不要再数长度） */
  children: (rows: readonly T[]) => ReactNode;
  noticeVariant?: 'bar' | 'inline';
}) {
  const view = listView(resource);
  const notice = view.error ? (
    <ReadErrorNotice
      subject={subject}
      error={resource.error ?? '读取失败'}
      notEquals={notEquals}
      onRetry={onRetry}
      {...(retryLabel !== undefined ? { retryLabel } : {})}
      {...(hint !== undefined ? { hint } : {})}
      {...(noticeVariant !== undefined ? { variant: noticeVariant } : {})}
    />
  ) : null;

  // 失败时保留上一次的内容（陈旧 + 失败条），绝不把它清成空态。
  if (view.error) {
    return (
      <>
        {notice}
        {view.rows.length > 0 ? children(view.rows) : null}
      </>
    );
  }
  if (view.loading) {
    return <>{loading ?? null}</>;
  }
  if (view.empty) {
    return <>{empty ?? null}</>;
  }
  return <>{children(view.rows)}</>;
}
