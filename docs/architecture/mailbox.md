# Mailbox：执行态与内容轴的分离（C2）

> **一句话**：`mailbox_items` 不再存正文。正文（这条事件说了什么）只有一个位置 —— `triggers`，
> 只有一个写者 —— `SqliteTriggerRepo.insertOrGet`。`mailbox_items` 只留执行态（怎么跑它）+ 一个指针。

## 1. 为什么拆

拆之前同一份正文在库里有两个位置：

| 位置 | 谁写 | 谁读 |
|---|---|---|
| `triggers.summary` / `triggers.body` | `event-ingress`（外部事件） | 流时间线 |
| `mailbox_items.payload.summary` / `.content` | `AgentMailbox.enqueue` → `SqliteMailboxRepo.save` | 出队处理、历史页 |

两个位置 = 两个写者 = 迟早不一致，而且没人负责对齐（这正是 A1「发生了什么有三条并行记录」的同一种病，
只是发生在 mailbox 上）。**加守卫治不了它**：只要那列还留着正文，「不一致」就是结构上可表达的。

## 2. 轴清单（唯一权威；有测试逐项核对，漏登记即红）

`mailbox_items` 的每一列只属于一条轴。判据是「它回答哪个问题」：
**这条工作要怎么跑**（执行态）／**这条事件说了什么**（内容）／**正文在哪一行**（引用）。

| 字段 | 轴 | 写者 | 读者 | 说明 |
|---|---|---|---|---|
| `id` | 执行态 | `save()` | 全链路 | 投递行的身份，`mbx_*` |
| `agent_id` | 执行态 | `save()` | 队列/认领 | 投递目标 |
| `source_type` | 执行态 | `save()` | 出队分派 | 该由哪个 handler 跑（**不是**内容分类） |
| `priority` | 执行态 | `save()` / `updateStatus()` | 出队排序 | 调度顺序 |
| `status` | 执行态 | `claimItem` / `updateStatus` / `requeueItem` / `markStaleProcessingAsDropped` | 全链路 | 状态机 `queued→processing→completed/dropped/failed/merged/deferred` |
| `payload` | 执行态（**不含正文**） | `save()` | 出队处理 | 只剩路由/执行提示键，见 §3 |
| `metadata` | 执行态（路由/上下文） | `save()` | 出队处理 | 见 §4 |
| `queued_at` | 执行态 | `save()` / 回队 | 超时判定、排序 | 时间戳 |
| `started_at` | 执行态 | `claimItem` / 回队 | 观测 | 时间戳 |
| `completed_at` | 执行态 | `updateStatus()` | 观测 | 时间戳 |
| `deferred_until` | 执行态 | `updateStatus()` | 自动重现 | 延后到何时 |
| `merged_into` | 执行态 | `updateStatus()` | 观测 | 合并去向 |
| `retry_count` | 执行态 | `updateStatus()` | 重试上限 | 重试计数 |
| `claimed_by` | 执行态 | `claimItem` / `releaseClaim` / 回队 | 租约校验 | 认领者（跨实例唯一胜者） |
| `lease_until` | 执行态 | `claimItem` / `renewLease` | 过期回收 | 租约到期 |
| `dedup_key` | 执行态 | `save()` | 幂等抑制 | `(agent_id, dedup_key)` 唯一；**不是** trigger 的幂等键 |
| `trigger_id` | **引用** | `save()` | `mapRow()` | 正文在 `triggers` 的那一行；为空 = 历史行（§5） |

## 3. `payload` 的键（执行态/路由 vs 内容）

内容键由 `packages/storage/src/mailbox-content.ts` 的 `MAILBOX_CONTENT_KEYS` **唯一定义**，
读写两侧共用；下面这张表必须与它一致（测试会核对）。

| 字段 | 轴 | 去向 | 说明 |
|---|---|---|---|
| `payload.summary` | 内容 | `triggers.summary` | 显示摘录；权威正文是 `content` |
| `payload.content` | 内容 | `triggers.body` | **权威正文**，`turnContentOf()` 只读它 |
| `payload.messages` | 内容 | **不落库** | 合并产生的派生视图；正文已在 `content`，序列化进文本列会重新引入 R3「用文本表达结构」 |
| `payload.reviewContext` | 内容 | **不落库** | 全仓零生产者的死字段；移除条件＝确认无外部消费方后从 `MailboxPayload` 删除 |
| `payload.taskId` | 执行态（实体引用） | 留在 `payload` | 实体作用域/幂等键用；**不是**流键（流键只能由 `resolveThreadRefs` 产出） |
| `payload.requirementId` | 执行态（实体引用） | 留在 `payload` | 同上 |
| `payload.extra` | 执行态（执行提示） | 留在 `payload` | `triggerExecution` / `actionRequired` / `directMention` / `round` / `sessionHint` 等；决定走哪条执行路径与是否 strict-state |

