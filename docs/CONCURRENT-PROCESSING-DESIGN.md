# Agent 并发处理设计（CONCURRENT PROCESSING DESIGN）

> 作者：CTO · 日期：2026-09-04 · 状态：**已实现（implemented）**
> 实现说明见 [`CONCURRENT-PROCESSING.md`](./CONCURRENT-PROCESSING.md)（AS-BUILT，权威口径）。
> 本文为**原始设计备忘录**，保留用于记录设计动机、备选方案与阶段规划；与实现不一致处，以 AS-BUILT 文档与代码为准（对照见文末 §11）。
> 范围：让单个 Agent 能**同时处理多个 mailbox 消息 / 多个 Session**，通过「智能体设置」开关（默认开）。
> 核心挑战：在把「一次一件事」的严格单飞，升级为「受控并发」的同时，**保住事实认知的一致性**，不让任务 A 与任务 B 的认知互相污染、前后矛盾或重复动作。

---

## 1. 背景与目标

### 1.1 现状
Markus 把 Agent 建模为**单线程认知实体**（`docs/MAILBOX-SYSTEM.md` §1）：一个 Agent 同一时刻只处理一个 mailbox item，其余消息排队或被合并/批量处理。这是**刻意设计**，不是疏漏。

### 1.2 目标
提供一个可配置的**并发模式**：开启后，单个 Agent 可同时处理多个任务 / 多个 Session（mailbox 消息由多个并行的处理协程消费）。设置位于「设置页面 → 智能体设置」，**默认开启**。

### 1.3 必须解决的历史问题（老板原话转述）
之前强制串行，是为了避免 Agent 在同时处理多件事时，对**事实的理解出现偏差和歧义**（任务 A 认知到的事实 vs 任务 B 认知到的事实可能冲突）。真要做并发，必须让 Agent ：
- **知道当前自己在并发处理**（自己是众多分身之一）；
- 结束时**知道其他 Session 是否也在处理相关的事**；
- 能**理解其他已完成 Session 的过程**，避免**前后矛盾 / 重复动作**。

这要靠 **提示词工程 + 上下文工程 + 代码** 整体协同解决。

---

## 2. 现状：单飞约束的完整模型（并发改造的落点）

「一个 Agent 一次只处理一件事」是**分层**实现的。理解每一层，才知道并改哪里。以下是代码实证（`packages/core/src`）。

### 2.1 外层——唯一注意循环（attention.ts）
`AttentionController.runLoop`（`attention.ts` L343-542）是一个**单协程 `while` 循环**：`dequeueAsync()` 一次出一个 item → `processFocusedItem()`（L550-738，完整状态机：超时取消、cancelled/preempted 判定、异常完成检测、批处理收尾）→ 回循环取下一个。

```
while (running) {
  item = await mailbox.dequeueAsync();      // 一次一个
  await processFocusedItem(item);           // 串行处理完
}
```

### 2.2 中层——任务数上限（agent.ts）
- `MAX_CONCURRENT_TASKS = 1`（L462 默认）+ `config.profile.maxConcurrentTasks` 可覆盖。
- `_executeTaskInternal` 入口闸：`activeTasks.size >= maxConcurrentTasks` 直接 throw（L4980-4988）。
- `executeTaskConcurrent` 走 `TaskExecutor`（`./concurrent/`），它是**已有的任务级并发基础设施**，默认上限 1。

### 2.3 内层——单值字段集合（agent.ts，真正的「会话级状态」）
这些是实例级单值，任何一个并发 worker 共享都会交错：

| 字段 | 含义 |
|---|---|
| `currentSessionId`（L366） | 全局唯一「主会话」指针，`handleMessage`/`startNewSession`/`restoreSessionFromHistory` 覆盖它 |
| `processingMailboxItemId`（L419） | 当前处理的 item（单值） |
| `currentActivity`（L3292/3366） | 单活动槽（chat/task/heartbeat…） |
| `activeStreamToken`（L415） | 单流 token |
| `currentTaskId`（L334） | 单值当前任务 |
| `currentInteractingUserId`（L367） | 单值交互用户 |
| `pendingInjections`（L414） | 注入消息缓冲（按 item drain） |
| `interruptSignal / pendingInterruptItem / lastYieldDecision`（attention） | 中断信号，单值 |

