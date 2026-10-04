# 平台加固 2026-10 —— Agent 自管理边界与彻底重构

> 状态：**H1–H6 / H8 已实施并验证**（H7 / H9 / H10 / H11 见 §8 待办）
> 分支：`fix/agent-self-management-2026-10-04`
> 作者：CTO（technical co-founder），基于 v0.11.1 → `8a0d017c` 的变更评审 + 驻留 Agent 视角体验分析

---

## 0. 设计原则（本文件所有修复必须服从）

1. **平台只在必要时介入**。平台的职责是：守住**不可协商的硬不变量**（磁盘/上下文/安全的边界），其余一律交给 Agent。
2. **Agent 自己的事，给工具 + 引导，让它自己处理**。记忆整理、状态维护、知识取舍都是 Agent 的职责；平台提供的是**诚实可用的工具**和**不会误报的信号**，而不是替它做决定，也不是反复催促。
3. **宁可少管，不可误报**。一个"永远在报警但实际上没问题"的指标，比没有指标更糟——它会训练 Agent 忽略信号。信号必须可被信任。
4. **彻底重构，不打补丁**。修复必须消除**产生 bug 的结构**（例如"两个写者""两个预算口径""两套完成协议"），而不是在症状上加条件分支。
5. **顺序：文档 → 测试 → 重构修复 → 验证**。测试先写，用来钉住目标行为；修复必须让测试从红转绿。

---

## 1. 问题清单（已核实，含证据）

| ID | 严重度 | 问题 | 根因类型 |
|---|---|---|---|
| H1 | 🔴 | 记忆健康指标**结构性误报**：用整文件大小（含从不注入的观察缓冲）对比注入预算 | 口径错误 |
| H2 | 🔴 | `convergeLongTermToCap` **假收敛**：超额在 `_observations` 时零收缩，仍打 "converged" | 例外段无强执行点 |
| H3 | 🔴 | 预算常量**自相矛盾**：观察缓冲上限 30000 > 总量上限 15000 | 不变量不可满足 |
| H4 | 🔴 | 新会话首条消息**占位 buffer 不提升**→ 消息消失、回复不流式（回归） | 双写者使 setter 守卫短路 |
| H5 | 🟠 | `$` 模板语义残留两处未迁移（`memory/store.ts:788`、`workflow-template.ts:321`） | 同类 bug 漏修 |
| H6 | 🟠 | 子代理共享迭代预算 → 耗尽时**静默返回空结果**，调用方以为成功 | 失败不可见 |
| H7 | 🟠 | 完成协议**双轨并存**（`end_turn` 工具 + 文本 `COMPLETION_MARKER`）→ 合法回合被判 dropped | 迁移未收口 |
| H8 | 🟡 | 退役 CPP 配置与文档漂移（`markus.json` 死配置 + 6 处文档仍讲现行 CPP） | 删除未全仓收口 |
| H9 | 🟡 | 技能引用悬空静默降级，界面不可见 | 可观测性缺失 |
| H10 | 🟡 | shell 输出超限被动落盘，调用方无法主动截断 | 工具表达力不足 |
| H11 | 🟡 | 并发分身共享同一工作区，无冲突可见性 | 并发协调缺失 |

---

## 2. H1–H3：记忆预算重构（旗舰项，对应原则 1/2/3）

### 2.1 根因

`knowledge.md` 里有两类内容，**注入语义完全不同**：

- **curated sections**（`## <key>`）→ 会被 `SYSTEM_KNOWLEDGE_CHARS` 切片**注入每一轮 prompt**。这才是"记忆压力"的真实来源。
- **`## _observations`** → 明确**不注入**，只在 `memory_search` 时按需检索。

而现状把它们混在一个数字里：

- `getMemoryHealth()`：`totalChars = 整个文件的长度`，`cap = MEMORY_MD_TOTAL_MAX_CHARS(15000)`，`percent = totalChars/cap`。→ **观察缓冲越大，"记忆健康"越差**，尽管它对 prompt 零压力。（实测：本 Agent 36739/15000 = 245%，而 curated 段合计约 2k。）
- `convergeLongTermToCap()`：文件超 15000 时调 `compressLongTermMemory()`，后者 Phase 2/3 **显式跳过 `observationBuffer`**（`store.ts` `if (section.observationBuffer) continue;`）。→ 超额全在观察缓冲时，`compressed === content`，零改动，却打 `WARN knowledge.md over budget at load — converged {charsBefore:30522, charsAfter:30522}`。**日志在说谎**，且每次 load 重复三次。
- `MEMORY_OBSERVATIONS_MAX_CHARS(30000) > MEMORY_MD_TOTAL_MAX_CHARS(15000)`：观察缓冲自己的上限就已经超过总量上限。**总量上限在数学上不可满足**。

### 2.2 设计（重构，非补丁）

**把"一个含混的预算"拆成两个各自可执行、各自诚实的不变量：**

- **INV-1（注入预算）**：`curated` 部分（`## _observations` 之前 + 之后的非观察段）字符数 ≤ `MEMORY_MD_TOTAL_MAX_CHARS`。这是 `getMemoryHealth().percent` 的口径。
- **INV-2（观察缓冲预算）**：`## _observations` 字符数 ≤ `MEMORY_OBSERVATIONS_MAX_CHARS`，**写入路径与加载路径都强制执行**，超限时把**最旧的观察无损归档**到 `knowledge-archive.md`（可检索、不注入、绝不静默丢弃）。

**常量对齐**：`MEMORY_OBSERVATIONS_MAX_CHARS` 必须 ≤ 注入预算的合理倍数，且注释写明二者**不是同一个预算**。观察缓冲是"原始素材库"，可以比注入预算大，但它必须有**自己的**强执行点——现状缺的正是这个执行点。

**收敛函数**：`convergeLongTermToCap()` → 拆为对两个不变量各自收敛，返回结构化结果 `{injected:{before,after,converged}, observations:{before,after,converged}}`。**只有在真的收缩时才报告 converged**；否则打 `WARN ... could not converge`（这本身就是需要人/Agent 介入的真实信号）。

**信号与引导（原则 2/3）**：
- 横幅 `## Your Knowledge` 的健康行改为报告**注入预算**占用，并在观察缓冲接近其自身上限时**单独一行**提示（两个信号，各自诚实）。
- `memory_status` 工具同样返回两个口径，`hint` 只在**真的**接近上限时出现。
- 平台不替 Agent 整理；`memory_organize` / `memory_update` 仍是 Agent 的整理工具。

### 2.3 测试计划（先写）

`packages/core/test/memory-budget-invariants.test.ts`：

1. **INV-1**：curated 超限 → `converge*` 后 curated ≤ 上限，且被归档段正文出现在 `knowledge-archive.md`。
2. **INV-2**：观察缓冲超限（且 curated 远未超限）→ load 收敛后观察缓冲 ≤ 上限，最旧观察被**无损**归档（可从 archive 检索到原文）。→ **这条现在必然红**（假收敛）。
3. **诚实性**：无法收敛时，返回结果 `converged=false`，且日志不是 `converged`。
4. **指标正确性**：一个大观察缓冲 + 小 curated → `getMemoryHealth().percent` 反映 **curated**，不得因观察缓冲而虚高。
5. 幂等：连续两次收敛，第二次 `charsBefore === charsAfter`。

### 2.4 实施记录（已完成）

- 常量：`MEMORY_MD_TOTAL_MAX_CHARS` → **`MEMORY_MD_CURATED_MAX_CHARS`**（"TOTAL"这个词本身就是 bug 的根源，改名让不变量自我解释）；两处常量注释重写，明确二者**不是同一个预算**。
- `MemoryHealth` 接口（`memory/types.ts`）：字段由 `totalChars/cap` 改为 `curatedChars/curatedCap/percent` + `observationChars/observationCap/observationPercent`。
- `splitKnowledgeSections()`（导出）：按 `## _observations` 边界切分，作为**唯一**口径来源，供健康、写入、收敛三处共用。
- `MemoryStore.getMemoryHealth()`：口径改为 curated 注入段。
- `MemoryStore.convergeLongTermToCap()` → **`enforceMemoryBudgets()`**：对两个不变量**各自**收敛，返回结构化结果 `{curated, observations}`；只在真的收缩时报告 converged，改不动时打 `error` 级 `COULD NOT CONVERGE`（不再谎报）。
- 新增 `trimObservationsToCap()`：load 时把最旧观察**无损归档**（`knowledge-archive.md`，仍可 `memory_search`），补上观察缓冲缺失的强执行点。
- `compressLongTermMemory()`：预算口径从 `render().length`（含观察缓冲）改为 **curated-only** 的 `curatedSize()` —— 这是"假收敛"的直接成因（循环永远够不到目标，因为被跳过的段落算在分母里）。
- `addLongTermMemory()`：超预算判断改 curated 口径；section 替换的 replacer 改为**函数形**（`$&` 等不再展开）——顺带消掉 H5 在此处的一处残留。
- 消费端同步：`context-engine.ts` 横幅改为**两个独立信号**（注入段 ⚠️/🔴 + 观察缓冲 🗒️）；`tools/memory.ts` 的 `memory_stats` 输出 `budget`（注入）+ `observationBuffer`（独立）+ 两个分别的 hint；`org-manager/src/api-server.ts` 暴露两组字段。
- 测试：新增 `test/memory-budget-invariants.test.ts`（10 例，含**根因钉**："compress 单独跑不动观察缓冲"）；重写 `memory-health.test.ts`（原用例把错误行为写死了——"观察积压 → percent ≥ 70"——已推翻）；更新 `memory-convergence / memory-organize-tools / knowledge-lifecycle`。

**验证**：相关 5 个测试文件 **35/35 绿**；`tsc -b` 全仓 **0 错误**；`vitest --project node` **5175 通过**。

---

## 3. H4：Team Chat 占位 buffer 提升（回归）

### 3.1 根因

"一个存储 + 一根指针"模型里，`view` 是**指针**，`setActiveSession()` 是**唯一**该写它的地方——它额外承担"把 `NEW_CHAT_ID` 占位 buffer 折进真实会话"的职责：

```ts
setActiveSession(key, sessionId) {
  const cur = this.view.get(key);
  if (cur === sessionId) return;                    // ← 守卫
  if (cur === undefined || cur === NEW_CHAT_ID) {
    this.promotePlaceholder(sessionId);             // ← 提升
    this.view.set(key, sessionId);
  }
}
```

而 `useChatStream.ts` 在调用它**之前**先直接写了指针：

```ts
activeSessionBuffer.set(sendKey, event.sessionId);  // 等价于 view.set — 守卫被击穿
setActiveSession(sendKey, event.sessionId);         // cur===sessionId → 立即 return
```

`promotePlaceholder()` 因此成为**死代码**。复现（`tsx` 直跑 manager）：`view after session_start = sess_real_1` / `visible messages after promote = undefined` / `appendTextChunk -> rendered = []`。

### 3.2 设计（消除结构，而非加判断）

**`view` 变成真正的私有单写者**：删除对外暴露的 `get view(): Map`，改为**只读**访问器（`readActiveSession(key)` / `getActiveSession(key)`）+ 全部写操作收敛到 `setActiveSession` / `clearActiveSession` / `restoreFromCache`。任何调用方不得再持有可变 Map —— 击穿守卫在**类型上不可表达**。

调用点迁移：`Team.tsx:2364`、`useChatStream.ts:1021` 的 raw `set` 删除（由 setter 完成）；读取改为 `getActiveSession()`。

### 3.3 测试计划（先写）

- manager 单测：`view===NEW_CHAT_ID` 时 `setActiveSession(realId)` → 占位行折入真实 buffer，`getMessages(key)` 非空。
- 回归钉：**不存在**任何可写的 `view` 出口（由类型系统保证；调用点迁移后编译即验证）。
- 集成：模拟 `session_start` 生产序列（乐观行 → `session_start` → 增量 chunk），断言增量不丢。

### 3.3 实施记录（已完成）

