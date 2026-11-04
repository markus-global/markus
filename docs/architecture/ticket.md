# Ticket —— 执行侧的工作单位

> 状态：**Living**（已实现，commit 见 `docs/design/superagent/03-概念澄清与状态台账.md` C1 行）
> 对应问题：概念混淆清单 **C1**「Ticket 必须独立成表」；Owner 2026-11-03 裁定：
> **Task 是更上层的治理对象；任何东西都可能有 Ticket**（一条评论、一封消息、一个 webhook）。

## 0. 一句话

**Task 回答「这件事该不该做、谁批、谁验收」；Ticket 回答「这一件外部来的东西现在归谁、办完没有」。**

## 1. Ticket vs Task —— 边界表

| 问题 | Task（治理对象） | Ticket（执行侧单位） |
|---|---|---|
| 回答什么 | 这件事**该不该做**、谁批、谁验收 | 这一件东西**归谁处理**、结束了没有 |
| 状态 | `TaskStatus` 9 个治理态（pending→…→archived）+ 审批闸门 | 本文件 §3 的 3 个态 |
| 能否独立存在 | **不能**：必须挂 requirement、必须有人批准 | **能**：不挂 task、不挂 requirement 也可以 |
| 谁创建 | 人 / requirement 审批流 | 任何入口：事件、评论、webhook、人手动 |
| 有审批吗 | 有（建卡闸 / review 闸 / 需求闸） | **没有**——票不授予任何授权 |
| 驱动执行吗 | 是：assignee 会被叫醒干活 | **否**：票没有 `ticket → agent` 的投递通道 |
| 生命周期跟随谁 | 自己的治理状态机 | **自己**，不跟随 task、不跟随 session |

### 「会不会变成第二个 Task」

唯一判据是上表倒数第二行：**票不驱动任何执行**。它是「标签 + 生命周期」，不是执行引擎。
一旦有人给 ticket 接上「ticket → agent 投递」，它就退化成第二个任务系统 —— 那时必须停下来重新裁定
（契约 H1：不得新增一个「系统」）。这条判据写在这里，是为了让下一个想加投递的人先读到它。

## 2. 字段表（`tickets`，见 `packages/storage/src/sqlite-storage.ts` 的 `SCHEMA_SQL`）

| 列 | 类型 | 可空 | 含义 | 约束 / 说明 |
|---|---|---|---|---|
| `id` | TEXT | 否 | 票 id | 主键，`tkt_` + 16 位随机 |
| `org_id` | TEXT | 否 | 租户 | Markus 单租户恒 `default`；**刻意不建到 `organizations` 的外键**（票的存在不应依赖组织配置先落库，否则「任何事件都能挂票」被一条无关的初始化顺序卡死） |
| `kind` | TEXT | 否 | 这条东西是什么 | **开放字符串**（已知取值：`message` / `comment` / `webhook` / `task` / `resource` / `approval` / `manual`）。不做闭集：Ticket 的卖点就是「任何东西都可挂票」，枚举死等于每来一个来源都要改核心类型（R1 老路） |
| `source_ref` | TEXT | 是 | 来源对象指针 | `msg_…` / `cmt_…` / `gh:owner/repo#123` / `tsk_…`；`NULL` = 手动创建，无来源事件 |
| `subject` | TEXT | 否 | 一句话标题 | 写入时 `trim()` 后为空直接拒绝（无名票在 UI 上无法被认领） |
| `status` | TEXT | 否 | 票的状态 | 默认 `open`；合法值见 §3；**新建只能是 `open`** |
| `assignee` | TEXT | 是 | 谁在处理 | **单值**。票是「一件东西归一个人」，不是责任域（那是 A4 / `resource_bindings`，另一个概念） |
| `task_id` | TEXT | **是** | 可选关联的 Task | `REFERENCES tasks(id) ON DELETE SET NULL` —— 删任务只断开关联，**不级联删票** |
| `created_at` | INTEGER | 否 | epoch ms | 新表统一毫秒整数（与 `thread-store.ts` 约定一致，`ORDER BY` 才走索引） |
| `updated_at` | INTEGER | 否 | epoch ms | 每次状态流转 / 关联变更都推进 |

