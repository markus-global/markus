# Agent 自我管理机制重构方案（P0/P1）

> 作者：CTO ｜ 日期：2026-09-27 ｜ 状态：已批准开发
> 背景：老板（Owner）以「平台入驻 Agent 第一视角」提出：Agent 应有自我管理能力——能给自己定闹钟、能回顾/整理记忆、分身之间能知道彼此在做什么。经平台自体检（CTO 亲自作为 Agent 实测）发现：**声称拥有的能力有一批是「声明了但不接线」的**，正是此前多轮 bug（心跳风暴、cancelled 停滞、终态乱标）的同根问题。本文档调查现状 → 定位根因 → 给出修复/实现方案 → 分阶段开发。

---

## 一、四个问题域

| 编号 | 领域 | 现象（Agent 实测） |
|---|---|---|
| P0-1 | 工具注册可用性 | `schedule_wakeup`/`cancel_wakeup`/`set_heartbeat_interval`/`complete_deliberation` 出现在系统提示「Deferred Tools」列表、要求 discover 后使用，但 `discover_tools({name:[...]})` 返回 **unknown/not found**——激活永远失败 |
| P0-2 | 自我闹钟 | 「到点做某事」能力名义存在（`schedule_wakeup` schema 里有），但 Agent 实际**无法调用**（P0-1 同根因：schema 有、handler 不可达） |
| P1-1 | 记忆整理工具化 | memory_save/search/update 存在，但**没有「观察→合并→归档」的显式工具**；knowledge.md 超 15000 字符预算只能靠系统被动压缩，Agent 无感知、无主动整理入口 |
| P1-2 | 分身共享工作记忆 | 并发分身（worker>1）有交接日志，但**无「其他分身的工作记忆快照」**——分身 A 不知道分身 B 在做什么/做过什么（除 8 条 handoff 摘要外） |

---

## 二、现状调查（证据链）

### P0-1 工具注册可用性：schema 注入与 handler 注册「两张皮」

**关键事实：** `packages/core/src/tool-selector.ts` 通过 `pushUnique()` **无条件注入**以下工具的 schema：

- `schedule_wakeup` / `cancel_wakeup` / `set_heartbeat_interval` （L483-521）
- `recall_activity` （L523-547）
- `complete_deliberation` （L549-579）
- `notebook_upsert` / `notebook_clear`（原 `update_working_memory` / `clear_working_memory`，L586-609）

但这些工具的**执行路径不是 `registerTool()` 注册的 handler**，而是 `agent.ts` 里的 `if (toolCall.name === '...')` 分支 dispatch（L8376-8444）。

`discover_tools` 的激活逻辑（`agent.ts handleDiscoverTools`，L7907-7988）只认两个来源：

```ts
if (this.tools.has(name)) { /* 注册过的 handler → 激活 */ }
if (this.skillRegistry?.get(name)) { /* skill → 注入说明 */ }
// 否则 → unknown.push(name)
```

**根因链：**
1. 预算不足时，`evictToolsToBudget` 把非 protected 工具驱逐进「Deferred Tools」catalog（`capability-packs.ts` `formatEvictedToolCatalog`）；
2. 系统提示要求先 `discover_tools` 再使用；
3. 但 `schedule_wakeup` 等**未注册进 `this.tools`**（仅 if 分支 dispatch）→ `handleDiscoverTools` 判定 unknown → **激活失败**；
4. Agent 永远拿不回被驱逐的工具 schema → 工具名存续、功能死锁。

**实测复现（CTO 亲自执行）：**
```
discover_tools({name:["schedule_wakeup","set_heartbeat_interval","cancel_wakeup","complete_deliberation"]})
→ { status:"ok", activated:[], unknown:[...全部 4 个], hint:"not found as tools or skills" }
```

**对照成功案例：** `recall_activity` / `notebook_upsert` / `notebook_clear` 能激活成功——因为它们分别注册在 `createRecallTool`（agent-manager L1732）与 `createMailboxTools`（L1728）里。证明：**「注册进 this.tools」是 discover 可激活的充要条件**。

### P0-2 自我闹钟：后端已完整，只差「工具可达」

`schedule_wakeup` 的**后端实现是完整的**：

- 注册：`agent.ts` L8376-8411 → `pendingCallbackRegistry.register({type:'wakeup', deliveryMode, note, wakeAt, recurringMs})`
- 持久化：`org-manager/api-server.ts` L1397 `pendingCallbackRegistry.setPersistence(storage.pendingCallbackRepo)`；`sqlite-storage.ts` 有 `pending_callbacks` 表 + `wake_at` 索引 + `recurring_ms`/`note` 列
- 触发：`agent.ts` `startWakeupSweep()` L7186 + `sweepDueWakeups()` L7198（~1 分钟粒度，到期 → `deliverCallback` → mailbox / in_session，recurring 自动 re-arm）