- `ConversationBufferManager`：新增导出的 **`ActiveSessionView`**（只有 `get`）；`view` 由 `readonly` 改为 **`private readonly`**；删除对外的 `get view()`，改为**稳定只读投影** `get activeSessions()`（对象标识固定，避免再次触发"effect 依赖不稳定 → 120 次/秒空转渲染"）。绕过 setter 直写指针现在**在类型上不可表达**。
- `useConversationBuffers`：`activeSessionBuffer` / `viewBuffer` 改为返回只读投影。
- `useChatStream`：`ChatStreamContext.activeSessionBuffer` 类型改为 `ActiveSessionView`；**删除** `session_start` 分支里的裸 `activeSessionBuffer.set(...)`（指针写入只保留 `setActiveSession` 一条路径），并就地写下"为什么不能在这里写"的注释。
- `Team.tsx`：切换会话时的直写改为 `setActiveSession(...)`。
- 测试：`ConversationBufferManager.test.ts` 增加 H4 契约用例（断言投影**无写入口** + 从 `NEW_CHAT` 占位**提升**乐观行 + 真实会话增量分片确实落在视图里）；两处 `mgr.view.get()` 改为 `mgr.activeSessions.get()`。

**验证**：`ConversationBufferManager.test.ts` **17/17 绿**；web-ui 项目 **678/678 绿**；`tsc -b`（含 web-ui）**0 错误**。

> 备注：`vitest --project node` 有 1 个**既有**失败用例（`packages/cli/test/commands-start-integration.test.ts` 的 "auto-runs quickInit when config is missing"，60s 超时）——它真实启动 server 并做联网 quickInit，属环境性 flaky；`git diff HEAD -- packages/cli` 为空，与本次改动无关。

---

## 4. H5：`$` 模板语义残留（同类收口）

`literal-replace.ts` 只覆盖了 `file_edit` / `apply_patch`。全仓仍有两处：

- `memory/store.ts`：`existing.replace(regex, \`${sectionHeader}\n${truncatedContent}\n\`)` —— `truncatedContent` 是 Agent 自撰正文，含 `$&` 会展开复制。
- `shared/src/types/workflow-template.ts`：`prompt.replaceAll('{{key}}', value)` —— `value` 可含 `$`。

**设计**：`literal-replace.ts` 补齐 `replaceAllLiteral(content, search, replacement)`，上述两处改走它。**凡是"把 Agent/用户自撰文本插入既有文本"的地方，一律不得使用字符串形替换器** —— 写成模块顶部的一句硬规则 + 注释锚点。

---

## 5. H6：子代理预算（失败必须可见）

现状：`spawn_subagents` 的多个子代理**共享一个聚合池**；池尽时子代理 `break`，返回的 `cleanResult` 可能为空字符串 → 父 Agent 收到空结果，**误以为子代理完成了任务**（实测：本轮派 2 个子代理，其中一个直接返回空，评审被迫重做）。

**设计**：
- 预算**按子代理独立**计量（每个子代理有自己的迭代上限，聚合池仅作为整体熔断上限，触顶时返回**显式错误结果**而非空串）。
- 结果对象携带 `status: 'budget_exhausted'` + 明确的文本错误，父 Agent 一眼可见。
- 日志分级：正常触顶 = `warn` + 结构化字段；不产生"空成功"。

---

## 6. H7：完成协议双轨 → 统一到类型化的 `end_turn`

### 6.1 根因：同一件事两套协议

| | 文本哨兵 `<<HANDLE_COMPLETE>>` | `end_turn` 工具 |
|---|---|---|
| 信号形态 | 模型**写出来的字符串** | 模型**调用的工具**（运行时观察 `endTurnCount` 计数器） |
| 注入 | 5 处手工拼接 `COMPLETION_MARKER_INSTRUCTION` | `ToolSelector.pushUnique` 无条件注入 + `TOOL_DEF_PROTECTED` |
| 校验 | `hasCompletionMarker`（还要 `<think>` 挖空防误判） | `endTurnCount` 增量，**不可能被改写** |
| 清洗 | 泄漏正则 + 3 处 strip（畸形变体 `<HANDLE_COMPLETE>` 也要管） | 不需要 |
| 漏判代价 | 合法回合被判 `completion marker missing` → 邮箱项 dropped（当日 8 次） | — |
| 额外成本 | 每个非 chat 回合**多一次完整 LLM 续写调用**（`ensureCompletionMarker`） | 0 |

两套协议同时在线，于是"完成"这件事有两个互相不认识的判据——又一个"同一事实两个来源"。

### 6.2 设计：删掉文本协议，`end_turn` 成为唯一协议

1. **邮箱层只判断它真能判断的**：`detectAbnormalCompletion` 改为**结构性**判定 —— 只有"这一回合**什么都没产出**"才算异常。`[preempted]/[cancelled]/[end_turn]` → 正常；`undefined`/`''` → 异常（`empty reply`）；**其余任何非空回复 → 正常**。
   理由：「Agent 有没有把活干完」只有 **Agent 循环**能回答（它拥有工具循环与 `end_turn`）；邮箱层越权判它会误判（这正是 dropped 的来源）。
2. **"别只宣布计划就停"的约束留在 Agent 循环内**，并改为**类型化**提示：`ensureCompletionMarker()` → `ensureTurnCompleted()`，提示文案从"补一个 token"改为"调用 `end_turn` 工具收口"。
3. **整体删除文本协议**（不留兼容层、不留正则）：`COMPLETION_MARKER`、`COMPLETION_MARKER_INSTRUCTION`、`hasCompletionMarker`、`COMPLETION_MARKER_LEAK_RE`、`stripCompletionMarkerLeak`，以及 5 处注入、3 处 strip、`agent-metrics` 的 `markerFailureRate`。
4. **心跳用类型化静默**：`heartbeat` 原本靠"返回 marker"表示完成 → 改为返回 `END_TURN_REPLY_SENTINEL`（语义更准：回合已**刻意**结束）。
5. **指标换成诚实的那个**：`markerFailureRate` → `emptyTurnRate`（非 chat 回合里"空产出"占比）——marker 没了，这个指标才有意义。

**为什么安全**：`end_turn` 已在 `TOOL_DEF_PROTECTED` 且由 `pushUnique` 无条件注入（已核查 `tool-selector.ts` + `capability-packs.ts`），所有场景（chat / a2m / requirement / comment / workflow）都有。

**已知取舍**：历史会话里可能残留 `<<HANDLE_COMPLETE>>` 文本，模型有极小概率模仿输出；不再清洗会让它**可能**出现在可见回复里（纯观感，不损数据）。选择"不留兼容层"以兑现"无技术债"；如需回退，`git revert` 单个提交即可。

### 6.3 实施记录

见 §9。

---

## 7. H8–H11：可观测性与工具表达力

- **H8**：删除 `markus.json` 中的死配置 `agent.cognitive`（不校验未知键，无害但脏），并清理 6 处仍以现行概念描述 CPP 的文档。
  - 已完成：`README.md`、`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/PROMPT-ENGINEERING.md`、`docs/STATE-MACHINES.md`；另补齐常量改名后的全仓收口（`docs/MEMORY-SYSTEM.md`、`docs/CONCURRENT-PROCESSING.md`、`packages/core/docs/agent-self-management-redesign.md`、`README.zh-CN.md`）。死配置未动（属 Owner 的运行时文件，需其确认）。
- **H9**：启动期"技能引用缺失"只有日志 → 结构化：**单点计算** `resolveMissingSkills`（消除两处重复谓词）→ 落到 **agent 实例状态**（WeakMap，不改 `Agent` 类）→ **API 暴露** `skillWarnings{missing,available}` → **前端 ⚠️ 可见** → 启动**汇总**一条日志（不刷屏）。
- **H10**：`shell_execute` 增加 `max_output_chars`，**由调用方主动指定返回上限**，替代"超限被动落盘 + 二次 `file_read` 往返"。关键约束：**截断必须无损** —— 上限只作用于"返回给模型的文本"，完整输出仍落盘并给出路径（复用 agent 既有 offload 通道，不新增第二套持久化）。
- **H11**：并发分身共享工作区 → 至少提供"当前有其他会话正在编辑 X"的可见性。（**本轮不做**，Owner 指定）

---

## 8. 实施顺序与验证

1. 本文档（完成）
2. H1–H3 记忆预算重构：测试 → 重构 → 验证 ✅
3. H4 占位提升：测试 → 重构 → 验证 ✅
4. H5 字面量收口 ✅
5. H6 子代理预算 ✅
6. H8 文档/配置漂移清理 ✅
7. **H7 完成协议统一**（本轮）
8. **H9 技能缺失结构化可见**（本轮）
9. **H10 `shell_execute` 主动截断**（本轮）
10. 全量验证：`tsc -b` + 相关 vitest 套件

**验证口径**：每条修复必须有"修复前红、修复后绿"的测试证据；禁止只靠读代码断言。

---

## 9. 第二批实施记录（H7 / H9 / H10）

### 9.1 H7 —— 完成协议统一到类型化 `end_turn` ✅

**删除**（不留兼容层）：`COMPLETION_MARKER`、`COMPLETION_MARKER_INSTRUCTION`、`hasCompletionMarker`、`COMPLETION_MARKER_LEAK_RE`、`stripCompletionMarkerLeak`，以及 5 处 prompt 注入（`markerSuffix` 变量整体删除）、`ensureCompletionMarker` 的"缺标记就判 dropped"分支、`agent-metrics` 的 `markerFailureRate`。

