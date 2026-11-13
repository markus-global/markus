/**
 * 第六刀 C3 · 状态筛选片的取值域必须与投递状态机的取值域**一致**。
 *
 * 缺陷（本轮实测发现）：`AgentProfile.tsx` 里筛选片是内联数组字面量，状态改名
 * （删 `dropped`、加 `bounced` / `catch_all`）后没有人去改它，结果是：
 *   - `dropped` 变成**死片**：点了没有任何行（库里历史行已被读路径归一成 bounced）；
 *   - `bounced` / `catch_all` **没有入口**：退信行在 UI 上无法单独筛选，
 *     「没投进去的信号在概览里恰好出现一次」这条判据在人这一侧断链。
 *
 * 为什么抽成模块常量而不是继续内联：内联字面量在 JSX 里**测不到**（渲染整页太重），
 * 于是「筛选片覆盖了哪些状态」只能靠人肉看代码 —— 那就一定会再次漂移。
 *
 * 为什么不 import `@markus/shared` 的 `MailboxItemStatus`：浏览器包不能引运行时
 * node 侧代码（本仓既有约定，见 `constants/allowedTransitions.ts` 同款手抄）。
 * 漂移风险由 `mailboxStatusFilters.test.ts` 与本目录的三语言文案对账兜住：
 * 少一条文案、多一个孤儿键、丢了退信两态都会红。
 */

/** 筛选片取值域 —— 与 `@markus/shared` 的 `MailboxItemStatus` 对齐（不含已删的 dropped）。 */
export type MailboxStatusFilterKey =
  | 'all'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'deferred'
  | 'merged'
  | 'bounced'
  | 'catch_all';

/** 一个筛选片：`key` 同时是翻译键后缀和 API `status` 查询参数。 */
export interface MailboxStatusFilter {
  key: MailboxStatusFilterKey;
  /** 状态点颜色（`all` 无点，用空串）。 */
  dot: string;
}

/**
 * 筛选片的**唯一**定义（顺序即渲染顺序）。
 *
 * 取值域：`queued / processing / completed / deferred / merged / bounced / catch_all`。
 * **不含 `dropped`** —— 它是已删除的终态，历史行在读路径已归一为 `bounced`，
 * 给一个永远空的片只会误导操作者。
 */
export const MAILBOX_STATUS_FILTERS: readonly MailboxStatusFilter[] = Object.freeze([
  { key: 'all', dot: '' },
  { key: 'queued', dot: 'bg-amber-400' },
  { key: 'processing', dot: 'bg-blue-400' },
  { key: 'completed', dot: 'bg-green-500' },
  { key: 'merged', dot: 'bg-brand-400' },
  { key: 'deferred', dot: 'bg-purple-400' },
  { key: 'bounced', dot: 'bg-red-500' },
  { key: 'catch_all', dot: 'bg-red-700' },
]);

/** 传给 API 的 `status` 参数：`all` = 不筛选（`undefined`，不是字面量 "all"）。 */
export function statusFilterParam(key: string | undefined): string | undefined {
  return !key || key === 'all' ? undefined : key;
}
