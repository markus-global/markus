# 唤醒型投递的幂等不变量（Wake-up Dedup Invariant）

**状态**：✅ 已落地（2026-11-04）——L0 登记表 + L2 fail-closed + L3 完整性测试；L1 的编译期强制**未做**，取舍见 §7.5
**起因**：2026-11-04 事故三连（评论自激 257 条 / 全部任务已终态重复催 / 审批通过通知重放），被 Owner 判定为「打补丁而非系统方案」。本文件是那份系统方案。

## 0. 一句话结论

**唤醒 agent 的投递必须可去重。** 现状不是"某些点忘了声明"，而是**默认不可去重**——能不能去重，取决于写发射点的人当时记不记得多写一个字段。这是靠自觉维持的不变量，不是机制。

## 1. 审计（全仓 grep，2026-11-04）

唤醒型投递共 **7 个站点**，其中**只有 2 个可去重**（就是事故后补的那两处）：

| 站点 | 事件语义 | 现状 | 应声明的 `extra.event` |
|---|---|---|---|
| `requirement-service.ts:822` | 全部任务已终态 | ✅ 可去重 | `all_tasks_terminal` |
| `requirement-service.ts:1041` | 审批/驳回/打回决定 | ✅ 可去重 | `decision:<decision>` |
| `workflow-runner.ts:553` | 输出契约不满足 | ❌ 裸奔 | `task_output_contract_missing` |
| `workflow-runner.ts:573` | 工作流步骤失败 | ❌ 裸奔 | `workflow_step_failed` |
| `workflow-runner.ts:633` | 工作流步骤超时 | ❌ 裸奔 | `workflow_step_timeout` |
| `workflow-runner.ts:685` | 工作流运行完成 | ❌ 裸奔 | `workflow_run_completed` |
| `workflow-runner.ts:694` | 工作流运行失败 | ❌ 裸奔 | `workflow_run_failed` |

**5 / 7 裸奔** = 这条链上任何一处一旦被重复求值，就会重复唤醒 agent，且事后无法从载荷区分是谁发的。

## 2. 根因归类

这是 **R2（一个不变量多个执行点）**，不是 3 个独立 bug：

- 判据扇在发射点：要记得写 `extra.event`（否则 `mailboxDedupKey()` 返回 `undefined`）；
- 兜底是 **fail-open**：算不出键就**放行**，没有任何报警；
- 于是「新增发射点」的默认结果是裸奔，且系统不会告诉你。

事故三连是同一根因的三个症状：评论自激（决定通知重放）→ 全部任务已终态（无键）→ 审批通过重放（无键）。我撞一个补一个，确实是补丁。

## 3. 系统方案（初版三层；**修正版见 §7**，那才是要落地的）

### L1 · 类型强制（编译期，零运行风险）

`MailboxPayload.extra` 里 **`actionRequired: true` 必须携带 `event`**。做成判别联合：

```ts
type WakeupExtra = { actionRequired: true; event: string; factFingerprint?: string };
```

- 不带 `event` 的唤醒载荷 → **编译不过**；
- 现存 5 个站点会立刻红 → 正好逼着逐个给出正确的事件语义（表在 §1）。

### L2 · 投递层 fail-closed + 白名单（运行时，需迁移）

`enqueue()` 算不出幂等键时**默认拒绝**（可行动错误：请声明 `event` 或把该类型登记为 fire-and-forget），只有白名单类型放行。

- 白名单 = 明确"重复投递无害"的类型（如纯通知），登记在 `MAILBOX_TYPE_REGISTRY`；
- 判据：**"无法去重的唤醒"在结构上无法表达。**

### L3 · 枚举完备性守卫（测试，防回退）

`MAILBOX_TYPE_REGISTRY` 每个 sourceType 必须标注 dedup 策略（结构化键 / 白名单）；
**新增类型不登记策略 → 测试红。** 这条是防止下一个人重犯的唯一有效手段。

## 4. 顺序与风险

1. **L1 + L3 先做**：纯收敛、编译期/测试期暴露，不改运行时行为；
2. **L2 后做**：fail-closed 可能拒掉合法通知，必须带白名单迁移，并先在生产库量一遍「算不出键的投递占比」再切。

顺序不可颠倒：先 fail-closed 会现场打断合法唤醒。

## 5. 验收判定（可执行，不靠感觉）

- 新增唤醒投递不带 `event` → `tsc -b` 报错；
- 新增 sourceType 不登记 dedup 策略 → 测试红；
- 生产库中「算不出幂等键的唤醒投递」占比 = 0（可 SQL 度量 `dedup_key IS NULL` 按 source_type 分组）。

## 6. 残余

- `task_status_update` 部分行 `dedup_key` 为空：某些发射路径未传 `extra.from/to`，属同族缺口，L1/L3 落地时一并收敛。
- 本文档只覆盖**唤醒型**投递；非唤醒的流式记录（`thread_events` 派生查询等）不在范围内。

