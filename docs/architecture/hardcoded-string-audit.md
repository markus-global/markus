# 硬编码字符串审计：同类病灶还有多少

**日期**：2026-11-04
**方法**：把**硬编码字符串**当作「结构被复制」的可观测证据，用 8 组探针在全仓（`packages/*/src`，排除测试）实测。
**为什么用字符串当探针**：同一个字面量出现在 N 个文件，就是「同一个事实有 N 个读口径 / N 个写者」的物证；而且改名时它们不会一起改——这正是 R1（一个事实多个写者）与 R2（一个不变量多个执行点）的静态指纹。

---

## 1. 总览（实测数字，非估计）

| # | 探针 | 命中 | 是否有单一事实源 | 风险 |
|---|---|---|---|---|
| P1 | 任务/需求状态字面量 `'pending' / 'in_progress' / …` | **934 处**（completed 186/59 文件、pending 158/41、in_progress 119/24、cancelled 109/36、failed 104/43、blocked 74/22、review 74/27、rejected 66/32、archived 44/19） | 类型有（`ItemStatus`），**判断没有** | 高 |
| P2 | `status === '…'` / `status !== '…'` 裸比较 | **386 处** | 无 | 高 |
| P3 | 「终态集合」内联数组/Set | **≥11 处，且互相不一致**（见 §2） | ❌ 有 5 种不同定义 | **最高** |
| P4 | actor 类型字面量 `'agent' / 'system' / 'human'` | **814 处**（agent 441、system 196、human 177） | 类型有，判定无 | 中 |
| P5 | in-band 结构标记 `actionRequired / triggerExecution / directMention` | 54 处（34 / 13 / 7） | 有谓词但判据散落 | 高 |
| P6 | 吞错 `catch(() => …)` | **97 处**（org-manager 29、web-ui 24、core 23、desktop 7、extension 5、comms 4） | 无 | 高 |
| P7 | `Date.now()` 参与 id/键 | 553 处（需逐点判定是否为键） | 无 | 中 |
| P8 | 投递 `enqueueToMailbox('…')` 字面量 | **仅 9 处** | ✅ 收敛得不错 | 低 |

**P8 是好消息**：投递点没有散（9 处），所以上一轮「唤醒必须可去重」能靠一个执行点收口；**病灶集中在"读/判断"，不在"写"**。

---

## 2. P3：同一个「终态」有 5 种定义（最硬的一条）

| 位置 | 定义 |
|---|---|
| `org-manager/src/task-service.ts:88` | `TERMINAL_BOARD_STATUSES = ['completed','failed','rejected','cancelled','archived']` |
| `core/src/agent-manager.ts:135` | `['completed','failed','cancelled','archived']` —— **少 rejected** |
| `core/src/context-engine.ts:1179` | `CLOSED_STATUSES = ['completed','cancelled','failed','archived','rejected']` |
| `org-manager/src/agent-conservator.ts:287` | `DEAD_DEP_STATUSES = ['failed','cancelled','archived']` —— **少 completed/rejected** |
| `web-ui/src/lib/boardFilters.ts:17` | `CLOSED_STATUSES = ['rejected','cancelled','archived']` —— **少 completed/failed** |
| `org-manager/src/task-service.ts:2340 / 6303` | `['review','completed','failed','cancelled','archived','blocked']` —— **把 review 和 blocked 当终态** |

前 5 处是「同一个概念的 5 种口径」；最后两处更危险：**`blocked` 被当终态**，而 `blocked(deps)` 是会被依赖引擎自动解除的活状态 —— 一旦这里判断提前返回，任务就再也不会被解封（这正是 2026-11-03 拉锯事故的另一条可能路径）。

**已有正确形态**：`shared/src/types/task.ts` 里有 `TERMINAL_STATUSES`（唯一常量）和 `TASK_TRANSITIONS`（声明式矩阵）。问题是**没人强制用它**。