**新增/改造**：
| 位置 | 改动 |
|---|---|
| `attention.ts detectAbnormalCompletion` | 改为**结构性**判定：只有 `undefined`/`''` 算异常。`[preempted]`/`[cancelled]`/`[end_turn]`/**任何非空回复** → 正常。删除了对 `'completion marker missing from reply'` 的特殊分支（该 reason 已不存在） |
| `agent.ts ensureCompletionMarker` → **`ensureTurnCompleted`** | 守卫改为**类型化**：`if (this.endTurnRequested) return reply`；催办文案从"补一个 token"改为"调用 `end_turn` 工具" |
| `agent.ts heartbeat` 分支 | 完成语义从"返回魔法 token"改为返回 `END_TURN_REPLY_SENTINEL`（语义更准：回合**刻意**结束） |
| `agent.ts` 退化截断分支 | 不再往截断回复尾部补标记（非空回复本身即正常结束） |
| `createMarkerStrippingDelta` | 不再扣留 marker 长度的尾巴 —— 旧实现让**每一次流式输出都延迟 N 字符**且毫无收益 |
| `agent-metrics.ts` | `markerFailureRate` → **`emptyTurnRate`**（空产出占比）+ 新增 **`turnEndedViaToolRate`**（类型化完成协议采用率） |
| `shared/limits.ts` | 保留一个**有移除判据的**历史数据清洗器 `stripLegacyCompletionToken`：旧会话/日志/知识里仍有该 token，回放会被模型模仿并泄漏到用户可见输出。注释写明"非协议的一部分 + 何时可删" |

**测试影响（真实改动面：13 个测试文件）**：所有用 `COMPLETION_MARKER` 伪造"正常回复"的 mock 改为普通非空文本；`attention-more.test.ts` 新增/推翻断言：(a) 空回复 → 异常重排队；(b) `[end_turn]`/`[preempted]`/`[cancelled]` → 正常；(c) **非空且不含任何标记 → 正常（推翻旧行为）**。`agent-extended.test.ts` 的"退化截断补标记"与"续写文本转发"两例改为类型化语义。
另发现并修正一处**测试脚手架缺陷**：这些用例没把 `AttentionController.running` 置真，于是走了 `!this.running → requeue` 分支——断言看起来在测完成协议，其实什么都没测。已显式置真并加注释。

### 9.2 H9 —— 技能缺失结构化可见 ✅

- **单点计算**：`core/src/skill-warnings.ts` 的 `resolveMissingSkills` / `buildSkillWarnings`，消除 create/restore 两处重复谓词；registry 整个缺失时**全部**已分配技能算缺失（真实降级不能被静默隐藏）。
- **落到 agent 状态**：`setAgentSkillWarnings` / `getAgentSkillWarnings`（`WeakMap` 挂在实例上，**不改 `Agent` 类**；读侧返回防御性拷贝，避免调用方改写污染）。
- **API**：`GET /api/agents` 每个 agent 带 `skillWarnings.missing`（非空才带，避免 payload 膨胀）；`GET /api/agents/:id` 带完整 `{missing, available}`。
- **前端**：`AgentProfile.tsx` 技能页顶部 ⚠️ 横幅，列出缺失技能名 + "该技能未安装，相关工具不可用"；i18n key 三语言（zh-CN / en / es）齐备。
- **启动汇总**：`org-service.ts` 恢复循环结束后打**一条**汇总（"N of M restored agents reference skills that are not installed"），不再 per-agent 刷屏。
- **测试**：`core/test/skill-warnings.test.ts` 10 例（0 缺失 / 部分缺失 / registry 为 null / available 截断 / 实例隔离 / 写读双向拷贝）。

### 9.3 H10 —— `shell_execute` 主动输出上限（无损） ✅

- `shell_execute` 新增 `max_output_chars`（schema + 说明）。
- 在**工具边界**统一执行：`executeToolInternal` 作为唯一漏斗（写锁/非写锁都经过它），把原实现改名为 `runTool`，由漏斗读取本次调用的上限。
- **无损**：命中上限走 `offloadLargeResult(name, raw, cap)` —— 完整输出落盘，返回"上限长度预览 + 文件路径"。不是丢弃尾部。
- **幂等**：以 `Agent.OFFLOAD_BANNER_PREFIX` 判定"已是落盘载荷"，杜绝二次落盘（嵌套文件引用 + 白写一次磁盘）。调用方要求的上限同时**降低落盘阈值**并**作为预览长度**，语义一致。
- 未传该参数时行为与之前完全一致（阈值 `TOOL_RESULT_OFFLOAD_CHARS`、预览 2000/30000）。

### 9.4 验证（全量实测）

| 项 | 结果 |
|---|---|
| `tsc -b` 全仓 | ✅ **0 错误** |
| `vitest --project node` | ✅ **5184 通过 / 10 skipped** |
| `vitest --project web-ui` | ✅ **678/678** |
| 唯一失败 | `packages/cli/test/commands-start-integration.test.ts > auto-runs quickInit when config is missing` —— **既有环境性 flaky**（真实启 server + 联网 quickInit 超时），`git diff HEAD -- packages/cli` 为空 |

**未做**：H11（并发分身工作区可见性，Owner 指定本轮不动）。死配置 `markus.json#agent.cognitive` 仍未动（属 Owner 运行时文件）。

---

## 10. H12：观察缓冲"上报口径 ≠ 执行口径"（在 Owner 亲测中发现的 H1–H3 残留缺陷）

> 这是**回归发现**：H1–H3 落地并重启后，Owner 让我亲自体验。实测发现旗舰修复
> **在真实数据上仍然没有生效** —— 观察缓冲依旧 119%，一个字没减。下面记录根因与彻底修法。

### 10.1 现象（实测，非推断）

重启后（新构建）启动日志：

```
[ERROR] [memory-store] observation buffer over budget at load — COULD NOT TRIM
        {"charsBefore":32028,"charsAfter":32028,"cap":30000,"archived":0}
```

横幅：`🗒️ 观察缓冲 119%（35734/30000 字符 · 41 条观察）`。

**诚实信号是对的**（不再假报 converged），但**执行点是死的**：`archived:0` —— while 条件从未为真。

对 `knowledge.md` 副本用真实 `MemoryStore` 复现（`/tmp/repro_h12.ts`）：

```json
{ "onDiskBefore": 35734, "enforce": {"before":35734,"after":35734,"converged":false,"archived":0},
  "onDiskAfter": 35734, "verdict": "STILL OVER (bug reproduced)" }
```

### 10.2 根因：同一个预算，两种互不相等的度量

| 口径 | 来源 | 值 |
|---|---|---|
| **不变量 / 横幅** | `splitKnowledgeSections(file).observations.length`（磁盘上的原始 `## _observations` 文本） | 35734 |
| **裁剪循环** | `Σ(entry.content.length + OBSERVATION_ENTRY_OVERHEAD_CHARS)`，常量 **96** | ≈ 29300（load 时） |

真实条目携带 `data-meta: {…}` JSON（tags / session 溯源信息），实际每条约 **168** 字符
markdown 开销，而估算常量只有 **96** → 系统性少算 ~72 字符/条。load 时 raw 32028（>30000）
触发裁剪，但估算口径算出 ≈29242（≤30000）→ **while 条件为假 → 一个字没减**。

这与 H1–H3 修的是**同一类错误**（"数量口径漂移"），只是漂移点从"文件 vs 注入段"挪到了
"序列化文本 vs 手写估算"。**任何用手写常量去近似序列化体积的做法都会再次漂移。**

**为什么测试没抓到**：`bigObservationKnowledge()` 夹具的每条 meta 只有 `<!-- type: note -->`
（≈30 字符开销），估算常量 96 **大于**真实开销 → 夹具里估算口径反而**高估**、裁剪正常触发、
测试通过。真实条目的 `data-meta` 让开销反超 96 → 生产失败。**夹具不代表真实序列化。**

### 10.3 设计（重构：让"体积"只有一个定义）

1. 抽出纯函数 `serializeObservationBuffer(entries)` —— **它就是写盘时生成 `## _observations`
   的那段序列化逻辑本身**（原来内联在 `saveToDisk` 里）。
2. **唯一权威度量** = `serializeObservationBuffer(writeSet).length`。写入端、裁剪端、
   上报端全部调用它 —— 手写常量 `OBSERVATION_ENTRY_OVERHEAD_CHARS` **整个删除**。
   手里没有常量，就无从漂移。
3. **单一执行点** `trimObservationBufferToCap()`：同时服务**写路径**（`saveToDisk`）与
   **加载路径**（`enforceMemoryBudgets`），消灭原来两处各写一遍、各自估算的重复循环。
   裁剪最旧观察（**无损**归档，仍可 `memory_search`）；观察裁尽仍超限才回退归档最旧碎片
   （同样无损）—— 让不变量**真的可执行**（"没有执行点的上限不是上限"）。
4. 保留 H1–H3 的诚实失败上报：裁不动就 `COULD NOT TRIM`，绝不谎报 converged。

### 10.4 测试计划（先写）

- 回归用例用**带 `data-meta` 的真实形态**夹具（旧夹具必然通过、无法回归保护）。
- 断言 `enforceMemoryBudgets` 后**磁盘上的 `## _observations` 长度 ≤ 上限**（口径 = 磁盘，
  与横幅同源）。
- 断言写入端 **往返保真**：`serializeObservationBuffer(entries).length` 等于磁盘切片长度
  —— 这条正是"两个口径永不漂移"的结构性保证。
- 断言幂等、无损归档（最旧条目进 `knowledge-archive.md`）依旧成立。

### 10.5 实施记录（已完成）

- `packages/core/src/memory/store.ts`：新增并导出 `serializeObservationBuffer`；删除
  `OBSERVATION_ENTRY_OVERHEAD_CHARS`；`saveToDisk` 与 `enforceMemoryBudgets` 共用
  `trimObservationBufferToCap()`；新增 `observationWriteSet()` / `observationBufferChars()`。
- `packages/core/test/memory-budget-invariants.test.ts`：新增 H12 回归组（真实 `data-meta`
  夹具 + 往返保真 + 磁盘口径）。
- 验证：见 §10.6。

### 10.6 验证

| 项 | 结果 |
|---|---|
| 真实数据复现（修复前） | `archived:0`，磁盘 35734 不变 —— bug 复现 |
| 真实数据复现（修复后） | 磁盘 ≤ 30000，最旧观察进入归档 —— 收敛 |
| `memory-budget-invariants` | 旧用例 + 新 H12 用例全绿 |
| `tsc -b` | 0 错误 |

---

## 11. H14/H15：记忆\"自整理触发器错位\" + \"信号不可行动\"（Owner 亲测发现）

问：**一个普通 Agent，会不会自己整理 knowledge？有认知吗？有定期机制吗？**
实测回答：**机制在，但对绝大多数 Agent 是死的；信号在，但不可行动。** 这是 H1–H3
\"平台只守硬不变量、把自管理交给 Agent\"这一原则**只做了一半**——工具给了，
但让工具自动起作用的那根\"扳机\"扣在了错的度量上。

### 11.1 现象（实测，非推断）

1. 全量日志（10-01 ~ 10-04，84+ Agent）里 `Dream cycle starting` **只出现 2 次**——
   自动语义整理事实上从不运行。
2. 本 Agent（CTO）观察缓冲 **31 条 = 29823/30000 字符（99%）**，`lastConsolidatedAt`
   却停在手动整理那天。也就是说：**缓冲已经满了，自动整理仍然不触发。**

### 11.2 根因：触发器用的是**另一个**度量

`Agent.consolidateMemory()`（dream 周期）的守卫是：

```ts
if (entries.length >= 50 && this.lastDreamDate !== dreamKey) { … }
```

而观察缓冲的预算是**字符**：`MEMORY_OBSERVATIONS_MAX_CHARS = 30 000`。
**\"≥50 条\" 与 \"≤30000 字符\" 是两套互不相干的度量**——正是 H1–H3/H12 反复
修掉的同一个反模式（同一件事，两个口径）。后果：

- 条目**小**（≈30 字符/条）的 Agent：50 条才 ≈1.5k 字符，远没到预算，却会触发 dream；
- 条目**大**（≈960 字符/条，含 `data-meta`）的 Agent（如本 Agent）：**31 条就 99%**，
  永远够不到 50 → **dream 永远不跑**，缓冲里堆积的垃圾（转储片段、陈旧观察）
  只能靠 load 时的**机械**裁剪（最旧无损归档），**没有任何语义合并/提升**。

一句话：**会溢出的缓冲不会触发清理，能触发清理的缓冲不需要清理。**

### 11.3 设计（让它扣在同一个度量上）

1. **触发器与横幅同源**：新增 `MEMORY_DREAM_TRIGGER_PERCENT`，其值**就是**
   `MEMORY_HEALTH_WARN_PERCENT`（同一条常量引用，永不漂移）。横幅在 X% 警告 Agent
   的那一刻，平台的自动 dream 也在 X% 触发——**警告不再是死路**。
2. **保留条目数作为次级压力信号**：`MEMORY_DREAM_MIN_ENTRIES = 50` 仅用于
   \"字节不多但碎片极多、检索成本高\"的情形，不再是唯一闸门。
3. **信号可行动（H15）**：横幅在报告观察缓冲压力的同时，给出**具体杠杆**
   （`memory_organize` 合并 / `memory_update` 删除），让 Agent 有权自己处理——
   符合\"平台给工具与引导、Agent 自行处理自己的记忆\"。

### 11.4 测试计划（先写）

- 断言 `MEMORY_DREAM_TRIGGER_PERCENT === MEMORY_HEALTH_WARN_PERCENT`（同源，防漂移）。
- 纯函数 `shouldRunDreamCycle(health, entryCount)` 表驱动用例：
  - 31 条 / 99% → **true**（修复前为 false，即本 Agent 的真实形态）；
  - 60 条 / 10% → true（次级信号）；
  - 5 条 / 12% → false（不空转 LLM）。
- 断言触发阈值 `> MEMORY_HEALTH_CRITICAL_PERCENT` 之类的边界不被误用到。

### 11.5 实施记录（已完成）

- `packages/shared/src/limits.ts`：新增 `MEMORY_DREAM_TRIGGER_PERCENT`
  （= `MEMORY_HEALTH_WARN_PERCENT`）与 `MEMORY_DREAM_MIN_ENTRIES`。
- `packages/core/src/agent.ts`：dream 守卫抽成可测纯函数 `shouldRunDreamCycle()`，
  由\"字符压力 OR 条目数\"驱动；不再单看条目数。
- `packages/core/src/context-engine.ts`：观察缓冲横幅补上**可行动指引**。
- 测试：`packages/core/test/memory-budget-invariants.test.ts` 新增 H14/H15 组。

### 11.6 验证

| 项 | 结果 |
|---|---|
| 本 Agent 真实形态（raw 29824/30000 = 99% · 31 条）| `shouldRunDreamCycle` → **true**（修复前因 31<50 恒为 false） |
| `tsc -b` | 0 错误 |
| `memory-budget-invariants` | 19/19 全绿 |
| `vitest --project node` | 5193 通过 / 10 skipped（唯一失败为既有环境性 flaky `commands-start-integration`） |
| `vitest --project web-ui` | 678/678 |

**副作用（预期且为正向）**：修复后，本 Agent（99% > 70%）会在下一轮 4h dream 周期被触发，
自动清理观察缓冲里堆积的转储碎片——即**平台自愈**，无需人工介入。

---

## 12. H16：会话压缩片段被当成"观察"（结构重构——由 Owner 交办的设计问题）

### 12.1 问题：一个缓冲区，两类语义完全不同的东西

`## _observations` 同时承载：

| 内容 | 来源 | 语义 | 期望的处理 |
|---|---|---|---|
| Agent 自撰观察（`memory_save`：note/fact/insight）| **Agent** | 草稿日志 | dream 合并/提升 |
| 会话压缩片段（`conversation_fragment`）| **平台**（compaction 分页载荷）| 原始历史 | 按 id 检索、`session_include` 回注 |

两者混在一个池子里，产生三个具体伤害：

1. **Agent 为自己的记忆付别人的账**：片段挤占观察预算
   （实测本 Agent 的 99% 里有大量 `frag_*`），而 Agent 无权也无法"整理"这些原始转储。
2. **dream 语义错位**：dream 把整套观察（含原始对话转储）喂给 LLM 去"去重/提升模式"。
   对原始历史做模式提升没有意义，纯属白烧 token。
3. **概念污染**：`_observations` 的文档定义是"Agent 的原始、按需检索的草稿日志"——
   这句话对会话分页载荷不成立。

**判定原则**：压缩片段是**平台**产物（分页），不是 **Agent** 的知识。本项目的核心原则是
"平台只在必要时介入、Agent 自管自己那部分"——把两者的预算混在一起，正是这一原则的反面。

### 12.2 设计（在结构上分离，而非共享）

| | 归属 | 文件/区 | 预算 | 是否注入 | 谁整理 |
|---|---|---|---|---|---|
| 观察（note/fact/insight…）| **Agent** | `knowledge.md ## _observations` | `MEMORY_OBSERVATIONS_MAX_CHARS` | 否 | dream |
| 会话片段 | **平台** | **`session-fragments.md`** | `MEMORY_FRAGMENTS_MAX_CHARS` | 否 | 平台（按会话 purge / 超限无损归档）|

要点：

- **`getObservations()` 不再返回片段** → dream 与观察健康信号**只**看到 Agent 自撰内容。
- 片段独立存储、独立预算、独立截断（超限**无损**归档到 `session-fragments-archive.md`）。
- `session_retrieve` / `session_include` 检索**活区 + 归档**（修复此前"归档即检索不到"的缺口）。
- **迁移自愈**：加载时把 `_observations` 里的历史片段迁出到 `session-fragments.md`，
  knowledge.md 随之自愈——不丢数据。
- `addEntry()` 内部按类型路由，**所有调用点无需改动**（compaction 代码一字未动）。

### 12.3 测试计划（先写）

- 迁移：给定 knowledge.md 的 `_observations` 内含 `conversation_fragment` →
  加载后 `getObservations()` 不含它、`session-fragments.md` 含它、knowledge.md 不再含它。
- 独立预算：大量片段不改变 `getMemoryHealth().observationPercent`。
- 检索：迁移后的片段可被 `retrieveFragments` 找回并 `includeFragment` 回注。
- 往返：`addEntry({type:'conversation_fragment'})` 只写 `session-fragments.md`。

### 12.4 实施记录（已完成）

- `packages/shared/src/limits.ts`：新增 `MEMORY_FRAGMENTS_MAX_CHARS`。
- `packages/core/src/memory/store.ts`：新增片段池 `this.fragments` 与
  `session-fragments.md` / `session-fragments-archive.md` 的读写、独立截断与归档检索；
  `addEntry` 按类型路由；`getObservations`/`getEntries`/`retrieveFragments`/
  `includeFragment`/`purgeSessionFragments`/`sessionStats` 改用片段池；
  加载时迁移历史片段（knowledge.md 自愈）。
- 测试：`packages/core/test/memory-fragment-separation.test.ts`。

### 12.5 验证（实测）

| 项 | 结果 |
|---|---|
| 本 Agent 真实文件迁移（副本实测）| 31 条 → **30 条观察 + 1 个片段独立成池**；`knowledge.md` 观察区不再含 `frag_*`（自愈）；`session-fragments.md` 已生成 |
| 迁移后观察健康 | `observationPercent` **99% → 89%**（片段不再计入 Agent 的观察预算）|
| 迁移后检索 | `retrieveFragments('心跳')` → 命中该片段（分离未损害检索）|
| 定向测试 | `memory-budget-invariants` 19/19 · `memory-fragment-separation` 5/5 |
| `tsc -b` | 0 错误 |
| `vitest --project node` | 5198 通过 / 10 skipped（唯一失败为既有环境性 flaky `commands-start-integration`：端口 8056 被运行中的 Markus 占用）|
| `vitest --project web-ui` | 678/678 |

**行为变更（预期）**：`getEntries()`（无参）现在只返回 **Agent 自撰观察**；片段通过
`getEntries('conversation_fragment')` / `getFragments()` / `retrieveFragments()` 访问。
H13 的回归夹具原先把"含 `## ` 标题的正文"放在**片段**里，已改为**观察**——因为片段
已不再属于观察区（这正是 H16 的目的）。

## 13. H17：观察条目分隔符可被正文伪造（Owner 亲测中由探测证明）

### 13.1 现象（实测，非推断）

用真实的序列化/解析函数做往返探测：一条**完全合法**的 Agent 观察，正文里含一个
markdown H3 标题——

```
### obs_probe_1
<!-- type: insight -->
结论：这样做。
### 修复步骤
1. 打开文件
2. 改一行
```

解析结果 **2 条**（期望 1 条）：

| 实际产出 | id | 内容 |
|---|---|---|
| 条目 1 | `obs_probe_1` | `结论：这样做。`（**正文被截断**）|
| 条目 2 | `修复步骤` | `1. 打开文件\n2. 改一行`（**凭空多出一条幽灵条目**）|

这是**静默数据损坏**：Agent 的一条观察被切断、并被伪造出一条 id 为正文片段的假条目。

**当前是否有实际损坏**：没有。实测本 Agent 真实 `knowledge.md` 中 30 个 `### ` 行
**全部**是真条目 id（`obs_*`），且无一条的下一行不是 `<!-- type: … -->`。属**潜伏**
缺陷——由探测证明，尚未触发。

### 13.2 根因：容器用了载荷能生产的结构记号

`parseEntryBlocks()` 用 `obsContent.split(/\n### /)` 划分条目。但 `### ` 是 **markdown
H3 标题**——Agent 正文（任意 markdown）**可以自由生产**它。用载荷能生产的记号做分隔符，
载荷就迟早会伪造出分隔符。

与 §10 的 H13（curated 段落误切正文里的 `## `）**是同一类结构性缺陷**：容器结构记号
与载荷内容空间重叠。H13 的修法是"压缩只作用于 curated 区、观察区逐字节原样拼回"；
而观察区本身**必须**逐条解析，所以这里需要在**边界定义**上消除重叠。

### 13.3 设计（把边界锚在机器产物上，而非 markdown 记号）

条目在磁盘上的**权威形态**由**唯一写入方** `serializeEntryLines()` 产出，它**总是**输出：

```
### <id>
<!-- type: … -->
<正文>
```

即条目头**必然**紧跟一行机器生成的 meta 注释。于是把分隔条件从"任意 `### `"收紧为
"`### ` 且其后紧跟 `<id>\n<!-- type: … -->`"：

```ts
obsContent.split(/\n### (?=\S+\n<!-- type: )/)
```

- Agent 正文里的裸 `### 标题`（**已观察到的**触发形态）旁若没有 `<!-- type: … -->`，
  不再被当作边界 → 归入当前条目正文。
- 对**所有经本 store 写出的数据**，该边界是**精确**的（写入方保证 meta 行必然存在）。
- 零格式变更、零迁移：现存文件（无正文 `### `）解析结果不变。
- 单一读写点：`parseEntryBlocks` 同时服务观察区、片段区、片段归档 —— 一处修复，三处受益。

**已知残余边界（如实记录）**：若正文**逐字**包含 `### token` **且其下一行**也是
`<!-- type: … -->`，仍会被判为边界。要在 markdown 容器里彻底消除这一点，只能让写入方
对正文里的 `### ` 做转义（改磁盘格式 + 全量迁移）。当前证据（真实文件无正文 `### `；
连本 Agent 那条内嵌了 `<!-- type: … -->` 字样的观察正文，其前一行也不是 `### `）表明
该形态在实践中不可达。按"简单优先 / 不过度设计"，**不做转义**；若将来出现该形态的真实
数据，转为转义方案（届时按下述测试先写）。

### 13.4 测试计划（先写）

新增 `packages/core/test/memory-entry-boundary.test.ts`：

1. 往返不变式：正文含 `### 标题` 的条目 → 序列化再解析 → 仍是 **1 条**、正文**完整**。
2. 幽灵条目不复现：解析结果里**不存在** id 为正文片段（如 `修复步骤`）的条目。
3. 多条目混合：正文含 `### ` 的条目 + 正常条目，条目数与内容均正确。
4. 片段区同受保护：`serializeFragmentRegion` 往返，正文含 `### ` 不分裂。
5. 真·条目边界仍生效：两个合法条目（各自 `### id` + meta）仍解析为 2 条。

### 13.5 实施记录（已完成）

- `packages/core/src/memory/store.ts` —— `parseEntryBlocks()` 分隔正则收紧为
  `/\n### (?=\S+\n<!-- type: )/`，并加注释说明"边界锚在机器产物上"。
- 测试：`packages/core/test/memory-entry-boundary.test.ts`。

### 13.6 验证（实测）

| 项 | 结果 |
|---|---|
| 探测脚本（修复前）| 1 条输入 → 解析出 **2 条**（复现损坏）|
| 探测脚本（修复后）| 1 条输入 → 解析出 **1 条**，正文完整含 `### 修复步骤` |
| 本 Agent 真实 `knowledge.md` | 仍 **30 条**（无回归；30 个 `### ` 全为真条目）|
| 定向测试 | `memory-entry-boundary` 5/5 |
| `tsc -b` | 0 错误 |

## 14. H18：带内容器的**区域隔离不变式**（H13/H17 的系统化收口）

### 14.1 为什么这不是"又一个 bug"，而是一族

H13（`## ` 在正文里）与 H17（`### ` 在正文里）**同根**：`knowledge.md` 是**带内（in-band）
markdown 容器**——结构是从**裸 markdown 记号**推断的，而载荷（Agent 自撰 markdown）**也能
生产同样的记号**。而且格式**没有单一主人**：写入期守卫（`sanitizeSectionBody`）存在，却能被
任何「扫错区域」的读取期变换绕开（H13 就是这么发生的）。

**跨全部 Agent 的实测**（`~/.markus/agents/*/`）：

```
9 / 96 个 knowledge.md / session-fragments.md 在观察/片段区内含 H13 归档存根
```

即：**这不是我的数据问题，是共享格式的问题，已经在多个 Agent 身上留下痕迹。**

### 14.2 严重性（如实修正）

我一度判断为"内容丢失"。**核实后修正：主要是搬家，不是丢失。** 逐例核对：被归档的正文
确实出现在该 Agent 的 `knowledge-archive.md` 中（例：`agt_623a4a9a…` 的
`## Task Execution & Platform Lifecycle` 完整正文在归档里）。因此存根的承诺
"正文已无损归档、可用 memory_search 检索"**大体成立**；危害是**结构被误判 / 归档命名空间被
污染**，而非静默丢数据。我之前的"存根在撒谎"是**过度推断，特此更正**。