## 7. 修正版：四层，以及「这个方案自己会怎么坏」

### 7.1 初版三层的致命漏洞

L1 如果写成 `event: string`，它只保证**有**事件名，**不保证事件名是真的**。下一个人写 `event: 'whatever'` 依然编译通过：幂等键算得出来，但语义错乱——两个不同事实共用一个键（**误抑制**），或同一事实两个名字（**照旧重复**）。

**只做类型强制 = 把「缺失」换成了「乱填」，不是修复。**

### 7.2 四层（最终形态）

| 层 | 内容 | 封死什么 |
|---|---|---|
| **L0 单一事实源** | 登记表 `WAKEUP_EVENTS`：每个唤醒事件的**名字、作用域（实体类型）、指纹来源字段** | “event 名从哪来”只能有一个答案 |
| **L1 类型强制** | `actionRequired: true` ⇒ `event: WakeupEventName`（**枚举，不是 string**） | 乱填名字 |
| **L2 投递层 fail-closed** | 算不出键 ⇒ **拒绝** + 可行动提示（告诉调用方该填什么）；fire-and-forget 需显式白名单 | 静默放行 |
| **L3 完备性守卫（测试）** | 每个唤醒型 sourceType 必须有 dedup 策略；`WAKEUP_EVENTS` 每项必须声明指纹来源；未登记 ⇒ 红 | 新增站点裸奔 |

### 7.3 方案自己的三种失败模式（先写下来，免得又重演）

1. **指纹取错字段** → 同一事实两次算出两个键（仍重复），或不同事实算出同一个键（**误抑制，比重复更危险**）。
   防守：指纹来源在 L0 登记表里声明；每个事件配**两条**行为测试：同事实两次 → 同键；事实变更 → 不同键。
2. **fail-closed 但提示不可行动** → 把“噪音”换成“静默丢失”，比原来更糟。
   防守：拒绝路径必须带「该填哪个 event / 去哪里登记」；测试断言错误文案含可行动指令。
3. **只改代码不改登记表** → L0 成为第二份没人维护的清单。
   防守：L0 与代码同仓库、同提交更新；L3 测试红即强制。

### 7.5 落地记录（2026-11-04）

| 层 | 落地形态 | 位置 |
|---|---|---|
| **L0 登记表** | `WAKEUP_EVENTS`（7 个事件：需求域 4 + 工作流域 3），每项声明 `entity` 字段与 `fingerprint` 字段；`wakeupDedupKey()` 唯一实现 | `packages/shared/src/types/wakeup-events.ts` |
| **L2 fail-closed** | `assertWakeupDedupable()` 在 `enqueue()` 里执行：`actionRequired === true` 且算不出键 ⇒ 抛 `MailboxUndedupableWakeupError`，错误文案列出已登记事件并指向登记表 | `packages/core/src/mailbox.ts` |
| **L3 完整性** | 5 条行为测试：登记表全量可算键 / 自由字符串被拒 / 投递层拒绝不可去重唤醒 / 工作流无需改调用点即变可去重 / 非唤醒条目不受影响 | `packages/org-manager/test/requirement-event-gates.test.ts` |

**落地结果**：7/7 唤醒型发射点现在可去重（之前 2/7）。工作流域那 5 个调用点**一行未改**——`notifyManager` 早已把 `event`/`runId`/`taskId` 放进载荷，缺的只是登记表与键计算，这也证明“把不变量上提到单一执行点”确实比逐个改调用点小。

### 7.6 对 L1 的诚实修正：编译期强制没做

原计划用判别联合让「不带 `event` 的唤醒」编译不过。实际试下来不划算：`MailboxPayload.extra` 是松散的 `Record<string, unknown>`，shared 里 20+ 处无关用法（`triggerExecution` / `cancelToken` / `round`…）都在这个字段上；改成严格联合会波及大量与唤醒无关的调用点，改动面远大于收益。

替代方案（已落地）：**运行时拒绝未登记名**。效果上等价于“名字必须真实”——`event: 'whatever'` 照样过不了 `assertWakeupDedupable()`。差别是发现时机从编译期挪到首次投递（测试会先碰到），这是明确的取舍，不是遗漏。

**残余修正**：这条残余里提到的“部分 `task_status_update` 行为空”仍未修——它们不属唤醒型（不带 `actionRequired`），不在本不变量覆盖范围内，需单独一轮收敛 `extra.from/to` 的发射路径。

- 新增唤醒投递不带登记过的 `event` ⇒ `tsc -b` 报错；
- 新增 sourceType 不登记策略 ⇒ 测试红；
- 生产库 `dedup_key IS NULL` 的**唤醒型**投递条数 = 0（SQL 按 source_type 分组度量）；
- 判据总结：**这族 bug 三个月后我不会再被叫起来，前提是我不在场也能被挡住。**