索引：`idx_tickets_task(task_id)`（按任务列票）、`idx_tickets_org_status(org_id, status, updated_at DESC)`（列表页）。

## 3. 状态机（唯一事实源：`packages/shared/src/types/ticket.ts`）

```
open ──ended──▶ ended ──open──▶ open        （人在这条流上又发消息 → 票被恢复）
  │               │
  └──cancelled────┴──cancelled──▶ cancelled  （人喊停：终态，不可恢复）
```

| 状态 | 含义 | 允许转到 |
|---|---|---|
| `open` | 还没办完 | `ended`、`cancelled` |
| `ended` | 办完了（**可恢复**） | `open`、`cancelled` |
| `cancelled` | 人喊停 | ∅（终态） |

设计依据（`01-分析与目标设计.md` §3.1）：「open→ended，人发消息可恢复（除非人喊停）；
**自己定义状态，不跟随 Executor**」。

**只有一个执行点**：`SqliteTicketRepo.transition()` 调 `isValidTicketTransition`，
自己**不写**任何 `if (from === ...)` 分支。第二个「能不能转」的判断 = 一个新的写者（契约 H7）。

## 4. 单一写入点

`packages/storage/src/ticket-store.ts` 是**全仓唯一**的票写入者：

| 方法 | 唯一的写操作 |
|---|---|
| `create()` | `INSERT INTO tickets`（全仓唯一） |
| `transition()` | `UPDATE tickets SET status …`（全仓唯一） |
| `linkTask()` | `UPDATE tickets SET task_id …`（全仓唯一） |

为什么能把这条守住：SQLite 同进程只有一个连接、没有 per-table ACL，**物理上挡不住**别的模块直接拼 SQL。
所以把「单一写者」做成一条**会红的检查**而不是一句注释 ——
`packages/storage/test/ticket-store.test.ts` 扫描 `packages/*/src/**/*.ts`，
断言 `INSERT INTO tickets` / `UPDATE tickets` 只出现在 `ticket-store.ts`。加第二个写者即红。

**越界一律「拒绝 + 可行动提示」**（平台规则第 5 条）：

| 越界 | 结果 |
|---|---|
| 流转一个不存在的票 | `TICKET_NOT_FOUND`，提示「流转不会自动建票，先 `POST /api/tickets`」（**不静默 upsert**：自动建票会让「流转了但票不存在」变成合法操作） |
| 非法状态转移 | `TICKET_TRANSITION_INVALID`，并列出当前状态**允许转到**哪些 |
| 非法状态字面量 | `TICKET_STATUS_INVALID` |
| 挂到不存在的任务 | `TICKET_TASK_NOT_FOUND`，把 `FOREIGN KEY constraint failed` 翻译成人话，并提示「票不需要任务也能独立存在」 |
| 空标题 / 空 kind / 空 org | `TICKET_SUBJECT_REQUIRED` / `TICKET_KIND_REQUIRED` / `TICKET_ORG_REQUIRED` |

## 5. 关联规则（与 Task 是可选关联，不是从属）

1. **票可以没有任何 Task**：`task_id IS NULL` 是一等状态，不是「还没设置」。
2. **票可以挂一张 Task**：一张票最多挂一个任务（单列）。一个任务可以有很多票（`listByTask`）。
3. **删 task 不得级联删 ticket**：`ON DELETE SET NULL`。删任务后票仍在、仍可读、`task_id` 变 `NULL`。
4. **task 完成/取消 → 票不动**：票的状态**不跟随** task（设计原文「Ticket 自己定义状态，不跟随 Executor」）。
   要结束票，显式调 `transition(…, 'ended')`。
5. **断开关联 ≠ 删票**：`linkTask(id, null)` 只清 `task_id`。

## 6. 与 approval 的关系

**没有关系**，而且是刻意没有：

- approval（`approvals` / HITL 三态）回答「**允许不允许**」——它授予或收回授权，是治理闸门。
- ticket 回答「**归谁、办完没**」——它不授予任何东西，`assignee` 只是一句「谁在看」，**不参与** autonomy 判定，
  也不触发任何投递。

