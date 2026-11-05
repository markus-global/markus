# P0 收口报告 · 「终态」唯一事实源（2026-11-05）

> 对应审计：`docs/architecture/hardcoded-string-audit.md` §2
> 分支：`task/tsk_5407eaa5ea28222f348fea44-cto`（基线 `8ac0ad84`，与 P1/P2/P4 卡同基线）

## 1. 结论

终态判定从 **8 份定义 + 审计外 5 处逃逸** 收敛为 **1 个常量 + 1 个谓词**：

```ts
// packages/shared/src/types/task.ts
export const TERMINAL_STATUSES: ReadonlySet<ItemStatus> =
  new Set<ItemStatus>(['completed', 'failed', 'rejected', 'cancelled', 'archived']);

export function isTerminal(status: string | null | undefined): boolean;
```

`blocked` / `review` 明确**不是**终态。判据不靠直觉，靠 FSM（`TASK_TRANSITIONS`，同文件）：

| 状态 | 出边（权威） | 所以 |
|---|---|---|
| `blocked` | `→ in_progress` / `cancelled` / `failed` | 依赖引擎会自动解除，是**活的等待态** |
| `review` | `→ completed` / `in_progress` / `cancelled` | 等人工决策，是**活的待决态** |
| `archived` | 无出边 | 唯一吸收态 |

未知字符串（含历史遗留的 `'accepted'`）一律 `false`：**「不认识」不等于「已结束」**。

## 2. 八处旧定义的去向

| # | 位置 | 原形态 | 处置 |
|---|---|---|---|
| 1 | `org-manager/src/task-service.ts:88` | `TERMINAL_BOARD_STATUSES`（分页分桶） | 删除，改用 `TERMINAL_STATUSES`（成员逐字相同，等价替换） |
| 2 | `org-manager/src/task-service.ts:2340` | `['review','completed','failed','cancelled','archived','blocked']` | **删除**（见 §3） |
| 3 | `org-manager/src/task-service.ts:6303` | 同上，逐字重复 | **删除**（见 §3） |
| 4 | `org-manager/src/task-attention.ts:59` | 私有 Set，含 `'accepted'` | 删除；`isTerminalTaskStatus()` 改为转发 `isTerminal()` |
| 5 | `core/src/agent-manager.ts:135` | `['completed','failed','cancelled','archived']`（**少 `rejected`**） | `isTerminal()` |
| 6 | `core/src/context-engine.ts:1179` | 函数体内每次调用 `new Set(...)` | 删除；改模块级 `isTerminal()`（缓存友好：不再每次调用重建集合、无形状漂移） |
| 7 | `web-ui/src/lib/boardFilters.ts:17` | `CLOSED_STATUSES` | **不是终态** → 正名为 `HIDDEN_BY_DEFAULT_STATUSES` / `isHiddenByDefault`（见 §4） |
| 8 | `web-ui/src/pages/Work.tsx:739` / `:6194` | 两份内联 `['rejected','cancelled','archived']` | 删除，改用 `isHiddenByDefault` / `HIDDEN_BY_DEFAULT_STATUSES` |

浏览器侧不 import `@markus/shared`（包体限制，仓库既有约定），因此新增
`web-ui/src/lib/taskStatus.ts` 作为**投影**（非第二定义），写入者仍是 shared，
漂移由 `packages/shared/test/terminal-status-mirror.test.ts` 判红
——与 `mailboxTypeMeta.ts` 的既有机制完全一致。

## 3. `2340` / `6303` 的诚实定性（不做过度归因）

这两处的下游条件（`:2351` / `:6309`）都还要求 `status === 'in_progress'`，
因此数组里的 `review` / `blocked` 是**不可达条件**——它没有直接造成过任何事故。
按「删第二定义」处理：整个 `alreadyTerminal` 变量删除，条件是

```ts
if (!didSubmit && currentTask && currentTask.status === 'in_progress')
```

语义完全等价（`isTerminal('in_progress') === false` 恒成立），少一份「终态」说法的物证。

## 4. 排除清单（不计入终态清零，附理由）

| 位置 | 形态 | 为什么不是终态判定 |
|---|---|---|
| `cli/src/commands/approval-card.ts:31` | `approved/rejected/cancelled/expired` | **审批单**状态，另一套状态机 |
| `web-ui/src/components/CodingToolCard.tsx:40` | `completed/failed/cancelled/timeout` | **coding 工具会话**状态 |
| `org-manager/src/requirement-service.ts:73` | `VALID_STATUSES` | 状态**枚举**，不是终态判定 |
| `web-ui/src/lib/boardFilters.ts:17` | `HIDDEN_BY_DEFAULT_STATUSES` | **视图偏好**：回答「默认看板要不要藏」，`completed`/`failed` 默认仍要可见。改它=用户可见行为变更，不夹在重构里做 |
| `org-manager/src/agent-conservator.ts:287` | `DEAD_DEP_STATUSES` | 「**依赖已死**」：`completed` 是终态但不是死；`rejected` 是人类决定不阻塞下游。它是终态的**真子集**，语义不同 |
| `scheduled-task-runner.ts:183` / `api-server.ts:13480` | `resettable*` | **可重跑资格**（只允许已跑完的），与「是否终态」无关 |
| `web-ui/src/lib/workflow-view.ts:104` | `DONE_STATUSES` / `FAILED_STATUSES` / `ACTIVE_STATUSES` | **展示分类**：把终态拆成「成功 / 失败」两种颜色，合并会丢掉区分 |
| `task-service.ts:1431` / `Work.tsx:1400` | `['completed','failed','cancelled','execution_finished']` | 比的是**执行日志 content 字符串**，`execution_finished` 不是状态 |
| `shared/src/types/requirement.ts:9` | `TERMINAL_REQUIREMENT_STATUSES` | 同一枚举上的**另一个问题**：需求不会 `failed`。它本身是需求域的 SSOT（位于 shared，非内联副本） |

