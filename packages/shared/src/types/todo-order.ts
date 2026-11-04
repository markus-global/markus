/**
 * 「待办排序」的**唯一实现**。纯函数，零 IO，浏览器与 Node 都能直接跑。
 *
 * ── 为什么必须只有一个写者（2026-11-04 实测）────────────────────────────
 *
 * 同一个事实「谁该先被处理」当时在仓库里有三份实现，三份给出三种序：
 *
 *   · `event-routes.ts#buildInboxRows`  → `lastActivity` 降序（最新活动在前，与 stage 无关）
 *   · `ActionCenter.tsx#sortActions`    → 本地 `PRIORITY_WEIGHT` 表（优先级在前，其次等得久）
 *   · `InboxCard/ThreadView`            → `stageRank` 升序 + `lastActivity` 降序
 *
 * 后果不是「潜在风险」，是当下就在发生的显示错误：同一条流在 `/api/threads` 里排第 4、
 * 在概览首屏排第 1，用户按一个界面做的判断，另一个界面不认。这与 `02` §0.7「计数口径 4 份」
 * 是同一个病：**一个事实有两个写者，改一处另一处不跟随。**
 *
 * ── 最终规则（PR 里逐条写死，任何改动都是契约变更）──────────────────────
 *
 * 四段键，全序（任意两条不同的待办一定有确定先后），因此：
 *   1. stage 契约序：`stageSortRank()` —— person:approval(0) → person:answer(1) →
 *      person:review(2) → person:blocked(3) → system:queued(4) → agent:working(5) →
 *      none:idle(6)。**「审批优先」压过「紧急优先」**，因为 `PERSON_STAGES` 的注释早已
 *      把「顺序即 UI 排序」定为契约；优先级只在同一 stage 内生效。
 *   2. 同 stage 内优先级：urgent(0) < high(1) < medium(2) < low(3) < 无优先级(4)。
 *   3. 同 stage + 优先级内：`lastActivity` **升序**（等得最久的在前）。等得久的先处理，
 *      这是「已经有人为这件事等了 3 天」这个事实本身的排序含义。
 *   4. `id` 升序兜底：让同一批输入永远产出同一个序列 —— 可断言、可回放、可缓存。
 *      没有它，两个完全相同的待办在两次读取里可能互换位置，任何「序列相等」的验收
 *      都会变成 flaky，而不是变成红。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 * **同一个逻辑输入若能产出两种序列，它就不是一个可排序的接口。**
 * `scripts/architecture-guard.mjs` 的 `todo-order-single-writer` 规则会拦住第二处定义
 * （优先级权重表 / 自建 stage 序 / 就地 stage 比较器），并指向本文件。
 */

import { stageSortRank, type ThreadStage } from './thread.js';

/**
 * 排序输入。刻意做成**结构最小集**而不是某个具体 DTO：
 * 服务端给的是 `withStage()` 之后的行，前端给的是 `ThreadAPI` / `ActionItem`，
 * 两边都不需要为自己的类型写适配层 —— 适配层本身就是第二个写者的温床。
 */
export interface TodoOrderInput {
  /** 待办对象的稳定标识（`tsk_…` / `req_…` / `apr_…`）。第 4 段键，不可缺。 */
  id: string;
  /** 「它在等谁」（`deriveStage` 的派生量）。缺省/未知 → 按 `none:idle` 排。 */
  stage?: string | null;
  /** 任务/需求优先级。缺省/未知 → 排在同 stage 的最后。 */
  priority?: string | null;
  /** 最后一次活动的 epoch ms。缺省/非有限值 → 排在同组最后。 */
  lastActivity?: number | null;
}

/**
 * 优先级权重：**它是唯一一份**。数字小的先排。
 *
 * `normal` 与 `medium` 同秩：平台里「任务/需求」用 medium，「通知」用 normal
 * （见 `NotificationInfo.priority`）—— 同一件事的两种词表，秩必须一样，
 * 否则「通知里 normal 排 medium 后面」这种没人能解释的差异就会出现。
 * 缺省 / 不认识的值为 `NO_PRIORITY_RANK`。
 */
export const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  normal: 2,
  low: 3,
};

/** 没有优先级 / 不认识的优先级，排在同 stage 内所有已知优先级之后。 */
export const NO_PRIORITY_RANK = 4;

/**
 * 未知 stage 的落点 = `none:idle` 的序号。
 *
 * 复用 `stageSortRank('none:idle')` 而不是写死 6：`ThreadStage` 加一档时两者一起动，
 * 不会出现「常量说 6、switch 说 7」的第二份事实。与展示层的选择一致 ——
 * `threadPresentation#stageLabel` 对未知 stage 也回退到「无待办」，不抛错、不白屏。
 */
const STAGE_RANK_FALLBACK = stageSortRank('none:idle');

/** stage → 序号。未知 stage（后端新增了一档而这里没跟上）回退为 `none:idle`，不抛错。 */
export function todoStageRank(stage: string | null | undefined): number {
  if (!stage) return STAGE_RANK_FALLBACK;
  const rank: number | undefined = stageSortRank(stage as ThreadStage);
  return Number.isFinite(rank) ? (rank as number) : STAGE_RANK_FALLBACK;
}

/** priority → 序号。未知/缺省排最后。 */
export function todoPriorityRank(priority: string | null | undefined): number {
  if (!priority) return NO_PRIORITY_RANK;
  return PRIORITY_RANK[priority] ?? NO_PRIORITY_RANK;
}

/**
 * 「等了多久」的比较键。
 *
 * 时间戳缺失时给 `+Infinity`（排在同组最后）而不是 `0`：`0` 会被读成「1970 年开始就在等」，
 * 于是**一条没有时间戳的待办会排到所有人前面** —— 缺陷会伪装成「排序生效了」。
 */
function activityKey(lastActivity: number | null | undefined): number {
  return typeof lastActivity === 'number' && Number.isFinite(lastActivity)
    ? lastActivity
    : Number.POSITIVE_INFINITY;
}

/**
 * 待办比较器。给 `Array#sort` 与「挑最该处理的一条」共用同一个判定。
 *
 * ⚠️ 不要用 `keyA - keyB` 直接减两个 `activityKey`：两边都是 `+Infinity` 时得到 `NaN`，
 * 而 `NaN !== 0` 为真 → 比较器返回 `NaN` → 排序结果随实现而异。这里显式分支。
 */
export function compareTodoOrder(a: TodoOrderInput, b: TodoOrderInput): number {
  const byStage = todoStageRank(a.stage) - todoStageRank(b.stage);
  if (byStage !== 0) return byStage;

  const byPriority = todoPriorityRank(a.priority) - todoPriorityRank(b.priority);
  if (byPriority !== 0) return byPriority;

  const ta = activityKey(a.lastActivity);
  const tb = activityKey(b.lastActivity);
  if (ta !== tb) return ta < tb ? -1 : 1;

  // 第 4 段键：确定性。字符串直接比较（不用 localeCompare —— 它依赖运行环境 locale，
  // 同一批输入在不同机器上会给出不同序列，那就不可断言了）。
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 排序入口。**不修改入参**（返回新数组）—— 调用方常常把 store 里的数组直接传进来，
 * 就地排序会让 React 的 memo 失效、并制造「谁改了我的列表」这类无法定位的问题。
 */
export function orderTodos<T extends TodoOrderInput>(rows: readonly T[]): T[] {
  return [...rows].sort(compareTodoOrder);
}