### 2.4 状态机（AgentStatus）
`idle / working / offline / error`（`shared/types/agent.ts`）。`isProcessing()` = `status==='working' || !!processingMailboxItemId`。

### 2.5 硬约束注释
`agent.ts` L3519-3524（`handleMessage`）：
> INVARIANT: This method must only be called through processMailboxItem() ... Direct concurrent calls would corrupt session state and interleave tool execution.

---

## 3. 关键判断：并发改造的障碍在「认知一致性」与「共享写入」，不在基础设施

对现有代码的三个乐观信号（决定可行的原因）：

1. **mailbox 天然支持多消费者**：`dequeue()` 用 `queue.shift()` 取 head 并标记 `processing`（`mailbox.ts` L405-413）——多个 worker 各自调用会取到**不同的 item**，不重复。唯一要改：`dequeueAsync` 的 `idleResolve` 目前是**单值 promise**（一次只唤醒一个等待者），多 worker 需改成**广播唤醒**。①

2. **会话身份本来就独立**：每个 mailbox item 已拿到独立 session id（`sys_` / `task_<id>_r<round>` / `hb_*` / `channel_*` / `a2a_*` / `requirement_*`，见 subagent 分析）——只有「主对话」`human_chat` 复用单值 `currentSessionId`。会话上下文天然隔离，**只需把会话状态从实例级下放到 per-worker**。②

3. **提示词有现成注入点**：`context-engine.ts buildSystemPrompt`（L228）按 stable / semiStable / dynamic 三段组装（如 L328-540 stable、L580-740 semiStable/dynamic）。新增「并发上下文段」在这里加一块即可，不破坏现有结构。③

真正的障碍是两件事，对应老板的担忧：
- **A. 共享可变状态的交错**：`currentSessionId` 等单值字段是实例级的，两个并发 LLM 循环都写 `this.xxx` → 互相污染。→ 需**状态下放到 per-worker**。
- **B. 事实认知的冲突**：memory / knowledge / 文件 / task 状态的并发写入可能覆盖、矛盾、重复。→ 需**写入仲裁 + 并发感知提示词 + 调度错开**。

---

## 4. 并发设计总览：Attention Worker Pool（注意力工作池）

**核心模型**：把「一个单飞的注意循环」升级为「N 个并发 worker 协程」，共享同一个 mailbox 与 AgentManager，但**每个 worker 持有独立的会话状态**。

```
                    ┌─────────────────────────────────────────┐
 AgentMailbox ────► │      AttentionWorkerPool (N 个 worker)   │
 (priority queue)   │                                           │
                    │   worker 1 ── dequeueAsync() ──> item A   │  ← 独占会话状态A
                    │   worker 2 ── dequeueAsync() ──> item B   │  ← 独占会话状态B
                    │   worker 3 ── dequeueAsync() ──> item C   │  ← 独占会话状态C
                    └───────────────┬──────────────────────────┘
                                    │ 每个 worker 内部仍是一个单飞循环
                                    │ （processFocusedItem 原样，状态隔离后）
                                    ▼
                     SharedStateCoordinator (共享写入仲裁)
                                    │
                    ┌───────────────┼───────────────┐
                 memory/knowledge  task/task_exec   文件/工作区
```

- **worker = 1 时 = 现状**：整个现有单飞行为 100% 保留（兼容性底线，详见 §8）。
- **worker = N 时**：N 个协程从 mailbox 并发出队，各处理各的 item。

---

## 5. 分层设计（代码 / 上下文 / 提示词 / 调度 四层协同）

### 5.1 L1 代码层：状态隔离 + 共享写入仲裁

**5.1.1 会话状态下放 per-worker（`SessionWorkspace`）**