**缺口：** 工具 schema 存在，但被预算驱逐后 discover 无法激活（P0-1）→ Agent 实际调不到。**修好 P0-1，闹钟即通。** 附带的完善点：sweep 是 setInterval 常驻（unref），agent idle 时不烧 token，设计 OK。

### P1-1 记忆整理：有「存/查/改」无「整理」，预算压缩被动且不可见

现有能力（`packages/core/src/tools/memory.ts` + `memory/store.ts`）：

- `memory_save`：写 `knowledge.md ## _observations`
- `memory_search` / `memory_list`：关键词检索（observations + curated sections）
- `memory_update` / `memory_update_longterm`：写 curated sections
- 预算：`shared/src/limits.ts` — `MEMORY_MD_SECTION_MAX_CHARS=3000`、`MEMORY_MD_CURATED_MAX_CHARS=15_000`（注入段）、`MEMORY_OBSERVATIONS_MAX_CHARS=30_000`（观察缓冲，独立预算、不注入）、`MEMORY_ENTRY_MAX_CHARS=4_000`
- 超预算自动压缩：`store.ts` L676-697 `compressLongTermMemory()`（压缩后仍超则拒绝写入）
- 被动 consolidation：`agent.ts` L611 `MEMORY_CONSOLIDATION_INTERVAL_MS=4h` → `consolidateMemory()`（dream cycle，信号量限 3 并发、随机初始延迟防风暴）

**缺口：**
1. **无显式整理工具**：观察会无限堆积在 `## _observations`，没有「把 N 条 observations 合并成一条 curated section 并标记已归档」的入口；
2. **预算不可见**：Agent 不知道 knowledge.md 当前多大、还剩多少预算、有多少 observations 待整理；
3. **dream cycle 对 Agent 不可感知/不可触发**：平台 4h 自动跑，Agent 无法主动请求一次 consolidate。

### P1-2 分身共享工作记忆：有 handoff 摘要，无共享工作记忆快照

现有（`packages/core/src/concurrent-handoff.ts` + `context-engine.ts`）：

- `ConcurrentHandoffLog`：declared/fact/done/conflict 四类记录，内存环形（64）+ JSONL 持久化（512 行压实），`inFlight()`/`byEntity()` 查询；
- `context-engine.ts` L1239-1242：并发模式（worker>1）注入 `concurrentContext`（handoffs + workerId/workerCount），每轮**最多 8 条**（`HANDOFF_CONTEXT_LIMIT`）；
- `attention.ts` worker 机制：`workerStates` 按 workerId 隔离状态，`getWorkerWorkspace(workerId)` 返回各分身独立 workspace（`session-workspace.ts`）。

**缺口：**
1. Handoff 只有「一句话摘要」，不含**工作记忆（notebook）内容**；分身 A 的 `notebook_upsert` 内容，分身 B 的并发上下文里**看不到**；
2. 超过 8 条/64 条即被挤出，长任务中途换分身会丢上下文；
3. 没有「主动读其他分身工作记忆」的工具。

---

## 三、修复/实现方案

### P0-1：统一「schema 注入工具」的激活路径（核心修复）

**原则：** 凡是 schema 里出现、且系统提示要求「先 discover 再用」的工具，必须能被 discover 激活。不能出现「列表里有、激活失败」的死锁。

**实现：**
1. `capability-packs.ts` 新增导出 `SCHEMA_INJECTED_TOOLS`（常量集合，与 `tool-selector.ts` pushUnique 注入清单同源）：
   `schedule_wakeup, cancel_wakeup, set_heartbeat_interval, recall_activity, complete_deliberation, notebook_upsert, notebook_clear`；
2. `agent.ts handleDiscoverTools` 激活分支**优先判定**：name 命中 `SCHEMA_INJECTED_TOOLS` → `stickyTools().activated.add(name)` 并返回 `activated`（这些工具 schema 由 selectTools 注入，激活后晋升 protected 永不被驱逐——P0-3 审计已保证）；
3. 若后续某工具改为 `registerTool` 注册，命中 `this.tools` 的自然走原路径，两路兼容；
4. 测试：`discover_tools({name:['schedule_wakeup']})` 返回 activated；此后 selectTools 输出包含 `schedule_wakeup`，且系统提示不再把它列为「需 discover」的 deferred 项。

### P0-2：自我闹钟打通 + 心智模型完善

1. 依赖 P0-1 修复（工具可达）——**核心**；
2. 在心智层（提示词/HEARTBEAT 纪律）明确：精确到点的自我提醒 → `schedule_wakeup`；周期性安全网 → `set_heartbeat_interval`；二者职责分离（呼应此前心跳风暴修复）；
3. 验证链：注册 → 持久化 → sweep 触发 → deliverCallback → mailbox item → attention 唤醒处理（补端到端测试）。

### P1-1：记忆整理工具化

新增两个能力（`tools/memory.ts` + `memory/store.ts`）：

