# 集中修复报告 · AUDIT-FIXES-2026-09

> **所属需求**：Markus 客户端核心机制全面审计 → 分支整顿 → 问题修复（`req_1e663c568c5d895535b2f09d`）
> **本任务**：集中修复（`tsk_6c7d14af7f818cb1cb943122`）
> **修复分支**：`fix/audit-2026-09`
> **基线**：从已 rebase + 压缩后的 `refactor/team-chat-state-machine` @ `252bb935` 新建分支（未直接在原分支改）
> **审计输入**：`/Users/liuqian/.markus/shared/audit-2026-09/00-SUMMARY.md`（87 条问题，P0×3 / P1×15 / P2×31 / P3×38）

---

## 1. 「问题 → 提交 → 测试/门禁」映射表

| 问题 | 提交 | 防回归测试 / 门禁 | 状态 |
|---|---|---|---|
| **P0-1** 事件接线断裂：`agent:incomplete` 漏登转发白名单 → 任务自愈路径死代码、可永久卡 `in_progress`（同族 `agent:entity-conflict`） | `db6a826a` | `packages/core/test/agent-event-forwarding.test.ts`（5 例）+ 门禁规则 `event-reachability` | ✅ 已修复 |
| **P0-2** 无统一写门禁：shell 重定向（`>`/`>>`/`tee`/`sed -i`/`dd of=`）可绕过 file 工具写任意路径 | `439fa3e0` | `packages/core/test/write-guard.test.ts`（20 例，含反向测试）+ 门禁规则 `write-gate` | ✅ 已修复 |
| **P0-3** 激活被静默回退 → discover 死循环：已激活工具被驱逐后静默 `delete` 激活态，工具彻底不可见 | `074bab53` | `packages/core/test/tool-selector.test.ts`（P0-3 用例：25 个已激活 MCP 全部 LIVE、`consumeEvictedActivated()==[]`） | ✅ 已修复 |
| **P1-2** strict 状态项合并守卫只覆盖 2/4 类 → 评审/需求动作被 informational 项合并吞掉，永不执行 | `4ffd3f99` | `packages/core/test/mailbox-strict-merge.test.ts`（4 例：谓词覆盖 4 类 + 不被合并 + 对照组合并仍生效） | ✅ 已修复 |
| **P1-6 / D-MB-10** 防回潮门禁缺位：architecture-guard 只有 3 条规则，不覆盖本批事件/写门禁不变量 | `0cc381ed` | `packages/core/test/architecture-guard.test.ts`（5 例：违规夹具必红 / 登记后必绿 / 通用事件不误报） | ✅ 已修复 |
| **P1-12** `deliverable_create` 即使被激活也在 converse 下被无条件剔除（splice 在 activated 注入之后） | `bc9695c2` | `packages/core/test/tool-selector-activation.test.ts`（2 例：未激活剔除 / 已激活放行） | ✅ 已修复 |
| **F1 · D-API-1** SSE 续传（`id:` / `Last-Event-ID` / `afterSeq`） | — | `prep/F1-D-API-1-sse-resume-prep.md`（草案，**不进仓**） | 🟡 技术侧准备（待 Owner 决策） |
| **F2 · D-MB-8** 同会话同优先级 LIFO → FIFO | — | `prep/F2-D-MB-8-same-session-order-prep.md` + 最小复现（草案，**不进仓**） | 🟡 技术侧准备（待 Owner 决策） |
| **P1-1 / 3 / 4 / 5 / 7 / 8 / 9 / 10 / 11 / 13 / 14 / 15**，P2 / P3 | — | 见 §4「未修复项与原因」 | ⛔ 本轮未修复（列明原因） |

---

## 2. 逐项修复说明（含根因）

### P0-1 · 事件可达性（`db6a826a`）
- **根因（结构型 M-A「双入口/双真相源」）**：事件在 agent 私有 bus `emit`，唯一消费者（`cli/start.ts` 的 WS 广播 + `TaskService.recoverLostTaskExecution`）订阅在 manager bus；转发白名单 `FORWARDED_EVENTS` 是**手写局部数组**、漏登即静默死代码。
- **修复**：白名单抽为模块级 `AGENT_FORWARDED_EVENTS` + `wireAgentEventForwarding()` 纯函数（便于单测与静态强制）；补登 `agent:incomplete` 与 `agent:entity-conflict`。
- **机制守住**：门禁 `event-reachability` 静态要求「在 agent 私有 bus 发射者文件里 emit、且被外部 `on()` 订阅的事件」必须登记白名单。

### P0-2 · 单一写门禁（`439fa3e0`）
- **根因（结构型 M-B「守卫只覆盖部分路径」）**：写约束只写在 `file_write`/`file_edit`/`apply_patch`，9 条写路径只有 3 条受控；`shell_execute` 完全绕过。
- **修复**：新增 `packages/core/src/write-guard.ts`，收口三件事：
  - `assertWriteAllowed(path, {policy})`：`denyWritePaths`（其他 agent 工作区，**边界感知**）+ 敏感文件 denylist；
  - `extractShellWriteTargets(cmd)`：静态解析 `>`/`>>`/`>|`/`tee`/`sed -i`/`dd of=` 写目标，**跳过 fd 复制**（`2>&1`、`>&2`）与引号内容；
  - `assertShellWriteAllowed(cmd)`：逐目标过同一道门。
- `file.ts` 的 deny 判定改为引用 `write-guard`（单一源，行为一致且修正同前缀误伤）；`shell.ts` 执行前插入门禁。
- **已知残余风险**（如实记录）：解析为启发式，不覆盖 `bash -c "…嵌套重定向…"`；但只在目标确实命中 deny 时拒绝，故不会误伤正常写入。

