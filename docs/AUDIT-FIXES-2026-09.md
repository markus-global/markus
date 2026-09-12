# 集中修复报告 · AUDIT-FIXES-2026-09

> **所属需求**：Markus 客户端核心机制全面审计 → 分支整顿 → 问题修复（`req_1e663c568c5d895535b2f09d`）
> **本任务**：集中修复（`tsk_6c7d14af7f818cb1cb943122`）
> **修复分支**：`fix/audit-2026-09`（基于已 rebase + 压缩后的 `refactor/team-chat-state-machine` @ `252bb935`，**未**直接在原分支改）
> **审计输入**：`/Users/liuqian/.markus/shared/audit-2026-09/00-SUMMARY.md`（P0×3 / P1×15 / P2×31 / P3×38）
> **修订**：round 3 —— 按 QA 退回意见补齐剩余 10 项 P1 + 报告准确性修正。
> **引用纪律**：全文按 `00-DECISION-ID-MAP.md` 新编号（如 LIFO=`D-MB-8`、SSE 续传=`D-API-1`）。

---

## 1. 「问题 → 提交 → 测试/门禁」映射表

| 问题 | 提交 | 防回归测试 / 门禁 | 状态 |
|---|---|---|---|
| **P0-1** 事件接线断裂：`agent:incomplete` 漏登转发白名单 → 任务自愈路径死代码、可永久卡 `in_progress`（同族 `agent:entity-conflict`） | `db6a826a` | `packages/core/test/agent-event-forwarding.test.ts`（5 例）+ 门禁规则 `event-reachability` | ✅ 已修复 |
| **P0-2** 无统一写门禁：shell 重定向（`>`/`>>`/`tee`/`sed -i`/`dd of=`）可绕过 file 工具写任意路径 | `439fa3e0` | `packages/core/test/write-guard.test.ts`（20 例，含反向测试）+ 门禁规则 `write-gate` | ✅ 已修复 |
| **P0-3** 激活被静默回退 → discover 死循环：已激活工具被驱逐后静默 `delete` 激活态，工具彻底不可见 | `074bab53` | `packages/core/test/tool-selector.test.ts`（P0-3 用例：25 个已激活 MCP 全部 LIVE、`consumeEvictedActivated()==[]`） | ✅ 已修复（**残余风险见 §4.1**） |
| **P1-2** strict 状态项合并守卫只覆盖 2/4 类 → 评审/需求动作被 informational 项合并吞掉 | `4ffd3f99` | `packages/core/test/mailbox-strict-merge.test.ts`（4 例） | ✅ 已修复 |
| **P1-3** 重连流 `attach()` 无心跳定时器 → 前端 60s stall 看门狗误判死连接并 `reader.cancel()` | `7096ca58` | `packages/org-manager/test/active-stream-registry.test.ts`（P1-3 两例：60s 内 ≥4 帧心跳 / 完成后停跳动） | ✅ 已修复 |
| **P1-5** 事件层无投递语义：监听器异常被**静默吞**（无日志/无计数） | `0d305007` | `packages/core/test/events.test.ts`（P1-5 两例：计数+不中断广播 / 健康总线计数为 0） | ✅ 已修复（异常可见性；**seq/ack/回放见 §4.2**） |
| **P1-6 / D-MB-10** 防回潮门禁缺位：architecture-guard 仅 3 条规则，不覆盖本批不变量 | `0cc381ed` | `packages/core/test/architecture-guard.test.ts`（5 例：违规夹具必红 / 登记后必绿） | 🟡 **部分完成（见 §2.6）** |
| **P1-7** catalog 未命中静默用 1,000,000 窗口兜底 → 预算系统性失真、小窗模型 400 溢出 | `fccb7f96` | `packages/core/test/llm-router-budget-window.test.ts`（3 例：未登记模型**绝不用 1M** / 常量保守 / env 覆盖） | ✅ 已修复 |
| **P1-8** 预算按 provider 默认模型而非生效模型解析 | `fccb7f96` | `...llm-router-budget-window.test.ts`（2 例：覆盖模型窗口 < 默认模型窗口；maxOutput 同步） | ✅ 已修复 |
| **P1-9** token counter 进程级单例跨 agent 串扰 + 流式路径从不激活模型 | `dfe3c5cc`（+ `d06515e1` 修 Vitest require） | `packages/core/test/token-counter-p1-9-10.test.ts`（4 例：两计数器状态隔离 / 交替两族模型计数稳定） | ✅ 已修复 |
| **P1-10** Anthropic `countTokens` 未接线 | `dfe3c5cc` | `...token-counter-p1-9-10.test.ts`（2 例：init 后可调 count API / 无 key 优雅回退） | ✅ 已修复 |
| **P1-11** MCP 工具永不注销 + 重连不刷新清单 | `bc119a5a` | `packages/core/test/mcp-client-p1-11.test.ts`（3 例：连接广播新清单 / 退出广播空表 / 断连调用明确报错） | ✅ 已修复（**列表级；见 §4.3**） |
| **P1-12** `deliverable_create` 即使被激活也在 converse 下被无条件剔除 | `bc9695c2` | `packages/core/test/tool-selector-activation.test.ts`（2 例） | ✅ 已修复 |
| **P1-13** skill 惰性激活不可靠：读盘失败 ≡「无指令」 | `b3e20ee5` | `packages/core/test/skill-loader-p1-13.test.ts`（3 例：缺失/可读/不可读三分）+ 提示词语义修正 | ✅ 已修复 |
| **P1-14** `beginStream` 无条件置忙、清理被 `if (streamSessionId)` 门控 → 新会话首包前失败则侧栏永久「工作中」 | `bb14b55f` | 见 §4.4（web-ui 无 hook 测试夹具；改动为 1 行门控去除 + 纯 manager 配对语义） | 🟡 已修复（**测试缺口见 §4.4**） |
| **P1-15** reattach 两条静默 `early-return` 不平账 → 气泡永久「思考中」+ busy 残留 | `bb14b55f` | 同上（新增 `finalizeIfDetached()` 在两条早退处平账） | 🟡 已修复（**测试缺口见 §4.4**） |
| **F1 · D-API-1** SSE 续传（`id:` / `Last-Event-ID` / `afterSeq`） | — | `prep/F1-D-API-1-sse-resume-prep.md`（草案，**不进仓**） | 🟡 技术侧准备（待 Owner 决策） |
| **F2 · D-MB-8** 同会话同优先级 LIFO → FIFO | — | `prep/F2-D-MB-8-same-session-order-prep.md` + 最小复现（草案，**不进仓**） | 🟡 技术侧准备（待 Owner 决策） |
| **P1-1**（D-API-1）/ **P1-4**（D-MB-1） | — | — | ⛔ Owner 决策阻塞，不做（见 §5） |
| P2（31）/ P3（38） | — | — | ⛔ 任务书为「视时间做」，本轮未纳入（见 §5） |

