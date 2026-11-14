# 第七刀 C7 · 执行计划：WorkUnit + FSM-3 + 预算归并

> 状态：**已被仓库版取代（SUPERSEDED）** · 仓库唯一事实源：`docs/records/cut7-workunit-execution-plan-2026-11-13.md`（随 C7-A 的 PR 进 `feat/refactor-plan`）· CTO 草稿镜像 v1 · 2026-11-13
> **本文件只读**：它不在任何仓库分支里，PR 评审人看不到它。**任何人不得把结论只写在这里**；跨 agent workspace 写入是禁区。
> 唯一概念事实源：[`markus-master-refactor-plan-2026-11-11.md`](./markus-master-refactor-plan-2026-11-11.md) §2.1 / §4.6 / §5.2 / §5.3
> 硬边界：动共享基础设施（新表 + 委派链路 + 预算语义）→ **改前通知团队**；merge main / 发版 / 删数据 / 改他人绑定一律 Owner 明确批准。

---

## 0. 起点核对（不是复述卡状态，是读代码与主干）

| 项 | 实测 |
|---|---|
| 第六刀（C6） | PR #428 **已合并到 `feat/refactor-plan`**（merge `9b8bf879`，2026-11-13 21:32 北京时间）；**未进 main** —— 按既定流程等整条 feature 完成 |
| C7 是否已开工 | **否**。`git grep work_units origin/feat/refactor-plan` = 0 命中 |
| 6b 补丁现状 | `packages/core/src/tools/subagent.ts` `DEFAULT_MAX_SUBAGENT_ITERATIONS = Infinity`；`packages/shared/src/limits.ts:714` `SUBAGENT_MAX_AGGREGATE_ITERATIONS = 100`（聚合断路器，非日程） |
| 现有实体类型值域 | `status_transitions.entity_type` 目前只有 `'task' | 'requirement'`（`packages/shared/src/types/task.ts:179`），表结构见 `sqlite-storage.ts:704` |

**为什么 C7 必须紧接 C6**：C6 给 `mailbox_items` 加了 `work_unit_ref` 列但**写入数恒为 0**（只加列不写值，避免"先建引用后建实体"的悬空引用）。C7 是那个唯一写者的上线时刻。C6 的承诺到期日就是现在。

---

## 1. 这一刀做什么（一句话 + 边界）

**一句话**：把今天"被五个机制各推一遍"的一条活，收敛成**一个有身份、有父子、有预算、有状态机的对象** `WorkUnit`，并让委派成为它唯一的生产方式。

**做完的判据**（可机械验证，不靠自述）：
1. 一次真实委派在库里产生**父 + 子** `work_units` 行，父子关系可查；
2. 预算到线时状态变 `paused_budget`，且 `status_transitions` 有对应行；
3. 三条日常链路（chat / task / a2a）的 `mailbox_items.work_unit_ref` **非空**；
4. 6b 三处临时补丁**从代码里消失**（grep 归零），预算只有一个口径。

**本刀不做**：不动心跳与 dream 的触发机制（C8）、不建 `facts` 表（C9）、不接外部来源（C10）、不实现四档自主度、不改 `cs_*`/`sess_*` 会话契约、不回填观测四表 ≥11.6M 历史行。

---

## 2. 数据与状态机（C7 的唯一形状）

`work_units` 字段严格按主计划 §2.1 五组，**不建 `thread` 表、不给 ContextSession 加 `status`**：

```sql
CREATE TABLE IF NOT EXISTS work_units (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES work_units(id),   -- 父子委派
  ref           TEXT NOT NULL,                    -- 幂等键（复用 task_<id>_r<round>，零迁移）
  agent_id      TEXT NOT NULL,
  address_ref   TEXT,                             -- C6 的地址（可空，跨组织时才填）
  task_id       TEXT,
  model         TEXT,
  status        TEXT NOT NULL,                    -- running | idle | paused_budget | terminated | archived
  budget        INTEGER,                          -- 沿用 iteration 语义（见 §7 裁决 3）
  used          INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  lease_until   TEXT,
  stop_reason   TEXT,
  result_ref    TEXT,
  context_ref   TEXT,                             -- sessionLockKey 从这里派生
  archived_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_units_ref ON work_units(ref);
```

`WU_TRANSITIONS`（声明式矩阵，唯一执行点 `WorkUnitService.transition()`，其它路径绕过即被 architecture-guard 判红）：

