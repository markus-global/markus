/**
 * 浏览器侧「终态」投影 —— 服务端唯一事实源是
 * `packages/shared/src/types/task.ts#TERMINAL_STATUSES` + `#isTerminal()`。
 *
 * 为什么要有这份副本：web-ui 的包体是浏览器构建，不能运行时 import
 * `@markus/shared`（那会把 fs/crypto 这类 node 侧依赖拖进来 —— 同一约束在
 * `lib/mailboxTypeMeta.ts`、`lib/entityShapes.ts`、`constants/providers.ts` 里都
 * 有记录）。
 *
 * 因此这里的规则是**投影而非第二定义**：
 *   - 写入者仍然只有 shared 一处；
 *   - `packages/shared/test/terminal-status-mirror.test.ts` 在两边不一致时判红，
 *     所以手改本文件不会悄悄改变行为，只会让 CI 红；
 *   - 判据语义与共享谓词逐字一致（含「不认识的字符串 = 未结束」）。
 *
 * 注意：本文件回答的是「工作是否已经结束」。「默认看板要不要隐藏」是另一个问题，
 * 在 `lib/boardFilters.ts#HIDDEN_BY_DEFAULT_STATUSES` —— 两者**不得合并**
 * （合并会让已完成任务默认从看板消失，那是用户可见的行为变更）。
 */

/** 终态：与 shared 的同名常量成员完全一致。 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'archived',
]);

/** `blocked` / `review` 不是终态：FSM 里它们都还有通往活跃状态的出边。 */
export function isTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

/**
 * 需求终态 —— 同一枚举上的**另一个问题**，投影自 shared 的
 * `types/requirement.ts#TERMINAL_REQUIREMENT_STATUSES`。
 *
 * 差别是真实的：需求不会被「执行失败」，所以 `failed` 不在里面。别把两份并成一个。
 */
export const TERMINAL_REQUIREMENT_STATUSES: ReadonlySet<string> = new Set<string>([
  'completed',
  'rejected',
  'cancelled',
  'archived',
]);
