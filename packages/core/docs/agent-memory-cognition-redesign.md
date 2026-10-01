# Agent 记忆与认知机制 —— 完整重构设计（SSOT）

> **版本** v2（2026-09-29）· 作者：CTO · 取代 v1 分阶段评审稿
> **原则**：一次性彻底重构。不留补丁、不留尾巴；**前端 + 后端 + 测试全量改齐**；
> 原有功能一个不少，但机制与架构更合理、更完备。
> **依据**：源码全量测绘（`audit-store.md` / `audit-context.md` / `audit-tools.md` /
> `audit-frontend-api.md` / `audit-tests.md`）+ 一次真实事故复盘（9/27 手改被 9/28 静默覆盖）。
>
> **实现状态：已落地**（2026-09-29，分支 `feat/ui-optimize-0925`）。唯一有意偏离：**P-08 不删遗留兼容**，
> 改为**迁移读取层（读旧、只写新）**——实测 106 个 agent 目录仍残留 `memories.json` / `MEMORY.md` / `state.md`，
> 删除会使其记忆无法迁移/解析（违背「功能不减少」）。故遗留文件改为**加载时读入并迁移**，源文件消费（改名 `.migrated`），
> 写入端只发规范格式。详见 `store.ts` / `taxonomy.ts` 文件头「Migration-read layer」。

---

## 0. TL;DR

现状是 **4 类机制交织 + 至少 3 代补丁共存**：长期记忆（`knowledge.md`）、工作记忆（`NOTEBOOK.md`）、
认知准备管道（CPP）、以及四套各自为政的"自动整理"（dream cycle / `memory_consolidation` /
压缩器 / `daily_report`）。它们之间有**双目的地、双写入者、单位不一致、有损不可逆**等结构性问题。

本方案收敛为：

```
两个 Store（各自单一写入者）
      +  一套工具（Agent 主动调用，渐进披露）
      +  一张场景提示词矩阵（引导"何时拉、何时写"）
      +  一层无损兜底（有界、可见、可恢复）
```

---

## 1. 设计原则（不可违背，逐条可测）

| 编号 | 原则 | 可测判据 |
|---|---|---|
| P1 | **单一写入者**：每个 Store 只有一个写入路径；其余一律拒绝 | `file_write` 写记忆文件被拒并有引导消息 |
| P2 | **全工具化**：一切读写/整理能力都是带 schema 的工具，可 `discover` | 每能力有工具；无"只能自动、Agent 碰不到"的能力 |
| P3 | **场景提示词化**：何时拉取/写入由场景提示词引导，替代硬编码注入 | 场景矩阵（§7）逐格有对应提示词 + 快照测试 |
| P4 | **兜底无损**：自动机制只做无损/有界/可见的动作 | 删除即归档（可检索）；有落盘标记；不静默丢 |
| P5 | **单位一致**：预算一律按 **字符**；不再混用 byte | 全仓 grep 无 byte 预算判定 |
| P6 | **原子且可恢复**：写入原子；任何收敛都可回溯 | 崩溃不产生半截文件；归档段可 `memory_search` |
| P7 | **功能不减**：旧能力逐项有对应新实现 | feature parity 矩阵（§12）全绿 |
| P8 | **概念去歧**：Agent 长期记忆 与 项目知识库 命名分离 | `memory_*` vs `kb_*`，无同义混用 |

---

## 2. 现有机制的目的（**必须全部保留**的职能）