| from | to | 触发 |
|---|---|---|
| `running` | `idle` / `paused_budget` / `terminated` | 回合收口 / 预算到线 / 取消 |
| `idle` | `running` / `terminated` | 新回合 / 取消 |
| `paused_budget` | `running` / `terminated` | 追加预算 / 取消 |
| `terminated` | `archived` | 归档 |
| `archived` | — | 终态 |

每次迁移写 `status_transitions(entity_type='work_unit')`——值域扩到 `'task' | 'requirement' | 'signal' | 'work_unit'`（`signal` 已在 C3 扩过）。

---

## 3. 唯一写者与生产者点（谁在什么时候造 WU）

| 角色 | 落点 | 纪律 |
|---|---|---|
| 唯一写者 | `WorkUnitService.ensure(ref)` | 幂等（`uq_work_units_ref` 兜底）；**写失败不阻断业务**但必须 `warn` + 计数，否则就是静默漏记 |
| 生产者 ① | `org-manager/src/api-server.ts:2494 persistChatTurn()` | 一轮对话 = 一个 WU（`ref = session:<id>:r<n>`） |
| 生产者 ② | `org-manager/src/task-service.ts:2639 createTask()` + 状态变更 | `ref` 复用 `task_<id>_r<round>`，**不新造第二套命名** |
| 生产者 ③ | `org-manager/src/agent-delivery.ts deliver()`（A2A 唯一出口） | 一次投递挂到发送方 WU 的 `context_ref` |
| 委派路径 | `spawn_subagent`（`tools/subagent.ts:556`）、`spawn_subagents`（`:640`）、跨团队委派 | **全部改写为创建 WU，禁止绕过**；父 WU 已知，立刻产生子 WU |

---

## 4. 卡拆分（2 张，每张一次提交、可单独 revert）

> **拆分判据修正（Owner 2026-11-13 指正）**：卡不是按"技术接缝"切，而是按**可独立验证的完成态**切。
> 一张卡只有在"单独合入后能用一个读数证明它对，且单独 revert 后行为回到已知状态"时才值得独立存在。
> "只建表"（原 C7-1）单独合入没有任何可验证价值 —— 那正是四刀复盘里"建了对象没流量"的墓碑教训。
> 收口验证也不单开一张卡：按平台规则，回归与验收是**复核人**的职责。

### C7-A｜WorkUnit 对象落地，三条日常链路第一次有身份

| 项 | 内容 |
|---|---|
| 改动 | `work_units` 表（幂等迁移）+ `WU_TRANSITIONS` 矩阵 + `status_transitions.entity_type` 扩 `work_unit` + `WorkUnitService.ensure(ref)` / `transition()` + 三个生产者点接线（`persistChatTurn()` / `TaskService.createTask()` / A2A `deliver()`）+ `mailbox_items.work_unit_ref` 开始写值 |
| 做完的判据（一次跑完再验） | 真实实例探针：chat / task / a2a 三条链路各出现 `work_unit_ref IS NOT NULL` 的行；并发 `ensure` 同一 ref ⇒ 恰一行；非法迁移（`archived→running`）被矩阵判红；写失败被吞但有结构化 warn 事件 |
| 为什么这三件事必须在一张卡里 | 表 + 写者 + 生产者构成同一个事实："这条活第一次有了身份"。拆开就变成"表建好了但没人写"（今天的 `work_unit_ref` 就是这个状态） |
| 回滚 | 单提交 revert；表可留（无历史行，`ref` 复用既有格式零迁移） |

### C7-B｜委派产生父子 WU + 预算单一口径 + 删掉 6b 补丁

| 项 | 内容 |
|---|---|
| 改动 | 三条委派路径（`spawn_subagent` / `spawn_subagents` / 跨团队委派）改写为创建 WU 并落 `parent_id`；预算归并进 `work_units.budget/used`；到线 → `paused_budget` + transition 行；**删除 6b 两处补丁**（`infinity` 回退 + 把断路器当日程）；`sessionLockKey` 改从 `context_ref` 派生；**把 chat / task 的 WU 创建点从「回合收口」前移到「回合开始」** —— C7-A 里 chat WU 建于回复落库之后并立即 `running→idle`，因此 `work_status()` 任何时刻都读不到 `running`；「这个 agent 现在在干什么」的可观测性必须在 B 关闭，不能留口头 |
| 做完的判据 | 一次扇出产生 **1 父 + N 子**且父子链可查；预算到线用例：状态 `paused_budget` 且 `status_transitions` 有对应行；**回合进行中（未收口）调 `work_status()` 能读到 `running` 行，回合收口后同一条变 `idle`**；`DEFAULT_MAX_SUBAGENT_ITERATIONS = Infinity` 与聚合断路器 grep 归零；`subagent-*` / `concurrent-*` / `mailbox-claim-lease` 三族测试全绿 |
| 为什么与 A 分开 | B 改变**行为**（预算、委派、锁），必须能单独回滚；A 只加对象与写入、不改行为。这是唯一值得独立的一刀 |
| 回滚 | 单提交 revert；6b 补丁可用 revert 恢复 |