---

## 3. P6：97 处吞错把「没读到」伪装成「确实没有」

实测过的两次事故都出自这一族：

- 时间线面板「还没有任何记录」第一帧闪现 —— `catch(() => [])` 把取数失败变成空数组；
- 历史弹窗未读数不刷新 —— 失败被吞，UI 显示旧快照。

判据：**`catch` 里返回空集合/空数组，等于对用户陈述一个你不知道的事实。** 正确形态是三态（loading / error / empty），错误必须可见。

---

## 4. P5：54 处 in-band 结构标记（R3 温床）

`extra.actionRequired` / `extra.triggerExecution` / `extra.directMention` 让**载荷字段**决定调度行为：

- 优点：不用加字段就能表达结构；
- 代价：判据只有一个 `isStrictStateItem` 谓词，但**读取点 54 处各自解释**；上一轮事故就是「缺 event 时静默放行」。

已收敛的部分：唤醒型投递现在由 `WAKEUP_EVENTS` 登记表 + `assertWakeupDedupable()` 强制。
未收敛：`triggerExecution`（13 处）与 `directMention`（7 处）仍是纯约定，**缺少同样的登记与 fail-closed**。

---

## 5. 修复方向（按优先级，每条都有验收判据）

### P0 · 终态集合收敛到一处
- 做法：只留 `shared/types/task.ts#TERMINAL_STATUSES`；`blocked` / `review` 明确**不属于**终态；`DEAD_DEP_STATUSES` 这类"依赖失败"语义另立常量并写清理由。
- 验收：全仓 `['completed'` 字面量数组 = **0**；新增状态只改一处；两个既有事故（已完成需求仍带待审批、blocked 被提前判死）各配一条行为测试。

### P1 · 吞错改三态
- 做法：`catch(() => [])` 在取数路径上改为抛出/置 `error` 状态；UI 区分 loading / error / empty。
- 验收：97 处里"取数路径"的全部改造；测试断言「取数失败不得渲染空态文案」。

### P2 · `triggerExecution` / `directMention` 纳入登记表
- 做法：照搬 `WAKEUP_EVENTS` 模式——谓词单一执行点 + 未登记即拒绝。
- 验收：新增标记不登记 → 测试红。

### P3 · 状态裸比较收口
- 做法：386 处不必一次改完；**新增**必须走 `isTerminal()` / `TASK_TRANSITIONS`，老代码按触碰即改。
- 验收：`isTerminal` 成为唯一判定入口，`status === 'completed'` 在业务逻辑里逐步清零。

### P4 · `Date.now()` 不进缓存键
- 做法：id 生成可以带时间；**缓存键/指纹不得含时间**。
- 验收：键构造函数（`fingerprint` / `dedupKey` / `cacheKey`）内不得出现 `Date.now()`。

---

## 6. 残余与不确定性（诚实列出）

1. **P7 的 553 处没有逐点判定**：多数是 id 生成（合法），不是缓存键。要精确需人工/半自动过一遍。
2. **字符串探针发现不了的问题**：逻辑重复但字面量不同的（如两套等价的条件判断）、时序竞态、两个写者用不同字段表达同一状态 —— 这些要靠行为测试与真实数据探针，**本审计不覆盖**。
3. **P4 的 814 处 actor 字面量未处理**：它与「谁有权做什么」相关，属授权域，需单独一轮，且必须与 `authorizeAction()` 单一判定点合并考虑。
4. 本审计只做**静态分布**，不代表每一处都是缺陷；判定标准是「同一事实是否存在多个口径」，逐条落地时仍需复现证据。

---

## 7. 复核更正（CTO，2026-11-04 23:16；grep 于 `/Users/liuqian/mycode/markus`）

落地前按原文 grep 复核，发现三处需要更正，**以本节为准**：

