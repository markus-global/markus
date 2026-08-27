# 前端流式/轮询死循环防护 + 断连自动重连 审计报告（SS-2, F 域）

> 仓库：markus-wt-billing ｜ 分支：ss2-fe-stream ｜ 日期：2026-08-27
> 依据：`docs/feedback-0.9.8-analysis.md` S 域问题 16/17/18（前端侧）。
> 范围：严格限前端流式/轮询（F 域），未动后端 provider 熔断（SS-1 已处理）。

---

## 一、前端流式/轮询现状盘点

Markus 前端消费 agent 生成的方式是 **fetch + ReadableStream（SSE 风格 `data:` 行）**，不是 `EventSource`。两条消费链路：

### 1. 实时发送：`api.agents.messageStream`（packages/web-ui/src/api.ts）
- POST `/api/agents/{id}/message`（`stream:true`），拿 `res.body.getReader()` 逐块读，解析 `data:` 行。
- 事件：`text_delta` / `thinking_delta` / `tool_call_start` / `agent_tool` / `text_commit` / `thinking_commit` / `done` / `error` / `heartbeat`。
- **问题**：`while(true) { await reader.read() }` 没有空转兜底——若连接真死（半开 TCP / 服务进程退出 / provider 挂起让服务端不再吐数据），`reader.read()` 会永久 pending，界面停留在「思考中」，死循环不退出。

### 路径 2：刷新后重挂：`api.sessions.reattachStream`
- `GET /api/agents/{id}/sessions/{sid}/stream?afterSeq=…`，同样是 reader 循环。同样无空转兜底。

### 轮询（DB 兜底）：Team.tsx `pollForReply`
- 当 SSE 断连且本地 agent 气泡为空时，轮询 `getMessages` 从 DB 恢复回复。**问题**：固定 3000ms 间隔 5 次，无退避/抖动——断连时所有客户端同时紧密重轮（雷群效应）。

### WS 事件源：`WSClient`（api.ts）— 已有防护 ✅
- 指数退避重连（base 1s → max 30s）、每 25s 心跳、`since` 增量恢复、`disconnect()` 主动关闭。**此项已达标**。

### 页签切回自动续流：Team.tsx `tryReattachActiveStream`
- `reattachCooldownRef` 1.5s 防抖防 attach storm；`userStoppedSessions` 防复活被停止的 turn；`streamStatus` + `reattachStream` 自动重挂。**连接自恢复已达标**。

---

## 二、关键前提：服务端 SSE 心跳

`packages/org-manager/src/sse-handler.ts` 生成消息流时用 `SSEBuffer`，`heartbeatInterval: 15000` —— **服务端对 agent 消息流每 15s 必发一次 `heartbeat`**（若连接还活着）。

推论：
- 「**长任务合法执行**」期间，服务端仍会持续发 heartbeat → 前端会持续拿到数据。
- 因此「**60s 完全收不到任何数据**」只可能发生在连接真正死亡时（半开 TCP / 服务进程退出 / 网络中断 / provider 挂死让服务端不再推流）。
- ⇒ 前端做一个「空转看门狗」是**安全**的，不会误杀长任务。

---

## 三、本次修复

### 1. 新增纯函数库 `packages/web-ui/src/lib/streamResilience.ts`
- `createStreamWatchdog({ signal, timeoutMs?, onStall? })` —— 空转看门狗：
  - 每次读到 chunk（含 heartbeat）后 `bump()` 重置计时；`timeoutMs` 内无任何数据则触发 `onStall()`（仅一次）。
  - `signal.aborted` 或 `stop()` 立即解除计时（用户停止/导航/流正常结束）。
  - 默认 60s（> 服务端心跳 15s 的 4 倍余量）。
- `exponentialBackoffDelay(attempt, {baseMs,maxMs,maxAttempts,random?})` —— 全抖动指数退避：
  - `delay = random(0, min(base*2^attempt, maxMs))`，attempt 封顶 `maxAttempts-1`；注入 `random` 便于测试。

### 2. 接入 `api.agents.messageStream`（真发送）
- `while(true)` 循环前创建 watchdog（有 signal 时）；每轮 `reader.read()` 后 `bump()`。
- `onStall` → `reader.cancel()`：让卡死的 `read()` 抛错/结束，流优雅降级返回，把「永久思考中」抢救出来。
- `done`/`error`/`catch`/循环正常结束均 `watchdog.stop()` 清理。

### 3. 接入 `api.sessions.reattachStream`（刷新重挂）
- 同样加 watchdog + 全路径 `stop()`。

### 4. Team.tsx DB 兜底轮询改退避
- `pollForReply(5, 2000)` 改用 `exponentialBackoffDelay(i, {baseMs:2000, maxMs:8000, maxAttempts:5})`，指数退避+抖动+上限，避免紧密狂轮。

### 5. 连接自恢复（已有，确认达标）
- WS 重连退避、页签切回续挂、`streamStatus`+`reattachStream`、`since` 增量恢复 —— 服务重启/断连后自动恢复。

---

## 四、测试（`packages/web-ui/test/streamResilience.test.ts`，10 例全过；全 web-ui 182 例全过）
- `exponentialBackoffDelay`：首尝试 0..base 抖动（防雷轰）、指数增长但封顶 maxMs、maxAttempts 封顶、自定义 maxMs。
- `createStreamWatchdog`：超时触发一次、`bump()` 重置防误杀、`stop()` 解除、`signal` abort 解除、stall 后 bump 不复发。
- 默认超时 60s 为服务端心跳 15s 的整数倍多。

---

## 五、验收方向对照

| 验收 | 状态 |
|------|------|
| 流式失败后自动重连、不死循环 | ✅ messageStream/reattachStream 加空转看门狗（reader 不再永久 pending）+ `pollForReply` 退避 |
| 不永久「思考中」 | ✅ 空转看门狗触发 → reader.cancel → 优雅降级收敛；已有 `tryReattachActiveStream` 清「思考中」 |
| 断连自动恢复 | ✅ WS 指数退避重连 + 页签切回续挂 + `reattachStream` + `since` 增量 |
| 范围限 F 域 | ✅ 只改 `web-ui`（api.ts / Team.tsx / 新增 lib + test / 文档），未动后端 |

---

## 五、遗留（非本任务）
- google/ollama 流式 provider 仍是单一定时器（非逐 tick 重置）—— 后端域，见 SS-1 遗留。
- fallback 行为告警 —— 见 MD-3。
- 可视「卡在什么」—— 见 OB-1/OB-2。