把 §2.3 的全部单值字段从 Agent 实例级**迁移**为一个可挂载/卸载的 `SessionWorkspace` 对象，每个 worker 持有一份：

```ts
interface SessionWorkspace {
  sessionId?: string;              // 原 currentSessionId
  scenario?: string;               // 原 activeScenario
  activity?: AgentActivity;        // 原 state.currentActivity
  streamToken?: AbortController;   // 原 activeStreamToken
  pendingInjections?: Map<...>;    // 原 pendingInjections
  currentTaskId?: string;          // 原 currentTaskId
  currentUserId?: string;          // 原 currentInteractingUserId
  workerId: number;                // 分身编号
}
```

- worker 启动时 `attachWorkspace(w)`，结束恢复共享默认（`detachWorkspace`）。
- **关键**：`handleMessage` / `handleMessageStream` / `executeTask` / `respondInSession` 内部所有 `this.currentSessionId` / `this.state.currentActivity` 引用改为走 `this.workspace`。这是最大的重构面（agent.ts ~20 个引用点），但**语义不变**——对 worker=1 没有任何行为差异。
- `AgentState.status` 汇总：任一 worker working → `'working'`；全部 idle → `'idle'`。`currentActivity` 槽位化（活动记录本身按 worker 各建各的，DB 不冲突）。
- 中断信号（`interruptSignal` / `pendingInterruptItem` / `lastYieldDecision` / `criticalInterruptResolve`）**per-worker 独立**——worker A 处理时来新消息，只打断 worker A（可选），不打断 worker B。

**5.1.2 mailbox 多消费者改造**

- `dequeueAsync` 的 `idleResolve` 单值 → **广播唤醒**（`Set<resolve>`，enqueue 时全部唤醒，各 worker 再各自 `dequeue()`，靠 `shift()` 天然互斥）。
- 新增 **实体锁（entity lock）**：`dequeue()` 前检查 head item 的「实体键」（taskId / requirementId / conversationId / 用户id）是否已被其他 worker 持有；若已持有，**跳到下一个可解锁的 item**，避免同一实体的两个 item 被并发处理（见 §5.4）。
- 现有 `consolidateByEntity`（同实体合并）在并发下更有价值：能合的先合，减少跨 worker 共享同一实体的概率。

**5.1.3 共享写入仲裁（`SharedStateCoordinator`）**

并发下最重要的一段代码。所有「全局事实」的写入集中收口：

| 写入对象 | 仲裁策略 |
|---|---|
| `memory_save` / `knowledge.md` / 长时记忆 | **读-改-写 + 版本号**：写前读取当前值，追加/合并后在版本上递增（类似 `memory_update` 的 patch 语义）。禁止「整文件覆盖」跨界写 |
| `deliverable_create` / `task_update` / `requirement` 状态 | 这些工具本身由 FSM 驱动（幂等 + 状态机），加 **per-entity mutex**（同一实体串行，不同实体并发）即可 |
| 文件系统（workspace 文件） | worker 写**自己的工作区子目录**；共享文件用文件锁（复用 `auth-profiles.ts` 的 rename 文件锁模式）或写临时文件 + 原子 rename |
| `agent_send_message`（A2A） | 天然异步，无需仲裁；但**同一 conversation 的回复**应串行（per-conversation 锁） |
| task 执行（`executeTask` / `_executeTaskInternal`） | 仍由 `activeTasks` / `maxConcurrentTasks` 闸控制——**同一任务永不并发**（这也是调度层的底线） |

**5.1.4 并发交接记录（`ConcurrentHandoffLog`）——代码层的新基础设施**

这是老板「结束时应该知道其他 session 是否在处理相关的事、理解其他已完成 session 的过程」的核心落地物。一个轻量、有序、持久化的日志，每个 worker 在**关键节点**写入一行：

```ts
interface ConcurrentHandoff {
  id: string;
  workerId: number;
  ts: string;
  entityKey?: string;              // task/requirement/conversation/用户
  kind: 'declared' | 'fact' | 'done' | 'conflict';
  summary: string;                 // 一句话：我要做什么 / 我发现的事实 / 我做完了 / 我检测到冲突
}
```

