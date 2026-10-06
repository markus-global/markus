# 会话状态机重构 — 分析、设计与执行计划

> 状态：**执行中** — P1 ✅ / P2a ✅ / P2b ✅ / P3 ✅ / **P4a ✅ · P4b（前端同步）待做**（老板 2026-10-06：「按序执行，完成后再更新本文档」）
> 创建：2026-10-06 · 分支 `refactor/session-state-machine`（自 PR #359 的 bugfix 分支拉出；PR #359 未动）
> 本文档是本次重构的**唯一执行入口**：每个阶段先在这里更新，再动代码。
> 关联：[STATE-OWNERSHIP.md](./STATE-OWNERSHIP.md) · [STREAMING-AND-REATTACH.md](./STREAMING-AND-REATTACH.md) · [MAILBOX-SYSTEM.md](./MAILBOX-SYSTEM.md) · [MESSAGE-STOP-CANCEL-FIX-PLAN.md](./MESSAGE-STOP-CANCEL-FIX-PLAN.md)

---

## 1. 问题现象（老板 2026-10-06 报告）

| # | 现象 | 影响 |
|---|------|------|
| **A** | agent 流式输出中途因大模型接口不稳定而中断，**这次回复就结束了**；用户看到半截状态，需手动"继续/重试" | human chat（Team Chat）体验很差；task 场景虽有自动重试，但语义与 chat 不一致 |
| **B** | agent 明明还在处理（后端 session 仍在跑），**前端显示已空闲**；反过来也会（前端在转，后端已结束） | 前后端状态不一致，用户误判 |
| **C** | `callback_result`（agent 通过工具发起的异步结果，如 `background_exec`）**没有回到发起它的那个会话**，而是另起会话/落到任意会话 | 上下文断裂、会话碎片（磁盘上实测 200+ 个 `sys_*` 空壳会话） |

**老板给出的目标（本重构的方向）：**
1. **所有 agent loop 都在"会话"里跑，只是在处理不同的 mailbox msg session。** 处理在**消息创建时**就标记"处理中"；只有新的 **`end_turn` 工具调用**（或前端取消）才结束。提示词应写明：**所有结束都以该工具调用收尾**。
2. **每个 session 在后端有一个状态机**，由 `end_turn` 工具或前端取消按钮驱动终结。所有场景（human chat / task / 系统消息 / A2A / channel）统一。
3. **agent 可同时处理多个 session、多 worker**；agent 的"工作中"状态 = **各 session/worker 状态的并集**。每个 session 状态**以后端为真相**，及时向后端同步（重启、手动刷新也一样）。
4. **每个 mailbox 消息绑定一个主体（subject）**；callback result 必须在**创建它的同一 session** 中处理。
5. **task 的自动继续 / 提交 review 机制本次不动**（两者相互配合，单独处理）。
6. **不合理的直接重构，不要到处打补丁** —— 当前补丁过多、代码脆弱、技术债重。

---

## 2. 侦查结论 —— 关键代码事实（非猜测，均带 file:line）

### 2.1 完成协议（end_turn）现状
- `end_turn` 已是**类型化**工具：定义在 `tool-selector.ts:394-407`，受保护不被预算驱逐 `capability-packs.ts:41-54`。
- 消费点：`agent.ts:594 endTurnRequested`（易复位）、`agent.ts:604 endTurnCount`（跨 worker 可信计数）；工具处理 `agent.ts:8481-8487`；工具循环守卫 `shouldContinueToolLoop` `agent.ts:336-347`。
- **但 turn 的结束并不由 `end_turn` 唯一决定**：模型正常停下来（provider finish）本身就会结束 turn。`end_turn` 只是"别再继续"的信号。

### 2.2 流中断 → 被当成"正常结束"（问题 A 的直接机制）
- `packages/core/src/llm/provider-helpers.ts:438`（非流式）、`:564`（流式）：`FINISH_REASON_MAP[...] ?? 'end_turn'` —— **未知/缺失 finish_reason 一律降级成 `end_turn`**。
- `provider-helpers.ts:513` `createSSEAccumulator` 默认 `finishReason: 'end_turn'` ⇒ **一个"没有任何 finish_reason 就断掉"的流，静默保持 `end_turn`**（Markus provider 走的正是这个 accumulator）。
- 同类：`anthropic.ts:317/530`、`google.ts:348`、`ollama.ts:208-209` 全是 `?? 'end_turn'`。
- 硬异常（中途 error / 超时无 partial）会 **throw**（`anthropic.ts:321-347`、`openai.ts:405-415`），但**已归属 `end_turn` 的截断不会**。
- **结论**：`end_turn` 是"可信终点"的这一前提，被 `?? 'end_turn'` 破坏了 —— 系统无法区分"模型真的说完了"和"流断了"。