### 14.3 设计：把整族钉成**不变式**，而不是逐点修补

新增 `packages/core/test/memory-region-isolation.test.ts`，用**对抗性载荷**（正文里逐字包含
`## …`、`### …`、`_[archived → …]_`、`<!-- type: … -->`、围栏代码、`$&`…）钉死：

1. `splitKnowledgeSections` 往返恒等（区域切分无损）。
2. **curated 变换绝不改写观察区——逐字节保留**（H13 的正向不变式）。
3. curated 变换前后**观察条目数不变**（不伪造、不吞并）。
4. curated 段落正文里的 `## ` 不在回读时伪造幽灵段落。
5. `sanitizeSectionBody` 幂等。

**这套不变式在第 3 条上当场又抓出同族的第 4 个实例**（见 14.4）——证明它作为系统级闸门是
有效的，而非一次性补丁。

### 14.4 由该测试抓出的新实例：meta 注释可被正文伪造

写入方 `serializeEntryLines` 把 meta 注释**固定在** `### <id>` 的下一行；但读取器
`parseEntryBlocks` 对**条目内任意一行**做 `^<!-- type: … -->$` 匹配。于是一条正文含
`<!-- type: insight -->` 的观察：该行被当元数据吞掉（**篡改 type**），若它是唯一正文行，
**整条观察被判为空而丢弃**（噪声探测：7 条输入 → 只剩 6 条）。