- `declared`：worker 开始处理 item 时声明意图（防重复动作）。
- `fact`：worker 在处理中**写下影响全局的事实**（如「已将 X 状态改为 Y」）。
- `done`：worker 完成时总结成果与遗留。
- `conflict`：worker 发现自己将与已完成/进行中的工作冲突时记录。
- 该日志**注入到所有 worker 的上下文**（见 L2），成本可控（每 worker 只读最近 N 条）。

---

### 5.2 L2 上下文工程层：并发感知上下文

**5.2.1 System Prompt 新增段：`## 并发上下文（Concurrency Context）`**

在 `buildSystemPrompt` 的 semiStable 段（L580-740 区域）追加（**仅当开启并发且 worker > 1 时注入**）：

```
## Concurrency Context（并发上下文）
- 当前 Agent 处于并发模式：本会话是你（worker W_i）处理的多个会话之一，共有 N 个分身。
- 正在进行的其他会话：
  - worker 2 → 任务 tsk_xxx（TWS 回测），最近事实：「...」
  - worker 3 → 与用户对话，最近事实：「...」
- 最近完成的会话（交接记录）：
  - worker 1 → 完成 tsk_yyy，结论：「...」，产物：dlv_...
- 一致性规则：
  1. 你并不独占认知。做任何持久化决策前，先查共享知识 + 交接记录，避免与已完成/进行中的工作矛盾或重复。
  2. 同一任务/需求/对话串同时只能有一个分身处理——发现实体已被占用，不要强行开做，如实说明。
  3. 发现事实冲突时（你的认知与交接记录矛盾），优先报告差异并请求合并决策，不静默覆盖。
```

**5.2.2 并发快照注入（每轮/每 item 开始）**

- 每个 worker 开始处理 item 时，注入**轻量快照**：`最近 5 条交接记录 + 其他 worker 的 intent（待办声明）+ 各自关联的实体键`。
- **只给概要，不互泄完整会话内容**——保护隐私/上下文预算，同时足够防止方向性矛盾。
- 实现位置：`context-engine.ts` 的 dynamic 段或 `task-context.ts`，在组装 messages 时追加一条 system 消息。

**5.2.3 结束协议（Concurrent Handoff at Completion）**

每个 worker 在 item 处理收尾（`processMailboxItemInternal` finally 处）自动写一条 `done` 交接记录。这样**任何后来的分身都能理解此前发生了什么**——正是老板要求的「理解其他已完成 session 的过程」。

---

### 5.3 L3 提示词工程层：分身认知协议（Prompt Protocol）

不只是把信息塞进上下文，还要**塑造 Agent 的自省行为**：

1. **认知声明**（Self-Awareness）：并发模式下，prompt 明确「你是分身之一，不假设独占事实」。
2. **行动前声明**（Intent Declaration）：跑可能有副作用的工具前（memory_save / task_update / 文件写 / 订阅），先写一条 `declared` 交接记录——其他分身可见 → 天然防重复（类似「先占坑再干活」）。
3. **冲突优先报告**（Conflict-over-Silence）：若快照/交接记录显示冲突，检测到就**停下来说明**，而不是覆盖。给出选项：等待 / 只做不重叠部分 / 放弃交给对方。
4. **完成时沉淀**（Completion Summary）：结束时把「结论 + 产物 + 遗留」写进 `done` 记录，让未来分身可追溯。
5. **batch awareness 复用**：现有「多条消息打包处理」机制（`comment_response` 场景）保留，减少并发窗口。

这五条直接落进 system prompt 的「并发上下文」段 + 相关 scenario 的本地指令（`context-engine.ts` 里各 scenario 已有本地指令注入位）。

---

### 5.4 L4 调度编排层：实体亲和（Entity Affinity / Per-Entity Lock）

**这是解决「认知冲突」的第一道闸，比提示词更硬核。**