> 六条命令可复现本表全部用例（见 §6）。共 **13 个修复提交 + 1 个 docs 提交**（`252bb935..HEAD`）。

---

## 2. 逐项修复说明（含根因）

### 2.1 P0 三项（上一轮已交付，本轮未回退）
- **P0-1**（`db6a826a`）：白名单抽为模块级 `AGENT_FORWARDED_EVENTS` + `wireAgentEventForwarding()` 纯函数；补登 `agent:incomplete` / `agent:entity-conflict`；门禁 `event-reachability` 静态要求「有外部订阅者的 agent 级事件必须登记」。
- **P0-2**（`439fa3e0`）：新增 `write-guard.ts`，收口 `assertWriteAllowed()` / `extractShellWriteTargets()`（拦 `>`/`>>`/`tee`/`sed -i`/`dd of=`，跳过 fd 复制与引号内容）/ `assertShellWriteAllowed()`；`file.ts`、`shell.ts` 接入同一门。
- **P0-3**（`074bab53`）：所有已激活工具晋升 `protected`；`pruneEvictedActivatedTools` 改保留 sticky + `log.warn`，不再静默 `delete`。

### 2.2 P1-3 · 重连流心跳（`7096ca58`）
- 根因：`ActiveStreamSession.attach()` 只转发存量 + 后续事件，**不发心跳**；前端 `streamResilience.ts` 的 60s stall 看门狗假定服务端每 15s 有一帧 → 慢工具/长思考时合法静默被判死连接。
- 修复：`attach()` 内启动 15s `setInterval`（`unref()`，写 `{type:'heartbeat'}`），流终止 / `res.close`/`error` 时清理。

### 2.3 P1-5 · 事件异常可见性（`0d305007`）
- 根因：`EventBus.emit` 的 `catch {}` 无日志、无计数 → 订阅方故障不可观测。
- 修复：保留「不中断其他监听器」语义，但 `log.warn` + `listenerErrors++`，新增 `getListenerErrorCount()`。
- **未做**：事件 `seq`/`ack`/回放属产品语义（`D-MB-6`）→ 见 §4.2。

