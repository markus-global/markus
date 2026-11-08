/**
 * 「多久以前」的唯一实现（指向**过去某刻**的相对表达）。
 *
 * 为什么单独成一个模块：`NotificationBell`、概览右栏、历史弹窗、时间线四个地方都要说
 * 「这条等了多久」，此前各自 `Math.floor(diff / 60000) + ' 分钟前'`。四份实现里只要有一份
 * 忘了归一化入参（ISO 字符串减去数字 = NaN），就会渲染出「NaN 天前」。
 *
 * 纪律：
 *  · 入参统一 epoch ms；ISO 字符串必须在边界处经 `toEpochMs()` 归一化；
 *  · 解析失败返回 `''` / `'时长未知'`，绝不把 NaN 泄露到界面上；
 *  · 不读 i18n —— 这里的输出是**同一句话**，与语言无关的纯函数才可以被单测直接钉住。
 *
 * 出处：与 feat/thread-trigger-router 的 `lib/threadPresentation.ts` 同实现（逐字一致），
 * 移植到本分支时只带这里纯函数部分，避免把 thread 领域的词表一起搬进来。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 时间戳 → 「3 分钟前」。 */
export function formatRelative(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? '昨天' : `${d} 天前`;
}

/** 时长 → 「3 分钟」（纯区间，不带「前」）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '时长未知';
  const d = Math.max(0, ms);
  if (d < MINUTE) return '不到 1 分钟';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分钟`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时`;
  return `${Math.floor(d / DAY)} 天`;
}

/** ISO 字符串 → epoch ms。解析失败返回 NaN，交给上游的防御分支。 */
export function toEpochMs(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

/** ISO 或 epoch 都可的相对时间。只在确实会拿到两种形态的边界使用。 */
export function formatRelativeAny(value: string | number | null | undefined): string {
  return formatRelative(toEpochMs(value));
}