**依赖**：`C7-A → C7-B`。中间态（A 合入、B 未合入）是**可用且已知**的：对象在长，行为未变。

---

## 5. 验证计划（证据高于推理）

1. **先红后绿**：每卡先写行为测试并**看到红**，再实现。禁止 `readFileSync + toContain` 文本栅栏。
2. **真实实例探针**（不是只跑单测）：在隔离实例（独立 `HOME`、独立端口，如 `/tmp/cut7probe`）上跑真实委派，读 `work_units` / `status_transitions` / `mailbox_items.work_unit_ref` 三张表，读数贴进记录。
3. **门禁**：`tsc -b`、`tsc --noEmit -p packages/web-ui`、`eslint packages/*/src/`（0 error）、`node scripts/architecture-guard.mjs`、全仓 vitest、CI 四项。
4. **回归面提示**：C7-B 碰 `subagent` 预算与 `attention.sessionLockKey`，必须重跑 `subagent-*`、`concurrent-*`、`mailbox-claim-lease` 三个族。

---

## 6. 风险与硬边界

| 风险 | 处理 |
|---|---|
| `ref` 命名两套（`task_<id>_r<n>` vs 新造） | 只允许复用既有格式；C7-A 里用测试锁死格式，禁止第二个生成器 |
| 写失败静默漏记 | `ensure()` 失败必须 `warn` + 结构化事件计数；探针里断言"事件发生了"而不是"日志里有文字" |
| 预算换单位（iteration → token）导致行为漂移 | **本刀不换**（见 §7 裁决 3），只在表里预留语义空间 |
| 观测四表 11.6M 行 | 只加可空 `work_unit_ref` + 索引，**不回填**；看板只统计新纪元 |
| 委派链路回归 | C7-B 三条路径各自一次提交（整卡仍可单 revert） |
| 与 C8 的边界 | C7 不碰心跳/dream 触发；发现心跳也在写 WU 就停下来问，不在本刀顺手改 |

---

## 7. 裁决项与落定状态（2026-11-13 已定）

1. **需求批准**：已批（approvedAt 2026-11-13）。C7 范围 = **2 张卡**：C7-A `tsk_9fd9eb571e6ff46e2472e3e0` / C7-B `tsk_d1e815539620748b892d10b2`（B `blocked_by` A）。
2. **第六刀的尾巴**：`tsk_1203177cce7a503bff96cd5a`（横幅归属 DOM 级取证，PENDING）—— 已定：**保持独立**，走它自己的 PENDING 卡，不进 C7-B。
3. **预算单位**：已定：`work_units.budget` **沿用 iteration 次数**（与今天行为一致、可回滚）；token 配额留后续按需加列，不在本刀扩回归面。

---

## 8. 排期（按可验证的完成态，不按天估算）

| 波次 | 交付物 | 完成后可验证的事实 |
|---|---|---|
| 1 | **C7-A** | 三条日常链路第一次有 WU 身份（真实实例可查） |
| 2 | **C7-B** | 委派第一次有父子结构；6b 补丁消失；预算只有一个口径 |
| — | 真机跑一天真实流量 | 台账不漂、`paused_budget` 才上线、没有"对象长了但没人写" |
| 3 | C8（分两波：通道骨架 / 心跳+dream 迁移） | 心跳不再产生 mailbox 行；dream 不再二次入队 |
| 4 | C9 | facts 不可原地改写、只 supersede；「需要人」的对象在 Inbox 恰好出现一次 |
| 5 | C10 | 每条外部事件可按 `external_thread_ref` 追到 `work_unit_ref` |

每步都是 `task/tsk_*` 分支 → PR 到 `feat/refactor-plan`（不直接对 main）。

---

## 9. 第七刀与第八刀能否合成一刀（Owner 2026-11-13 提问）

**结论：不做"一刀"，做"一个需求 + 一个分支（已有）+ 两个波次"。**

三条判据：