### 2.4 P1-7 / P1-8 · 预算窗口（`fccb7f96`）
- 根因：`DEFAULT_CONTEXT_WINDOW_FALLBACK = 1_000_000`（catalog 未命中即给 1M）；`getModelContextWindow(provider)` 取 `provider.model` 而非 `getEffectiveModel()`。
- 修复：兜底改为 **32,768**（保守），支持 `MARKUS_FALLBACK_CONTEXT_WINDOW` 覆盖 + 上界 sanity 钳制；`getModelContextWindow(provider, model?)` / `getModelMaxOutput(provider, model?)` 增可选 `model`；`agent.getPrepareBudgetOpts()` 传 `getEffectiveModel()`。

### 2.5 P1-9 / P1-10 · token 计数器（`dfe3c5cc`）
- 根因：`getDefaultTokenCounter()` 进程级单例（`activeModel`+编码器槽跨 agent 互覆）；`setActiveModel` 仅非流式路径调用；`initTokenCounter()` 生产从未接线。
- 修复：新增 `createTokenCounter()`（每 agent 独立实例，继承 `initTokenCounter` 凭据）；`resolveEncoder()` 在计数时刻按 `activeModel` 回查模块级编码器缓存；`Agent` 用专有计数器并在**流式 + 非流式**两条路径都激活模型；`AgentManager` 启动期按环境变量调 `initTokenCounter`；新增 `isAnthropicTokenCounterEnabled()`。
- 附带修正（`d06515e1`）：`Agent` 内改用静态导入（Vitest 下 `require('./token-counter.js')` 解析失败）。

### 2.6 P1-6 / D-MB-10 · 门禁（`0cc381ed`）—— **部分完成**
- 已交付规则①（事件可达性）+ 额外 `write-gate` 规则（G1，属 P0-2 配套）。
- 审计建议的 4 条规则中，**尚缺 3 条**：②严格状态项守卫一致性（`isStrictStateItem` 被所有合并/丢弃路径使用）③并发闸唯一入口 ④SSE 帧必须带 `id:`。→ 这三条与 `D-MB-3`/并发闸/`D-API-1` 语义耦合，**待决策后再落**（④依赖 `D-API-1`）。
- 上一轮报告标「✅ 已修复」偏高，本次已更正为「🟡 部分完成」并列明缺口。

### 2.7 P1-11 · MCP 工具生命周期（`bc119a5a`）
- 根因：子进程退出只 `servers.delete`，agent 工具表永不删项（stale 工具残留）；重连只换进程，不保证清单刷新。
- 修复：新增 `setOnToolsChanged(cb)`，在**退出广播 `[]`**、**连接/重连广播最新 `tools/list`**；对不可达 server 的调用返回明确 `MCP server "…" is disconnected …` 错误；`AgentManager` 订阅并 `log.info` + emit `agent:mcp-tools-changed`（可观测）。
- **残余**：见 §4.3（agent 工具表热刷新未接线）。

### 2.8 P1-13 · skill 惰性激活（`b3e20ee5`）
- 根因：`readSkillInstructions` 把「无 SKILL.md」与「读盘失败」都返回 `undefined`。
- 修复：新增 `readSkillInstructionsDetailed()` 返回 `{ok:true,instructions?} | {ok:false,error}`（旧函数保留为兼容包装）；`SkillManifest.instructionsLoadError` 新字段；loader/index 读失败 `log.warn` + 标记；`discover_tools` 目录标签增 `load error`；系统提示修正「无指令 ≠ 其 MCP 工具可直接调用」的误导语义。

### 2.9 P1-14 / P1-15 · 前端 busy/reattach 平账（`bb14b55f`）
- P1-14：收尾清理 `if (streamSessionId) clearStreamSession(...)` → **无条件** `clearStreamSession(sendKey, streamSessionId ?? undefined)`（`removeStreamSession` 已支持 sid 省略＝整键清理）。
- P1-15：新增 `finalizeIfDetached()`，在 reattach 的**冷却早退**与**非活跃早退**两处补 `finalizeLastStreamingBubble` + `clearStreamSession`，且仅在本地无 stream session 归属时清理（不抢拆他人流）。

---

## 3. 回归结果（在最终修复树实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（`tsc -b` + web-ui `--noEmit`） | ✅ **exit 0** |
| 架构门禁 | `node scripts/architecture-guard.mjs` | ✅ 通过（31 处命中全部在白名单内） |
| core 全量 + HTTP 连续性门禁 | `npx vitest run packages/core packages/org-manager/test/session-continuity-http.test.ts` | ✅ **175 文件 / 2629 通过 / 9 skipped / 0 失败** |
| 前端 | `npx vitest run packages/web-ui/test/*.test.ts` | ✅ 57 通过（含 streamResilience / ConversationBufferManager） |

