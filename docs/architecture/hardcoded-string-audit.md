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

> **2026-11-05 18:10（本卡 R1/R2 收口，分支 `tsk_cc4497ad553c036c0b227b86-cto`）**
> 判据 2 与判据 6 的两条需求级残余已清零，证据与逐条清单见
> `docs/architecture/r1-r2-read-path-closure.md`：
> 11 处取数路径改三态（两个探针 `--classify` 实测「取数路径 = 0」），
> 四类计数收敛为一条只读命令 `node scripts/census.mjs`（同 commit 连跑两次 diff 为空）。
> 本文件编号到 §6 为止；整合线上的 §8.3 / §8.4 需按该报告 §7 的两步改为 ✅ / 删除 R1、R2。
>
> 口径提示：**取数吞错的探针实现在 `scripts/probe-catch-setempty.py`**
> （本审计早期文本里写的 `probe-catch-setempty.mjs` 从不存在）；`.py` 是唯一实现，
> 与 `scripts/probe-catch-swallow.mjs` 共用 `scripts/read-path-exemptions.json` 的分类登记。