### 2.3 中断后的重试语义按路径分裂
- 传输层重试统一：`withNetworkRetry`（`agent.ts:9070+`，`NETWORK_RETRY_MAX=3`，仅 `isNetworkError`；`agent.ts:629`）。
- **human chat / team chat**：异常完成（空回复）→ **直接 drop，不重试**（`attention.ts:1064-1078`）。
- background/空回复：`MAILBOX_ITEM_MAX_RETRIES = 2`（`limits.ts:126`）。
- task：`TASK_MAX_NO_SUBMIT_RETRIES = 8` + 递增延迟（`limits.ts:178/187`，`task-service.ts`）。
- **结论**：同一个"turn 没完成"，四种处理不一致 —— 这正是"场景不统一"的痛点。

### 2.4 `ensureTurnCompleted` 是 in-band 补丁
- `agent.ts:1743-1766`：turn 未以 `end_turn` 收尾时，向会话 **追加一条 `role:'user'` 的文本**（"You ended your turn without calling the end_turn tool…"），再跑**一次**有界续跑（`maxIter 24`），`max_tokens` 时再追加 `agent.ts:1840-1843`。
- **只对非 human_chat 生效**：`agent.ts:2028` `if (needsTurnCompletion && item.sourceType !== 'human_chat')`。
- 这是 R3/R4 类（用载荷文本表达结构 + 平台替 agent 改对话），且**恰恰缺在 chat 上**。

### 2.5 "处理中"有 4 个互不相干的真相源（问题 B 的核心）
| # | 真相源 | 位置 | 粒度 |
|---|--------|------|------|
| 1 | attention 内存态 | `attention.ts:154-306`（`workerStates`/focus，`aggregateState()`） | per-worker |
| 2 | DB `mailbox_items.status` | `mailbox.ts:138-183`（`claimItem`/`releaseExpiredLeases`/`recoverStaleItems`） | per-item（不绑 session） |
| 3 | 在途流注册表 | `org-manager/src/active-stream-registry.ts`（`ActiveStreamSession.status`） | per-(agent,session) |
| 4 | 前端本地 ref | `useChatStream.ts:139/169`、`ConversationBufferManager.ts:101`、`useChatStore.ts:32` | client-local |
- agent `status` 由 `transitionStatus`（`agent.ts:969-1017`）从 **activeTasks + worker 内存态** 聚合 —— 与 session 无关。
- 后端**没有**"列出该 agent 全部在途 session"的端点；只有 `GET /agents/:id/sessions/:sessionId/stream/status`（**必须先知道 sessionId**）。
- **结论**：没有任何一处能回答"这个 session 现在在不在处理中"，四个源各说各话 → 前后端必然漂移。

### 2.6 会话身份与 mailbox 主体：散落在载荷里
- `MailboxItem` **没有**一等主体字段（`shared/src/types/mailbox.ts:213-239`）。"归属"在消费时从 `payload.taskId`/`metadata.sessionId`/`extra.originSessionId`/`extra.channelKey` **零散重算**（`mailbox.ts:149-187 resolveEntityKeys`）。
- 会话选择是**唯一解析点** `resolveTurnSession`（`agent.ts:1984-1997`），依据 `sessionHint`；`unknown` 时**"保持当前会话"**（`agent.ts:2578`）—— 即"哪个 worker 抢到，就落在它上次碰过的会话"。
- `callback_result`：有 `originSessionId` 时回原会话（`agent.ts:2387-2416`，`deliverCallback` `agent.ts:7255-7299`）；**缺失时降级为 `unknown` → 落任意会话**；`deliveryMode:'mailbox'` 的 callback 变成 `system_event` → 每次新建 `sys_{id}_{ts}`（`agent.ts:2334`），**origin 被丢弃**。
- `entityKeys` 的 `conversation` 键取 `metadata.dbSessionId ?? metadata.sessionId`（`mailbox.ts:173-176`），而 `deliverCallback` 只写 `extra.originSessionId` → **conv 锁永远解析不出** → 退化成 `system:{agentId}` 全 agent 锁。
- **结论**：主体是"推断出来的"而非"声明的"，任何生产者漏字段就静默退化。