### 7.1 §2 表漏了两处（终态定义实际 ≥7 处，不是 5 处）
- `org-manager/src/task-attention.ts:59` `TERMINAL_STATUSES = ['completed','accepted','archived','failed','rejected','cancelled']` —— 含 `'accepted'`，其它定义均无此状态，疑为陈旧状态，须对照 `TASK_TRANSITIONS` 确认后删除或说明。
- `web-ui/src/pages/Work.tsx:739` 与 `:6194` 各一份内联 `CLOSED_STATUSES_SET = ['rejected','cancelled','archived']`（`6194` 还在组件体内每次渲染重建）。

### 7.2 `boardFilters.isClosedStatus` 不属于终态域（**本节曾写错，已更正**）
**更正说明**：本节初版写的是「`boardFilters.test.ts:43-44` 把 bug 写成了契约，应修正断言」——**这个判断是错的**。查调用方后确认：

- `isClosedStatus` 的唯一调用点是 `web-ui/src/lib/boardFilters.ts:55`：
  `let result = includeClosed ? tasks : tasks.filter((t) => !isClosedStatus(t.status));`
- 它回答的是「**默认看板要不要隐藏**」，不是「**是否终态**」。`completed` 不在该集合里 → 已完成任务默认仍显示在看板，这是**现有产品行为，不是 bug**。
- 若把这个集合并进 `TERMINAL_STATUSES`，`completed`/`failed` 会从默认看板消失（要开「显示已关闭」才看得到）= **用户可见的行为变更**，不能夹在重构里悄悄做。

**正确处置**：该常量列入「终态清零」的**排除项**（与审批单状态、coding 工具状态、`VALID_STATUSES` 枚举并列），改名说清语义（如 `HIDDEN_BY_DEFAULT_STATUSES`）+ 注释「视图偏好，非终态判定」；**`boardFilters.test.ts:43-44` 的断言保持原义，不许为凑「清零」去改它**。

**可复用判据**：同一个谓词不能同时回答「是否终态」与「默认是否隐藏」——同一形状回答两个问题，是本项目反复出现的陷阱。

### 7.3 验收判据必须收窄到「task / requirement 状态」定义域
「终态字面量数组 = 0」若不圈定定义域则不可满足，且会误伤语义不同的同名常量。**明确排除**（禁止合并，不计入清零）：
- `packages/cli/src/commands/approval-card.ts:31` —— 审批单状态 `approved/rejected/cancelled/expired`
- `packages/web-ui/src/components/CodingToolCard.tsx:40` —— coding 工具状态 `completed/failed/cancelled/timeout`
- `packages/org-manager/src/requirement-service.ts:73` —— `VALID_STATUSES`，是状态枚举而非终态判定

### 7.4 未逐条复现、留给执行者的项
`core/src/agent-manager.ts:135`、`org-manager/src/task-service.ts:2340 / 6303` 的行号本轮未复现，执行者须以自己分支 worktree 的 HEAD 为准重测，报告注明「行号取自 <worktree> @ <short HEAD>」。

> **2026-11-04 23:20 更正**：上述三处随后已逐条读源码坐实 —— `agent-manager.ts:135` 的集合确实**少 `rejected`**；`task-service.ts:2340` 与 `:6303` 是两处逐字相同的 `['review','completed','failed','cancelled','archived','blocked']`，下游另有 `status === 'in_progress'` 闸（`:2351` / `:6309`），故 `review`/`blocked` 当前是**不可达条件**，属「一个事实多个写者」的物证，**不得**写成历史事故根因。

---

## 8. 落地状态与完成度（CTO，2026-11-05 17:45 CST，现测）

> 本节是**落地状态的单一事实源**。§1–§5 是立项时的审计口径，§7 是落地前的复核更正，二者不随落地变化；本节只回答「现在做到了什么、还差什么」。

### 8.1 落地线

整合分支 `feat/thread-trigger-router`，HEAD `2069e13e`（读 `.git/logs/refs/heads/feat/thread-trigger-router` 现测，非转述）：

