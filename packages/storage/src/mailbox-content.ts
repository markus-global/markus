/**
 * `mailbox_items` 的**内容轴**唯一定义点（C2 拆轴，2026-11-03）。
 *
 * ## 为什么需要这个文件
 *
 * `mailbox_items` 曾同时承载两条正交轴：
 *  - **内容轴**（这条事件说了什么）：`payload.summary` / `payload.content` / `payload.messages`；
 *  - **执行态轴**（要怎么跑它）：`status` / `priority` / `claimed_by` / `lease_until` / `retry_count` …
 *
 * 结果是同一份正文在库里有**两个位置**（`triggers.summary/body` 与
 * `mailbox_items.payload.summary/content`）。两个位置就意味着两个写者，两个写者就意味着
 * 「总有一天不一致」，而且没人负责对齐（A1 记录的同一种病）。只要 mailbox 那列还留着
 * 正文，「两处不一致」就是**结构上可表达**的 —— 加多少守卫都堵不住。
 *
 * 所以内容轴整体搬到 `triggers`（唯一写者 `SqliteTriggerRepo.insertOrGet`），
 * mailbox 行只留执行态 + 一个指针 `trigger_id`。本文件把「哪些键算内容」写**一次**，
 * 读写两侧共用，不允许第二份清单。
 *
 * ## 单一执行点
 *
 *  - 写方向：`splitMailboxContent()` —— 只被 `SqliteMailboxRepo.save()` 调用。
 *  - 读方向：`hydrateMailboxContent()` —— 只被 `SqliteMailboxRepo.mapRow()` 调用。
 *
 * 两个方向各有且仅有一个调用点；本文件是纯函数，不碰 DB、不碰时间、不读配置。
 */

/**
 * 内容轴的键 —— **唯一定义**。
 *
 * 判据（而不是「看起来像正文」）：这个键的值是不是「这条事件说了什么」。
 * 是 → 内容轴，进 `triggers`；否 → 留在 `mailbox_items.payload`（执行态/路由提示）。
 *
 * | 键 | 归属 | 去向 |
 * |---|---|---|
 * | `summary` | 内容轴 | `triggers.summary`（显示摘录，权威正文是 `content`） |
 * | `content` | 内容轴 | `triggers.body`（**权威正文**，`turnContentOf` 只读它） |
 * | `messages` | 内容轴 | 不落库（合并产生的**派生视图**，正文已在 `content` 里；见下） |
 * | `reviewContext` | 内容轴 | 不落库（全仓零生产者，属死字段） |
 *
 * **`messages` 为什么不落库**：它是 `mergeSameConversation` 在内存里为「多渠道合并项」构造的
 * 结构化数组，每个元素的 `content` 与 `payload.content` 是同一段正文的两份拷贝。
 * 生产库实测 323/241247 行带它，而**没有任何读路径**从 DB 读它（只有合并代码在内存里读写）。
 * 把它序列化进 `triggers.body` 会重新引入「用文本列表达结构」（R3 老病），所以选择不落库；
 * 历史行（`trigger_id IS NULL`）原样保留、照旧可读，不搬不删。
 *
 * **`reviewContext` 为什么不落库**：`grep -rn reviewContext` 全仓仅剩类型声明一处，
 * 无生产者。移除条件：确认无外部消费方后从 `MailboxPayload` 删除该字段。
 */
export const MAILBOX_CONTENT_KEYS = ['summary', 'content', 'messages', 'reviewContext'] as const;

/** 内容轴的载荷：正文 + 显示摘录。`summary` 可以是摘录，`body` 必须是权威正文。 */
export interface MailboxContent {
  summary: string;
  body: string;
}

/** `triggers` 侧的内容（读方向要的形状；与 `TriggerRow` 解耦，避免跨文件类型依赖）。 */
export interface TriggerContent {
  summary?: string | null;
  body?: string | null;
}

const CONTENT_KEY_SET: ReadonlySet<string> = new Set(MAILBOX_CONTENT_KEYS);

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 写方向：把内容轴从 payload 里摘出来。
 *
 * 返回值 `rest` 是**原对象的浅拷贝减去内容键**，键顺序保持不变（缓存友好：同一逻辑输入
 * 永远产出同一字节序列，不会因为「这次有没有 content」改变 JSON 形状）。
 * 未知键一律留在 `rest` 里 —— 只搬我们**确认为内容**的键，绝不因为不认识就丢掉。
 */
export function splitMailboxContent(
  payload: Record<string, unknown> | null | undefined,
): { content: MailboxContent; rest: Record<string, unknown> } {
  const src = payload ?? {};
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (CONTENT_KEY_SET.has(key)) continue;
    rest[key] = src[key];
  }
  return {
    content: { summary: asText(src['summary']), body: asText(src['content']) },
    rest,
  };
}

/**
 * 读方向：把内容轴装回 payload。
 *
 * - `trigger` 非空 → 内容**只**来自 `triggers`（唯一事实源），`rest` 里的同名键被覆盖；
 * - `trigger` 为 null → **历史回落**：`trigger_id IS NULL` 的行是拆轴之前写入的，
 *   正文只在它自己的 payload 列里，不搬不回填，原样返回。
 *
 * ⚠️ 这条回落分支**不是**兜底网，而是「历史行」这一**可枚举状态**的唯一处理点
 * （判据：行的 `trigger_id IS NULL`，而不是「trigger 里读不到内容」）。
 * 删掉它，拆轴之前写入的行会读到空正文 —— 这正是守卫测试要钉住的行为。
 */
export function hydrateMailboxContent(
  rest: Record<string, unknown>,
  trigger: TriggerContent | null,
): Record<string, unknown> {
  if (!trigger) return rest; // 历史行：自身列就是唯一来源
  return {
    ...rest,
    summary: trigger.summary ?? '',
    content: trigger.body ?? '',
  };
}