> 新增 4 个测试文件（`llm-router-budget-window` / `token-counter-p1-9-10` / `skill-loader-p1-13` / `mcp-client-p1-11`）+ 扩展 3 个（`events` / `active-stream-registry` / `mcp-client`）。
> **未覆盖** cli / shared / storage / a2a / comms / gui 的独立套件（建议 CI `pnpm quality` 全量确认）。

---

## 4. 残余风险与已知限制（如实记录）

### 4.1 P0-3 残余：已激活工具全豁免驱逐 ⇒ toolDef 预算上界失效
- 现状：所有已激活 skill/MCP 工具晋升 `protected`，**不再受 pack budget 驱逐**。当模型一次激活大量大 schema 工具（测试用例即断言 **25 个已激活 MCP 全部 LIVE**），toolDef token 预算上界实际被穿透，可能挤压 prompt 可用空间。
- 取舍：这是为消除「激活即被静默驱逐 → discover 死循环」（token 空烧）而做的**有意取舍**。
- 建议后续：对「已激活工具总量」设上限或告警（如超过 N 个/超过 K tokens 时 `log.warn` 或回执模型），而非无限豁免。本轮未实现（属新增机制，非本轮退回项）。

### 4.2 P1-5 残余：事件层无 seq/ack/回放
- 已修监听器异常可见性；**事件 `seq`/ack/短窗口回放**属产品语义（`D-MB-6`），未做 → 待 Owner 决策。

### 4.3 P1-11 残余：agent 工具表热刷新未接线
- 已修：MCP 管理器层的**清单变化信号**（退出→[]、连接→最新清单）+ 断连调用明确报错 + 可观测日志/事件。
- 未接线：把该信号转换为「agent 工具表注销/重注册」的消费端。现有 `getToolHandlers*` 已从 `servers` 实时派生（故重新获取即正确），但已注册进 agent 的 handler 未被主动剔除。属后续小改动（消费 `agent:mcp-tools-changed`）。

### 4.4 P1-14 / P1-15 残余：缺 jsdom hook 测试
- 修复已落地（`useChatStream.ts`），web-ui 现有套件（纯函数 / 纯 manager）全绿；但**未新增 hook 级 jsdom 用例**（本仓库 web-ui 无 hook 测试夹具，搭建成本高）。评审建议的 jsdom 用例仍是缺口。

---

## 5. 未修复项与原因（如实列出）

| 问题 | 未修复原因 |
|---|---|
| **P1-1** SSE 缺 `id:`/续传 | 协议/产品语义变更，对应 Owner 决策 `D-API-1`；未获批准前不实施 → 仅技术侧准备（F1） |
| **P1-4** backstop requeue 无重试上限 | 与 Owner 决策 `D-MB-1`（被 backstop 取消的 item 是否重放）语义耦合，需先拍板 |
| **P1-6 尚缺 3 条规则** | 与 `D-MB-3` / 并发闸 / `D-API-1` 语义耦合，待决策（§2.6） |
| **P2（31）/ P3（38）** | 任务书为「视时间做」；本轮聚焦 P0 + 全部可行 P1 + 门禁，P2/P3 未纳入 |

---

## 6. 边界与合规声明

- ✅ **不擅自合并 main、不擅自发版**：全程只在 `fix/audit-2026-09` 上提交；未触碰共享检出。
- ✅ **产品语义先报 Owner**：`D-API-1`（SSE 续传）、`D-MB-8`（同会话顺序）、`D-MB-1`（backstop 重放）、`D-MB-6`（事件投递语义）、`D-REQ-1/2` 等**均未实施**，只做技术侧准备或留待决策。
- ✅ **每条修复成对交付**：修复提交 + 测试/门禁（见 §1）；无「无测试的修复」，例外（P1-14/15 的 jsdom 缺口、P0-3 残余）已在 §4 明列。
- ✅ **不破坏已落地三重守卫**：编译期契约、运行期 unknown 告警、提交前门禁均保留，并在其上新增两条门禁规则。
- ✅ **单次改动小、可独立回滚**：13 个修复提交按问题拆分，各自可独立 revert。

## 7. 复现步骤

```bash
cd <仓库> && git fetch origin
git checkout fix/audit-2026-09
pnpm install --prefer-offline --frozen-lockfile
pnpm -r build
npm run typecheck
node scripts/architecture-guard.mjs
npx vitest run packages/core packages/org-manager/test/session-continuity-http.test.ts
# 本轮新增/扩展的专项：
npx vitest run \
  packages/core/test/{llm-router-budget-window,token-counter-p1-9-10,skill-loader-p1-13,mcp-client-p1-11,events,mcp-client}.test.ts \
  packages/org-manager/test/active-stream-registry.test.ts \
  packages/web-ui/test/{streamResilience,ConversationBufferManager}.test.ts
```