| 项 | 分支快照 | 并入整合线的提交 | 冲突处置 |
|---|---|---|---|
| P0 终态唯一事实源 | `task/tsk_5407eaa5…-cto` @ `d2f78684` | `485e6321` | 无 |
| P1 取数吞错三态 | `task/tsk_093655c1…` @ `8e1f5c37` | `c8e2cebc` | 2 处：`context-engine.ts` 删掉 P1 自带的 `CLOSED_STATUSES`（P0 已立 `isTerminal` 单一判据）；`useUnreadCounts.ts` 保留批量 `_advanceReadCursors` + P1 的 error 态 |
| P2 in-band 登记表 | `task/tsk_3a804016…-cto` @ `eb0f39b3` | `545913d3` | 无 |
| P3 裸比较收口 + 门禁 | `task/tsk_1e766b22…-cto` @ `7d4fec50` | `0f00dc48` | 无 |
| P4 缓存键禁时钟 | `task/tsk_07659f0f…-cto` @ `8b4d904e` | `2069e13e` | 无（`architecture-guard.mjs` 自动合并成功） |
| P5 唯一度量入口 | 已 archived，无独立分支 | — | 普查口径并入 `scripts/architecture-guard.mjs` |

### 8.2 需求级复验（合并后同一棵树上跑，不是各分支分别绿）

```
npx tsc -b                                                → exit 0
node scripts/architecture-guard.mjs                       → ✓ 通过（命中全部在已登记白名单内；契约不变量 17/17）
npx vitest run --project web-ui                           → 1296 passed | 3 skipped
npx vitest run --project node packages/core packages/shared packages/storage packages/org-manager
                                                          → 442 files / 6112 passed | 10 skipped | 0 failed
```

> `tsc -b` 单独不算数：根 `tsconfig.json` 的 references **不含 `packages/web-ui`**，这是本仓已实测的假绿坑（见 `docs/architecture/p3-terminal-status-gate.md` §7.1）。

### 8.3 判据逐条

| # | 判据 | 结果 | 锚点 |
|---|---|---|---|
| 1 | 终态收敛到一处 + 排除清单 + `blocked`/`review` 非终态 | ✅ | `shared/src/types/task.ts#TERMINAL_STATUSES` + `isTerminal()`；`docs/architecture/p0-terminal-status-closure.md` |
| 2 | 取数 `catch` 不得用空集合冒充「确实没有」 | 🟡 **部分** | `docs/architecture/p1-swallow-fix-report.md`；**残余 R1** 见 §8.4 |
| 3 | 三标记登记 + 未登记即拒绝 | ✅ | P2（`extra.actionRequired` / `triggerExecution` / `directMention`） |
| 4 | `isTerminal()` 唯一入口 + 门禁拦新增违规 | ✅ | `scripts/architecture-guard.mjs` 规则 `terminal-status-predicate`，双向棘轮基线 `scripts/terminal-status-baseline.json`，7 例回归 `packages/core/test/architecture-guard.test.ts` |
| 5 | 缓存键/指纹不得含时钟、随机、自增 | ✅ | 同 guard 规则 `key-constructor-no-clock`（B 类 TTL 不误伤）；`docs/architecture/cache-key-constructors.md` |
| 6 | 计数型验收引用同一份普查输出 | 🟡 **部分** | 终态类、键构造类已是 guard 的单一命令；吞错类 / in-band 类仍是各自探针 → **残余 R2** |
| 7 | 计数必须可对账 | ✅ | `p3-terminal-status-gate.md` §1 实测四口径（386 不属任何可复现口径）；基线每条 `why` 说明「判断的是哪个问题」 |
| 8 | `tsc -b` 干净 + 三包全量回归绿 | ✅ | §8.2（合并线上实测） |

**完成度：8 条判据中 6 条达成、2 条部分（判据 2 余 11 处取数路径、判据 6 少一个统一入口），0 条未动。**