**修法（与 H17 同一原理）**：meta **只允许出现在固定位置**（`i === 1`）。正文里长得像 meta
的行是载荷，逐字保留。

### 14.5 已知残余边界（如实记录）

若 Agent 正文的**第一行**恰好逐字等于一条合法 meta 注释，则与真 meta 无法区分（后者必然
也在该位置）。因写入方**总是**产出真 meta，此形态仅可能出现在"无 meta 的遗留条目"上，实践
不可达。按"简单优先"，不做转义；若将来出现真实数据，转为转义方案。

### 14.6 实施记录与验证

- `packages/core/src/memory/store.ts` —— `parseEntryBlocks` 的 meta 匹配收紧到 `i === 1`。
- `packages/core/test/memory-region-isolation.test.ts` —— 5 例不变式（先红后绿）。
- 验证：对抗性探测 **7/7 条目完整**；记忆相关 **115/115**；`tsc -b` **0 错误**。

## 15. H19：curated 压缩的逻辑与「杀掉自动归档」

### 15.1 这个功能到底是什么（先讲清逻辑）

`knowledge.md` 分两区：**curated**（`## <name>` 段落，**每轮注入 prompt**）与
**`## _observations`**（观察缓冲，不注入、按需检索）。`compressLongTermMemory()` 只处理
curated，三段式：

1. 切分 curated / observations；
2. **单段**正文 > `MEMORY_MD_SECTION_MAX_CHARS`(3000) → 把正文搬进
   `knowledge-archive.md`，原位留一行指针存根；
3. **总量** > `MEMORY_MD_CURATED_MAX_CHARS`(15000) → 反复挑**最大的段落**做同样的事，
   直到达标。

意图：curated 会被**注入每一次 prompt**，必须有上限，否则上下文膨胀。

### 15.2 测量：它**从未合法触发过一次**

跨全部 Agent 实测（94 个 `knowledge.md`）：

```
curated 总量 > 15000 的：0
单段正文     > 3000 的：0
```

它只在 H12 之前那个**错误口径**（拿整文件含观察区去比 15000）下被触发过——而那正是
**H13 污染的成因**。口径修正后，**这个机制对任何 Agent 都不再触发**。

### 15.3 判定：意图合理，机制不合理 → 重构掉

机制的问题：
- **静默**：Agent 看不到 curated 被掏空；
- **按体积、价值盲目**：先归档**最大**的段落，可能掏掉最有价值的知识；
- **自相矛盾**：同文件的**单段**超限是**拒绝写入**并给出理由（"content is never
  silently truncated"），而**总量**超限却**静默改写**；
- **是 H13 的根因**。

**结论（按 Owner 口径：实现不合理就重构）**：**删掉"自动归档"这个机制**，把契约统一成
一套显式的：

| 情形 | 旧行为 | 新行为 |
|---|---|---|
| 单段 > 3000 | 拒绝写入 + 理由 | **不变**（已正确）|
| curated 总量 > 15000（软预算）| **静默归档最大段落** | **只报告**：横幅 ⚠️ + 日志；**不改一个字节** |
| curated 总量 > 硬天花板（45000）| —— | **拒绝写入** + 可操作理由（`memory_organize` / `memory_update` 先合并或删除）|

**为什么软预算不硬拒绝**：合并两段（`memory_organize`）的中间态**必然变大**，硬拒绝会
**锁死唯一的收敛路径**。故软预算只报告；硬天花板设在 **3× 软预算**，既有安全上界，又给
合并留足空间。**"软预算 + 强信号 + 工具"** 正是 Owner 一贯口径：平台只在硬不变量上介入，
其余交给 Agent 自管。

### 15.4 测试计划（先写）

`packages/core/test/memory-curated-budget.test.ts`：
1. curated 超软预算但 < 天花板 → **写入成功**；`knowledge.md` 内**无任何新增指针存根**（不静默归档）。
2. curated 超**硬天花板** → 写入**被拒绝**，带可操作理由；且**文件未变**（fail-closed）。
3. 合并（先删后加）路径不被软预算阻塞。
4. `enforceMemoryBudgets` 在 curated 超软预算时**只报告**，不改写文件。
5. 观察区在以上任何路径下**逐字节不变**。

### 15.5 实施记录

- 删除 `compressLongTermMemory()`（接口 `types.ts`、实现、`agent.ts` dream Pass 3、测试与桩）。
- `addLongTermMemory`：写前判硬天花板 → 拒绝；不再"写完再静默再平衡"。
- `enforceMemoryBudgets`：curated 分支改为**只报告**（不再归档）。
- 新增常量 `MEMORY_MD_CURATED_HARD_MAX_CHARS`。
- `knowledge-archive.md` 仍保留：**观察缓冲**的无损归档（H12/H16）继续用它。

### 15.6 验证

| 项 | 结果 |
|---|---|
| 测量（94 个 knowledge.md）| curated 超软预算 **0**；单段超 3000 **0** → 机制从未合法触发 |
| `memory-curated-budget`（新）| 5/5（先红后绿）|
| 记忆相关全量 | **215/215** |
| `tsc -b` | 0 错误 |
| 全量 node | 5217 通过 / 10 skipped（唯一失败为既有环境性 flaky `commands-start-integration`）|

## 16. H9：技能声明与注册表**对账**（干掉无意义声明）

### 16.1 先纠正一处误判

我一度以为 `Humanizer`/`Weather`/`Github`/`Find Skills` 因**大小写**丢失技能。**核实后更正**：
`InMemorySkillRegistry.get()` 早已用 `kebab()` 归一化 + alias 做**大小写/别名无关**匹配，
这些名字**本来就解析成功**（启动日志的缺失清单里根本没有它们）。特此更正。

### 16.2 实测：真正缺失的只有 8 个名字（跨 35 个 Agent，41 处引用）

`agents.skills`（`data.db`，84 个未删 Agent）中**解析不到**的技能名：

| 名字 | 引用数 | 性质 |
|---|---|---|
| `web-search` | 17 | **能力**（内置工具），被误当技能声明 |
| `self-evolution` | 16 | 模板**已下架/改名**（现为 `self-improving-agent`）|
| `markus-project-cli` | 3 | 旧模板名 |
| `git` | 1 | **不存在**（shell 已覆盖，Owner 点名）|
| `code-analysis` | 1 | **不存在**（Owner 点名）|
| `markus-cli` | 1 | 旧模板名 |
| `web-fetch` | 1 | 能力（内置工具）|
| `image-generation` | 1 | 能力（内置工具）|

三类：**幽灵引用**（`git`/`code-analysis`）、**下架模板**（`self-evolution`/`markus-*cli`）、
**能力被当技能**（`web-search`/`web-fetch`/`image-generation`）。共同点是**声明了一个
不存在的东西**——与 H9 当初暴露的是同一件事：定义从不与注册表对账。

### 16.3 处理：干掉（Owner 口径）

- 备份 `agents` 表 → `/tmp/agents-skills-backup-<ts>.json`（可回滚）。
- 从 35 个 Agent 的 `skills` 里移除这 8 个死引用（**41 处**）。
- 验证：残留死引用 **NONE**。

> 注：移除"能力型"声明**不降低任何能力**——它们本来就不是技能（平台注释明说 Skills 是
> *prompt-based instruction packages, not tool providers*），对应的能力由**内置工具**提供。

## 17. H20：H13 存量损坏的**一次性自动迁移**

### 17.1 存量实测

跨全部 Agent（`~/.markus/agents/*/`）：

```
受影响文件 9 个 | 存根 43 处
  可按名字唯一回填: 38 | 重名歧义: 5 | 归档里找不到: 0
```

### 17.2 迁移规则（保守、确定性、幂等）

`MemoryStore.repairStubResidue()`，在 **load 时**运行：

- 存根行**上一行**的标题名，在 `knowledge-archive.md` 里**唯一**匹配到一节 → 回填该正文；
- **重名（歧义）或找不到 → 原样保留，绝不猜**；
- 归档副本**保留**（copy-back，不是 move ⇒ 不可能丢数据）；
- 幂等：无存根时是 no-op。
- 观察与片段**两个池**都修（片段由其独立写入器 `saveFragmentsToDisk` 落盘）。

### 17.3 测试与验证

- `memory-h13-repair.test.ts` **6/6**（唯一匹配回填 / 歧义不猜 / 找不到保留 / 幂等 /
  片段同修 / 无归档安全 no-op）。
- 全量 node：**5217 通过 / 10 skipped**；`tsc -b` 0 错误。

**生效方式**：迁移在仓里；Owner 下次**重新编译重启**后，所有 Agent 首次加载即自动回填
（本 Agent 那 31 处片段存根中，38 处唯一匹配会回填）。

---

## 18. H21：H13 存量修复的**覆盖漏洞**——curated 区 + 归档重名（Owner 亲测再次发现）

### 18.1 现象（重启后实测，非推断）

重启后日志证明 H20 **确实跑了**：`H13 residue repaired {"repaired":27,…}` 等 9 条。但全量扫描
（逐 Agent 读文件、按区域分类）显示 **26 个 Agent 仍残留 73 处存根**：

```
kn:curated  unique 65   ← 每轮注入 prompt 的 curated 区
frag        unique 3 / ambiguous 4
kn:observations ambiguous 1
```

**65 处集中在 curated 区**——也就是说 Agent 的实时知识里，整整一节内容变成了一行指针。

### 18.2 根因（不是"没跑"，是"跑不到"）

1. **H20 的 `repairStubResidue()` 只遍历 `this.entries` 与 `this.fragments` 两个池**。
   `knowledge.md` 的 curated 区**不是**这两个池的一部分（它以原始文本形式落盘、由 `saveToDisk`
   原样保留），因此 curated 里的存根**根本没有任何代码路径**去处理。
2. **条目内回填取"正上方那一行"当标题名**（`lines[i-1]`）。而写入方序列化的是
   `### <id>` / `<!-- type: … -->` / 正文——标题与存根之间只要再夹一行与 meta 同形的注释，
   取到的就是 `<!-- type: note -->` 而非标题，**永远匹配失败**。
3. **归档里存在重名**（`## 验证` ×5、`## Relevant Memories` ×N……）——这正是 H13 自身造成的：
   旧压缩把多条"正文里含 `## 验证`"的内容分别归档，产生同名 section。重名让"唯一匹配"规则
   必然落空，5 处存根永久无解。

### 18.3 设计（重构，非补丁）

新增纯模块 **`packages/core/src/memory/residue-repair.ts`**（无 fs、无 logger，可直测）：

- `indexArchiveBodies(text)` — 归档 → `name → bodies[]`（唯一/歧义可判）。
- `healStubLines(text, bodies)` — 行级规则，**curated 文本、单个观察正文、单个片段正文通用**：
  存根的"所属标题"= 向上最近的一行标题，**跳过 meta 注释、空行、以及其它存根**；
  - 唯一匹配 → 回填正文；
  - 重复名（歧义）/ 找不到 → **不动**，收进 `ambiguous` / `notFound` 如实上报。**绝不猜**。
- 幂等：无存根即 no-op。

`MemoryStore.repairStubResidue()` 改为编排器（返回结构化 `ResidueRepairReport`）：
修复 **curated 区 + 观察池 + 片段池**，只写回真正变化的文件；歧义/找不到打 WARN 并保留原样。

**同时从源头消灭歧义**：`archiveSection()` 不再允许产生同名 section——同名不同正文时自动加序号
（`## 验证 (2)`），完全重复则幂等跳过。

### 18.4 测试

- `memory-residue-repair.test.ts`（新，纯函数）**11/11**：唯一回填 / 歧义上报候选数 / 找不到 /
  meta 行不阻断 / 多存根各自判定 / 幂等 / 快速路径 / 索引忽略区域标记。
- `memory-h13-repair.test.ts`（扩写）**11/11**：新增 curated 唯一年回填 / curated 歧义上报 /
  curated+观察同时回填且 curated 仍在 `## _observations` 之前 / meta 间隔不阻断 /
  归档写入不产生重复 `## name`。

> **一处诚实修正**：初版 fixture 用了 `### 团队协调与通信路由` + `<!-- type: note -->`，
> 结果被条目边界正则切开、存根自成一"条目"、上方无标题——**测试当场抓出 fixture 不真实**。
> 改用不会触发边界的 `## ` 后才反映真实形态。这条也说明：**必须拿真实数据实测**。