### 2.7 并发/worker 模型（已具备的基础设施）
- worker = 拉取式消费者（`attention.ts:788` `concurrentWorkerLoop`），任意空闲 worker `dequeue` 后按 `entityKeys` 上锁（`:813-818`）。
- per-worker 可变状态在 `SessionWorkspace` + `AsyncLocalStorage`（`session-workspace.ts:59-129`）；`currentSessionId`/`activeStreamToken`/`activeScenario` 都挂在 workspace（`agent.ts:473/536`）。
- `STATE-OWNERSHIP.md` 已把"per-worker 状态禁止跨线程读；唯一跨线程桥梁是 `dbSessionMap`"写成契约。
- **结论**：多 worker 的**执行**基础设施是有的；缺的是**以 session 为单位的状态机与聚合视图**。

---

## 3. 根因归类（按性质，不按现象）

依据工程方法论：**同一 bug 换个记号再犯 = 没修到根因**。三个现象归到 3 个结构性根因：

### R1 — 一个事实，多个写者/读者（问题 B 的主因）
"这个 session 在不在处理中"有 **4 个真相源**（§2.5），且彼此无同步。前端只能看 `agent.status`（滞后）+ 本地 ref（猜测）。→ 必然漂移。
**修法**：为该事实建立**唯一真相源**（后端 session 状态机），其余全部降级为它的**投影**。

### R2 — 一个不变量，多个（且有条件的）执行点 / 多种度量（问题 A 的主因）
"turn 是否结束"由**4 种度量**共同决定：模型 finish、`end_turn` 标志、max-iter、in-band nudge；且**按路径分化**（chat 不重试、background 2 次、task 8 次）。同时 `?? 'end_turn'` 让"流断开"与"模型说完了"用了**同一个记号**。
**修法**：收敛为**单一终态判定**——区分「传输结束(clean/fault)」与「语义结束(turn concluded)」，只有**可信的 clean finish**或**显式 `end_turn` 工具**才算 concluded；fault/unknown **一律不算**，session 保持 processing 并续跑（有界）。

### R3 — 结构从载荷推断（问题 C 的主因，也是 A 的隐性根因）
mailbox 主体/会话身份从 `payload.*`/`metadata.*`/`extra.*` 零散推断（§2.6），漏字段即静默退化到 `system:{agentId}` / `unknown`。`finish_reason` 也是"从载荷字段的缺省值推断结构"。
**修法**：主体**声明式**落到 `MailboxItem.subject`（一等、持久化、必填可校验）；finish 分类读**显式**枚举，缺省即 `incomplete`。

### R4 — 平台替 Agent 决定内容（次要）
`ensureTurnCompleted` 追加合成 `role:'user'` 文本、`ensureTurnCompleted` 二次提示。属"平台改写对话"。
**修法**：移除 in-band nudge，改为**结构性循环条件**（session 未终结 → 继续），不再往 prompt 里塞补丁文本。

---

## 4. 目标设计

### 4.1 核心不变量（目标态）

1. **工作单元 = Turn，绑定 = Session。** 每个 turn 恰好属于一个 session；session 用稳定 key 标识：
   - human chat → DB 会话 `cs_*`（映射内存 `sess_*`）
   - task execution → `task_{taskId}_r{round}`
   - A2A → `a2a_{conversationId}`；channel → `channel_{channelKey}`
   - 系统/自主 → **每 agent 稳定的 system session**（不再 `sys_{id}_{ts}` 每次新建）
   - callback → **发起它的 origin session**（§4.4）
2. **Session 状态机（后端，唯一真相源）：**
   ```
        messageCreated(session)            end_turn / clean-finish / cancel
   idle ──────────────────────► processing ──────────────────────────────► idle
                                   │  │
                                   │  └── hard bound exceeded ──► error(可见, 非静默)
                                   └──── user cancel ─────────► cancelled
   ```
   - **进入 processing**：消息**创建（入队）时**即置位（老板明确要求），不依赖 worker 领取。
   - **离开 processing**：仅 `end_turn` 工具调用 / 用户取消 / 硬上界（→ error）。
   - **fault（LLM 报错/断流/未知 finish）不改变状态** —— 保持 processing，同一 turn 续跑。