1. **`memory_stats`（新工具）**：返回 knowledge.md 当前大小 / 预算（15k）、observations 条数、curated section 数、距上次主动整理的天数——让 Agent 看到「记忆健康度」；
2. **`memory_organize`（新工具）**：把 `## _observations` 中满足条件的条目合并进目标任务（move/archive）：
   - 输入 `target_section` + 可选 `query`/`ids`；
   - 从 observations 中筛出匹配条目 → 内容累积进目标 section（预算内）→ 原 observations 删除（归档）；
   - 返回移入/归档统计 → Agent 据此决定是否 `memory_update` 精修。
3. `memory_update` 预算自动压缩后**返回可见的压缩统计**（原来只 warn 日志）；
4. dream cycle 增加**可观察性**：`consolidateMemory` 完成后记录上次整理时间（供 memory_stats 读取）。

### P1-2：分身共享工作记忆

1. `context-engine.ts` 并发上下文段**增加工作记忆快照**：注入当前 agent 的 notebook（`getWorkingMemorySnapshot()`）中**其他 worker 最近写入/更新的条目**（带 workerId 标注），与 handoff 摘要并列；
2. `ConcurrentHandoffLog` 新增 `kind='fact'` 语义强化：允许写入「影响全局的工作记忆」摘要，`byEntity`/`inFlight` 已支持；
3. 提供 `shared_working_memory`（或复用 `notebook_upsert` + 注入）：分身的 `notebook_upsert` 写入的 key 在并发上下文可见（标注 workerId）——让分身 B 知道「分身 A 正在/刚在做什么」；
4. 上限控制：快照条数 ≤ 8、每条约 200 字符（防预算膨胀），只增改并发段、不动 stable 前缀。

---

## 四、分阶段实施

| 阶段 | 内容 | 涉及文件 | 验收 |
|---|---|---|---|
| S1（P0） | discover 激活路径 + 闹钟打通 | capability-packs.ts、agent.ts、tool-selector.ts（同源清单）、测试 | discover 4 工具全激活；schedule_wakeup 端到端注册/触发/投递 |
| S2（P1-1） | memory_stats + memory_organize | tools/memory.ts、memory/store.ts、shared/limits.ts（如需）、测试 | 两工具可用；整理后 observations 归档、目标 section 增长、预算统计可见 |
| S3（P1-2） | 分身上下文共享工作记忆 | context-engine.ts、concurrent-handoff.ts、agent-manager.ts（快照接线）、测试 | 并发模式注入含 worker 标注的 notebook 快照；handoff fact 可查 |

## 五、全局原则（延续）

- **不做「声明的能力」**：任何 schema 里的工具必须可 discover、可调用——否则从 schema 移除；
- **单一事实源**：工具注册表、schema 注入清单、discover 激活路径三方同源，杜绝「两张表漂移」；
- **自我管理优先**：闹钟/心跳/记忆整理是 Agent 的自理器官，默认常驻、轻量、可观察，不依赖人类提醒；
- **不烧 token 的安全网**：sweep/consolidation 均用 unref 定时器 + 信号量限流，idle 不产生 LLM 调用。

---

## 六、实施状态（2026-09-27 已全部落地）

| 阶段 | 状态 | 落地内容 | 验证 |
|---|---|---|---|
| S1（P0） | ✅ 完成 | `capability-packs.ts` 新增 `SCHEMA_INJECTED_TOOLS`；`agent.ts handleDiscoverTools` 对命中集合的工具走「激活」路径（sticky activated）；`tool-selector.ts` 预算驱逐时已激活的 schema-injected 工具同样豁免（原先只豁免 `allTools` 注册工具） | `schema-injected-tools.test.ts` 5/5 绿 |
| S2（P1-1） | ✅ 完成 | `tools/memory.ts` 新增 `memory_stats`（预算/观测数/curated section 数/健康度提示）+ `memory_organize`（按 query/ids 把观测合并进目标 section 并归档，预算内、无匹配不写库） | `memory-organize-tools.test.ts` 6/6 绿 |
| S3（P1-2） | ✅ 完成 | `context-engine.ts` 并发段注入「分身共享工作记忆」快照（agent 级 NOTEBOOK，限量 5 条、每条约 140 字符截断）；`agent.ts getConcurrentContext()` 附带 `getWorkingMemorySnapshot()` | `context-concurrency-notebook.test.ts` 3/3 绿 |
| 回归 | ✅ | tool-selector / memory-tools / context-engine / context-engine-deep 等既有套件 | 78/78 绿，tsc 0 错误 |

**说明**：P0-2（自我闹钟）后端链路本就完整（注册→持久化→sweep→投递），S1 修好 discover 激活后即达可用，无需额外代码；S2/S3 中「dream cycle 可观察性」「handoff fact 强化」两项列为后续增量（不阻塞本次交付）。