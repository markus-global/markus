# 会话身份与消息管线：完整核查 + 整改方案

> 2026-09-11 · 起因：「同一会话后续请求看不到历史」修完一轮后，老板要求**完整检查所有相关代码与文档**再给方案，
> 而不是继续逐点打补丁。本文是先核查、后方案的产物。

---

## 0. TL;DR

问题不是「某个函数写错了」，而是**架构层面的身份契约缺失**：

- 全仓有 **21 个入口**能让 agent 处理一条消息，**每个入口各自决定会话身份**；
- 而「恢复会话 + 写 DB→内存绑定」的完整逻辑**只存在于唯一一条路径**（`processMailboxItemCore` 的 `human_chat`/`a2a_message` 分支，`agent.ts:1711–1738`）；
- 于是：**没走到那条路径的入口、或没带身份的入口，都会静默地开一个全新会话** —— 这就是「agent 失忆」反复出现的原因。

修法不是给 21 个入口逐个补参数，而是：**把会话身份变成入口的必填契约（编译期强制）+ 把解析收敛成唯一函数（所有 sourceType 共用）**。

---

## 1. 核查范围与证据

**代码**（全部读过，非抽样）：
- `packages/org-manager/src/api-server.ts`：所有会触发 agent 处理消息的路由与内部调用（14 类入口）+ Feishu 入站 + 群聊/频道 + 两个近乎重复的 message 处理块；
- `packages/core/src/`：`agent.ts`（mailbox 入口、`processMailboxItemInternal/Core`、`handleMessage/Stream`、会话状态 getter/setter、`startNewSession`/`restoreSessionFromHistory`/`bindDbSession`/`getDbSessionId`）、`mailbox.ts`（enqueue/实体键）、`attention.ts`（worker 循环、定向取消、`emitIncomplete`）、`memory/store.ts`、`session-workspace.ts`；
- `packages/org-manager/src/task-service.ts`、`packages/cli/src/commands/*`、`federation-manager.ts`、`sse-handler.ts`。

**文档**（docs/ 共 25 篇，精读 11 篇）：
`MAILBOX-SYSTEM.md`（管线权威口径）、`ARCHITECTURE.md`、`STATE-MACHINES.md`、`STREAMING-AND-REATTACH.md`、`CONCURRENT-PROCESSING.md`、`CONCURRENT-PROCESSING-DESIGN.md`、`STATE-OWNERSHIP.md`、`ARCHITECTURE-FRAGILITY.md`、`TEAM-CHAT-REFACTOR.md`、`MEMORY-SYSTEM.md`、`PROMPT-ENGINEERING.md`。

**实测**：core 不变量 9 条、core 真链路冒烟 3 条、org-manager HTTP 层门禁 2 条（1 绿 1 已知缺陷）、若干临时探针与插桩。

---

## 2. 事实清单

### 2.1 唯一权威链路（文档口径 + 代码一致）
```
sendMessage / sendMessageStream / enqueueToMailbox / sendTaskExecution
  → mailbox.enqueue                      (mailbox.ts:363)
  → AttentionController worker 循环       (attention.ts:822)
  → processMailboxItemInternal            (agent.ts:1638)
  → processMailboxItemCore                (agent.ts:1650)  ← 会话身份的唯一下载点
  → handleMessage / handleMessageStream   (agent.ts:3936 / 4700)
```
> `MAILBOX-SYSTEM.md` 明确要求「每个 LLM 调用必经 mailbox，禁止直接调 `handleMessage`」。

### 2.2 入口矩阵（21 条）—— 按「是否携带会话身份」分类

