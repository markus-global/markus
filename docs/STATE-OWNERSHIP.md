# 状态归属契约（STATE OWNERSHIP）

> 为什么需要这份文档：把状态从「agent 级单例」下放到「per-worker 工作区」是对的方向，
> 但它会**合法地改变**全仓大量代码的隐含前提（「读 `currentSessionId` 就能拿到本次请求的会话」）。
> 这类改动不会报错、编译通过、旧测试全绿——只在生产表现为「agent 失忆」。
> 所以必须把「谁拥有什么状态、谁能读、在哪个上下文里读」写成契约，并用机器强制。

**适用对象**：任何触及会话身份 / 历史 / 并发 / 工作区状态的改动。

---

## 1. 三种执行上下文（先分清自己在哪）

| 上下文 | 何时出现 | `sessionWorkspaceStore.getStore()` | 默认工作区 |
|---|---|---|---|
| **HTTP 线程** | `api-server` 处理请求、SSE 回调、路由校验 | `undefined` | `rootWorkspace` |
| **worker 工作区** | attention worker 池处理 mailbox item | 该 worker 的 workspace | 该 worker 的 workspace |
| **后台定时器 / 裸回调** | backstop 超时、`setTimeout`、外部事件 | `undefined` | `rootWorkspace` |

> 判据：`private workspace() { return sessionWorkspaceStore.getStore() ?? this.rootWorkspace; }`
> 在并发模式（默认 3 个 worker）下，**HTTP 线程与 worker 看到的不是同一个东西**。

---

## 2. 状态归属矩阵（写者 / 读者 / 上下文）

| 状态 | 归属 | 谁写 | 谁读 | 隐式读允许？ |
|---|---|---|---|---|
| `currentSessionId`（内存会话 `sess_*`） | **per-worker** | 处理该 item 的 worker（restore / startNewSession / handle*) | 同一个 worker 内的 turn 逻辑 | ❌ **禁止**跨线程读 |
| `dbSessionMap`（`cs_*` → `sess_*` 绑定） | agent 级（多 worker 共享） | **只在处理该消息的 worker 里写** | 任何人（按 DB id 查） | ✅ 允许（这是唯一跨线程安全的会话桥梁） |
| `MemoryStore.sessions`（历史本体） | agent 级单例 | `appendMessage`（worker 内） | `getRecentMessages` / `getSession` | ✅ 允许（但未知 id 必须告警，不许静默空） |
| `chatSessionRepo`（`cs_*` 持久层） | storage（进程外） | api-server（persist） | api-server / restore | ✅ 允许 |
| `activeScenario` / `currentTaskId` / `turnModelOverride` / `currentInteractingUserId` | **per-worker** | 同 worker | 同 worker | ❌ 禁止跨线程读 |
| `workerWorkspaces` / `workerStates` / `inFlightProcessing` | attention 控制器 | attention 自身 | attention / 定向取消（**必须显式带 workerId**） | ⚠️ 仅限带 workerId 的定向 API |
| `session.summary` / fragments / slots | MemoryStore（单例） | compactor | context 组装 | ✅ 允许 |

**一句话**：**per-worker 的东西，永远不能靠「读全局指针」拿到；必须显式传参。**
唯一允许跨线程共享的会话桥梁是 `dbSessionMap`（`cs_*` ↔ `sess_*`）。

---

## 3. 硬规则

1. **DB id 与内存 id 永不混用**。`cs_*` 是请求身份，`sess_*` 是内部缓存 key；
   永远不要把 `cs_*` 直接当 `MemoryStore` 的 key（那会造成 split-brain：同一个对话分裂成两个存储）。
2. **跨线程传会话身份必须显式**。HTTP 线程要把会话交给 worker，只能通过 mailbox item 的
   `extra.sessionId` / `extra.sessionRestore`，不能依赖任何共享指针。
3. **会话上下文只在处理该 item 的工作区里应用**。禁止在 HTTP 线程做「eager restore」
   （它只会写 `rootWorkspace`，worker 看不到）。
4. **失败必须可见**。区分 `found | missing | notLoaded`：后两者至少 `log.warn` 带
   `dbSessionId / memorySessionId / agentId`。禁止「查不到就返回空 / 就新建 / 就吞异常」。
5. **绑定只允许一处写**：在真正处理该消息的工作区里写 `dbSessionMap`。
6. **定向操作必须带 workerId**（取消、状态查询、热更新），不允许靠 ALS 推断。

---

## 4. 已落地的强制手段

| 手段 | 位置 | 保护什么 |
|---|---|---|
| 流式路径显式携带 DB session id | `agent.ts` `sendMessageStream` → `extra.sessionId` | R2 规则 |
| 会话解析按「DB 绑定的内存会话 > 工作区指针 > 新建」 | `handleMessageStream` | R1 规则 |
| restore / 绑定在处理该 item 的工作区执行 | `processMailboxItemCore` | R3/R5 规则 |
| 历史读取懒加载 + 未知 id 告警 | `memory/store.ts` `getRecentMessages` | R4 规则 |
| 不变量测试套件 | `packages/core/test/conversation-session-invariants.test.ts` | 上述全部 |
| 架构门禁 | `scripts/architecture-guard.mjs`（CI 必过） | 禁 `console.*`、禁空 `catch` |

---

## 5. 新增/改动状态时的检查清单

1. 这个状态属于 **agent 级** 还是 **per-worker**？（per-worker 就必须显式传参）
2. 谁写、谁读、在哪个上下文？（填进第 2 节矩阵，**空格就是风险**）
3. 读不到时会怎样？是否静默降级？（必须可观测）
4. 加一条**不变量测试**（不是实现快照断言），并做变异验证（回退修复 → 用例必须变红）。
5. 是否影响 `worker=1` 的串行等价契约？（必须保持等价）