原则：**并发只发生在不同实体之间；同一实体永不并发。**

- 实体键：`taskId` / `requirementId` / `conversationId`（用户会话）/ `a2a conversation_id` / 文件路径。
- worker 出队时：检查 head item 的实体锁；已锁 → 找下一个可解锁项（或等锁释放）。
- 效果：两个分身不会同时处理同一个任务（任务执行本来就由 `activeTasks` 闸保证）、不会同时对同一个用户的两条消息做「事实不一致的回复」、不会同时写同一个文件。
- **事实冲突被结构性降维**：同一实体的认知天然串行——「任务 A 认知 vs 任务 B 认知冲突」变成「不同实体的认知互相独立，全局事实通过交接记录 + 写入仲裁协同」。

---

## 6. 认知一致性问题的完整回答（老板最关心的点）

| 老板的担忧 | 解决方案（按优先级） |
|---|---|
| 两个 Session 认知冲突、前后矛盾 | ① **实体亲和**：同一实体不并发（§5.4）——同实体矛盾从根上消失；② **并发快照 + 交接记录**：跨实体也互相可见关键事实（§5.2）；③ **冲突优先报告**：真冲突时停下说明，不静默覆盖（§5.3） |
| 重复做事（两个分身做同一件事） | ① 实体亲和锁掉同一实体；② `declared` 意图声明占坑；③ 快照注入让分身知道别人正在/已经做 |
| 不知道自己在并发处理 | ① System prompt「并发上下文」段显式声明 worker 编号与并发模式（§5.2.1） |
| 结束时不知道其他 session 在做什么 | ① 完成时写 `done` 交接记录 + 进行中 `fact` 记录；所有 worker 每轮注入最近记录（§5.2.2/5.2.3） |
| 理解其他已完成 session 的过程 | ① `ConcurrentHandoffLog` 持久化、有序、可查；新 worker 启动时注入（§5.1.4） |

一句话总结：**用「实体亲和」从结构上消灭同实体冲突；用「交接记录 + 快照 + 并发感知提示词」让跨实体的协作可见、可溯、可仲裁；用「per-worker 状态隔离 + 共享写入仲裁」保证代码层无交错。** 三层缺一不可。

---

## 7. 设置项设计（智能体设置）

沿用现有智能体设置的完整链路（见 subagent 调查）：
- **前端**：`web-ui/src/pages/Settings.tsx`（execution 区块附近）+ `web-ui/src/api.ts` 的 `api.settings.updateAgent` schema。
- **后端**：`org-manager/src/api-server.ts`（`/api/settings/agent` 读写）+ `saveConfig` → `~/.markus/markus.json` 的 `agent` 段。
- **开关样式**：参照 `cognitive.enabled` 开关（`Settings.tsx` L2160-2165）、`proxyEnabled`（L296）等现成模式。

新字段（写入 markus.json `agent` 段）：

```jsonc
{
  "agent": {
    "maxToolIterations": 200,
    "cognitive": { "enabled": true },
    "concurrent": {
      "enabled": true,          // 并发处理总开关（默认开）
      "maxWorkers": 3,          // 并发上限（1 = 串行，完全等同于今天）
      "conflictPolicy": "auto"  // auto=实体亲和自动错开；report=冲突时停下报告
    }
  }
}
```

UI 呈现（智能体设置 → 新增「并发处理」区块）：
- 开关「允许并发处理」（默认开）。
- 数字输入「最大并发数」1–10，默认 3；注释：1 = 串行（等价现有行为）。
- 下拉「冲突处理策略」：自动错开（默认）/ 冲突时报告。
- 说明文案：并发只作用于**不同**任务/会话之间；同一任务或同一用户对话永不并发，保证认知一致性。

建议：`maxWorkers` 与现有 `profile.maxConcurrentTasks`（任务级并发）**做一致性联动或合并**，避免两个互相矛盾的并发门槛。可在 UI 上只暴露一个「并发数」，同时驱动注意循环 worker 数与任务并发上限。

---