### 18.5 实测验证（真实数据副本，绝不碰线上文件）

`/tmp/verify_repair.ts`：把 26 个受影响 Agent 的三份文件复制到临时目录，逐个真实构造
`MemoryStore`（触发修复），前后比对各区域存根数：

```
before: {"curated":65,"obs":1,"frag":7}
after : {"curated":0, "obs":1,"frag":7}
```

**65/65 curated 全部回填**，25 个 Agent 的实时知识被修复。

### 18.6 残余与如实说明

- 剩余 7 处存根**全部位于本 Agent 自己的 `session-fragments.md`**，且性质是"条目开头即存根"
  （标题被边界正则切成独立条目）或真歧义（`## 验证` 等重名）。实测 **blast radius = 1 个 Agent**。
  它们**不注入 prompt**，正文在归档里可 `memory_search` 检索，故按"不猜"原则保留并上报，不重写
  平台载荷。
- **H22（本轮发现，未修，已记录）**：`session-fragments.md` 的解析对**载荷内含
  `### <x>` + `<!-- type: … -->`** 的内容会切成伪条目，而 `loadFragmentsFromDisk` 只保留
  `conversation_fragment` 类型 → 下次保存会**静默丢弃**这些伪条目。实测影响面同样只有 1 个
  Agent（本 Agent，10 条 / 2451 字符，且均为转储碎片）。修法：把片段文件当**无损容器**——
  按类型只在**读取**时过滤，保存时原样写回。属独立一轮工作。

### 18.7 状态

- `tsc -b` **0 错误**；定向 **22/22**；全量 node **5233 通过 / 10 skipped**；
  唯一失败 `commands-start-integration` quickInit 超时（既有环境性 flaky，与本次无关）。
- 提交：`fix/agent-self-management-2026-10-04`（本地，未推送）。**重新编译重启后**首次加载即自动生效。

## 19. H22/H23：载荷伪造条目边界 —— in-band 容器族的格式级收口

### 19.1 现象（实测，非推断）
重启后亲测：H21 生效（curated 存根已回填）。用**真实数据副本**喂给真实代码做往返探测，抓到：
- 磁盘上 `session-fragments.md` 的真实片段正文 **13701 字符**，经真实 `MemoryStore` 加载后只剩 **11200** —— **静默丢失 2501 字符**，且下一次保存会把截断结果持久化。
- 根因形态：该片段正文是一份上下文转储，逐字包含 `### 团队协调与通信路由` + `<!-- type: note -->` 等 10 处 —— 被读取器当成条目分隔符。
- 全组织扫描（134 个记忆文件）：**13 个文件 / 11 个 Agent** 存在载荷伪造边界。（初版按"非 `obs_`/`frag_` 前缀"误判为 74 个 —— 把 `mem_`/`merged_`/`compact_`/`daily_` 等**遗留真条目**算了进去，见 19.2。）

### 19.2 两次被否决的修复（如实记录）
1. **"锚定 `obs_`/`frag_` 命名空间"** —— 实测否决：全组织 id 前缀分布 `obs_`1765 / `mem_`757 / `merged_`164 / `compact_`87 / `frag_`25 / `daily_`19。只认 `obs_|frag_` 会把 **2817 条真条目中约 26 条/文件**误并。
2. **"id 必须是含 `_` 的 ASCII 记号"** —— 被既有测试当场抓红：本代码库条目 id **不受形状约束**（树内实测 `o1`、`o0`、`marker-0`、`test-role`），该规则会静默丢弃真条目。

### 19.3 判定与设计（重构，非补丁）
根因：**带内 markdown 容器 + 任意载荷 ⇒ 结构不可判定**（H13/H17/H18/H22 同族）。
- **写入端转义（结构性保证）**：正文里以 `\`、`### `、`<!-- ` 开头的行加一个 `\` 前缀，读取时精确反转。**对任意 id、任意载荷都成立** —— 载荷从原理上无法再生产结构记号。
- **片段池读取端锚定 `frag_`**：片段 id 由存储器独占（只写 `frag_<ts>_<sessionId>`）→ 无损回收"转义出现之前"已损坏的历史片段。**观察池不做形状猜测**（id 不受约束），其历史伪造边界如实上报、不猜。

### 19.4 测试（先写）
新增 `packages/core/test/memory-payload-forgery.test.ts`（5 例）：转义往返恒等（对抗性行）；载荷含完整条目形态 → 落盘即转义、回读 1 条无损；观察池同理；历史片段文件（载荷含未转义边界）整段无损读回；多真实片段仍各自成条。

### 19.5 实施
`store.ts`：新增 `escapeEntryBodyLine`/`decodeEntryBodyLine`；`serializeEntryLines` 转义正文；`parseEntryBlocks` 增加 `boundaryId` 参数（默认 `\S+`）；片段池两处调用点传 `frag_\S*`；`archiveFragment` 幂等判定收紧为 `\n### <id>\n`（避免与正文转义行误匹配）。

### 19.6 验证（实测）
- 真实数据副本往返：丢失 **2501 → 0**（加载后 **+756** 字符 —— 被修正暴露的 7 处存根中可唯一匹配者已被 H20/H21 自动回填）。
- `tsc -b` 0 错误；新增 5/5；`packages/core` 全量 **3147 通过 / 10 skipped / 0 失败**。
- 护栏：两次被否决的读侧规则各被既有测试当场抓红 → 证明测试有效。

### 19.7 已知残余（如实）
- **观察池**历史伪造边界（约 10 处）：id 不受约束，无法在不误伤真条目的前提下自动判定 → 保留并上报，不猜。
- 载荷若逐字包含**本存储器自己序列化出的片段记录**（`### frag_<ts>` + meta），仍可伪造片段边界 —— 需载荷内嵌存储器私有记录，实测未出现。

## 20. H24：机器记录改用机器格式 —— 从第一性原理消灭这一族

### 20.1 诊断：这不是四个 bug，是一个定理

真实需求只有三条：**curated 知识**（小、要注入 prompt、要人能读）、**观察**（量大、只被检索、
不注入）、**会话片段**（平台产物、只被检索、不注入）。

现状把三者都塞进 markdown 文本文件，结构用 markdown 记号（`## ` / `### `）**在带内编码**。于是：

> **只要分隔符是内容里可能出现的字符串，格式就是歧义的。**

H13（`## `）/ H17（`### `）/ H18（`<!-- type: … -->`）/ H22（载荷内嵌整条记录形态）是**同一个 bug
被撞了四次**，而我给的"修复"（sanitize / 形状规则 / 固定位置 / 转义 + 锚定）是同一错误前提上的
五个补丁。判据：**一个 bug 能换个记号再犯一次，说明修的不是根因。**

### 20.2 设计：结构必须待在载荷够不到的地方

| 池 | 性质 | 存储 | 理由 |
|---|---|---|---|
| curated 知识 | 目标 prompt 注入、人读、平台写 | `knowledge.md`（markdown，**不变**）| 小、注入、可读性即需求；`## ` 在这里**就是**合法格式 |
| 观察 | 追加式、机器写、**不注入**、无需可读 | **`observations.json`**（JSON 数组）| 载荷是 JSON **字符串** ⇒ 永远无法造出一行记录 |
| 会话片段 | 同上 | **`session-fragments.json`** | 同上 |

归档同理：`observations-archive.json`、`session-fragments-archive.json`。

**关键点**：JSON 数组里载荷只是一个字符串值——转义由 JSON 规范保证，**不需要任何自定义转义规则、
边界正则、形状启发式或修复遍历**。这一族 bug 由构造消失。

### 20.3 这会**减少**复杂度（而非增加）

可删除：`escapeEntryBodyLine`/`decodeEntryBodyLine`、`serializeEntryLines`/`parseEntryBlocks`
的边界启发式、`serializeObservationBuffer`/`serializeFragmentRegion`/`extractFragmentRegion`、
`ENTRY_ID_LOOKAHEAD`、以及为它们服务的测试（收敛为一条不变式：*payload 造不出记录*）。

仅保留一个**一次性迁移读取器**（读旧 `.md` 的 `## _observations` / `session-fragments.md`），
带明确删除判据：全部 Agent 迁移完成并验证后删除。

### 20.4 迁移（一次性、幂等、保守）

`observations.json` 不存在且 `knowledge.md` 含 `## _observations` → 用**旧读取器读一次**（尽力而为、
歧义不猜、如实上报）→ 写 JSON → 重写 `knowledge.md` 为 curated-only。片段同理（`.md` → `.json`）。
数据不丢：写成功后才移除旧区段。

### 20.5 残余（如实）

- curated 正文若含 `## `：仍是带内结构，但该区由平台写入且有写入期守卫（`sanitizeSectionBody`），
  且**有界**（KB 级、注入面）。属"markdown 即格式"的**有意选择**，非歧义缺陷。
- 迁移读取器读到**无法判定**的旧载荷（如真歧义重名存根）：保留原样并上报。

### 20.6 实施
- 新增 `packages/core/src/memory/records.ts`：`parseRecords` / `serializeRecords`（纯函数，可直测）。
- `store.ts`：观察 → `observations.json`（溢出 `observations-archive.json`）；片段 → `session-fragments.json`（溢出 `session-fragments-archive.json`）。`knowledge.md` 改为**只写 curated**（`writeCuratedKnowledgeMd`）。`search()` 纳入观察归档 JSON。`getMemoryHealth().archiveChars` 改为**全部归档之和**。
- 删除：`serializeObservationBuffer` / `serializeFragmentRegion` / `serializeEntryBlocks` / `fragmentArchiveHeader` 及 `archiveSection` 的观察归档调用点。
- 保留（标注 LEGACY MIGRATION ONLY，带删除判据）：`parseEntryBlocks` / `extractFragmentRegion` / `escapeEntryBodyLine` / `decodeEntryBodyLine` —— 只用于**一次性**读取旧 `.md` 后改写成 JSON。

### 20.7 验证（实测）
- 新增 `packages/core/test/memory-records.test.ts`（5 例，含"载荷内嵌整条序列化记录仍只有 1 条"）。
- **真实数据沙盒**（本 Agent 数据副本，绝不碰线上）：`knowledge.md 48914 → 3130` 字节（纯 curated）；`session-fragments.md`（28442 字节）被 `session-fragments.json` 取代并删除；**28 观察 + 1 片段零丢失**；二次加载幂等（`observationChars` 不变）。
- 全量：`tsc -b`（全仓）**0 错误**；`packages/core` **227/227 测试文件通过**。
- 迁移的测试：`memory-budget-invariants` / `memory-fragment-separation` / `memory-h13-repair` / `memory-migration` / `memory-observations-order` / `memory-store` / `cognitive-enhancement`。

### 20.8 本轮实测抓到的两个**自造回归**（如实记录）
1. **指针注释重复追加**：`writeCuratedKnowledgeMd` 每次保存都往 `knowledge.md` 追加一条指针注释 → 200 次 `addEntry` 后文件涨到 29812 字节（banner 报 199%）。由探针实测抓出，**修法：干脆不写指针**——curated 区是要注入 prompt 的，注释会被并进最后一个段落正文并一起注入。
2. **回归由"数值异常"暴露**：`199%` 一开始被怀疑是"测试过期"，实测证明是真 bug。教训重申：**测试的数值异常先当 bug 查，别当陈旧断言放过**。

### 20.9 残余与后续
- 迁移读取器 + `residue-repair.ts` 在**全部 Agent 迁移完成并验证后**可整体删除（判据：所有 `agents/*/` 下无 `session-fragments.md`、且 `knowledge.md` 无 `## _observations`）。
- curated 正文含 `## ` 的写入期守卫（`sanitizeSectionBody`）保留——markdown 在 curated 区是**有意选择**。

---

## 21. H25 —— 预算口径必须与表示形式无关（重启后实测发现）

### 21.1 现象
H24 重启后的启动日志里，10 个 Agent 各被"无损归档 1~6 条观察"（`observation-buffer over budget at load — trimmed losslessly {charsBefore:35183, charsAfter:29425, archived:6}`）。但这些 Agent 在变更**之前**是健康的。

### 21.2 根因
H24 换了**容器**，也顺手换了**度量单位**：上限 `MEMORY_OBSERVATIONS_MAX_CHARS = 30_000` 是按 markdown 序列化标定的，而新口径量 `JSON.stringify(entries, null, 2)` —— **缩进 + 重复键名 + 引号**。