3. **agent 工作状态 = 所有 session 状态的并集**（任一 processing → agent working）。`transitionStatus` 的启发式聚合退役，改为**从 registry 派生**。
4. **每个 mailbox item 携带 subject**，决定它进哪个 session（§4.4）。
5. **一个 session 同一时刻至多一个 turn**（会话内串行）；**不同 session 可并行**（多 worker 承载）。worker 仍是执行资源池，但"谁在处理哪个 session"是 registry 的事实。

### 4.2 续跑与硬上界（防"永远不停"）
- fault 后**续跑**必须**有界**：每次续跑计入 `turnAttempt`，超过上界 → session 置 `error`（**可见**，不是静默 drop），并通过 SSE 发结构化 `incomplete/error` 事件。
- 续跑的 prompt 续接**复用现有会话历史**（同一 session），不新建会话、不追加 in-band 哨兵文本。
- **不可**出现"因未调用 end_turn 而无限循环"（现有 nudge 只有一次续跑；新结构同样有界，且上界统一配置）。

### 4.3 finish 诚实化（问题 A 的最小充分修复）
- `FINISH_REASON_MAP` 缺省从 `'end_turn'` 改为 **`'incomplete'`**（新增枚举）；只有**真实** `stop`/`tool_use`/`length` 等映射到既有语义。
- `createSSEAccumulator` 默认 `finishReason` 改为 `'incomplete'`；流**无 finish_reason 结束** = `incomplete`，触发续跑而非收尾。
- 处理链把 `incomplete` 视为"turn 未 concluded" → session 不变、循环续跑（§4.2）。
- 清理 `?? 'end_turn'` 全部 fallback（provider-helpers / anthropic / google / ollama / markus-provider）。

> **对老板原话的一处建议性偏差（请确认）**：老板说"所有结束都以 `end_turn` 工具结尾"。若严格要求**每条**普通聊天回复都必须额外产生一次 `end_turn` 工具调用，会带来固定的额外 token/延迟与"模型漏调"风险。**建议**：状态机的终结由**类型化终止事件**驱动，`reason ∈ {ended_turn_tool, clean_finish, cancelled, bound_exceeded}`；其中 `clean_finish` = **可信的** clean finish（真实 finish_reason + 流完整 + 无待执行工具）——它**语义等价于** `end_turn`，但无需模型多写一次工具调用。**关键保障不变：任何 fault/unknown 都不产生 `clean_finish`，绝不终结 session。** 提示词仍把 `end_turn` 作为"显式收尾"来引导。

### 4.4 Mailbox 主体绑定（问题 C）
- `MailboxItem` 增加**一等、持久化**字段：
  ```ts
  subject: { kind: 'conversation' | 'task' | 'requirement' | 'channel' | 'a2a' | 'system';
             id: string; sessionKey?: string }
  ```
  生产者在**创建时**写入（`sendMessage*` / `deliverCallback` / org-manager 各 producer）。
- `resolveEntityKeys`（`mailbox.ts:149-187`）**只**从 `subject` 派生锁键；缺失 subject = **拒绝入队并告警**（不再静默退化到 `system:{agentId}`）。
- `callback_result`：注册时绑定 `originSessionId`；投递时**只**回该 session；origin 缺失 = **显式错误**（拒绝，不"保持当前会话"、不新建 `sys_*`）。
- `system_event`/`daily_report`/`memory_consolidation`：改用**稳定 system session**（每 agent 一个 `sys_{agentId}`，或按主体），消灭 `sys_{id}_{ts}` 碎片。
- 会话选择收敛：`resolveTurnSession` 的 `unknown` 分支从"保持当前会话"改为**从 subject 推导**（有 subject 必有 session；无 subject 是编程错误）。

### 4.5 状态暴露与前端同步（问题 B）
- 后端新增端点：`GET /api/agents/:id/sessions/state` → 返回该 agent **全部** session 的 `{ sessionKey, state, since, itemId?, kind }`；`/mind` 保留为聚合视图。
- 前端：**per-session 状态以该端点为权威**；在 mount / 切会话 / 重连 / 重启 / 轮询（30s）时对齐。agent"工作中"点 = 后端聚合，**不再**由 `chatStore.streamingAgents` 之类本地猜测单独决定（本地流仅作**乐观即时反馈**，可被后端否决 —— 与既有"UI 幽灵态必须能被权威状态否决"一致）。
- SSE：fault 时**不再**发 `done`；改为保持连接 / 发结构化 `incomplete`，让前端显示"仍在处理"，与 session 保持 processing 一致。