| # | 机制 | 它要解决的真实问题（目的） | 现状实现 | 新方案如何保留 |
|---|---|---|---|---|
| G1 | 长期语义记忆 | 让经验跨会话留存，且**小预算常驻**（策展段）+ **大容量可检索**（观察缓冲） | `knowledge.md`：curated + `## _observations` | 保留双区模型；**单一写入者** + 无损再平衡 |
| G2 | 记忆整理 | 观察多了要**归纳进策展段**，而不是无限堆积 | dream cycle + `memory_consolidation` + 压缩器（三套重叠） | 收敛为**一个** `memory_organize` 原语；dream 只做定时调用者 |
| G3 | 工作记忆 | 短期、按 key、**并发分身共享**、自动过期 | `NOTEBOOK.md` + 分层 TTL + LRU | 保留；统一单一写入者与锁域；改由工具读写 |
| G4 | 认知准备 | 每轮开始前**按需补齐相关上下文**（检索/反思） | CPP：LLM 多阶段管道 → 双目的地 | **工具化**：`memory_search`/`kb_search` 按需调用 + 轻量确定性注入 |
| G5 | 上下文工程 | 预算内组装 prompt，且**前缀缓存稳定** | ContextOS 分层 stable/dynamic/volatile + slots/summary | 保留（本方案不改 ContextOS 内核） |
| G6 | 安全兜底 | 预算不能无限增长；文件不可损坏 | 压缩器（有损）+ 自愈重建 + 原子写 | 保留但**无损化**：归档而非截断；安全修复而非重建 |
| G7 | 执行/会话史 | 回溯"我做过什么" | sessions/*.json + `recall_activity` + `session` | 保留 |
| G8 | 项目知识库 | 团队共享的文档知识（与 Agent 私有记忆不同物） | `FileKnowledgeStore` + `knowledge_*` 工具 | 保留；**改名去歧**为 `kb_*` |

---

## 3. 问题全量清单（重构的靶子，逐条带证据）

| 编号 | 问题 | 证据（file:line） | 归类 |
|---|---|---|---|
| **P-01** | **双写入者 → 静默覆盖**：`knowledge.md` 由「内存模型整文件重写」与「通用 file_write」两路写；锁只保证互斥、不保证"内存模型知道外部改动"，故外部编辑被**下一轮落盘覆盖** | `lock-resources.ts:11-13`；**事故实证**：9/27 手改被 9/28 覆盖 | P1 |
| **P-02** | **同资源两个锁域**：`update_notebook` 域 `notebook` vs 别名 `update_working_memory` 域 `working-memory`，写同一 Map | `lock-resources.ts:8-10`（旧行为；已部分修复，需端到端复验） | P5/P1 |
| **P-03** | **CPP 双目的地**：同一产出既写 NOTEBOOK（有 writer 时）又注入 prompt（无 writer 时），语义不一致 | `context-engine.ts:1084-1102` | P3/P8 |
| **P-04** | **有损截断**：curated 段截到 3000、总量收敛缩成 stub(400)；观察超 500 **静默丢弃**（无标记） | `store.ts:1535-1569`、`:1416` | P4 |
| **P-05** | **拒绝写入 × 永久超预算**：写路径 `{ok:false}` 拒绝，而拒绝无法缩小文件 → 超预算后**永久超**（自述实测 23 323 vs 15 000） | `store.ts:676-704`、注释 `:1206` | P4 |
| **P-06** | **单位不一致（char vs byte）**：写路径按 char 判总量，加载路径 `statSync.size` 按 byte 判 → CJK 下"15 000 字符"实为 ~45 000 字节，被误判超限 | `store.ts:676` vs `:1224` | P5 |
| **P-07** | **破坏性自愈**：>2MiB 或命中可疑标记即**重建**，可能固化损坏 | `store.ts:1247` | P6 |
| **P-08** | **三代补丁共存**：双→单 `data-meta`、legacy `, tags:`、`MEMORY.md`/`state.md` 迁移 | `store.ts:1247-1317`、`taxonomy.ts`、`agent.ts:6980` | 补丁 |
| **P-09** | **摘要覆盖**：`compactSession` 每次**覆盖** `session.summary`，多代压缩塌缩成一份 | `store.ts:900` | P6 |
| **P-10** | **碎片与观察共享 500 上限**：压缩碎片挤占真实观察配额 | `store.ts:866` | P4 |
| **P-11** | **整理触发面重叠**：dream cycle / `memory_consolidation` / 压缩器 / `daily_report` 四者职责交叉、不可预测 | `limits.ts:420`、`session-workspace.ts:16`、`store.ts:1544` | P2/P3 |
| **P-12** | **全自动不可见**：无预算/陈旧度信号；Agent 不知何时该整理（本次纯属偶然发现 150%） | 无信号注入；`memory_stats` 需主动调 | P3 |
| **P-13** | **场景硬编码分支**：`isDream/isReflex/isConverse` 决定注入内容，无场景化"补全信息"引导 | `context-engine.ts` 多处 | P3 |
| **P-14** | **命名分裂**：`knowledge.md`（记忆）vs `knowledge_*`（项目知识库）同名不同物 | `tools/memory.ts` vs `knowledge-*` 工具 | P8 |
| **P-15** | **admin 旁路**：org-manager 直接 `addLongTermMemory`，绕过统一锁/整理，可能与管理周期竞态 | `api-server.ts:5735/5827` | P1 |

---

## 4. 目标架构（分层）

```
┌── A. Store 数据层（各自单一写入者；对外只读）───────────────────────────┐
│  knowledge.md   ← MemoryService（唯一写者）                              │
│  NOTEBOOK.md    ← NotebookService（唯一写者）                            │
│  sessions/*.json← SessionService（唯一写者）                             │
│  (项目知识库 docs 独立存储，命名 kb_*)                                    │
└──────────────────────────────────────────────────────────────────────────┘
┌── B. Service 访问层（进程内，唯一写者；锁 + 原子写 + 不变量）────────────┐
│  MemoryService:   save/search/organize/forget/stats/applyCurated         │
│  NotebookService: read/upsert/clear/prune                                │
│  SessionService:  (沿用现有 session 原语)                                 │
│  ★ 所有写操作经此层；直接 file_write/file_edit 记忆文件 → 拒绝          │
└──────────────────────────────────────────────────────────────────────────┘
┌── C. Tool 工具层（Agent 主动调用；渐进披露）────────────────────────────┐
│  memory_save/search/organize/update/forget/stats                         │
│  notebook_read/upsert/clear                                              │
│  kb_search/read/list（项目知识库，去歧命名）                              │
│  session(...) / recall_activity                                          │
└──────────────────────────────────────────────────────────────────────────┘
┌── D. Prompt 提示词层（场景矩阵 §7；替代硬编码注入）─────────────────────┐
│  按场景注入"该主动拉取/写入什么"的引导 + 记忆健康信号（§8.3）             │
└──────────────────────────────────────────────────────────────────────────┘
┌── E. Backstop 兜底层（无损 / 有界 / 可见）───────────────────────────────┐
│  预算再平衡 = 归档（`## _archived_*`，可检索），非截断                     │
│  dream = 定时调用 organize 原语，暴露 lastRunAt                            │
│  安全修复（不重建）；原子写；任何丢弃须有落盘标记 + 上报                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键变化（相对现状）**
1. **CPP 取消**为独立"机制"：其"检索/反思"能力改为 **(a)** 确定性轻量注入（进体积小的相关记忆，无 LLM 管道）+ **(b)** 提示词引导 Agent 主动 `memory_search`/`kb_search`。**不再有"产出写进 NOTEBOOK"的分叉**（消除 P-03）。
2. `update_working_memory`/`clear_working_memory`/`update_notebook`/`clear_notebook` **四名归一**为 `notebook_upsert` / `notebook_clear` / `notebook_read`（旧名**直接删除**，未保留别名）。
3. 记忆文件 **禁止** `file_write`/`file_edit`（工具层拒绝 + 引导）。
4. 预算判定**全改字符**，写/读路径**共用同一 enforcement 函数**。

---

## 5. 数据模型与不变量

### 5.1 knowledge.md（长期记忆）
```
# Knowledge
## <curated-key>            ← 常驻注入；body ≤ KNOWLEDGE_SECTION_MAX_CHARS
...（N 段策展）
## _archived_<date>          ← 归档段：被"再平衡"移出的内容，可检索、不注入
## _observations             ← 观察缓冲：`### <id>` + `<!-- type, data-meta -->` + body
```
**不变量**
- INV-K1：`## _observations` 恒为**最后**段；永不作为 curate 段参与注入/检索（现状已满足）。
- INV-K2：总字符 ≤ `KNOWLEDGE_TOTAL_MAX_CHARS`（**字符**，全路径一致）。超限 → **再平衡**：
  1. 先把最旧/最低价值策展段**归档**进 `## _archived_*`（内容保留、可检索、不再注入）；
  2. 归档后仍超限 → 触发一次 `memory_organize`（归纳而非丢弃）；
  3. 仍超限 → 上报并**保留最新观察**，绝不静默丢弃（对比现状 P-04/P-05）。
- INV-K3：任何内容移除必须**可检索**（在 `_archived_*` 或 `memory_search` 命中），否则拒绝该移除。
- INV-K4：写入原子（`writeFileAtomic`），崩溃不留半截。

### 5.2 NOTEBOOK.md（工作记忆）
```
# Notebook
## <key>
<!-- updated: ISO -->
<!-- managed: agent|system|cpp -->
<text ≤ NOTEBOOK_MAX_CHARS_PER_ENTRY>
```
**不变量**
- INV-N1：单一写入者（NotebookService）；**单一锁域**（`agent-memory` / sub `notebook`）。
- INV-N2：TTL 分层（agent 96h / system 24h）+ 容量上限（总 16 / agent 4），驱逐顺序 **cpp→system→agent**、最旧优先；**CPP 层随 CPP 移除而消失**。
- INV-N3：key 归一化（空白折叠、去 `#`、截断到 `NOTEBOOK_KEY_MAX_CHARS`）且**截断可报**。
- INV-N4：并发分身共享一致（写经 debounce + maxWait + 单锁）。

### 5.3 sessions/*.json（执行史）
- INV-S1：`summary` 为**追加式多代锚点**（不覆盖，见 P-09）或明确只保留最新 + 旧锚在 fragments；二选一并写清语义。
- INV-S2：fragments 与 observations **分池**（不再共享 500 上限，修 P-10）。

---

## 6. 工具层（全量清单）

| 工具 | 归属 | 语义 | 关键约束 |
|---|---|---|---|
| `memory_save` | 长期 | 追加一条观察 | 单对象、非数组；`sanitize` 后写入 |
| `memory_search` | 长期 | 语义→关键词回退检索 | 覆盖 curated + observations + archived |
| `memory_organize` | 长期 | 把观察归纳/归档进策展段 | **唯一**整理原语（dream 亦调用它） |
| `memory_update` | 长期 | 策展段 upsert | 超 section 上限不再截断，改分页/归档 |
| `memory_forget` | 长期 | 删除策展段（= `removeLongTermSection`） | 删除前确认可归档 |
| `memory_stats` | 长期 | 预算/观察数/策展数/**lastConsolidatedAt** | 供提示词层读信号（§8.3） |
| `notebook_read` | 工作 | 读单/全量条目 | 只读 |
| `notebook_upsert` | 工作 | 写/更新条目 | 单一锁域；归一 key |
| `notebook_clear` | 工作 | 删条目/清空 | — |
| `kb_search`/`kb_read`/`kb_list` | 项目库 | 文档知识（原 `knowledge_*` 去歧） | 与 Agent 长期记忆**分名分物** |
| `session` / `recall_activity` | 会话 | 不改 | — |

**删除**：`update_notebook`、`clear_notebook`、`update_working_memory`、`clear_working_memory`
（→ 归一为 `notebook_upsert` / `notebook_clear` / `notebook_read`）；`knowledge_*`（→ `kb_*`）。已直接移除，未保留别名。

---

## 7. 场景 × 行为矩阵（P3 落点）

| 场景 | 常驻注入（自动、低成本） | 提示词引导（Agent 主动拉 / 写） |
|---|---|---|
| **chat（Owner 对话）** | 策展段、sender 身份、时间、**记忆健康信号** | 涉及既有工作 → `memory_search` + `session` 回看；形成结论 → `memory_save` |
| **heartbeat** | 看板、团队状态、**记忆健康信号** | `memory_stats` 看预算 → 超阈值 `memory_organize`；无变化 → **不空转** |
| **task_execution** | 任务、验收标准、相关策展段 | 开工前 `memory_search` 经验；收尾 `memory_save` 教训 |
| **a2a / comment** | 对方身份、线程 | 需要对方历史 → `recall_activity` |
| **mailbox triage** | 邮箱项、看板 | 需决策依据 → `memory_search` |
| **dream（定时）** | 无（不注入） | 调用 `memory_organize` 原语；产出报告可观测 |

> 原则：**平台把"状态"告诉 Agent，把"有损整理"交给 Agent 用工具做**。

---

## 8. 自动机制与兜底重构

### 8.1 CPP 移除（能力迁移，不减少功能）
- **删除**：CPP 的 LLM 多阶段管道 + `notebookWriter` 写 NOTEBOOK 分叉（P-03）。
- **保留能力**：
  - "检索相关记忆" → 确定性轻量注入（`retrieveRelevantMemories` 精简版，体积有界）+ 提示词引导主动 `memory_search`；
  - "反思" → 由 `memory_organize` / 正常推理承担；
  - 复杂/多跳 → Agent 主动调 `memory_search`/`kb_search`。
- **类型**：`shared/types/cognitive.ts` 与 `CognitiveConfig/Stimulus` 一并移除或降为内部实现细节。

### 8.2 整理触发面收敛（P-11）
- **唯一原语** `memory_organize`。
- **dream cycle** 退化为"每日一次调用 organize 原语的定时器"，暴露 `lastRunAt`（可观测）。
- `memory_consolidation` mailbox 类型：**合并**进 dream 定时器（不再单独产生条目）。
- 压缩器（`compressLongTermMemory`）：**保留但其"截断"改为"归档"**（见 8.4）。
- `daily_report`：与 Agent 笔记**职责划清**（报告≠记忆）；去除与 knowledge 的重复写入。

### 8.3 信号（P-12）：让"必要时"成立
- `memory_stats` 输出固定字段：`usedPercent / observations / curated / lastConsolidatedAt`。
- **当 `usedPercent > 阈值（80%）`**：在 prompt 的"记忆健康"段出现一行提示，引导 `memory_organize`。
- **陈旧**：`lastConsolidatedAt` 超过 N 天也在提示中体现。
- 未超阈值**不出现**（避免噪声）。

### 8.4 再平衡 = 归档（P-04/P-05 的无损解）
```
ensureBudget(knowledge):
  while total(chars) > LIMIT:
    // 1) 归档最旧/最低价值策展段（内容保留、可检索、不注入）
    moveOldestCuratedTo('## _archived_<date>')
    // 2) 仍超 → 触发 memory_organize（归纳，非丢弃）
    if stillOver: return { needsOrganize: true }   // 交给 Agent
  // 绝不静默丢弃；若无法无损收敛，保留最新 + 上报
```
- 写路径**不再直接 `{ok:false}` 拒绝**；改为"先再平衡、必要时请求 Agent 整理"。
- 归档段可被 `memory_search` 命中（可恢复）。

### 8.5 安全修复替代破坏性重建（P-07）
- 自愈改为**保守修复**：仅当解析失败才回退；**绝不**因"看起来可疑"就重建；重建前先备份原文。

---

## 9. 前后端与接口改造

### 9.1 前端（`packages/web-ui`）
- `AgentProfile` 的 memory 折叠组：从"展示摘要"升级为 **健康可视化 + 只读查看**（预算条、观察数、上次整理时间；`knowledge.md`/`NOTEBOOK.md` 只读渲染）。
- `AgentMemorySummary`（`api.ts`）**增字段**：`usedPercent / observations / curated / lastConsolidatedAt / archivedCount`。
- **无独立写路径**：前端任何"整理"动作走 admin API → 服务层（同一写入者），不直改文件。
- 组件/快照测试同步更新。

### 9.2 后端 / 接口（`packages/org-manager`）
- **admin 写路径归口**（P-15）：`api-server.ts` 的 `addLongTermMemory` 直调改为经 `MemoryService`（拿锁、走不变量）。
- 修 `storage-usage.ts` 的"memory 体积"误导（只统计真正的记忆文件，去掉 sessions 的 99.98% 噪声）。
- 端点清单与返回字段随 §9.1 调整；知识库（`FileKnowledgeStore`）保持独立、**改名 `kb_*`**。

### 9.3 共享类型（`packages/shared`）
- `limits.ts`：删除 byte 预算常量/注释，统一字符；`NOTEBOOK_*_CPP` TTL 随 CPP 移除而删。
- `types/knowledge.ts`：新增 `archived` 段类型；`KnowledgeSection` 增 `archived:boolean`。

---

## 10. 测试计划（全量改齐，不留旧断言）

### 10.1 必须更新的既有测试（当前钉死旧行为）
- `cache-optimization.test.ts:577`（CPP→notebook 路由）
- `cognitive.test.ts:257/286/309/337`、`cognitive-deep.test.ts`（CPP 段落/管道）
- `memory-store.test.ts:35/257/264/338/350/360`、`knowledge-lifecycle.test.ts:67/88/100`、
  `memory-convergence.test.ts:34/50/60`（有损截断 / 拒绝写入）
- `notebook-lifecycle.test.ts:64/69/71-73/178`（CPP 层 TTL）
- `agent-targeted-coverage.test.ts:324/372`（dream 剪枝，改断言唯一原语）
- `context-engine.test.ts:138/698+`（consolidation 场景、Learning Habits 文案）

### 10.2 必须新增的回归（当前缺口）
1. **`file_write`/`file_edit` 直改记忆文件被拒 + 引导消息**（头号缺口，事故无覆盖）。
2. **无"永久超预算"路径**：预算恒 ≤100%；写路径拒绝分支被"再平衡"取代。
3. **归档可逆**：被归档内容可 `memory_search` 找回。
4. **预算信号注入**：>阈值出现、未超不出现。
5. **CPP 产出不再进 NOTEBOOK**（单目的地）。
6. **dream 唯一且可观测**（`lastRunAt`）。
7. **并发**：内存落盘 × 外部 file_write 不丢数据。
8. **命名去歧**：`memory_*` 与 `kb_*` 不串。
9. **单位一致**：CJK 文件不被误判超限。
10. **admin 写入走服务层**（锁/不变量生效）。

### 10.3 运行
`npx vitest run --project node <path>`（单文件）· `pnpm test:node` · `pnpm test:web-ui` · coverage ratchet。

---

## 11. 删除清单（拒绝"留补丁"）

- 代码：CPP 管道与 `notebookWriter` 分叉；`update_notebook`/`clear_notebook`/`update_working_memory`/`clear_working_memory`（归一）；`knowledge_*`（→`kb_*`）。
- 数据：`NOTEBOOK_*_CPP` TTL 常量；byte 预算常量。
- 迁移残留：双→单 `data-meta` 兼容分支、legacy `, tags:` 容忍、`MEMORY.md`/`state.md` 迁移（跑完一次性迁移后**删除代码**）。
- 死导出：`parseCuratedSections`/`slugSectionId` 若无外部引用则内联或导出并测试。

---

## 12. 验收 + 功能不减少（feature parity）

**验收（全部必须满足）**
- INV-K1..K4 / INV-N1..N4 / INV-S1..S2 全部有测试。
- §10.2 十项回归全绿；§10.1 全部更新后全绿。
- 无"永久超预算"；无静默丢失；`memory_search` 可命中归档内容。
- 前端展示健康数据；无任何直改记忆文件的路径。

**功能不减少（parity 矩阵）**

| 旧能力 | 新实现 | ✅ |
|---|---|---|
| 长期记忆读写/检索 | `memory_save/search/update/forget` | ✅ |
| 观察→策展归纳 | `memory_organize`（唯一原语） | ✅ |
| 工作记忆读写/共享 | `notebook_read/upsert/clear`（统一锁域） | ✅ |
| 检索相关记忆注入 | 轻量确定性注入 + 提示词引导工具 | ✅ |
| 反思 | 归纳/推理承担 | ✅ |
| 预算保护/防损坏 | 无损再平衡 + 安全修复 | ✅ |
| 执行史回溯 | `session` / `recall_activity` | ✅ |
| 项目知识库 | `kb_*`（去歧） | ✅ |
| 前端 memory 视图 | 健康可视化 + 只读查看 | ✅ |