| 类别 | 入口 | 位置 | 会话身份 | 后果 |
|---|---|---|---|---|
| ✅ **完整** | `POST /api/agents/:id/message`（非流式） | api-server 4576 | `dbSessionId` + `sessionRestore` | 正常 |
| ✅ 完整 | 同上（流式，经 SSEHandler） | sse-handler 204/208 | `sessionId` + `sessionRestore` | 正常（本轮新修） |
| ❌ **完全无身份** | `POST /api/message`（**第二个近乎重复的块**） | api-server 6433 / 6478 / 6484 | 无 | 每次都开新会话 |
| ❌ 无身份 | `POST /api/agents/:id/command` | 6086/6092/6105 | 无 | 同上 |
| ❌ 无身份 | `POST /api/agents/:id/a2a` | 4413 | 无 → `a2a_{id}_{ts}` | 本轮改为按「对话」绑定 |
| ❌ 无身份 | channel 单 agent 兜底 | 4040 | 无（连 `channelKey` 也丢） | 会话漂移 |
| ❌ 无身份 | `inject:true` → `injectFollowUp` | 4511 → agent.ts:1076 | 无 | 同上 |
| ⚠️ 仅 channelKey | 群聊广播 → `processGroupChatReply` | 4006 → 1742 | `channel_{key}_{id}` | 有会话、**永无 DB 绑定** |
| ⚠️ 仅 channelKey | agent 工具 `send_group_message` | 865/897/2087 | 同上 | 同上 |
| ⚠️ 系统会话 | heartbeat / daily_report / memory_consolidation / 公告 / task-service 多处 / workflow executor | agent.ts:728/3911/8549/3920、task-service 3583/3856/371/519/2478/1441 | `sys_*` / `task_*` / 无 | 设计如此，但**无 DB 绑定** |
| ❌ **绕过 mailbox** | `agent.injectUserMessage` | task-service **1429 / 4535** | 直接写 memory | **完全不进 Core**：无恢复、无绑定、无 mailbox 语义 |
| ⚠️ HTTP 线程提前 restore | Feishu 入站 | api-server 2607–2641 | `sessionRestore` + HTTP 线程 `bindDbSession` | 并发下写 root 工作区（陈旧/空绑定） |
| — | CLI 直连 | cli/commands/agent.ts:43/64、start.ts:1412/1940 | 多数无 `sessionId` | 本地使用可接受，但属同一缺口 |

### 2.3 三条 id 空间与规则（`STATE-OWNERSHIP.md` 已立契约）
- `cs_*` = DB 会话（对外身份）；`sess_*` = 内存会话（内部缓存）；`sys_*`/`task_*`/`a2a_*`/`channel_*` = 系统/临时会话。
- **per-worker 状态禁止隐式跨线程读**；`dbSessionMap` 是**唯一允许跨线程共享的桥**；DB id 绝不当内存 key。
- 现状违规：`sendMessage.sessionId` 被当作**内存会话 key**（agent.ts:4019–4030），而 `sendMessageStream.sessionId` 被当作 **DB 提示**去查绑定（4769）—— **同一个字段名，两种相反语义**。

### 2.4 已确认的文档 ↔ 代码偏差（4 处，建议一并修）
1. `MAILBOX-SYSTEM.md:290-293` 称 `task_comment`/`requirement_comment` 为 priority 0 且「always preempt」；实现里它们是 `defaultPriority:2`（`shared/src/types/mailbox.ts:106,112`），且 `USER_INTERACTION_TYPES` 只含 `human_chat`（`attention.ts:1493-1495`）。
2. `MAILBOX-SYSTEM.md` 注册表只列 14 类，`ARCHITECTURE.md:174` 与代码为 **15 类**（多 `workflow_update`）。
3. `CONCURRENT-PROCESSING.md:207-212,300-304` 与设计稿 `:343` 称 `a2a/heartbeat/group_chat` **无实体键、不被锁**；实现已改为声明式多键且**恒非空**（`mailbox.ts:437-451`、`attention.ts:802-806`）。
4. `MAILBOX-SYSTEM.md:76` 规定类型值不得出现在注册表外；`attention.ts:1532-1580` 大量硬编码字面量。

---

## 3. 根因（结构级，非 bug 级）

| # | 根因 | 证据 |
|---|---|---|
| R1 | **身份契约缺失**：会话身份没有类型强制，21 个入口各自决定 → 忘传即静默新会话 | 2.2 表格 |
| R2 | **解析逻辑只存在于一条分支**：restore/startNewSession/绑定写在 `human_chat`/`a2a` 分支里，其它 sourceType 与其它入口无此逻辑 | agent.ts:1711–1738 |
| R3 | **同名不同义**：`sessionId` 在两个 API 里语义相反（内存 key vs DB 提示）→ 传错方向就 split-brain | agent.ts:4019 vs 4769 |
| R4 | **失败静默**：绑定缺失、历史读取未知 id 都不报错（本轮已修 `getRecentMessages` 与绑定告警） | store.ts、agent.ts:1736 |
| R5 | **双实现**：`/api/agents/:id/message` 与 `/api/message` 是两个几乎相同的块；Feishu 入站又有自己的 restore | api-server 4420 / 6433 / 2607 |