## 4. `metadata` 的键（全部属执行态/上下文，本轮不动）

| 字段 | 轴 | 说明 |
|---|---|---|
| `metadata.senderId` | 上下文 | 发起人 |
| `metadata.senderName` | 上下文 | 发起人显示名 |
| `metadata.senderRole` | 上下文 | 发起人角色 |
| `metadata.isFirstConversation` | 上下文 | 首轮标记 |
| `metadata.sessionId` | 上下文 | 会话提示 |
| `metadata.dbSessionId` | 上下文 | DB 会话 id（跨会话合并防护） |
| `metadata.taskId` | 实体引用 | 同 `payload.taskId` 的旧位置 |
| `metadata.channelContext` | 上下文 | 频道上下文 |
| `metadata.mergeCount` | 执行态 | 折叠了几条（`mailbox-summary.ts` 唯一读点） |
| `metadata.isResume` | 执行态 | 续跑标记 |
| `metadata.responsePromise` | **不落库** | 函数闭包，`cli` 装配层落库前剥离（`recovered-reply-persist.ts` 依赖此事实） |

## 5. 历史行（`trigger_id IS NULL`）

拆轴之前写入的行，正文只在它自己的 `payload` 里。**不搬、不回填**（平台不替用户搬运数据；
且回填会 UPDATE 旧行，直接违反 I9「升级不改旧表任何一行」）。

读路径的回落**唯一执行点**是 `SqliteMailboxRepo.mapRow()` → `hydrateMailboxContent(rest, trigger)`：

```
trigger_id 有值 → 正文只从 triggers 读（唯一事实源）
trigger_id 为空 → 用自身 payload 列（历史行）
```

判据是**列的值**，不是「trigger 里读不到内容」——后者会把「正文真的是空」误判成「没有正文」，
又变成一次从载荷猜结构。删掉回落分支，拆轴之前写入的行会读到空正文（守卫测试会红）。

**移除条件**：`SELECT COUNT(*) FROM mailbox_items WHERE trigger_id IS NULL` 归零。

## 6. 保留策略（否则拆轴会让 30 天清理变空转）

正文搬到 `triggers` 之后，只删 `mailbox_items` 终态行**不再释放正文**，保留策略会变成空转，
回收字节数也会说谎。所以 `pruneTerminalMailboxItems()` 两步走：

1. 删终态 `mailbox_items` 行（原行为）；
2. 回收**没有行再引用**的 `mbx:*` 正文行。

只回收 `mbx:*` 键：那是平台为 mailbox 投递自建的正文行（`mailboxTriggerKey()` 产出）。
外部事件（`gh:` / `im:` …）的 trigger 由 `event-ingress` 写入、要留在时间线上，**不归保留策略管**。

## 7. 刻意不做（每条都有理由）

1. **不给 `mbx:*` trigger 填 `thread_refs`**：H7 明令流键只能由 `resolveThreadRefs` 产出；
   在这里再推一次就是第二个流键写者。故 `thread_refs` 留空，时间线仍只由 ingress 侧事件派生。
2. **不把 15 值 `MailboxItemType` 重构成注册表**：那是任务四（Source 适配器）的范围。
3. **不给 `triggers.body` 做 blob 外置**：与 `event-ingress` 写 body 的现状一致（同一列同一语义）。
   观测口径：`SELECT MAX(length(body)) FROM triggers`。

## 8. 怎么验证（可复跑，不靠转述）

```bash
# 行为测试（真 Sqlite，不是夹具）
vitest run --project node packages/storage/test/mailbox-axis-split.test.ts

# 真库探针（openSqlite 建库 → 投递 → 读回 → 历史行回落 → 保留策略）
node scripts/probe-mailbox-split.mjs
```

测试覆盖：新行 payload 无内容键 / 读路径取 trigger 正文 / 历史行回落 /
同一事件只一行正文 / dedup 冲突整体回滚 / 执行态状态机不受影响 /
I9 升级前后旧列 dump 哈希一致 / 轴清单与真实列逐项对账 / `INSERT INTO triggers` 只有一处。