本机真实数据（34 条，实测）：

| 口径 | 值 | 相对上限 |
|---|---|---|
| 内容本体（payload） | 23 899 | 80% |
| 旧 markdown 序列化 | 25 716 | 86% |
| **JSON pretty** | **35 182** | **117%** |

即：**32% 的预算被 JSON 语法本身吃掉**；同一批知识**只因换了容器**就"超限"，于是迁移时被静默驱逐。

### 21.3 设计
**预算量的是 Agent 自己写的字节（payload），不是容器的序列化开销。**
`observationPayloadChars()` = `Σ content.length`；`fragmentPayloadChars()` 同理。这样任何未来的容器变更都不会再自行决定"哪些知识还活着"。条目数上限（`MAX_MEMORY_ENTRIES`）仍是结构约束。

### 21.4 验证
- 新增 `packages/core/test/memory-budget-measure.test.ts`（**先红后绿**）：修复前 `archived=4`、payload 断言失败；修复后 2/2 通过。用例之一即"payload 未超上限的旧数据，迁移后不得被驱逐"。
- 受影响的既有断言（原先量 `observations.json` 文件长度）按原意改为量 payload；其中两个 H12 夹具原先靠 JSON 膨胀"假超限"，改为按 payload 真超限（`realisticObservationKnowledge(42, 800)`），历史陷阱断言（`42*(600+96) ≤ cap`）原样保留。

---

## 22. H26 —— 迁移只在"已经出事"时才落盘（重启后实测发现）

### 22.1 现象
全组织扫描 94 个 Agent：只有 **10 个**有 `observations.json`；**81 个仍在旧格式**（`knowledge.md` 里带 `## _observations`）。而 10 个全在 21:33:30–33 这一瞬间生成 —— 恰好是**超限被裁**的那些。

### 22.2 根因
`loadFromDisk()` 的旧格式分支里，`saveToDisk()` 只挂在 **prune / fragment 迁移 / self-heal** 三条路径上。**未超预算 ⇒ 不写 ⇒ 迁移永不发生**：观察留在 knowledge.md、JSON 不生成，每次加载仍走有歧义的 markdown 解析。H13/H17/H18/H22 所修的一整族问题的**防护对这 81 个 Agent 从未生效**。

### 22.3 设计
`hadLegacyObservationRegion()`（存在性判断）→ 只要退役区域还在，加载即 `saveToDisk()`（唯一规范写入器：写 JSON + 剥离旧区域）。**一个"只有你出事时才运行"的迁移不是迁移。**

### 22.4 验证
- 用例：旧格式小文件（payload 远未超限）首载后 `knowledge.md='# Knowledge\n\n## a\nsmall\n'`、`observations.json=['o1']`、再加载字节不变（幂等）。
- 顺带修正 4 个原先**断言旧行为**的用例（它们此前"通过"只是因为保存恰好没发生，断言的是已退役的位置）。

---

## 23. H27 —— 残留修复写回退役容器（同一事实两个写者）

### 23.1 现象（探针实测）
对"归档可唯一匹配"的旧数据，加载后出现**两个容器**：`knowledge.md` 里退役的 `## _observations` 区域**复活**（含已修复正文），同时 `observations.json` 里仍是**未修复的存根**；`getEntries()` 返回修复后的内容。

### 23.2 根因
`repairStubResidue()` 的落盘是
`writeFileAtomic(knowledge.md, curated + serializeObservationBuffer(entries))`
—— 即用**已退役的带内容器**重写知识文件。两个后果：
1. 复活了 H24/H26 刚刚剥离的区域（同一事实两份副本）；
2. **从不更新 `observations.json`** ⇒ 下次加载 JSON（仍是存根）胜出，**修复被静默丢弃**。

与 H4（同一指针两个写者）、H12（同一预算两种度量）同族：**同一状态出现第二个写者**。

### 23.3 设计
只经**规范写入器**落盘：`entriesChanged → saveToDisk()`（→ `observations.json` + curated）；`curatedChanged → 只写 curated`（curated 仍是 markdown，是注入区）。`serializeObservationBuffer` 自此**无生产调用者**，标注为 LEGACY（仅迁移读取与测试夹具），与 `parseObservationsFromMemoryMd` 一同删除。

### 23.4 验证
- 探针三态（唯一匹配 / 歧义 / 无归档）复跑：三种情形**一致**——只剩一个容器、修复结果落在 JSON、不再复活退役区域。
- `memory-h13-repair` 12/12；记忆相关 21 文件 **172/172**。
- 全量 `--project node`：**5245 通过 / 10 skipped / 1 失败**（唯一失败为既有环境性 flaky `cli/commands-start-integration` quickInit 60s 超时，真启 server + 联网，与本次无关；`git diff` 未触及 `packages/cli`）。`tsc -b` 全仓 0 错误。

### 23.5 方法论备注（本轮最值钱的一条）
H27 **不是**靠读代码或想出来的，是靠**探针实测**：把三种真实形态喂进真实代码、打印全部相关文件后，才看见"knowledge.md 与 observations.json 各持一份、且互相覆盖"。上一轮 H22 也是同法发现。**单测会自欺（夹具不代表真实形态）；真实数据探针不会。**

---

# 24. 停止打补丁：记忆子系统的第一性原理重构（Owner 指令：按下葫芦浮起瓢）

## 24.1 先把话说清楚：不是"bug 多"，是同一个根因换了四次外衣

把本轮全部事件按**根因**（而不是按症状）归类：

| 根因 | 命中事件 | 我的历次"修复" |
|---|---|---|
| **R1 一个事实，多个写者** | H4（流指针）、H12（预算度量）、H27（修复写回退役容器）| 加守卫 / 加对账 / 换落盘点 |
| **R2 一个不变量，多个（且都有条件的）执行点** | H12、H14、H25、H26 | 换度量 / 补路径 |
| **R3 结构从载荷推断（带内容器）** | H13、H17、H18、H22、H23 | 加固 5 次：清洗 → 收紧边界 → 锚定 meta → 转义 → 换 JSON |
| **R4 平台替 Agent 决定内容** | H13、H20、H21、H25、H27 | 加"无损归档 / 一次性修复" |

**R3 的 5 次修复本身就是证据**：一个 bug 能换个记号再犯一次，说明修的不是根因。

## 24.2 元根因：一个文件身兼五职

`knowledge.md` 被同时要求成为：

1. **注入型 prompt 载荷**（curated，每轮进上下文）
2. **人类可读文档**
3. **追加型日志**（observations）
4. **平台分页存储**（会话压缩片段）
5. **四种退役格式的迁移目标**（memories.json / MEMORY.md / state.md / markdown 观察区）

角色之间**互相冲突** ⇒ 每个冲突都被一个启发式"解决" ⇒ 启发式互相碰撞 ⇒ 就是这一串事故。
**R1/R2/R4 都是"多角色硬塞进一个文件"的必然产物。**

代码层面的量化证据：

- `store.ts` **2354 行**（整个记忆子系统 3106 行），其中约 **243 处**命中 legacy/repair/migrate/heal/trim/archive 关键字。
- `knowledge.md` 有 **4 个写者**（`store.ts:936 / 1021 / 1860 / 2161`）+ 自愈路径。
- 为应对格式冲突而生的机制：`residue-repair.ts`(127 行) + escape/anchor/legacy 读写器 + 自愈 + 两处裁剪循环。
- **21 个** `memory-*.test.ts` 文件，其中 **5 个**（entry-boundary / payload-forgery / region-isolation / residue-repair / h13-repair）**只用来自证"带内容器能自洽"**——R3 一旦消失，它们整体失去存在意义。
- 平台**确实在替 Agent 改写内容**：`agent.ts:9465` 注释自述 dream「rewrites knowledge.md directly」，`pruneMemoryMd()` 用标题/子集启发式删改 curated 段落。

## 24.3 目标设计（按"谁拥有 / 干什么用"切分，而不是按"存哪儿"）

| 存储 | 拥有者 | 用途 | 形态 | 注入? | 唯一写者 |
|---|---|---|---|---|---|
| `knowledge.md` | **Agent** | 持久知识 | markdown 段落 | **是**（唯一有上下文预算的） | `memory_update` / 删除原语 |
| `observations.json` | **Agent** | 草稿日志，仅检索 | 记录（JSON） | 否 | `memory_save`（追加） |
| sessions / 压缩 | **平台** | 会话分页 | 记录 | 否 | 平台 |

**不变式（让 R1–R4 在结构上无法表达）**

- **I1 一个存储一个写者**：任何代码路径都不得自行构造某存储的字节；序列化器不再对外暴露（`serializeObservationBuffer` 等移出公共面）。
- **I2 一个预算一种度量**：上限与其度量口径同处一个函数，写者与上报共用；**度量必须与容器无关**（量 payload，不量容器语法）。
- **I3 平台永不自动改写 Agent 内容**：越界 → **拒绝 + 可行动的提示**（Agent 自己决定），不静默搬运、不静默压缩、不启发式修复。唯一的例外是"平台自己拥有的数据"（会话分页）。
- **I4 结构永不从载荷推断**：机器记录不从散文里解析。唯一读散文的地方是**一次性迁移**，跑完即封存。

**决定（删除清单）**

| 删除 | 理由 |
|---|---|
| 观察缓冲的**驱逐/裁剪/归档**（`trimObservationBufferToCap`、`observations-archive.json` 的写入） | R2+R4。改为：软线 30k **只报告**；硬线（病态上限）**拒绝写入**。历史归档在迁移时**并回主池**（无损） |
| `residue-repair.ts` + `repairStubResidue()`（**从每次启动的热路径摘除**） | R4。它是给已删除的 `compressLongTermMemory` 擦屁股；改由一次性迁移调用一次，跑完即删 |
| `pruneMemoryMd()`（标题/子集启发式删改 curated） | R3+R4。平台不该用启发式编辑 Agent 的散文 |
| 自愈（`shouldSelfHeal` 重写） | R4。其成因（嵌套 meta 序列化炸弹）已随旧写者消失 |
| 每次加载读散文 / 修复 / 重写 | R3+R4。改为 **marker 门控的一次性迁移**：跑过一次后，装载路径 = 纯 JSON，不解析散文、不修复、不重写 |

**保留**：dream 的 **LLM 整理**（那是 Agent 用自己的模型整理自己的记忆，且经存储 API 落盘 ⇒ 仍是单一写者）；`memory_organize` / `memory_update` / `memory_stats`；一次性迁移读取器（带删除判据）。

## 24.4 施工顺序（先文档 → 再测试 → 再重构 → 验证）
1. 本节（说明 + 删除清单 + 不变式）。
2. 先加**不变式测试**（I1 单写者、I2 单度量、I3 越界拒绝而不搬运、I4 装载路径不解析散文）。
3. 重构：门控一次性迁移；摘除 eviction / residue-repair / self-heal / pruneMemoryMd；收敛写者。
4. 验证：定向 → 记忆全量 → 全仓 `--project node` + `tsc -b`；真实数据沙盒复跑。
5. 删除判据（写明）：所有 `agents/*/` 出现迁移 marker 且无旧格式残留后，整体删除迁移读取器 + `residue-repair.ts`。

## 24.5 实施记录（本轮落地）

**常量（shared/limits.ts）**
- `MEMORY_OBSERVATIONS_MAX_CHARS`（30 000）语义改为 **ADVISORY（只报告）**；
- 新增 `MEMORY_OBSERVATIONS_HARD_MAX_CHARS`（200 000）= **唯一拒绝写入点**。

**store.ts**
- 新增 `migrationMarkerPath()`（`.memory-v2-migrated`）；`repairStubResidue()` 改为 **marker 门控、每个 Agent 只跑一次** —— 热路径不再有"永久启发式改写"（H27 的成因）。
- **删除** `trimObservationBufferToCap()` 与 `saveToDisk()` 里的调用：不再驱逐、不再写 `observations-archive.json`。`enforceMemoryBudgets()` 对观察缓冲**只报告**。
- `addEntry()` 返回 `{ ok, reason }`：越过硬线 **拒绝**并给出可行动理由（`memory_organize` / `memory_update mode:"delete"`），**一条既有内容都不动**。
- **删除** 装载期自愈分支（`shouldSelfHeal()` 调用点）—— 装载的职责是"读"。
- `sanitizeSectionBody()` 承担**写入口单点清洗**：剔除 `<think>` 泄漏块（含未闭合）+ 正文内 `## ` 降级为 `### `。取代原来挂在 `pruneMemoryMd` 里的装载期全文件扫描。

