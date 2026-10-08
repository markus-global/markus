/**
 * timeAgo —— 通知 / 条目时间显示的**唯一实现**。
 *
 * 之前「相对时间」在本仓库被重复实现了 5 次（NotificationBell.timeAgo、
 * Deliverables/Work/Home/AgentProfile 各一份），口径会漂移。通知相关的 UI
 * （铃铛、会话内通知卡、审阅弹窗）统一走这里：
 *   - `timeAgo`            友好相对形式：刚刚 / N 分钟前 / N 小时前 / N 天前
 *   - `formatExactTime`    具体时间（按当前语言本地化，含年月日时分）
 *   - `formatNotificationTime`  一次性给全「相对 + 具体」
 *
 * 为什么两个都要：相对形式给**时效感知**（一眼看出新旧），具体形式给**精度**
 * （跨天/跨时区对账时要用）。紧凑位置（卡片）用相对 + `title` 悬浮显示具体时间，
 * 宽敞位置（弹窗）两个都直出。
 */
import type { TFunction } from 'i18next';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 友好相对时间。非法 / 空时间返回空串（绝不吐出 "NaN 分钟前"）。
 * `count` 走 i18next 复数规则（zh-CN 与 en 都是单数形式，故只给 count）。
 */
export function timeAgo(iso: string, t: TFunction): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  // 未来时间（时钟漂移）也按「刚刚」处理，不显示负数。
  if (diff < MINUTE) return t('common:time.now');
  const mins = Math.floor(diff / MINUTE);
  if (mins < 60) return t('common:time.minutesAgo', { count: mins });
  const hrs = Math.floor(diff / HOUR);
  if (hrs < 24) return t('common:time.hoursAgo', { count: hrs });
  return t('common:time.daysAgo', { count: Math.floor(diff / DAY) });
}

/** 具体时间（年月日 + 时分），按 locale 本地化；非法 / 空返回空串。 */
export function formatExactTime(iso: string, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    // 极端环境下 Intl 不可用 —— 退回运行时的默认本地化，仍好过没有。
    return d.toLocaleString();
  }
}

/** 通知时间：相对 + 具体，一次给全。 */
export function formatNotificationTime(
  iso: string,
  t: TFunction,
  locale?: string,
): { relative: string; absolute: string } {
  return { relative: timeAgo(iso, t), absolute: formatExactTime(iso, locale) };
}