### 8.4 残余（条件 + 触发阈值 + 观测方式）

| # | 残余 | 触发条件 | 观测方式 |
|---|---|---|---|
| R1 | P1 报告 §9.2 的 R6–R16：**11 处** `catch { setX([]) }` 取数路径未改三态 | 同一位置再次出现「失败 → 空态文案」的用户投诉 | `scripts/probe-catch-swallow.mjs` + `probe-catch-setempty.py` 输出该清单；任一为空集合赋值即命中 |
| R2 | **无单一普查入口**（判据 6 欠账）：`census.mjs` 未交付，计数仍是「guard（终态 / 键构造）+ 两个 probe 脚本（吞错）+ 报告内 grep（in-band）」的拼装 | 任何新的「清零」对外声称，或 P2 新增标记 | 先合并为一个只读脚本（同 commit 两次运行 diff 为空）再谈计数；在此之前一切数字须注明探针 |
| R3 | P3 存量：`p3-terminal-status-gate.md` §5 记 **135 处 / 19 文件**终态裸比较（多为「具体状态」判断，不是终态判定） | 触碰即改；新增违规门禁直接红 | `node scripts/architecture-guard.mjs`；基线只许缩小（`--prune-terminal-baseline` 遇新增违规拒绝写盘） |
| R4 | 553 处 `Date.now()` 中非「键构成」子集未逐点分类 | 任意缓存命中率 / 幂等重复类事故 | 键构成子集已有门禁；其余需人工分类，无自动观测 |
| R5 | 814 处 actor 字面量（`'agent'/'system'/'human'`） | 授权相关事故 | 属授权域，须与 `authorizeAction()` 单一判定点一起做，另开需求 |

### 8.5 计数口径（判据 7 的对账，避免同名不同数）

- `architecture-guard.mjs` 运行行里的「35 处命中」= 白名单内命中数（跨规则自身计数），**不是终态存量**；终态存量以 `scripts/terminal-status-baseline.json` 为准（P3 §5：135 处 / 19 文件）。两者不是同一探针，引用时必须说明。
- §1 的 934 / 386 / 814 / 553 / 97 是 2026-11-04 立项口径，落地后**未重算**；引用时须带该日期。
- 一切「已清零」的表述，口径 = 定义域内（task / requirement 状态）+ 4 项排除清单（`approval-card.ts:31`、`CodingToolCard.tsx:40`、`requirement-service.ts:73`、`boardFilters.ts:17`）。
> **2026-11-05 18:10（本卡 R1/R2 收口，分支 `tsk_cc4497ad553c036c0b227b86-cto`）**
> 判据 2 与判据 6 的两条需求级残余已清零，证据与逐条清单见
> `docs/architecture/r1-r2-read-path-closure.md`：
> 11 处取数路径改三态（两个探针 `--classify` 实测「取数路径 = 0」），
> 四类计数收敛为一条只读命令 `node scripts/census.mjs`（同 commit 连跑两次 diff 为空）。
> 整合线上的 §8.3 / §8.4 需按该报告 §7 的两步改为 ✅ / 删除 R1、R2。
>
> 口径提示：**取数吞错的探针实现在 `scripts/probe-catch-setempty.py`**
> （本审计早期文本里写的 `probe-catch-setempty.mjs` 从不存在）；`.py` 是唯一实现，
> 与 `scripts/probe-catch-swallow.mjs` 共用 `scripts/read-path-exemptions.json` 的分类登记。
>
> **合并注（CTO，2026-11-05 18:58，解 `82374202` 冲突时补）**：本节之上已有 §7「复核更正」
> （2026-11-04 23:16），文件编号现已到 **§7**。该卡原文写的「本文件编号到 §6 为止」是撰写当时
> 的状态，**非当前事实**；两条陈述并存即会产生第二个口径，故在此显式更正。