**agent.ts**
- **删除** `pruneMemoryMd()`（约 115 行）及 dream 里的调用：它用标题相等/正文子集的启发式**删改 Agent 的 curated 散文**（含移除 `## daily-report-*`、同名段去重）—— 典型的 R4。
- dream 的 LLM 整理**保留**：那是 Agent 用自己的模型整理自己的记忆，且经存储 API 落盘 ⇒ 仍是单一写者。

**tools/memory.ts** — `memory_save` 透出拒绝裁决；对返回 void 的旧/mock 实现保持兼容（只在显式 `ok:false` 时拦截）。

## 24.6 验证（实测）
- 新增 `packages/core/test/memory-invariants.test.ts`（§24 不变式：越软线不搬运、越硬线拒绝且内容不动、装载不改写内容、`<think>` 只在写入口被剔除、上报口径 = payload）。
- 按新契约修正 **8 处**断言旧行为的用例（H2 收敛/H12 归档/H13 去重/memory-health/agent 覆盖等）——其中多数此前"通过"只是因为恰好没有触发保存。
- 记忆相关 **23 文件 194 用例全绿**；`tsc -b` 全仓 **0 错误**；全仓 `--project node` **5250 通过 / 10 skipped / 1 失败**（唯一失败为既有环境性 flaky `cli/commands-start-integration` quickInit 60s 超时：真启 server + 联网，与本次无关）。

## 24.7 本轮**未做**（如实列出，不是遗漏）
- **I1 的最后一环**：`knowledge.md` 仍有两个调用者按"读旧文本→改一处→整写"模式落盘（`addLongTermMemory` / `removeLongTermSection`），与 `writeCuratedKnowledgeMd()` 共存。要收敛成**唯一一个** `writeKnowledge(curatedText)`，需要把这三处合并——涉及 `write-guard` 与并发锁语义，单独一轮做，避免在收尾阶段引入新的交错风险。
- **`shouldSelfHeal()` 方法本体**：调用点已删（不再执行），方法体留待随迁移器一并删除。
- **一次性迁移的收尾**：`parseObservationsFromMemoryMd` / `parseEntryBlocks` / `escapeEntryBodyLine` / `decodeEntryBodyLine` / `serializeObservationBuffer` / `residue-repair.ts` 仍在（81 个 Agent 尚未迁移）。判据：`agents/*/.memory-v2-migrated` 全部出现且无旧格式残留 ⇒ 整体删除。
- **`observations-archive.json` 的读取**：仍在 `search()` 里（历史条目继续可检索），但**永不写入**。属于只读历史产物，随迁移器一并退役。

## 25. I1 收口 —— `knowledge.md` 收敛到**唯一写入者**（Owner 亲测后收尾）

### 25.1 现象与判定
§24 落地后 Owner 编译重启，实测确认：迁移已在 **84/94** 个 Agent 上执行（`session-fragments.md` 全组织归零、`knowledge.md` 只剩 curated、JSON 可解析 0 异常、0 个 Agent 超任何预算）。唯一未收口的是 §24.7 自认的最后一环 —— `knowledge.md` 仍有**多个物理写入点**。

### 25.2 根因：旧实现本身就是**不一致**的（R2）
同一份文件，两条路径行为相反：

| 路径 | 对 in-band `## _observations` 区 | 触发时机 |
|---|---|---|
| `addLongTermMemory` / `removeLongTermSection` | **保留**（把新段落插到它之前） | agent 调 memory 工具 |
| `writeCuratedKnowledgeMd`（经 `saveToDisk`） | **剥离** | 任何观察写入 |

⇒ **文件内容取决于"最后跑的是哪条路径"**。这正是 R2（同一不变量、多个各有条件的执行点）的又一实例，与 H12（两种度量）、H27（两个写者）同族。

### 25.3 修法（结构，非补丁）
引入**唯一物理写入者** `private writeKnowledgeMd(text)`：它对传入文本执行 `splitKnowledgeSections(...).curated`，即**强制"仅 curated"契约**（H24）。四处调用点全部改走它：

| 调用点 | 之前 | 现在 |
|---|---|---|
| `addLongTermMemory` | 直写 `updated`（可能含观察区） | `writeKnowledgeMd(updated)` |
| `removeLongTermSection` | 直写 `updated` | `writeKnowledgeMd(updated)` |
| `repairStubResidue`（一次性迁移） | 直写 curated | `writeKnowledgeMd(curated)` |
| `writeCuratedKnowledgeMd`（经 `saveToDisk`） | 自行 cut + 直写 | `writeKnowledgeMd(existing)` |

结果：`grep "writeFileAtomic(this.longTermFile"` **只剩 1 处**（在 `writeKnowledgeMd` 内）。文件级"一个事实一个写者"成为**结构事实**，R1 对注入区不再可表达。文件创建（`ensureKnowledgeFile`，仅在文件缺失时）与之区分：那是 bootstrap，不是内容写者。

### 25.4 一处需要**说明**的测试变更（不是"改测试让它过"）
`memory-curated-budget.test.ts` 原有一例「以上任何路径下，观察区逐字节不变」开始失败。逐一核实后判定：**它钉住的是 25.2 的旧不一致行为**，且夹具形态**在迁移后不可达**（它在构造 store **之后**从外部把观察区追加进文件；迁移后没有任何路径会这样写）。数据安全本身**并未失效**：「加载期把 in-band 观察区无损迁到 `observations.json`」由 `memory-migration.test.ts` 独立覆盖（该例断言旧观察正文出现在 JSON 中、且不再出现在 knowledge.md）。

因此按 H24 契约改写该例为：**任何 curated 写入路径都只产出 curated —— 文件里绝不出现观察区**。这是把测试对齐到架构，不是放宽断言。

### 25.5 验证（实测，绝不碰线上文件）
- **真实数据副本探测**（`MemoryStore` 真跑，取本人 + 一个休眠 legacy Agent 的副本）：
  - `[cto]`：`legacy_before=false`，obs `28→28`；`add/remove` 均成功；**写后无观察区泄漏**；`obs_intact=true`；二次加载**幂等**。
  - `[dormant-legacy]`（仍带旧观察区）：`legacy_before=true`，obs `0→14` —— 正是加载期**无损**把旧区搬进 JSON；写后 `curated_only=true`、无泄漏、幂等。
- 恶意载荷（正文含 `## fake` / `### also fake` / `$&`）经 `addLongTermMemory` 写入：无结构伪造、无 `$&` 展开。
- **全组织量化**：104 个 Agent，obs payload > 30k = **0**、> 200k（硬线）= **0**；curated > 15k = **0**；JSON 不可解析 = **0**；`.corrupt-*` = **0**。
- `tsc -b` 全仓 **0 错误**；`--project node` 全量 **5250 通过 / 10 skipped / 1 失败**（唯一失败仍为既有环境性 flaky `cli/commands-start-integration` quickInit 超时，未触及 `packages/cli`）。

### 25.6 仍如实保留的残余（不藏）
- **10 个休眠 Agent 未迁移**：`knowledge.md` mtime 停在 8–9 月、从未在本轮重启后被加载 —— 属**懒迁移**设计（首次加载即迁移），非缺陷；7 个带观察区的正在这 10 个内。判据同 §24.7。
- **5 处存根串残留在 migrated JSON 载荷内**（本人 4 处 + `agt_f15a…` 1 处）：正文在 `knowledge-archive.md` 可检索、且**不在注入区**（在观察/片段池）。属历史载荷形态，不重写平台载荷（改写对话记录 = 伪造）。
- **`shouldSelfHeal()` 方法体**与迁移读取器（`parseObservationsFromMemoryMd` 等）：随 §24.7 判据（全 Agent 迁移完成）一并删除。


---

## §26 模板/静态资源拷贝：合并 vs 镜像（R2 的又一实例）

### 26.1 现象（新装用户相关）

对"全新下载安装的用户，Agent 能否正常工作"做验证时发现：**CLI 分发包里的模板树陈旧**——`packages/cli/templates/` 相对源树多出 8 个**在源头已删除、却永远残留**的条目：

```
roles/SHARED.md
skills/image-generation
skills/markus-agent-cli
skills/markus-cli
skills/markus-project-cli
skills/markus-skill-cli
skills/markus-team-cli
skills/self-evolution      ← 文档明令"不得随包发布"的退役技能
```

其中 `roles/*/agent.json` 还在声明 `dependencies.skills: ["self-evolution"]`（源树已改为 `["coding-tools"]`）。后果：CLI 安装的用户从模板建 Agent 时，会**声明一个已退役的技能**，并触发 H9 新加的 ⚠️ 缺失技能告警；退役技能包本身也**还在发**。

### 26.2 根因：**不是"两棵树"，是"两种拷贝方式"**

侦察纠正了两个错误假设：

| 假设 | 实际 |
|---|---|
| `packages/cli/templates/` 是另一棵**源**树 | ❌ 它是 **gitignored 构建产物**（`.gitignore:21`），**未被 git 跟踪** |
| CLI 构建用的是别的源 | ❌ CLI `build.mjs:55` **本来就从根 `templates/` 拷贝** |

**单一源的设计早就存在。** 缺陷在拷贝语义：

| 构建 | 拷贝方式 | 结果 |
|---|---|---|
| `packages/desktop/build.mjs:114` | `rmSync(dest)` → `mkdirSync` → `cpSync` | ✅ **镜像**（注释明写"先清再拷，否则删掉的模板会永远留在包里"）|
| `packages/cli/build.mjs:60` | `mkdirSync` → `cpSync` | ❌ **合并**：源里删掉的文件在目标里**永存** |

CLI 的 **web-ui 拷贝**（`build.mjs:69`）同样用合并。**同一件事、两种实现、一种是对的** —— 与 §24（多写者）、§18/§21（多度量）同族：R2。

### 26.3 修法（结构，非补丁）

抽出**唯一实现** `scripts/sync-dir.mjs`：

```js
export function syncDir(src, dest) {   // 真镜像：先清，再拷
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
```

两个 `build.mjs` 的 **templates 与 web-ui** 四处拷贝全部改走它（desktop 那两处本就是镜像语义，改走它只是**消除重复实现**，行为不变）。此后"合并拷贝"不再有第二条产生路径。

### 26.4 测试（先红后绿的证据）

新增 `packages/core/test/templates-sync-mirror.test.ts`：

1. **镜像语义**：目标目录预置陈旧文件 + 陈旧子目录 → `syncDir` 后**必须消失**，源内容必须在；
2. **目标缺失时创建**；
3. **幂等**：连跑两次结果一致；
4. **结构闸门**：两个 `build.mjs` 都必须**调用 `syncDir(`**，且**不得**再出现 `cpSync(templatesRoot…` 这种裸合并——把"只能有一种拷贝方式"钉成断言。

**红→绿**：先写测试（`syncDir` 尚不存在 → import 失败 = 红），再建 helper（绿）。

### 26.5 验证

- **红→绿**：测试先写（`syncDir` 不存在 → `Cannot find module` = 红），建 helper 后 **6/6 绿**（3 例镜像语义 + 3 例结构闸门）。
- **实测镜像**（真实产物）：`syncDir(templates → packages/cli/templates)` 后，「只在产物里存在」的条目 **8 → 0**；`skills/self-evolution` 等退役包消失；`markus-admin-cli` 保留（源树本就有，属现役）。
- `tsc -b` 全仓 **0 错误**；`--project node` **5256 通过 / 10 skipped / 1 失败**（唯一失败为既有环境性 flaky `cli/…quickInit` 真启服务+联网超时，未触及 `packages/cli` 源码）；`--project web-ui` **678/678**。
- 两个 `build.mjs` 均 `node --check` 通过；未用 import 已清理（CLI 移除整个 `node:fs`，desktop 移除 `rmSync`）。

### 26.6 与 H9 的关系（诚实更正）

H9 说"清理了 41 处死技能引用"——那清的是**存量 Agent 定义（`data.db`）**，属**症状层**。**源头（构建产物 + 模板）仍在生成同样的死引用**。§26 修的是源头，两者互补：

- H9 → 存量 Agent 不再告警；
- §26 → 新装/新建成 Agent 不再被注入死引用，退役技能不再随包发布。

