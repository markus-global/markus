# 审计报告：事件队列/调度链是否会被单个 provider 调用阻塞

- 分支：`feat/context-os`
- 仓库：`/Users/liuqian/mycode/markus-wt-billing`
- 类型：只读静态分析（未改任何文件）
- 范围：agent 主循环 / 消息处理链 / 事件队列 / 调度链 / 调度链上的 provider 失败传播

> 说明：`packages/core/src/` 下没有 `agent/` 子目录，agent 主文件是 `packages/core/src/agent.ts`（8065 行），主循环在 `packages/core/src/attention.ts`，队列在 `packages/core/src/mailbox.ts`。

---

## 0. 结论速览

| # | 问题 | 判定 |
|---|------|------|
| 1 | provider **抛错**是否会永久阻塞主循环 | ✅ **不会** — 已被多处 try/catch 隔离，循环继续 |
| 2 | provider **挂起**（resolve 永不返回）是否会永久阻塞主循环 | ✅ **基本不会永久** — 有 45 分钟 backstop `Promise.race` 兜底，超时后 requeue 继续；但会**长时间停摆最长 45 分钟**（块级隔离是「有界」的，不是「永久」） |
| 3 | 单个悬挂消息是否会堵住后续队列 | ✅ **不会永久** — 单条消息超时后 requeue，队列继续；但有 45 分钟级 stall |
| 4 | 是否存在「无超时的 await」缺口 | ⚠️ **存在 3+N 处真实缺口**（见 §4），其中 **triage deliberation **最重要：**不在** backstop 之内 |
| 5 | provider 失败是否 fail-loud 传递、不静默吞掉 | ✅ **是 fail-loud** — 抛错经 `withNetworkRetry`(仅网络错误重试) 后上抛 → 循环捕获日志告警 → 异常消息 requeue/完成；deliberation/judge 失败是**有意 fail-soft**（回退启发式） |

**一句话回答**：单个 provider 调用**抛错**或**挂起**都不会让 agent 主循环「永久」卡死——`processFocusedItem` 的 45 分钟 backstop 是最后兜底，超时后会取消在途请求并 requeue 继续处理下一条。真正的隐患在于**这条 backstop 只覆盖「正式处理」阶段，并未覆盖 triage deliberation 阶段**，以及调度链上的 `TaskQueue.executeTask` 和 dream 信号量这些**既无超时也无 abort** 的并行位（见 §4）。

---

## 1. 主循环 / 消息处理链定位

- **队列**：`packages/core/src/mailbox.ts` — 优先级队列，单消费者。`dequeue()`（mailbox.ts:405-411）把队头移出并置 `processing`；`dequeueAsync()`（mailbox.ts:424-441）阻塞等待。
- **主循环**：`AttentionController.runLoop`（attention.ts:342-527）——`while` 循环，`dequeueAsync()` 阻塞取出一条消息 → pre-triage 清理/合并/去重 → triage deliberation → `processFocusedItem` → 回到 idle。
- **消息处理**：`processFocusedItem`（attention.ts:532-695）调用 `delegate.processMailboxItem`（agent.ts:1144）→ `agent.processMailboxItemInternal`（agent.ts:1460）→ 按 sourceType 分派到 `handleMessage` / `handleMessageStream` → `this.llmRouter.chat(...)` / `chatStream(...)`。

LLM 调用点（agent.ts）：
- agent.ts:1355 / 1421 / 2376 `this.llmRouter.chat(...)`（非流式、流式延续合计）
- agent.ts:3737 / 3964 / 4013 / 4077 / 4119 / 4181 / 4458 / 4711 `withNetworkRetry(() => this.llmRouter.chat(...))`
- 底层在 `llm/router.ts:1485 chat()` / `1630 chatStream()` 调用具体 provider。

---

## 2. provider「抛错」→ 是否永久阻塞：**不会**

主循环对抛错的隔离层次（从内到外，全部 try/catch 兜住）：

1. `processMailboxItemInternal` 的 switch 外层 try/catch（agent.ts:1532 起）——单项失败不穿透。
2. `processFocusedItem` 包住 `delegate.processMailboxItem` 的 try/catch（attention.ts:564-581）：
   ```ts
   try { ... await this.delegate?.processMailboxItem(...) ... }
   catch (err) { log.warn('Error processing mailbox item', {...}) }
   ```
   抛错 → 记录告警 → catch 吞下 → 继续走到状态裁决分支（complete/requeue/defer）。**循环不死**。