把 `assignee` 当授权用 = 把 A4 的两种授权混成第三种（Mandate 逐件事 / ResourceBinding 逐资源）。
票如果要「允许 agent 动手」，那必须走 approval 或 `resource_bindings`，不是在票上加个字段。

## 7. `thread_subscriptions.ticket_id` 为什么本轮**没有**加外键

`thread_subscriptions.ticket_id` 此前指向一个不存在的对象（C1 的原问题）。本轮建了 `tickets` 表，
但**没有**给那一列加 `REFERENCES tickets(id)`，理由三条：

1. **今天那两个生产写入点写的是 thread id**：`packages/storage/src/thread-store.ts`（`ensureSubscription`）
   与 `packages/cli/src/commands/start.ts`（`resourceToolDeps.subscribe`）都把 `thread.id`（`thr_…`）当
   `ticket_id` 写进去（v1 语义「ticket 就是 thread 本身」）。加 FK → 这两条路**立刻违规**。
2. **改动它们不是本卡的语义**：让它们「先建票再订阅」等于重新定义「一条流归谁」，属任务六（A4 边界）
   /任务七（Thread 视角）的范围；在本卡里做会让两张卡的判据互相污染。
3. **不能靠迁移脚本硬加**：SQLite 加外键必须重建表，而存量行里的 `ticket_id` 全是 thread id ——
   要么给它们凭空造一批「假票」（那正是 C1 要消灭的悬空引用的另一种形态），要么改写订阅语义。
   两条都比「先不做、写清条件」更坏。

**迁移触发条件（写死在这里，避免下一个人以为是忘了）**：当「订阅」的写入点改为「先拿一张真票、
再订阅」（任务六/任务七之一落地时），同一张卡里做三件事：① 存量 `thread_subscriptions` 回填票；
② `ticket_id` 加 `REFERENCES tickets(id)`；③ 本节的第 1 条理由作废，删掉本节。

在那之前，票自身的一致性由 §4 的单一写入点 + §5 的四条关联规则守住。

## 8. HTTP 面

| 入口 | 作用 | 拒绝口径 |
|---|---|---|
| `POST /api/tickets` | 建票。Body：`kind`（必填）、`subject`（必填）、`sourceRef?`、`assignee?`、`taskId?`、`orgId?`（缺省 `default`） | 400 + 具体原因（见 §4 表） |
| `GET /api/tickets/:id` | 读一张票 | 404（`error` 里给出「去哪找正确 id」） |
| `POST /api/tickets/:id/transition` | 流转状态。Body：`status` | 404 = 票不存在；400 = 状态非法/转移非法 |
| `PATCH /api/tickets/:id` | 关联/断开任务。Body：`taskId`（字符串或 `null`） | 404 / 400；**不接受 `status`**（流转只有 transition 一条路） |
| `GET /api/tasks/:id/tickets` | 某任务上的票 | 404 = 任务不存在（**不返回空数组**：否则打错的 task id 会显示成「这任务没票」——差数据比没数据更坏） |

鉴权沿用 `api-server` 的既有会话鉴权（与 `/api/threads*` 同一口径），`event-routes.ts` 只做 HTTP ↔ 仓储翻译。

## 9. 行为测试（这些是守卫，不是文档）

| 判据 | 用例位置 |
|---|---|
| ① 票不挂 task 也能建/读/流转 | `packages/storage/test/ticket-store.test.ts`「三向关联」 |
| ② 票挂 task 双向可查 | 同上 |
| ③ task 取消 → 票仍在、状态不跟随 | 同上 |
| ③b task 被删 → 票仍在、`task_id` 置空 | 同上（测的是真 FK 引擎，fake repo 测不到） |
| ④ 三种场景后 `PRAGMA foreign_key_check` 无违规行 | 同上 |
| ⑤ 单一写入点（源码扫描） | 同上「结构断言」 |
| ⑥ 外键形态 = `ON DELETE SET NULL` | 同上 |
| ⑦ 五个 HTTP 入口的正常/拒绝口径 | `packages/org-manager/test/ticket-routes.test.ts` |
