# 需求事件与写入闸门（Requirement Events & Write Gates）

**状态**：已落地（2026-11-04）
**触发事故**：`req_319b0b66c5f99964e3ff65e8` 在 3 小时内收到 **257 条评论**，全部由同一个 agent 写成。

## 1. 事故实测数据（取证口径）

```
评论总数            257（256 条内容各不相同）
作者分布            全部 = 该需求的 created_by（同一 agent）
相邻间隔分布        239/249 落在 2s–1m，15 条落在 1–60m
该需求的 mailbox    21 条（20 × task_status_update + 1 × requirement_update）
```

**结论**：唤醒源是**正常**的（21 次），失控的是**写入侧**——每次唤醒里连发十几条"卡1 completed、卡3 返修中…"的状态复述。软提示（评论正文里写「考虑 end_turn」）对这种行为**无效**。

## 2. 四个缺陷与四个闸门

| # | 缺陷 | 闸门 | 唯一执行点 |
|---|---|---|---|
| 1 | `requirement_update` 不在幂等键作用域内 → 「全部任务已终态」可无限投递 | 需求级幂等键：`requirement_update:<reqId>:<event>:<factFingerprint>`，键只由结构化字段构成 | `packages/core/src/mailbox.ts#mailboxDedupKey` |
| 2 | `checkCompletion()` 水平触发（每次评估都发），且只挡 completed/cancelled | 终态守卫（`TERMINAL_REQUIREMENT_STATUSES`）+ 事实指纹；事实不变 → 键不变 → 投递层抑制 | `RequirementService.checkCompletion` |
| 3 | 单个 agent 对同一需求的评论写入无任何上界 | 10 分钟窗口内最多 5 条，超出**拒绝**并给可行动提示（事实写卡面 / `end_turn`） | `TaskService.postRequirementComment` |
| 4 | `task_create` 接受终态需求 → 「已完成需求 + pending 卡」不变量破口 | 拒绝 + 提示改建新需求 | `TaskService.createTask` |

## 3. 幂等的语义边界（务必区分）

- **幂等 ≠ 永久静音**：指纹由事实构成。链接了新任务 → 指纹变 → 新一轮**可以**再通知。
- **只从结构化字段取键**：`extra.event`（事件种类）+ `extra.factFingerprint`（事实指纹）由发射方声明，**绝不从 `content` 文本解析**——in-band 文本不是结构。
- 未声明 `event` 的 `requirement_update` 返回 `undefined`（不加约束）：宁可没有幂等，也不要让平台**猜**事件语义。

## 4. 兼容性

- 全部为服务端闸门 + 一个共享常量，**无 schema 变更**、无数据迁移；
- 旧客户端调用 `requirement_comment` 不传 `authorType` 时按 `'agent'` 计，因此同样受限；
- 人类评论（`authorType: 'human'`）不受第 3 条闸门影响。

## 5. 观测与残余

- 拒绝是**显式错误**（`COMMENT_RATE_LIMITED` / `REQUIREMENT_TERMINAL`），调用方拿到可行动提示，不做静默丢弃。
- **残余**：评论速率阈值（5 / 10 分钟）是经验值，不是从数据推导出的最优解；若出现合法的密集协作（多人同时对同一需求讨论），需要按**作者 + 会话**细分而不是整体放宽。触发条件：出现被拒绝后确实需要继续写入的合法场景。
- **残余**：`task_status_update` 的部分行 `dedup_key` 为空（实测 20 条里多数为空），说明某些发射路径没传 `extra.from/to`（`mailboxDedupKey` 因此返回 `undefined`）。这是同一族的**下一个**缺口，未在本轮修复。