3. `runLoop` 外层 `while` 套 try/catch（attention.ts:344-354、527-534）——即便异常逃逸，也只结束单轮，下一轮继续。
4. `launchLoop` 自动重启 + 看门狗（attention.ts:299-309）——若循环意外死亡会在 `WATCHDOG_INTERVAL_MS=30s` 内 `launchLoop()` 重启。

结论：**单条 provider 抛错** => 该条消息失败（告警/requeue/完成），循环继续处理下一条。✅

---

## 3. provider「挂起」（resolve 永不返回）→ 是否会永久阻塞：**有界，不永久**（但有 45 分钟上限）

### 关键机制：`processFocusedItem` 的 backstop `Promise.race`（attention.ts:555-585）

```ts
const processing = this.delegate?.processMailboxItem(item, batchItems, batchContext);
const backstopMs = this.waitingForHumanApproval
  ? APPROVAL_WAIT_TIMEOUT_MS                       // 24h（等待人工审批）limits.ts:545
  : (this.processingTimeoutMs ?? MAILBOX_PROCESSING_TIMEOUT_MS); // 45min limits.ts:323
const backstop = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), backstopMs));
const result = await Promise.race([
  processing?.then(r => ({ done: true as const, reply: r })),
  backstop.then(() => ({ done: false as const, reply: undefined })),
]);
if (result?.done) reply = result.reply;
else {
  timedOut = true;
  this.delegate?.cancelProcessing?.(item);   // 取消在途流，防 requeue 双副作用
  log.error('Processing exceeded backstop timeout — cancelling in-flight and requeueing', {...});
}
```

- `backstop` 恒会 resolve，因此 `Promise.race` **必然**在 `backstopMs`（默认 45 分钟）返回，即使底层 `processing` 永不 resolve。
- 超时 → 打 `log.error` → `cancelProcessing`（agent.ts:1208 `cancelActiveStream` abort 在途流）→ `timedOut` 分支 `mailbox.requeue(item)`（attention.ts:599）→ 循环回到队列继续下一条。
- requeue 后异常行为判定：`MAILBOX_ITEM_MAX_RETRIES = 2`（limits.ts:126），连续异常（缺 completion marker）最多重试 2 次后强制 complete（attention.ts:642-668），不会无限循环。

### 触发时机 vs 各段超时对比

| 层 | 机制 | 值 | 位置 |
|----|------|----|------|
| provider 非流式 | AbortSignal.timeout / controller.timeout | openai `chatTimeoutMs=90s`；markus `CHAT_TIMEOUT_MS=90s`；其余 fetch 120~180s | openai.ts:117,420,461,493；markus-provider.ts:778 |
| provider 流式 | idle 超时 + hard 超时 | markus `streamTimeoutMs`(默认)+`STREAM_HARD_TIMEOUT_MS=15min` | markus-provider.ts:840-858 |
| 网络重试 | `withNetworkRetry` 仅对网络错误退避重试 ×3 | `NETWORK_RETRY_MAX=3`，`BASE=2s` 指数退避，耗尽后上抛 | agent.ts:7296-7315,464-465 |
| 主循环兜底 | `processFocusedItem` backstop | **45 min**（或审批 24h） | attention.ts:555-585; limits.ts:323 |

含义：即便某 provider 内部 timeout 全部失效（网络挂死、DNS 挂死、非 HTTP 步骤挂死），主循环也**不会被永久阻塞**——最多停摆 45 分钟后 requeue 继续。**但 45 分钟是一个非常长的停顿**，且 requeue 重复遇到同一坏 provider 会再等 45 分钟，形成「每 45 分钟撞一次头」的低吞吐，而不是彻底死锁。

---

## 4. 「无超时 await」的真实缺口（重点核查项）

这几处 `await` **不**在 `processFocusedItem` 的 backstop 之内，是真正可能让某条链永久卡死的候选点：

### ⚠️ GAP-A（最重要）：triage deliberation 不在 backstop 内
- `attention.ts:446-462`：`if (needsLLMTriage(...)) { ... const deliberationResult = await this.delegate.performDeliberation(item, allItems); ... }`
- 这段 `await` 在 `runLoop` 大 try/catch 内（catch 能兜**抛错**），但**没有** `Promise.race` 兜**挂起**。
- `performDeliberation`（agent.ts:2751）内部 `await this.handleMessage(deliberationPrompt,...)` 走 LLM，其 try/catch（agent.ts:2847 `catch { return null }`）只能兜抛错，**对挂起无效**。
- 影响：若 deliberation 内的 provider 调用**永不 resolve**（且该 provider 无内部超时），`runLoop` 会**永久卡在 attention.ts:452**，后面所有消息都不处理。
- 缓解：现实依赖的是 provider 内部 ~90s 超时 + `handleMessage` 在 portal 里本身受……（注意：deliberation 是**独立**的 `handleMessage` 调用，不在背靠的 mailbox 处理中，因此它**没有** 45 分钟 backstop 覆盖）。**这是审计中发现的最接近「永久阻塞」的唯一主循环路径。**