### 4.6 与既有契约的关系
- **不改** `STATE-OWNERSHIP.md` 的 per-worker/ALS 规则（新 session registry 是 **agent 级单例**，与 per-worker workspace 正交；session→worker 的绑定显式传参）。
- **不改** task 的自动继续 / 提交 review（老板明确本次不动）；task 的 turn 只在 `executeTask` 边界接入新状态机。

---

## 5. 分阶段重构计划

> 纪律：① 先改文档 → ② 先写测试并**看它红** → ③ 重构 → ④ 全量验证。每阶段一个**可回滚单元**。
> 顺序 = 依赖顺序：状态机是地基（4.1/4.2/4.3）→ 主体绑定（4.4）→ 前端同步（4.5）。

| 阶段 | 内容 | 关键产物 | 回滚单元 |
|------|------|----------|----------|
| **P1** ✅ | **SessionStateRegistry（后端唯一真相源）**：`packages/core/src/session-state.ts`——`Map<sessionKey, {state, processingSince, itemIds}>` + `begin/settle/getSession/anyProcessing/list`；agent `status` 改为从它派生（并集）；持久化 + 启动恢复（对齐 `STATE-OWNERSHIP.md`） | 状态机模块 + 单测（先红）+ `transitionStatus` 派生改造 | 1 提交 |
| **P2a** ✅ | **统一 turn 终止（第一步）**：finish 诚实化（§4.3，`incomplete` 枚举）、`incomplete` 视为**未终结**（同一会话有界续跑）、对 chat 生效；task 循环显式 opt-out（老板约束） | provider 分类修复 + agent loop 收敛 + 单测（先红） | 1 提交 |
| **P2b** ✅ | **截断可见化 + 判定统一**：循环达迭代上限仍未结束 ⇒ 标记截断，会话以 `error` 结算（不再静默当成功）；非任务循环统一走 `turnContinuationKind`。**in-band nudge 保留**（见 §11 残余说明） | agent loop 改造 + 纯函数 + 单测 | 1 提交 |
| **P3** ✅ | **Mailbox subject 绑定**：`MailboxItem.subject` 一等字段（持久化，列 `subject TEXT` 加法迁移）、`deriveMailboxSubject` 单一派生点、`enqueue` 一次绑定、`resolveEntityKeys` 从 subject 派生（conversation 键回退到 sessionHint/originSessionId）、修复 `callback_result` 锁退化为 `system:` | mailbox 类型 + storage 迁移 + adapter + 单测 | 1 提交 |
| **P4a** ✅ | **后端权威 per-session 状态**：`getSessionStates()` = 注册表（在跑的 turn）∪ mailbox 队列（仍 queued 的 item）**并集派生**（重启一致、不可能泄漏）；`isProcessing()` 纳入队列；`getAgentStatusSummary()` 附 `sessionStates` | core 派生 + 纯函数 + 单测 | 1 提交 |
| **P4b** | **前端同步**：agent 级 per-session 状态端点（在 `/stream/status` 或新增路由）+ 前端以后端为准并否决本地乐观态 + SSE fault 语义 | org-manager 端点 + web-ui + 单测 | 1 提交 |
| **P5** | **验证 + 清理**：真实数据探针（真实会话/流序列化形态）、全量回归、删除因重构而多余的旧补丁（净删代码） | 验证报告 + 残余清单 | 收尾 |

### 每阶段的验收不变量（测试钉死）
- P1：`anySessionProcessing ⇔ agent.status==='working'`；重启后 session 状态从持久化恢复，不残留 processing；`worker=1` 串行等价。
- P2：**未知/缺失 finish_reason ⇒ 不终结**（回归测试直接喂"无 finish_reason 的截断流"，修复前必须**红**）；fault 后同一 session 续跑；chat 场景也走该路径；硬上界 → error 可见。
- P3：无 subject 的入队被拒；`callback_result` 必经 origin session；不再产生 `sys_{id}_{ts}` 碎片。
- P4：前端在"后端仍 processing、前端未 attach"时**不显示空闲**；重启/刷新后对齐。

---

## 6. 与当前 PR #359（branch `bugfix/message-stop-cancel-p4`）的关系

PR #359 = P1–P4 的**症状级补丁**（停止/取消/重发 + 前端闪烁）。逐项判定：