## 8. 实施阶段划分

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **P0 基础** | `SessionWorkspace` 状态下放重构（agent.ts 单值字段 → per-worker），worker=1 行为零回归；mailbox 多消费者广播唤醒 | 现有全部 agent 测试通过（worker=1 等价） |
| **P1 并发循环** | `AttentionWorkerPool`（N worker 启动/停止）；`SharedStateCoordinator`（写入仲裁 + 实体锁） | worker=N 可从 mailbox 并发出队；同实体不错发 |
| **P2 上下文/提示词** | `BuildSystemPrompt`「并发上下文」段 + 快照注入 + `ConcurrentHandoffLog`（declared/fact/done/conflict）；分身认知协议落进 scenario 本地指令 | 并发时 prompt 含并发声明；完成必写 done 记录；冲突可检测 |
| **P3 设置 UI** | Settings.tsx「并发处理」区块 + api schema + api-server + saveConfig | 设置可读写、默认开、worker 数实时生效 |
| **P4 打磨** | 并发一致性测试（同实体锁、fact 交接、冲突报告）、成本限流（worker×token）、mind/注意力展示多 focus、文档 | 测试全绿；UI 展示并发状态 |

**建议落地顺序**：P0 是纯重构（风险可控、可独立合入），P1-P2 是核心并发闭环，P3-P4 收尾。建议 **P0 先行，独立评审**，避免一次大改动难回滚。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **认知一致性**（最核心） | 实体亲和（§5.4）+ 交接记录/快照（§5.2）+ 冲突报告协议（§5.3）三层兜底 |
| **工具副作用重复/交错** | per-worker 状态隔离（§5.1.1）+ 共享写入仲裁（§5.1.3）+ 同一任务永不并发的闸 |
| **token 成本上升**（并发=同时多 LLM） | `maxWorkers` 上限 + 默认 3；可加「并发成本预算」；低价值 item 仍可聚合处理 |
| **回归**（worker>1 破坏现有稳定） | worker=1 必须 100% 等价 → 用 P0 重构保证；默认开但可一键回 1 |
| **同一用户两条消息被两个分身回复，语义矛盾** | 用户会话作为实体键锁死：同一用户的消息串行（§5.4）——并发只出现在不同用户/不同任务之间 |
| **后台任务（heartbeat/梦）与前台对话抢 worker** | 前台 `human_chat` 优先级最高，保留 R0 合并 + 现优先级队列；至少保留 1 个 worker 空闲给用户 |

---

## 10. 结论

现有「一次一件事」是多层刻意设计，但**基础设施已为此备好**（mailbox 多消费者、`./concurrent/` 任务并发、独立 session id、prompt 组装点）。并发改造的核心不是「让两个协程跑起来」，而是**在代码/上下文/提示词/调度四层协同下保住认知一致性**：

- **代码层**：会话状态下放 per-worker + mailbox 广播 + 共享写入仲裁 + 交接记录。
- **上下文层**：并发感知 system prompt 段 + 每轮快照 + 完成交接协议。
- **提示词层**：分身认知协议（先占坑、冲突报告、完成沉淀）。
- **调度层**：实体亲和，让同一实体的认知永不并发。

`maxWorkers=1` 即今天的原样，**默认开启、可一键回退**，做到了「并发而不错乱」。

---

> 附（历史备注）：本文档原为设计草案。方向已获认可，P0–P4 已全部落地，本文档已并入仓库 `docs/` 作为设计备忘录；权威实现口径见 [`CONCURRENT-PROCESSING.md`](./CONCURRENT-PROCESSING.md)。

---

## 11. 落地对照（AS-BUILT 映射）

本节记录设计稿与实际实现的一致性，避免文档与代码再次漂移。**以 AS-BUILT 文档与代码为准。**