## 5. grep 清零台账

```bash
# 已删除的第二定义（源码命中数）
TERMINAL_BOARD_STATUSES  0
isClosedStatus           0
CLOSED_STATUSES          0
CLOSED_REQ_STATUSES      0

# 终态域内 '['completed' 起头」的字面量数组残留（经排除清单过滤后）
org-manager/src/scheduled-task-runner.ts:183   → 排除：可重跑资格
org-manager/src/api-server.ts:13480            → 排除：可重跑资格
org-manager/src/task-service.ts:1431           → 排除：执行日志 content
web-ui/src/lib/workflow-view.ts:104            → 排除：展示分类
```

定义处只剩 3 个：`shared` 的终态 SSOT、`web-ui` 的投影、`cli` 的审批单（另一域）。

## 6. 验证证据

**先红**（实现前）：

```
Test Files 3 failed (3) / Tests 6 failed (6)
TypeError: isTerminal is not a function
```

**变异闭环**（把 `'review'` 塞回 `TERMINAL_STATUSES` → `npx tsc -b` → 红 → 复原 → 重建 → 绿）：

```
npx tsc -b            # BUILD_EXIT=0（vitest 经 @markus/* 解析 dist，改 src 必须重建）
Tests 5 failed | 11 passed (16)
  × classifies exactly the five finished statuses as terminal
  × review is live: it waits for a human decision
  × mirrors exactly the server set
  × answers identically for every status, plus the legacy junk strings
  × ② review is not terminal — a human decision is still pending
# 复原后
BUILD_OK / Test Files 5 passed (5) / Tests 30 passed (30)
```

注意**表驱动一致性断言在这一轮是绿的**（两边一起被改坏），真正咬人的是 FSM 语义断言
——这就是为什么两类断言都要有。

**全量回归**（`npx tsc -b` 干净）：

| 包 | 结果 |
|---|---|
| org-manager | 95 files / **1691 passed** |
| core | 279 files / **3615 passed**, 10 skipped |
| web-ui | 98 passed / 1 skipped files，**1269 passed**, 3 skipped |

## 7. 残余（条件 / 阈值 / 观测）

1. **`'accepted'` 的 4 处兼容分支**（`core/src/agent-manager.ts:2260`、`:3166`、
   `web-ui/.../TaskDAG.tsx:834`、`Work.tsx:3357`）：这些是**完成计数**，不是终态判定，
   且可能是旧版存储值的兼容分支。
   条件：库里存在 `status='accepted'` 的存量行；阈值：任一统计口径与
   `SELECT COUNT(*) FROM tasks WHERE status='accepted'` 对不上；
   观测：桌面端统计面板。为空则可另开一卡删除。
2. **`workflow-view.ts` 展示分类**未接入 `isTerminal`：新增终态时需人工同步颜色。
   条件：`ItemStatus` 新增成员；阈值：DAG/进度条出现无色状态；观测：DAG 视图。
3. **`requirement-service.ts#checkCompletion` 的 `allDone`** 仍用
   `completed|cancelled|archived` 判断「全部任务已终态」（`failed`/`rejected` 不算 done）。
   这是「已成功收尾」而非「已终态」，疑似有意；本卡不改（改它会让全失败需求的
   需求方收到「请审阅」的过时催促）。条件：该需求下任务全为 failed/rejected 时
   从不提醒 → 已登记为独立议题。
4. 386 处状态裸比较（P3 卡）、`catch(() => [])`（P1 卡）不在本卡。

## 8. 改动清单

```
 M packages/shared/src/types/task.ts          # +isTerminal()，终态 SSOT 文档化
 M packages/org-manager/src/task-service.ts    # -TERMINAL_BOARD_STATUSES, -2×alreadyTerminal, 2 处 cap 判定
 M packages/org-manager/src/task-attention.ts  # 私有 Set → 转发 isTerminal
 M packages/org-manager/src/agent-conservator.ts # DEAD_DEP_STATUSES 导出 + 语义说明（值不变）
 M packages/org-manager/src/archive-service.ts  # ARCHIVABLE 由终态常量派生
 M packages/core/src/agent-manager.ts          # 补 rejected（原集合少一个）
 M packages/core/src/context-engine.ts         # 函数体内 new Set → 模块级谓词
 M packages/web-ui/src/lib/boardFilters.ts     # CLOSED → HIDDEN_BY_DEFAULT（视图偏好正名）
 M packages/web-ui/src/lib/taskStatus.ts       # 新增：浏览器侧投影（+需求终态投影）
 M packages/web-ui/src/pages/Work.tsx          # 5 处内联集合 → 单一来源
 M packages/web-ui/src/components/TaskDAG.tsx  # done 分组 + 需求锚点改用投影
 M packages/web-ui/test/boardFilters.test.ts   # 断言语义保持原义，仅正名 + 注释
 + packages/shared/test/terminal-status.test.ts
 + packages/shared/test/terminal-status-mirror.test.ts
 + packages/org-manager/test/terminal-status-single-source.test.ts
 + packages/web-ui/test/taskStatus.test.ts
```

**行为变更（必须让评审看到的两处）**：`rejected` 任务不再被计入
「活跃任务数」（org 上限 / agent 上限 / 项目内 agent 活跃计数 / 过期 activeTasks 清理）。
依据 FSM：`rejected → archived` 是唯一出边，它不可能再执行。