| 补丁 | 判定 | 理由 |
|------|------|------|
| 取消 target 定向 (`stopCancelDecision.ts`) | **保留** | 这是真实不变量（"不带 target 会误杀别的会话流"），与目标一致 |
| mailbox 行以在途流为权威 (`mailboxRowDisplay.ts`) | **保留/并入 P4** | 方向与"单一真相源以在途流为准"一致，P4 后由后端端点强化 |
| `recover-stale` 端点 + amber「清理」 | **保留为过渡** | P1 落地后 stale processing 从根上减少；入口可保留 |
| P3 worker 兜底回写 (`recovered-reply-persist.ts`) | **重构后删除** | 它是"回复落库有两个写者"的 band-aid；P1/P2 后由 worker 侧单一路径承担 |
| P4 `mergeDbWithCache` 身份衔接 | **P4 后重新评估** | 若前端改为后端 session 状态驱动，可简化甚至移除 |

**建议**：PR #359 **先按止血合并**（它本身是绿的、独立可回滚），重构另开 `refactor/session-state-machine` 分支，避免在 bugfix 分支上继续堆叠。**待老板确认**（见 §8）。

---

## 7. 测试计划

- **P1**：registry 单测（进出 processing、聚合 status、恢复）；`agent-status-machine.test.ts` 扩展。
- **P2**：★核心回归——"无 finish_reason 的截断流必须不终结 session"（先红）；"fault 后续跑"；"chat 与 background 走同一终止判定"；variational 验证（回退修复 → 用例变红）。
- **P3**：`MailboxItem.subject` 契约测试；`callback_result` 回 origin session（先红：当前会新建 `sys_*`）；`resolveEntityKeys` 派生测试；迁移测试（旧格式 item 升级）。
- **P4**：端点契约测试 + 前端 hook 测试（"后端 processing、前端不 attach ⇒ 不显示空闲"）；`useChatStream` 既有 699 例回归。
- **P5**：真实数据探针（复制真实 session/stream 载荷，非夹具）；全量回归；确认唯一失败是既有环境 flaky 且与本次无关（须核实，不得默认放行）。

---

## 8. 残余 / 风险 / 待决策

### 待老板决策
1. **是否批准本方向并从 P1 开始？**（P1 是地基，不动 task review 机制）
2. **PR #359 处理**：先合并止血 + 另开重构分支（我推荐），还是冻结 PR 等重构？
3. **§4.3 的偏差**：接受"可信 clean finish 语义等价 end_turn"（推荐，避免每条聊天多一次工具调用），还是坚持"每条回复都必须显式调用 `end_turn`"？

### 风险（诚实列出）
- **P2 是行为改变**：chat 场景从"断了就结束"变成"断了会续跑"。若模型本身在乱输出，续跑可能放大问题 → 必须**有界**（`turnAttempt` 上界）+ fault 可见。
- **P1 的持久化**：session 状态写 DB 引入新的写者；**必须单写者**（registry 唯一写，DB 只是镜像），否则又是 R1。
- **P3 迁移**：存量 `sys_*` 碎片与无 subject 的 item 需一次性迁移；迁移须幂等、可回滚。
- **范围**：这是**跨 core / org-manager / web-ui 的深层重构**，非一次对话能完成；建议按阶段推进、每阶段独立可回滚。

### 未做（本次仅文档）
- 未改任何代码；未动 task 自动继续/review；未合并/关闭 PR #359。

---

## 9. P1 落地记录（✅ 已实现并验证）

**产物**：`packages/core/src/session-state.ts`（纯模块，单一写者）+ 接线。

- `SessionStateRegistry`：`begin(key,itemId)` / `settle(key,itemId,outcome,err?)` / `getSession` / `anyProcessing` / `processingCount` / `activeSessionKeys` / `list`。会话内多条 item → 全部 settle 才回 idle；error/cancelled 记为 `lastOutcome`（**不粘滞**为状态）。
- 接线（`agent.ts`）：`processMailboxItemCore` 在 `resolveTurnSession()` 之后 `begin(currentSessionId, item.id)`，在 `finally` 中 `settle(..., turnFailed?'error':'ok')`。
- 状态派生：`transitionStatus` 的 idle 分支新增闸 `if (!force && sessionStates.anyProcessing()) return;`；`isProcessing()` 反映并集；新增 `getSessionStates()` 供 P4 前端状态端点。