| 设计稿条目 | 实现状态 | 落地位置 / 差异 |
|---|---|---|
| §5.1.1 `SessionWorkspace` per-worker 状态隔离 | ✅ 已实现 | `packages/core/src/session-workspace.ts`；`AsyncLocalStorage` 绑定，串行时共享 `rootWorkspace` |
| §5.1.2 mailbox 广播唤醒 | ✅ 已实现 | `mailbox.ts` `idleWaiters: Set`，`wakeIdleLoop()` 全量唤醒 |
| §5.1.2 实体锁 | ✅ 已实现 | `mailbox.ts` `entityKeyOf` / `lockEntity` / `unlockEntity`；`dequeue()` 跳过硬锁项 |
| §5.1.3 `SharedStateCoordinator`（统一写入仲裁） | ⚠️ 部分实现 | **未**建同名协调器。落地为：agent 级工具写互斥 `withToolWriteLock`（`agent.ts`）+ 任务级 `activeTasks` 闸。memory/文件的多步「读-改-写」仍靠交接记录软约束（见 AS-BUILT §7 已知限制） |
| §5.1.4 `ConcurrentHandoffLog` | ✅ 已实现 | `packages/core/src/concurrent-handoff.ts`；四类 kind + JSONL 持久化 |
| §5.2.1 System Prompt「并发上下文」段 | ✅ 已实现 | `context-engine.ts`，仅注入 volatile 段、不破坏 stable 缓存 |
| §5.2.2 并发快照注入 | ✅ 已实现 | `HANDOFF_CONTEXT_LIMIT = 8`，过滤本 worker 自己的记录 |
| §5.2.3 完成时写 `done` | ✅ 已实现 | attention 并发 worker 的 completed / failed 钩子 |
| §5.3 分身认知协议 | ✅ 已实现（提示词层） | 并发上下文段内含一致性规则三项 |
| §5.4 实体亲和（Per-Entity Lock） | ✅ 已实现 | 键：`task:` / `req:` / `conv:` / `user:`。**a2a / heartbeat / group_chat 无键**（已知限制） |
| §7 设置项字段 | ✅ 已实现 | `agent.concurrent.{enabled,maxWorkers,conflictPolicy}`；默认 `enabled: true, maxWorkers: 3` |
| §7 `maxWorkers` 与 `profile.maxConcurrentTasks` 联动合并 | ✅ 已合并 | **单一事实源** = `agent.concurrent.maxWorkers`（设置里的「并发数」）；任务闸 = `min(worker 闸, profile.maxConcurrentTasks 显式上限)`，构造与热更新都走 `Agent.applyConcurrency()` 一处同时驱动两闸（详见 CONCURRENT-PROCESSING.md）。`worker=1 ⇒ 任务必串行` 的串行等价契约由 min 保证。 |
| §8 P0–P4 | ✅ 全部完成 | 见 git 提交序列（P0 状态下放 → P1 worker 池 → P2 上下文/交接 → P3 设置 UI → P4 打磨） |
| §9 风险表 | ✅ 已覆盖 | 认知一致性（实体锁+交接+冲突报告）、成本（maxWorkers 上限）、回归（worker=1 等价契约） |

**实现期新增（设计稿未提）**：

1. **方案 A「并发不打断」**：并发 worker 循环为纯消费者，不跑 triage/deliberation/抢占——抢占与中断保留给串行 `runLoop`，显著降低并发路径复杂度。
2. **方案 B「定向取消」**：`cancelActiveStream({ itemId?, sessionId? })` 经 `findWorkerByItemId/BySessionId` 定位目标 worker，并在其 workspace 内执行取消；前端 stop/retry 统一带 sessionId target。
3. **冲突退避**：`auto` 与 `report` 两种策略都做轻量退避（`250ms × (1 + min(retryCount,8))`），消除双 worker 竞抢同一实体锁时的忙循环。
4. **并发下的活动聚合**：`currentActivity` 下放 workspace 后，实时活动由 `Agent.getLiveActivities()` 聚合展示。

**已知限制**（与 AS-BUILT §7 一致）：实体键未覆盖 a2a/heartbeat/group_chat；backstop 超时取消为 best-effort；缺少「两 worker 并行跑完整会话链路」的端到端并发测试。