### P0-3 · 已激活工具（`074bab53`）
- **根因（结构型 M-D「无仲裁/无回执」）**：`protectedNames` 只豁免「非 skill/MCP」的激活工具；skill/MCP 激活后可同轮被驱逐 → `pruneEvictedActivatedTools` 静默 `delete` → 永久不可见 → `discover_tools` 死循环。
- **修复**：tool-selector 中**所有已激活工具晋升 protected**（未激活 skill/MCP 仍按渐进披露延迟）；`pruneEvictedActivatedTools` 改为**保留 sticky + `log.warn`**，不再静默删除。

### P1-2 · strict 谓词统一（`4ffd3f99`）
- **根因（结构型 M-B）**：合并/清理路径只检查 `triggerExecution`（4 类中的 1 类）。
- **修复**：`mergeByEntity`（task/requirement/channel 三组）、`consolidateGroup`、`purgeStaleItems`、`dropStatusUpdatesByTaskId`、`tryMergeIntoExisting`（含其 find 守卫）统一改用共享谓词 `isStrictStateItem`。

### P1-12 · 激活放行（`bc9695c2`）
- **根因（实现型）**：`CONVERSE_FORBIDDEN_DEFAULT` 的 splice 发生在 activated 注入之后。
- **修复**：splice 增加 `!activated.has(n)` 守卫（未激活仍 discover-only）。

---

## 3. 回归结果（在最终修复树上实测）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（`tsc -b` + web-ui `--noEmit`） | ✅ **0 error** |
| 架构门禁 | `node scripts/architecture-guard.mjs` | ✅ 通过（31 处命中全部在白名单内） |
| core 全量 + HTTP 连续性门禁 | `npx vitest run packages/core packages/org-manager/test/session-continuity-http.test.ts` | ✅ **171 文件 / 2610 通过 / 9 skipped / 0 失败** |
| 会话不变量套件 / 双会话 e2e | 含于上表（`agent-concurrent-e2e`、`agent-concurrent-cancel-isolation` 等） | ✅ 通过 |

> 说明：核心套件覆盖 core 全量 + org-manager 的 HTTP 连续性门禁。**未覆盖** cli / shared / storage / a2a / comms / web-ui / gui 的独立套件（建议 CI `pnpm quality` 全量确认）。本轮 3 处前端 P1（P1-14/15）未改，不影响 web-ui 套件。

---

## 4. 未修复项与原因（如实列出）

| 问题 | 未修复原因 |
|---|---|
| **P1-1** SSE 缺 `id:`/续传 | 属**协议/产品语义**变更，对应 Owner 决策 `D-API-1`；未获批准前不得实施 → 仅出技术侧准备（F1） |
| **P1-3** 重连流无心跳定时器 | 需改 `active-stream-registry` + 时序测试（60s 内 ≥4 次心跳）；本轮窗口未及，改动小，建议下一批 |
| **P1-4** backstop requeue 无重试上限 | 与 Owner 决策 `D-MB-1`（被 backstop 取消的 item 是否重放）语义耦合，需先拍板再统一实施 |
| **P1-5** 事件层无投递语义（seq/ack/回放） | 结构型、改动面大；本轮先落 `event-reachability` 门禁防接线断裂 |
| **P1-7 / P1-8** 预算窗口按 provider 默认模型 / catalog 1M 兜底 | 需改 `llm/router.ts` 预算解析路径，建议与 P1-9 成批修（同一机制域） |
| **P1-9** token counter 单例串扰 | 结构性（per-agent/per-request 下放），改动中 |
| **P1-10** Anthropic `countTokens` 未接线 | 配置型；需 AgentManager 启动期接线 |
| **P1-11** MCP 工具永不注销 | 中改动（新增 `unregisterTool`/`syncToolsForServer` + 重连 diff） |
| **P1-13** skill 惰性激活不可靠 | 中改动（loader 返回 `{ok,error}` 语义 + 提示词修正） |
| **P1-14 / P1-15** 前端 busy/reattach 不平账 | 前端（web-ui）；本轮回归未覆盖 web-ui 套件，建议下一批带 jsdom 用例 |
| **P2（31）/ P3（38）** | 任务书为「视时间做」；本轮聚焦 P0 + 防复发门禁 + 高价值 P1，P2/P3 未动（未列入本轮范围） |

---

## 5. 边界与合规声明

- ✅ **不擅自合并 main、不擅自发版**：全程只在 `fix/audit-2026-09` 上提交。
- ✅ **产品语义先报 Owner**：`D-API-1`（SSE 续传）、`D-MB-8`（同会话顺序）、`D-MB-1`（backstop 重放）、默认并发度 `D-MB-2`、取消提示 UI `D-REQ-1`、S7 拆 tab `D-REQ-2` 等**均未实施**，只做技术侧准备或留待决策。
- ✅ **每条修复成对交付**：修复提交 + 测试/门禁（见 §1）；无「无测试的修复」。
- ✅ **不破坏已落地三重守卫**：编译期契约、运行期 unknown 告警、提交前门禁均保留，并在其上**新增**两条门禁规则。
- ✅ **单次改动小、可独立回滚**：6 个提交按问题拆分，各自独立 revert 不影响其他。

## 6. 复现步骤

```bash
cd <仓库> && git fetch origin
git checkout fix/audit-2026-09
pnpm install --prefer-offline --frozen-lockfile
pnpm -r build
npm run typecheck
node scripts/architecture-guard.mjs
npx vitest run packages/core packages/org-manager/test/session-continuity-http.test.ts
# 单条专项：
npx vitest run packages/core/test/{agent-event-forwarding,write-guard,mailbox-strict-merge,tool-selector-activation,architecture-guard}.test.ts
```