**与设计的一处落地偏差（记录在案）**：
- 本阶段 registry 的键 = **`resolveTurnSession` 解析出的内存会话 id**，驱动点在 **worker turn 边界**（begin/settle）。老板要求的「**消息创建时**即标记处理中」需要在**创建时**就能确定会话键——而这正是 **P3（mailbox subject 绑定）** 才提供的能力。因此「enqueue 时标记」顺延到 P3：P3 落地后，`begin` 将在 `mailbox.enqueue(subject)` 处调用，键由 `subject.sessionKey` 给出（无需再等 worker 领取），覆盖排队窗口。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `session-state.test.ts`（8）+ `agent-session-state.test.ts`（4） | ✅ 12/12 绿 |
| 回归：agent-status-machine / session-invariants / attention / worker-scoped-state / heartbeat-rollover | ✅ 129/129 绿 |
| 回归：mailbox-core/lifecycle/concurrent/claim-lease/recovery + agent-concurrent-e2e/cancel-isolation + handoff | ✅ 100/100 绿 |
| `tsc -p packages/core` | ✅ EXIT=0 |

---

## 10. P2a 落地记录（✅ 已实现并验证）——finish 诚实化

**问题 A 的直接机制**：全链路 `FINISH_REASON_MAP[...] ?? 'end_turn'` + `createSSEAccumulator` 默认 `'end_turn'`
→ 一个「没有任何 finish_reason 就断掉」的流被**静默当成模型说完了**，系统再也分不清「真的完成」与「流断了」。

**产物**：
- 类型：`LLMResponse['finishReason']` 新增 `'incomplete'`（`@markus/shared`）。
- 映射：新增 `mapUpstreamFinishReason(raw)`——**未知/缺失一律 → `incomplete`**（`provider-helpers.ts`）；替换 provider-helpers / anthropic / google / openai-codex / ollama 的全部 `?? 'end_turn'` 回退与流式默认值。
- 循环：新增纯函数 `turnContinuationKind(response, opts) → 'done'|'tools'|'text'`；`shouldContinueToolLoop` 委托它。
  `incomplete` ⇒ `'text'`（追加已产出内容 + 续跑 nudge，**有界**于既有 `maxToolIterations`），而非收尾。
- **task 循环显式 opt-out**：`executeTaskConcurrent` 传 `incompleteAsContinuation: false` → 任务自动继续/review 机制**逐字节不变**（老板约束）。
- 落点：`handleMessageStream` / `handleMessage` / `respondInSession` / `ensureTurnCompleted` 四个非任务循环的文本续跑分支由 `turnContinuationKind(...)==='text'` 判定。

**明确不做（P2b）**：移除 `ensureTurnCompleted` 的 in-band 文本 nudge；硬上界 → error 可见；终止判定与 task 完全统一。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `finish-reason-honesty.test.ts`（5，先红后绿） | ✅ 5/5 |
| 回归：agent-core/loop/extended/deep（273）+ llm providers/anthropic/openai/codex/markus（199） | ✅ 全绿 |
| `tsc -b packages/core` | ✅ 干净 |

---

## 11. P2b 落地记录（✅ 已实现并验证）——截断可见化 + 判定统一

**改动**：
- 非任务循环（`handleMessage` / `handleMessageStream` / `respondInSession` / `ensureTurnCompleted`）达迭代上限 `break` 前调用 `markTurnTruncated(where, finishReason)`；若该响应**仍未结束**（`turnContinuationKind === 'text'`）⇒ 置 `turnEndedTruncated`；
- `processMailboxItemCore` finally：结算结果 = `turnSettleOutcome(turnFailed, truncated)`——截断 ⇒ **`error`**（含错误信息），绝不静默当 `ok`；
- `getSessionStates()` 暴露 `lastOutcome` / `lastErrorMessage`（P4 前端状态端点的数据源）。
- task 循环同样不打此标记（保持既有语义）。

**明确保留的残余（诚实记录）**：**未移除 `ensureTurnCompleted` 的 in-band nudge**。理由：
1. 该 nudge 仅作用于**非 chat**（`human_chat` 已在入口被排除）的 LLM 轮次（mention / review / system / callback），是驱动弱模型调用 `end_turn` 的**承重**机制；
2. 真正移除它需要一个**结构化的续跑信号**（LLM 请求层的 continuation 标志），而非文本注入——那是独立、风险更高的改动，**不宜在全量验证前动**；
3. 已确认它不污染 human chat 会话（入口排除），故问题 A 的用户可见路径不受其影响。