1. **回滚粒度会失效。** C8 是整条计划里**行为变化最大**的一刀：心跳从"自己的 `setInterval`"降级为纯存活 tick、dream 从两条链路变单触发、15 类 mailbox 去向重排、`Trigger/Subscription/rest(wakeOn)` 首次出现。与 C7 合并后，一旦出现"心跳不再产生 mailbox 行"或"预算到不了线"这类回归，**无法判断是新对象（WU）还是新触发器（通道）造成的** —— 只能整刀回退，等于把这几十个改动绑成一个不可分割的原子。
2. **验证信号会互相污染。** C7 的判据是**对象一致性**（并发 ensure 恰一行、父子链可查）；C8 的判据是**流量形态变化**（心跳零 mailbox 行、dream 单次入队）。这两类读数必须各自在干净基线上取，混在一起时"心跳行变少了"可能只是因为 C7 的写者还没接完。
3. **评审无法逐条核对。** 合并后的 PR 会横跨 `core`（attention/agent/heartbeat/dream）+ `org-manager` + `storage` + `cli`，体量远超一次可有效 review 的边界。

**什么情况下可以合**：如果 C8 收缩为"只接 Trigger/Subscription、不动心跳与 dream"，它可以作为 C7-C 并入同一刀。但那样 C8 的核心价值（**消灭第二个时钟**）就没了 —— 那正是这一刀存在的理由。

**成本对比**：分两刀多一次需求评审 + 一次 PR，但换来两次"停下來用真实数据证明"的机会；合成一刀少一次流程，代价是唯一的失败信号只能告诉你"这堆里有问题"。

---

## 10. 终极验收：Agent 的自知与自由度（Owner 2026-11-13 提出的标准）

> Owner 原话：所有重构完成后，Agent 应该在任何时候、只要愿意，就能知道自己当前的状态 —— 刚收到什么消息、之前有什么消息、有哪几个 worker 分别在处理什么 —— 即对自身和认知充分完整，并能自由地处理消息与工作。

### 10.1 判定：**今天做不到**，但缺口不是"信息不存在"，是三处结构缺失

| 缺口 | 今天的实际形态（真实证据） | 后果 | 在哪一刀关闭 |
|---|---|---|---|
| **A｜自身状态没有对象** | "我有几个 worker、分别在处理什么"是平台每轮开头**注入的一段文本**（并发上下文块），从会话注册表现算。**没有可查询实体，也没有 mid-turn 查询入口** | 回答不了"worker 3 现在到哪一步"；文本是快照，与真实执行可能漂移 | **C7-A**：`work_units.claimed_by + lease_until + context_ref` 成为权威答案；并新增只读工具 `work_status()` |
| **B｜历史可查但入口分裂** | 消息在 `mailbox_items` / `status_transitions` / `agent_activities`，会话在 session 存储；要"愿查即查"，agent 得自己判断该调 `check_mailbox`、`session` 还是 `memory_search` | "重要但没被问起"的事实永远沉在库里；没有单一自省入口 | **C9**：facts + 一个统一自省视图（给定时间/实体/类型 → 消息与 WU 的联合视图） |
| **C｜工具面可能被裁掉** | 按体积淘汰工具会裁掉 `task_create` / `task_submit_review` 这类"要做事才用到"的工具 | "想处理也处理不了"，且 agent 会把"工具没注入"误判成"我没权限" | **C8 的硬前提**：工具分层与"按当前 WU 需要注入" |

### 10.2 一条必须先纠正的理解：「完整自知」≠「把所有历史塞进上下文」

上下文永远是有预算的投影 —— 本会话 471 条消息、469k 字符，已经触发过压缩。把"自知"理解成"全部在场"，会把每一次对话都推向截断。

正确判据是两条**同时**成立，缺一条都不算达标：

1. **不丢（可查）**：任何历史事实都能按需取回 —— 权威存储 + 一个入口，且答案来自**对象**而不是从文本推断。
2. **在场（自动）**：当前决策必需的最小集自动注入 —— WU 状态摘要、未处理消息、并发 worker 归属。

### 10.3 把它写成整条重构的最终验收

> **任何一个 agent，在任意时刻，应能用一次工具调用回答：我是谁、我在做什么（几条 WU、父子关系、预算状态）、谁在和我并行、我刚收到什么、我错过了什么 —— 且每个答案都有权威对象背书。**

这条验收今天不满足，原因是 A/B/C 三个缺口，而它们分别落在 C7-A、C9、C8。**这不是给重构加需求，而是说明 C7–C9 的顺序本来就是按"自知"能力依赖排的。**

具体到 C7-A 的 DoD，我加一条：`work_status()` 必须能回答"我这个 agent 现在有哪些 WU 在跑"，字段含 `ref / status / parent_id / claimed_by / lease_until / budget / used`，且**不读 payload 推断**（同一原则：结构不从载荷推断）。