### GAP-B：`evaluateWithLLMFallback`（interrupt 判断）
- `attention.ts:1066-1089`：`await this.llmJudge(prompt)` 有 try/catch 在**抛错**时回退启发式（fail-soft），但挂起（judge 永不 resolve）会卡住该 try 的 await。
- 该函数由 `evaluateInterrupt`（agent.ts:1199）调用，发生在 `checkAttentionYieldPoint`（工具循环内）⇒ 位于 mailbox item 的 45min backstop 覆盖范围内，所以**挂在工具循环内会被 45 分钟兜住**，严重性低于 GAP-A。但超过该时长前同样会长时间卡住当前工具回合。

### GAP-C：调度链 `concurrent/task-queue.ts` — 无超时、无 abort
- `task-queue.ts:204`：`const result = await task.execute();` —— **没有任何 per-task 超时**，也没有 `Promise.race`。
- 影响：一个 `execute()` 挂死（例如内部工具/LLM 永不返回）→ 该任务永久停留在 `runningTasks`（task-queue.ts:212-215 只有在 promise settle 时才删除），**占用一个并发槽**。
- `processQueue`（task-queue.ts:156-168）在 `availableSlots <= 0` 时直接 return；若 `maxConcurrent` 个槽全被挂死任务占满 ⇒ **整个执行器队列停止调度新任务**（task 状态一直是 PENDING，永不执行）。
- 位置/用法：`TaskExecutor`（task-executor.ts:42 `new TaskQueue`）→ agent.ts:587、`executeTaskConcurrent`（agent.ts:4878-4920）。这属于任务调度链（`_executeTaskInternal` 的 LLM 工具循环），**不在** mailbox backstop 的背靠 Promise 里，但实际情况是 `executeTaskConcurrent` 由 `processMailboxItemInternal` 的 `task_status_update` 分支 await，最终仍被 45 分钟 backstop 兜住（矛盾点：45 分钟超时后 mailbox 会 requeue，但 `_executeTaskInternal` 那个被丢掉的 promise 仍会在后台继续，可能产生滞后的副作用/日志，DB 里的 running tasks 靠 `cleanStaleProcessing` 看门狗在 idle/deciding 时清理）。**这个 executor 自身缺乏 per-task 超时与取消传播。**

### GAP-D：dream 信号量（背景子系统）
- `agent.ts:469` `static dreamQueue: []`、`797-814` `acquireDreamSlot/releaseDreamSlot`、调用点 `agent.ts:7731-7740`：
  ```ts
  await Agent.acquireDreamSlot();
  try { await this.dreamConsolidateMemory(entries); ... }
  finally { Agent.releaseDreamSlot(); }
  ```
- 若 `dreamConsolidateMemory` 内的 LLM **挂死**，`finally` 不执行 ⇒ `releaseDreamSlot` 永不调用 ⇒ `dreamQueue.shift()` 不再触发 ⇒ **之后所有 queued dreams 永久等待**。这是背景记忆子系统，不影响主 mailbox 循环，但同属「无超时 await」缺口。

### GAP-E：EventBus.emit（事件队列）— 安全
- `events.ts:26-35`：`emit` 是**同步** fire-and-forget，`fn(...args)` 不 await；每个 listener 用 try/catch 包住（抛错→吞掉，bus 不崩）。
- 结论：listener **挂起**不会阻塞 bus（emit 同步返回）；listener **抛错**被 catch。事件总线本身不会因单个 subscriber 卡死。✅

---

## 5. provider 失败是否 fail-loud 传递（不死锁、不静默吞）

- **抛错传播链（fail-loud）**：provider 抛错 → `router.chat`（router.ts:1485）先尝试同 provider 备选模型 + 跨 provider fallback（router.ts:1533-1567），全部失败后 `throw finalError`（router.ts:1568-1571，且 `CU_EXCEEDED / MARKUS_RATE_LIMITED` 明确不再 fallback，直接 throw router.ts:1552-1556）→ `withNetworkRetry` 仅对**网络错误**按 `NETWORK_RETRY_MAX=3` 退避重试（agent.ts:7304-7306），非网络错误/重试耗尽即抛 → handleMessage → processMailboxItemInternal → `processFocusedItem` catch（attention.ts:570-575 `log.warn('Error processing mailbox item')`）→ 告警可见，循环继续。**没有静默吞掉且继续卡住**。
- **异常完成裁决（fail-visibly）**：
  - 后台类消息（task_status_update / a2a 等）：缺 completion marker → 最多 requeue 重试 2 次，仍失败 → `complete` + `emitIncomplete`（attention.ts:652-668）——**记为不完整完成并可见**，不无限重试、不死锁。
  - 用户交互类（human_chat）：异常完成**不重试**（防重复副作用），`complete` + `emitIncomplete`（attention.ts:660-668）。用户可手动重发。