→ 列为 **P5（可选）/ 后续**：`ensureTurnCompleted` 结构性续跑化。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `turn-truncation-outcome.test.ts`（4） | ✅ 4/4 |
| 回归 agent-core/loop/extended + 本重构新增（121） | ✅ 121/121 |
| `tsc -b packages/core` | ✅ 干净 |

---

## 12. P3 落地记录（✅ 已实现并验证）——mailbox 一等主体

**根因（R1/C）**：item 的「归属」没有一等字段，turn 会话读 `payload.extra.originSessionId`、
并发实体锁读 `metadata.sessionId` —— 同一事实两个来源。`deliverCallback` 从不写 metadata，
于是 `callback_result` 的 turn 会话正确、但锁键退化为 `system:{agentId}`（回调可与其来源会话**并发**）。

**产物**：
- `MailboxSubject` 接口 + `MailboxItem.subject?`（shared）；
- `deriveMailboxSubject(item)` —— 主体**唯一派生点**；优先级刻意保守（metadata 在前），
  既有已解析项**逐字不变**，只有旧实现解析不出值时才回退 `sessionHint` / `originSessionId`（纯加法）；
- `resolveEntityKeys` 改为 `item.subject ?? deriveMailboxSubject(item)`；
- `mailbox.enqueue` 入队时一次派生并绑定 `subject`；
- storage：`mailbox_items.subject TEXT` 列 + **受保护加法迁移** + INSERT/`mapRow`/`loadQueued|Deferred` 贯通；
  旧行 `subject=NULL` ⇒ 读取方回退派生，**无需回填、可原地回滚**。

**明确顺延到 P4（诚实记录）**：**enqueue 时即 `begin`（标记处理中）**。文档 §238 原本约定 P3 提供主体后
即可在 enqueue 处 begin；但「排队即 processing」要求对**所有终态路径**（drop/defer/merge/未认领重启）
都显式 settle，否则会泄漏「卡在 processing」的幽灵会话——那正是本次要消灭的 UI 幽灵态。
故与 P4 的「**注册表重启重建 + 前端权威状态**」一并实现，避免半成品引入新幽灵。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `mailbox-subject.test.ts`（5，先红后绿） | ✅ 5/5 |
| 回归 mailbox-core / concurrency / agent-extended / shared-types | ✅ 全绿 |
| `tsc -b packages/cli`（含 shared/storage/core） | ✅ 干净 |

---

## 13. P4a 落地记录（✅ 已实现并验证）——后端权威 per-session 状态

**设计取舍**：不把 mailbox 队列**复制**进注册表（那会再造一个需要清理的并行副本 →
泄漏「卡在 processing」幽灵）。而是**派生**：

```
getSessionStates() = deriveSessionStates(注册表.list(), 队列按会话归组)
```

即「会话在跑」= 注册表里正在跑的 turn **∪** mailbox 里仍是 `queued` 的 item。
- **重启一致**：队列是已持久化事实，重启后照常载入 → 立即可见（无需 seeding）；
- **不可能泄漏**：无并行副本要清理（R1 根因：一个事实一个写者）；
- **「入队即处理中」**：队列里的 item 天然让会话显示 processing，覆盖「入队→认领」窗口。

**改动**：
- `session-state.ts`：新增纯函数 `deriveSessionStates()` + `DerivedSessionState`；
- `agent.ts`：`getSessionStates()` 改为派生；新增私有 `queuedItemsBySession()`（用 `subject.sessionKey`，缺失回退 `deriveMailboxSubject`）；`isProcessing()` 纳入「队列非空」；`getAgentStatusSummary()` 两个分支都附 `sessionStates`。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `session-state-derived.test.ts`（5，含「入队 ⇒ 处理中」端到端） | ✅ 5/5 |
| 回归 session-state / agent-session-state / mailbox-subject / turn-truncation / finish-honesty（31） | ✅ 31/31 |
| `tsc -b packages/cli` | ✅ 干净 |

**P4b（前端同步）留给下一轮**：把 `getSessionStates()` 暴露为 agent 级端点，前端以其为权威、
否决本地乐观态（幽灵「空闲」）。**精确接入点**：`api-server.ts:3890`
（`activeStreams.status(agentId, sessionId)`）与 `Agent.getSessionStates()`；
`activeStreams` 仅在**已开流**后才有值，对「已入队未开流」无感知 —— 这正是 `getSessionStates()` 要补的缺口。