---

## 4. 方案（四步，每步可独立交付、可回滚）

### 第 0 步 · 把「身份」变成必填契约 + 唯一解析函数（0.5 天，**先做**）
1. 新增类型（`packages/core/src/session-hint.ts`）：
   ```ts
   type TurnSessionHint =
     | { kind: 'new'; dbSessionId?: string }                       // 显式新对话
     | { kind: 'existing'; dbSessionId: string; preferredMemorySessionId?: string | null }
     | { kind: 'system'; role: 'heartbeat' | 'task' | 'report' | 'announce'; key?: string }
     | { kind: 'unknown'; reason: string };                        // 必须 log.warn
   ```
2. `mailbox` item 的 `extra.sessionHint` 设为**必填**；`sendMessage*` / `enqueueToMailbox` / `sendTaskExecution` 的**参数类型**上要求它 → **所有调用点在编译期被迫表态**（这一步会一次性照亮全部 21 个入口，比插桩可靠）。
3. core 新增唯一解析点 `resolveTurnSession(hint): { memorySessionId: string; created: boolean }`，把现在散在 `agent.ts:1711–1738` 的 `restoreSessionFromHistory` / `startNewSession` / 写绑定逻辑全部搬进去，**所有 sourceType 分支共用**。
4. 验收：core 不变量 9 条 + core 冒烟 3 条 + HTTP 门禁 2 条全绿；`kind:'unknown'` 必 warn（测试断言）。

### 第 1 步 · 收敛入口（1 天）
- 删除或合并 `/api/message`(6433) 与 `/api/agents/:id/message`(4420) 的重复块；api-server 引入唯一 `dispatchToAgent(agentId, text, hint, opts)`，**所有入口只能通过它**。
- `injectFollowUp` / `injectUserMessage`（task-service 1429/4535）改为走 mailbox 的 `system_event` + hint，否则永远不参与恢复与绑定。
- Feishu 入站删掉 HTTP 线程的 restore/bind，统一交给 worker 侧（与第 0 步一致）。

### 第 2 步 · 消除同名不同义（0.5 天）
- 跨层参数一律用 `dbSessionId`（DB 身份）与 `memorySessionId`（内存 key）两个名字；**禁止裸 `sessionId` 作为跨层参数**，旧字段标 `@deprecated` 并逐个迁移。
- 修完后 `sendMessage`（非流式）不再可能把 `cs_*` 当内存 key。

### 第 3 步 · 门禁 + 文档（0.5 天）
- `scripts/architecture-guard.mjs` 增规则：**调用 `mailbox.enqueue` / `sendMessage*` 必须显式传 sessionHint**（静态检查，防回潮）。
- 新增「入口矩阵测试」：对每个入口各写一条「同会话两连发必须看到历史」的断言（`packages/org-manager/test/entry-session-matrix.test.ts`）。
- 修 §2.4 的 4 处文档偏差；在 `MAILBOX-SYSTEM.md` 增「会话身份契约」一节；`STATE-OWNERSHIP.md` 矩阵补 `TurnSessionHint` 行。

**总投入**：约 2.5 人日；每一步都可独立发布，回滚成本低。

---

## 5. 本次核查的边界（诚实说明）

1. **已确证**：入口矩阵（2.2）、唯一解析点（2.1）、同名不同义（R3）、文档偏差（2.4）、以及「core 层绑定契约是可用的」（探针 + 9 条不变量 + 冒烟全绿）。
2. **未确证（我不粉饰）**：*HTTP 层首轮为何没有建立绑定*。目前有断言级证据（`getMemorySessionIdForDbSession(cs) === null`），但**我曾据 console 插桩得出「HTTP 层没走 `processMailboxItemCore`」的结论 —— 该结论不可靠**：复测发现「用例通过时 src 的 console 输出整体不出现」，插桩测量方式本身有偏差，我已撤掉全部插桩、不在结论里引用它。
   → 这条不需要再靠插桩：**第 0 步落地后，「入口没表态 / 走了非权威路径」会直接变成编译错误或显式 warn**，比任何插桩都可靠。
3. **未做**：取消提示的 UI 形态（需产品口径）；S7 拆 tab；合并发版。