- **fail-soft 的例外（有意为之，非缺陷）**：
  - `performDeliberation` 失败 → `catch { return null }`（agent.ts:2847）→ runLoop 用优先级顺序处理（`if (!triaged)`）；这是**有意的 fail-open**，不是静默卡住。
  - `evaluateWithLLMFallback` 失败 → 回退启发式（attention.ts:1080-1086）。
  - `withNetworkRetry` 的网络错误会重试再抛，这是合理的等级重试。

---

## 6. 针对问题清单的逐条回复

1. **主循环/处理链文件**：`packages/core/src/agent.ts`（处理逻辑）、`attention.ts`（runLoop 主循环）、`mailbox.ts`（队列）、`llm/router.ts`（LLM 路由与 fallback）、`concurrent/task-queue.ts`+`task-executor.ts`（并发任务调度链）。注：无 `agent/` 子目录。

2. **provider 抛错/挂起是否永久阻塞**：
   - 抛错 → **不会**（多层 try/catch，循环继续；看门狗还会重启死亡循环）。
   - 挂起 → **不会永久**，但有界停摆：`processFocusedItem` 的 45 分钟 backstop（attention.ts:555-585）兜底，超时 cancel+requeue 继续。
   - **例外（真永久风险）**：triage deliberation（attention.ts:452）不在 backstop 内，依赖 provider 内部 ~90s 超时；若 provider 彻底无超时则循环永久卡住（GAP-A）。

3. **事件队列是否 per-message 超时/隔离；悬挂消息是否堵住后续**：
   - 主 mailbox：**有** per-item backstop（45min）+ requeue + 重试上限 + 看门狗（清 stuck processing、nudge 丢失唤醒）→ 单条悬挂**不会**堵死后续永久，但会拖慢最多 45 分钟。
   - 并发任务队列 task-queue.ts：**没有** per-task 超时/abort，挂死任务占槽，可能**整体堵死调度**（GAP-C，次严重）。
   - EventBus：同步发送，不 await，天然隔离（GAP-E 安全）。

4. **无超时 await**：见 §4。重点：`performDeliberation`（attention.ts:452 / agent.ts:2751）、`evaluateWithLLMFallback`（attention.ts:1068）、`task.execute()`（task-queue.ts:204）、dream 槽（agent.ts:7731-7740）。`AbortSignal` 仅在 provider 内部/流 cancel 处传播（openai.ts:117,210；markus-provider.ts:864），router 主路径 `chat()` **不接收** agent 级 AbortSignal，靠背靠 provider 自带超时。

5. **provider 失败 fail-loud 传递**：是（见 §5）——抛错经 router fallback → withNetworkRetry(仅网络) → 上抛 → 循环告警 → 消息 requeue/完成可见。后台消息最多重试 2 次；用户消息不重试防双副作用。deliberation/judge 失败是**有意 fail-soft**回退，并非静默卡住。

---

## 7. 建议（供后续决策，本审计未改代码）

1. **为 triage deliberation 加同款 backstop**：在 attention.ts:452 用 `Promise.race` 包 `performDeliberation`（建议 30–60s 级，远小于消息处理的 45min），超时回退到纯优先级顺序。
2. **为 `evaluateWithLLMFallback` 的 `llmJudge` 调用加超时**（如 10–20s），超时回退启发式。
3. **为 `concurrent/task-queue.ts` 增加 per-task 超时/取消**：`Promise.race` + AbortSignal，超时标记 `TIMEOUT` 并释放槽位，避免挂死任务吃满 `maxConcurrent` 堵死整个调度链。
4. **为 dream/背景 LLM 调用统一加超时**，保证 `finally { releaseDreamSlot() }` 一定执行。
5. 若 45 分钟 stall 不可接受，可在配置层调低 `MAILBOX_PROCESSING_TIMEOUT_MS`（limits.ts:323），并将「超时后重试」改成「标记健康度下降并优先切换到健康 provider」，降低连续撞同一坏 provider 的成本。
