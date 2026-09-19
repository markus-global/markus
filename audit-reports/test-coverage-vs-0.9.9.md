# 测试覆盖评估 · v0.9.9 → `feat/ui-optimize-0917`

> 评估时间：2026-09-18
> 评估对象：`feat/ui-optimize-0917` @ `a3161011`（merge PR #319）
> 基线：tag `v0.9.9`
> 目的：判断自 0.9.9 以来的变更，测试覆盖是否足以支撑发一个新版本
> 纪律：本报告只做只读分析，未修改任何业务代码；所有结论附可复现命令。

---

## 0. 一句话结论

**后台（core / org-manager / storage）的测试是够硬发版的；前端是短板，且短板是"制度性"的——不是没人写测试，而是测试基础设施把整个 web-ui 排除在覆盖率门槛之外。**

具体地：

1. **后端核心链路覆盖扎实**。这一轮最危险的四类改动（并发/Mailbox、任务单飞、会话身份、上下文工程）都配了成对的行为级测试，共 **新增 73 个测试文件 / 改动 110 个**，而且很多是"真实 SQLite / 真实 worker / 真实 HTTP"的集成测试，不是 mock 摆拍。
2. **前端 87 个变更文件里有约 20 个高风险文件完全没有测试**，包括 `useChatStream.ts`(1437 行)、`AgentProfile.tsx`(2896 行)、`ChatTeamSidebar.tsx`(1885 行)、`AnimationBudget.ts`(107 行)。而这一轮修的恰恰全是 UI 性能/状态 bug——**修了 bug 却没有回归护栏**。
3. **覆盖率门槛对前端是失效的**：`vitest.config.ts` 的 `coverage.include` 只匹配 `.ts`（不含 `.tsx`），且 `exclude` 里直接排除了 `packages/web-ui/**`。所以前端**一行代码都不计入覆盖率**，CI 永远不会因此变红。
4. 另有两处"看起来有测试、实际守不住根因"的假绿（Codex 工具调用、token 计数器接线），详见 §4。

**发版建议**：后台可以直接发；前端建议在发版前补 **2 项最低成本护栏**（见 §5 的 P0），其余列入下一版。

---

## 1. 变更规模与构成

```
基线 v0.9.9 → HEAD a3161011
145 commits / 274 files changed / +37008 −4217
```

提交类型分布：`fix 82` · `feat 19` · `merge 16` · `refactor 11` · `perf 5` · `docs 5` · `test 3` · `chore 2`

按包分布（变更文件数）：

| 包 | 变更文件 | 说明 |
|---|---|---|
| `packages/core` | 113 | 主战场 |
| `packages/web-ui` | 87 | 分支主题（UI 优化） |
| `packages/org-manager` | 24 | 任务/需求/SSE |
| `packages/cli` | 9 | 模型发现、启动接线 |
| `packages/storage` | 7 | 迁移、事务、未读 |
| `packages/shared` | 7 | 类型、限额 |
| `packages/desktop` | 3 | 窗口激活 |

新增非测试源文件 **24 个**，新增测试文件 **73 个**，改动测试文件 **110 个** —— 从"修复成对交付"的角度看，比例是健康的。

### 四条主线

**A. 并发与状态机根治（最危险，也最扎实）**
- Mailbox：原子认领 / 租约 / 重投不丢 `review_request` / 评审单播 / 严格状态项合并
- 任务执行：task 级单飞（派发侧拒绝 + 消费侧 drop 留痕）+ settle CAS + 修订轮 deferred re-arm
- Agent 并发：worker 定向取消、活动状态隔离、写锁覆盖、统一并发闸
- 会话身份贯通：消灭"同一会话后续请求看不到历史"、a2a 会话按对话绑定、补齐 DB→memory 绑定

**B. ContextOS v2 → v5**
- 尾块变更门控、压缩管线缺陷修复、缓存作用域布局、完备性检查点、工具前缀冻结、场景×channel 一致性

**C. LLM 适配器与模型发现**
- Codex 丢工具调用、Gemini `functionResponse.name` 用错 / 思维链泄漏 / 安全拦截崩溃、Anthropic 并行 `tool_result` 被拒 + 流内 error 被吞
- 模型发现统一走 provider 官方 `/models`，不再硬编码清单
- 预算窗口按生效模型解析，catalog 未命中改保守兜底

**D. UI / UX 修复**（分支主题）
- Team Chat 会话状态机（空态/加载态/流式态）、多 session tab 并发串台、断开空闲态重渲染死循环（100%+ CPU 真因）、未读口径统一、侧栏 busy 单一事实源、移动端空白卡死、markdown 货币误判公式、中文路径二次编码

---

## 2. 测试现状（规模 / 环境 / 门禁）

### 规模

| 包 | 测试文件数 |
|---|---|
| `core` | 190 |
| `org-manager` | 56 |
| `cli` | 32 |
| `web-ui` | 25 |
| `shared` | 15 |
| `storage` | 13 |
| `comms` | 10 |
| `a2a` | 5 |
| **合计** | **360** |

### 运行环境

- vitest 4.0.18，全局 `environment` 未设置（默认 `node`）
- **未安装 jsdom，也未安装 `@testing-library/react`**（root devDependencies 里测试相关只有 `vitest` + `@vitest/coverage-v8`）
- `vitest.setup.ts` 把 `process.env.HOME` 指向临时目录——**所有测试都不会碰真实 `~/.markus`**，这个设计很加分
- `test.include` 为 `packages/*/test/**/*.test.ts` 与 `packages/*/src/**/*.test.ts` —— **只匹配 `.ts`，`.tsx` 测试文件不会被收集**（目前仓库里 `.test.tsx` 数量为 0，属"通道未开"而非"有测试没跑"）

### 覆盖率门槛（关键问题）

```ts
coverage: {
  provider: 'v8',
  include: ['packages/*/src/**/*.ts'],   // ← 不含 .tsx
  exclude: [ ..., 'packages/web-ui/**', ... ],  // ← 整个前端被排除
  thresholds: { statements: 75, branches: 65, functions: 78, lines: 80 },
}
```

后果：**前端一行代码都不进覆盖率分母，也不受任何门槛约束。** 如果哪天直接删掉 `packages/web-ui/**` 这行并加上 `.tsx`，会瞬间击穿现有阈值导致 CI 全红——所以不能"顺手放开"，得配**独立的 web-ui 覆盖率项目 + 独立阈值**。

### 实测结果（本机，2026-09-18，HEAD `a3161011`）

| 范围 | 命令 | 结果 |
|---|---|---|
| web-ui 全量 | `npx vitest run packages/web-ui` | ✅ **25 文件 / 461 用例全绿**，耗时 0.8s |
| core 关键回归子集（write-guard / architecture-guard / token-counter / wiring-contracts / mailbox-strict-merge / mailbox-claim-lease / task-execution-entity-exclusivity / context-engine / conversation-session-invariants） | `npx vitest run <9 files>` | ✅ **9 文件 / 99 用例全绿**，8.5s |
| org-manager `api-server-extended.test.ts` | `npx vitest run <file>` ×3 | ✅ **163 用例全绿**（该文件历史上曾失败，见 §3 补充） |
| org-manager 本轮新增 9 个用例文件 | — | ✅ 9 文件 / 77 用例全绿 |
| shared + storage + desktop 新增 9 个文件 | — | ✅ 9 文件 / 85 用例全绿 |
| core 全量（199 文件）· 本机带 `MARKUS_HUB_*` 凭据 | `npx vitest run packages/core` | ⚠️ **1 failed / 2856 passed / 9 skipped**（45s）—— 见 §2.5 |
| core 同一文件 · 清掉凭据环境变量后 | `env -u MARKUS_HUB_TOKEN -u MARKUS_MODELS_URL -u MARKUS_HUB_URL …` | ✅ **68 用例全绿** |

### 2.5 ⚠️ 本机 core 是红的 —— 根因是**测试隔离缺口**，不是代码缺陷

**现象**：`packages/core/test/llm-markus-provider.test.ts` 中
`soft-stop when remaining credits are 0 > does not soft-block when hubRemainingHint is 0 but Hub sync is unavailable`
在本机**确定性失败**（连跑复现，非 flaky）：

```
FAIL  … > does not soft-block when hubRemainingHint is 0 but Hub sync is unavailable
Error: CU_EXCEEDED: Organization credits exhausted
 ❯ MarkusProvider.assertCreditsAvailable src/llm/markus-provider.ts:725:15
```

**根因链**（已逐行确认）：

1. 用例构造 `MarkusProvider` 时**只传** `apiKey / baseUrl / model`，**没有** `hubUrl`、`modelsUrl`，也没有清环境变量；
2. 但 `resolveHubBase()`（`markus-provider.ts:549`）在无显式 `hubUrl` 时会回落：`new URL(this.modelsUrl ?? process.env.MARKUS_MODELS_URL).origin`；
3. 而 `resolveHubToken()`（`:563`）回落 `process.env.MARKUS_HUB_TOKEN`；
4. 本机 shell **恰好设了** `MARKUS_MODELS_URL` 与 `MARKUS_HUB_TOKEN` → `syncHubCredits()` 的守卫 `if (!base || !token) return null` **不生效**，真的走进了 `fetch`；
5. 用例把 `fetch` mock 成返回**聊天补全响应体**（不是 Hub 的 credit 响应），`syncHubCredits` 解析出 `remainingCu = Number(undefined ?? 0) = 0`、`remainingUsd = 0`；
6. → 判定为「Hub 已确认余额为零」→ 命中 `:722` 分支 → **抛 `CU_EXCEEDED`**。

**两个独立问题（严重度不同）**：

**① 测试隔离缺口（高 —— 影响发版验证的可信度）**
`vitest.setup.ts` 隔离了 `HOME`，但**没有隔离 `MARKUS_*` 环境变量**。后果：
- 任何**本机装了凭据**的人（包括 QA）跑 `pnpm test` 都会看到这个假红；CI 是干净环境所以一直是绿的 → **测试结果在「CI」与「开发机」之间不可复现**；
- 更危险的是：假红会让人习惯性忽略红灯，真回归就被淹没了。
- 注：这**不是本分支引入的**——`git diff v0.9.9..HEAD` 对 `markus-provider.ts` 与 `llm-markus-provider.test.ts` **均为空**，v0.9.9 起就如此。

**② 产品侧防御性解析缺口（中 —— 潜在用户可见风险）**
`syncHubCredits()` 里 `Number(data.remainingCu ?? 0)`、`Number(data.openrouter?.remainingUsd ?? 0)` 把**任何非预期响应体**一律当成「0 余额」。于是 Hub `cu/sync` 只要返回 200 但结构变了（字段改名、多包一层 `data`、网关返回 HTML/空体），就会被判定为「余额确认为零」→ **硬停用户聊天 + 触发 credit-exhausted 事件**。
代码本意是「同步失败时不要误判 / 清掉陈旧零值不要假拦截」（`:729-733` 正是为此写的），但这个 `?? 0` 兜底把该保护绕过了。
→ 建议：把「响应体里**根本没有** `remainingCu` 字段」与「字段存在且为 0」区分开，前者按 `null`（同步不可用）处理，而不是按 0。

⚠️ **全仓单跑有坑**：`npx vitest run`（不带包过滤）在本机 **超过 13 分钟仍未收敛**，且进程退出时会出现来自 `packages/shared/src/utils/crash.ts:380` 的 `Error: process.exit unexpectedly called with "1"` 堆栈，并**遗留一个孤儿 fork worker 持续占用 CPU**（实测 27 分钟后仍存活，需手动 kill）。
→ **发版走 CI 前建议先按包并行跑**，并留意是否有某个测试文件在超时边界上打转。另外 `--reporter=basic` 在 vitest 4 已移除（报 `Failed to load custom Reporter from basic`），别照抄老命令。

### CI 门禁（`.github/workflows/ci.yml`，仅在 push/PR → main 触发）

```
pnpm lint
node scripts/architecture-guard.mjs     # 架构门禁（3 条规则 + 白名单）
pnpm typecheck                          # tsc -b + web-ui --noEmit
pnpm test                               # 全量 vitest
# 会话不变量单独再跑一遍（跨 HTTP 线程 / worker 语义，单测覆盖不到）
npx vitest run packages/core/test/conversation-session-invariants.test.ts \
               packages/core/test/session-continuity-smoke.test.ts \
               packages/org-manager/test/session-continuity-http.test.ts
```

其中"会话不变量单独成步"这个设计值得保留——它护住的正是这一轮最核心的修复。

架构门禁当前 3 条规则：`mailbox-claim-uniqueness`、`review-request-protected`、`dependency-engine`。
（注：`docs/AUDIT-FIXES-2026-09.md` 提到的 `event-reachability` / `write-gate` 两条规则在当前 `architecture-guard.mjs` 中未见同名 id，建议核实是改名还是丢失——**这是发版前值得确认的一处不一致**。）

---

## 3. 覆盖扎实的部分（这些不用再花力气）

这一轮的修复质量整体是好的：**每一类"根治性"改动都配了行为级测试**，而且不少是真实集成测试而非 mock 摆拍。

| 子系统 | 变更量 | 测试文件 | 评价 | 说明 |
|---|---|---|---|---|
| ContextOS / context-engine | +722/−186 | 11 | **充分** | 压缩管线、槽位、缓存门控、场景矩阵均有真实行为断言 |
| Mailbox | +802/−48 | 12 | **充分** | 原子认领/租约/重投/评审单播/严格合并全有，含真实 SQLite 跨实例用例 |
| attention / concurrent | +860/−39 | 11 | **充分** | 定向取消、写锁、统一并发闸、worker 隔离全覆盖 |
| 任务执行实体独占 | — | 2（core + org-manager） | **充分** | 派发侧拒绝 + 消费侧 drop 留痕 + settle CAS + 幂等 |
| 会话身份贯通 | — | 3 | **充分** | 不变量测试 + 真实 mailbox→worker 冒烟 + **HTTP 线程级**三层，且 CI 单独成步 |
| storage 迁移/未读/认领 | 7 文件 | 13 | **良好** | 旧库升级 503、requeue 恢复、unread 口径、per-user token 均有 |
| 安全（write-guard / shell 重定向拦截） | 249 行新模块 | 20 例 | **充分** | 含反向测试（"不该拦的不能拦"） |
| 架构门禁 | 538 行新脚本 | 5 例 | **良好** | 违规夹具必红 / 登记后必绿，自检闭环 |

**特别值得肯定的三点：**

1. `packages/core/test/conversation-session-invariants.test.ts` + `session-continuity-smoke.test.ts` + `packages/org-manager/test/session-continuity-http.test.ts` 这三层测试，护住的正是这一轮最难的"同一会话后续请求看不到历史"问题——**单测覆盖不到的跨线程语义，用 HTTP 级门禁兜住了**。
2. `vitest.setup.ts` 把所有测试的 `HOME` 指向临时目录，**保证测试永不污染真实 `~/.markus`**。这类"默认安全"的基础设施做对了，后面补测试的人不会踩坑。
3. `docs/AUDIT-FIXES-2026-09.md` 里那张「问题 → 提交 → 防回归测试/门禁」三列映射表，本身就是很好的工程实践，建议每轮都保留。

> **补充核实**：该文档 §4.5 记录的 "`api-server-extended.test.ts > handleFeishuUserMessage routes to secretary agent` 基线预存失败" —— **在当前 HEAD 已不存在**。实测连跑 3 次全绿（163 例 / 0 失败），该文件本分支已改写（L1302→L1309，+31 行），根因是 `0781a997` 补 mock + `c794cb67` 引入 `waitForResponse` 轮询消除竞态。**发版前应把这段"回归口径仅限 core"的限定语更新掉**，否则 reviewer 会误以为仓里带着一个已知红灯。

---

## 4. 需要加强的部分（按风险排序）

### 4.1 【P0】前端 87 个变更文件里，约 20 个高风险文件零测试

这是本轮最实的问题。分支主题就是 UI 优化，修的全是"用户能直接感知"的 bug，但**没有回归护栏**。

无测试的高风险变更文件（行数为当前 LOC）：

| 文件 | 行数 | 风险 | 对应修复 |
|---|---|---|---|
| `packages/web-ui/src/hooks/useChatStream.ts` | 1437 | **高** | P1-14/P1-15 busy 门控与 reattach 平账 |
| `packages/web-ui/src/pages/AgentProfile.tsx` | 2896 | **高** | 徽标/i18n/分组 |
| `packages/web-ui/src/components/ChatTeamSidebar.tsx` | 1885 | **高** | 侧栏 busy 单一事实源 |
| `packages/web-ui/src/pages/ArtifactDetail.tsx` | 1735 | **高** | 目录预览导航 |
| `packages/web-ui/src/components/NotificationBell.tsx` | 1526 | **高** | 未读/全部过滤 + i18n |
| `packages/web-ui/src/animationBudget.ts` | 107 | **高** | 100%+ CPU 真因（动画预算） |
| `packages/web-ui/src/hooks/useConversationBuffers.ts` | 211 | 中高 | 多 session tab 并发串台 |
| `packages/web-ui/src/hooks/useHubAccount.ts` | 86 | 中高 | **登录多用户 token 隔离（安全级）** |
| `packages/web-ui/src/components/EmbeddedTerminal.tsx` | 540 | 中高 | 终端回放写进 PTY |
| `packages/web-ui/src/pages/AgentBuilder.tsx` | 1063 | 中 | rejected 徽标/重提交流程 |
| `packages/web-ui/src/components/DirectoryPreview.tsx` | 190 | 中 | 新增组件 |
| `packages/web-ui/src/components/ShortcutLessonModal.tsx` | 223 | 中 | 快捷键教学 i18n |
| `packages/web-ui/src/components/RightPanel.tsx` | 182 | 中 | 发送给对话路径标签 |
| `packages/web-ui/src/components/MobileDrawer.tsx` | 91 | 中 | 移动端 |
| `packages/web-ui/src/lib/keyboard-shortcuts.ts` | 84 | 中 | Cmd+N / Ctrl+Tab |
| `packages/web-ui/src/pages/teamPanels.tsx` / `tabDefs.ts` | 150 / 48 | 中低 | 页面拆分新文件 |

**已知保护到位的**（不用重复投入）：Team Chat 状态机转换、多 session 流隔离、未读口径、markdown 货币误判、中文路径二次编码、快捷键 i18n、移动端空白卡死、流式看门狗、thinking delta 路由。

**根因分析**：不是团队不写测试，而是**基础设施把前端排除在外**：

```ts
include: ['packages/*/src/**/*.ts'],      // ← 不含 .tsx，组件测试文件根本不会被收集
exclude: [ ..., 'packages/web-ui/**' ],   // ← 前端整体不计入覆盖率
thresholds: { statements: 75, branches: 65, functions: 78, lines: 80 }
```

加上仓库**未安装 jsdom / `@testing-library/react`**，组件只能靠手写 `globalThis.window` stub 才能 import（见 `ChatComponents.test.ts` 顶部的 `vi.hoisted` workaround）。**这个技术债不还，前端测试就永远是"能写多少写多少"的状态。**

### 4.2 【P0】两处"假绿"——有测试，但守不住根因

1. **`packages/core/test/llm-openai-codex.test.ts:142`**
   用例 `chat collects full stream into non-streaming response` **只断言 `content === 'Done'`**。而这一轮修的正是"Codex 非流式 `chat()` 重拼装时丢工具调用"——**有 bug 的旧实现同样能通过这个断言**。等于该文件看起来在测 Codex，实际对本次修复零保护。
   → 应补断言 `toolCalls` 与 `finishReason === 'tool_use'` 不丢。

2. **`packages/core/test/wiring-contracts.test.ts:43-82`**
   7 个用例全部是对**源码文本**做 `toContain` / `toMatch` 的字符串嗅探（如 `expect(src).toContain('activateTokenCounterForModel()')`）。
   它确实能防止"接线调用被误删"，但**完全无法发现"调用了却不生效"**——而 P1-9 的原始 bug 根因恰恰是"调用了但走的是进程级单例"。
   → 属有意取舍（好过没有），但应补一条端到端断言：接线后 `prepareMessages` 的 usage 来自 Anthropic count API 而非启发式估算。

### 4.3 【P1】LLM 适配器修复：多个高危改动零覆盖

这是本轮"修复最硬、测试最软"的一块。已修但**无任何测试**：

| 修复 | 文件 | 现状 |
|---|---|---|
| Gemini `functionResponse.name` 用错 | `core/src/llm/google.ts` | 全仓搜不到 `functionResponse` 测试，**零护栏** |
| Gemini 安全拦截当 `end_turn` 静默通过 | 同上 | 无测 |
| Gemini 思维链泄漏为正文 / 用量漏算 thinking | 同上 | 无测 |
| Anthropic 流内 `error` 事件被吞（overloaded_error 静默截断） | `core/src/llm/anthropic.ts` | 无测 |
| MiniMax 原生多模态端点缺 `GroupId` 必填参数 | `core/src/llm/minimax.ts` | 无断言 |
| Ollama `done_reason` 被忽略 / 思维链丢弃 | `core/src/llm/ollama.ts` | 无测 |

**为什么这批量级高**：这些都是"静默错误"——不报错，只是结果不对（工具名丢了、内容被截断、计费算少了）。用户侧表现为"Agent 变笨了"，很难归因。发版前值得至少补 Gemini 与 Anthropic 两条。

### 4.4 【P1】核心新增模块没有任何单元测试

| 文件 | 行数 | 问题 |
|---|---|---|
| `core/src/session-hint.ts` | 144 | 会话身份新模块，4 个导出，**全仓 0 处测试符号引用**（仅被 `agent.ts` / `index.ts` 引用）。会话身份是本轮主线之一，属于"高风险 + 零单元护栏" |
| `core/src/atomic-write.ts` | 26 | **记忆/状态落盘的唯一原语**（`memory/store.ts` 依赖）。写临时文件 + `rename` 的正确性、目录不存在、失败不破坏原文件——全无测试 |
| `core/src/tools/process-group.ts` | — | 整组击杀（修子孙进程孤儿泄漏），仅有集成路径，无单元级 `signalTree` / `KILL_GRACE_MS` 测试 |
| `cli/src/lib/provider-models.ts` | 109 | 模型发现新模块，**0 测试**。含 env 优先级、discover 超时降级、空列表回退三条易错逻辑 |

### 4.5 【P1】storage 事务化缺直接测试

`docs/AUDIT-FIXES-2026-09.md` 的 T-012 给 `sqlite-storage.ts` 加了 `runInTransaction`（含 SAVEPOINT 嵌套），但**没有针对事务本身的用例**：内层抛错是否只回滚 SAVEPOINT、外层抛错是否全回滚、成功路径是否提交、`deleteLastExchange` / `migrateLegacyMessages` 中途失败后 DB 是否保持一致。这是"数据一致性"级别的缺口，成本很低（纯 storage 层，无外部依赖）。

### 4.6 【P2】其他

- **`multimodal-providers.test.ts` 在无 API key 时整体 skip** 并注入占位 `it('skipped — no API key')`。CI 无密钥 → 这些真实 provider 用例**全部静默跳过**，覆盖率数字虚高。建议在 CI 里显式打印 skip 清单，或至少让 skip 数量进入门禁。
- **`org-manager/src/sse-handler.ts`** 的 `sessionHint / sessionId` 透传无断言（会话身份链路的最后一公里）。
- **`org-manager/src/requirement-service.ts`** 通知 i18n 的 `titleKey/bodyKey/params` 无断言。
- **`shared/src/utils/config.ts`** 的文件锁（T-010 修的并发丢失写）无测试；本分支未改，但属已知技术债。
- **`.tsx` 测试通道未开**：`test.include` 不含 `.tsx`，目前仓库 `.test.tsx` 数量为 0——**现在补组件测试，文件会静默不被执行**，必须先改配置。
- **`docs/AUDIT-FIXES-2026-09.md` 文档与实际状态漂移**：§4.5 的基线失败已消除；§2.6 说"尚缺 3 条门禁规则"但当前 guard 规则的 id 与该文档记载的 `event-reachability` / `write-gate` 对不上。**发版前应同步，否则后来人会按错的地图找路。**

---

## 5. 发版前建议动作

### 必做（发版阻断级，成本约 1 天）

| # | 动作 | 为什么 | 成本 |
|---|---|---|---|
| 1 | **把 `.tsx` 加入 `test.include`** | 不改这行，任何组件测试文件都**静默不被执行**——补了等于没补 | 5 分钟 |
| 2 | **修掉两处假绿**：Codex 用例补 `toolCalls`/`finishReason` 断言；`wiring-contracts` 补一条端到端生效断言 | 现在的绿灯是"看着在测 Codex / 其实测不到根因" | 2 小时 |
| 3 | **补 `animationBudget.ts` 测试** | 它是"Team 页 100%+ CPU"这个 P0 故障的修复落点，纯函数 + fake timers 即可全覆盖，**零依赖、成本最低、护住最贵的故障** | 2 小时 |
| 4 | **补 `useHubAccount` 多用户 token 隔离测试** | 安全级（跨用户 token 串号）。且它在这轮刚被修过 | 3 小时 |
| 5 | **补 Gemini / Anthropic 两条适配器测试** | 静默错误、用户无感知、排查成本极高 | 3 小时 |
| 6 | **同步 `docs/AUDIT-FIXES-2026-09.md`** 的过期结论（§4.5 基线失败已消除 / §2.6 门禁规则口径） | 发版说明与审计文档要对得上 | 30 分钟 |
| 7 | **修 `MARKUS_*` 测试隔离**（见 §2.5 ①）——在 `vitest.setup.ts` 统一 unset `MARKUS_HUB_TOKEN / MARKUS_HUB_URL / MARKUS_MODELS_URL / MARKUS_OPENROUTER_KEY / MARKUS_OPENROUTER_BASE / MARKUS_CU_REMAINING`（或改为「测试必须显式注入」） | 不修则**发版验证在本机不可复现**：QA 拿到假红、真回归会被淹没。当前本机 core = 1 failed | 30 分钟 |
| 8 | **`syncHubCredits` 防御性解析**（见 §2.5 ②）——「字段缺失」按同步不可用（`null`）处理，而非按 0 | 否则 Hub 响应结构一变 = 全体用户被误判零余额、被硬停聊天 | 1 小时 |

### 强烈建议（同版本内做完，成本约 2–3 天）

7. **搭前端测试基础设施**（这一步不做，前面第 3、4 项都是打补丁）：
   - 依赖：`happy-dom`（比 jsdom 快 2–5×）+ `@testing-library/react@^16`（React 19 兼容线）+ `@testing-library/user-event` + `@testing-library/jest-dom`
   - 配置：**不要**全局切 `environment`（会污染 node 后端测试）。用 vitest 4 的 `projects` 拆出 web-ui 子项目并设 `environment: 'happy-dom'`，或对单个文件用 `// @vitest-environment happy-dom` pragma
   - **覆盖率不要顺手放开**：`exclude: ['packages/web-ui/**']` 一旦删掉 + 加上 `.tsx`，会立刻击穿 75/65/78/80 阈值导致 CI 全红。正确做法是给 web-ui 起**独立 coverage project + 独立低阈值（20–30% 起步）**，再逐版抬升
8. **补 `session-hint.ts` + `atomic-write.ts` 单元测试**：前者是会话身份主线的新模块（0 引用），后者是记忆落盘的唯一原语
9. **补 `storage` 事务（`runInTransaction` / SAVEPOINT）直接测试**：数据一致性级缺口，纯 storage 层、成本低
10. **在 CI 里暴露 skip 数量**：`multimodal-providers.test.ts` 在无 key 时整体静默 skip，覆盖数字虚高

### 下一版（非阻断）

11. 前端组件测试按优先级铺开：`NotificationBell` → `ChatTeamSidebar` → `DirectoryPreview/RightPanel` → `ShortcutLessonModal` → `EmbeddedTerminal`（mock xterm）→ `AgentProfile` / `AgentBuilder` / `ArtifactDetail`
12. `useChatStream` 用 `renderHook` + mock fetch/EventSource 补 busy 门控与 reattach 平账（P1-14/P1-15 的 jsdom 缺口）
13. 补 `cli/src/lib/provider-models.ts`、`cli/commands/start.ts` 接线、`sse-handler` sessionHint 透传、`requirement-service` 通知 i18n
14. 把 `architecture-guard` 规则从 3 条补到审计建议的 6 条（缺：严格状态项守卫一致性、并发闸唯一入口、SSE 帧必须带 `id:`）

---

## 6. 结论

**能不能发？**

- **后台（core / org-manager / storage / cli）：可以发。** 这一轮的修复-测试配对是认真的，尤其是并发、Mailbox、会话身份三大主线，测试深度超出一般项目水平（有真实 SQLite、真实 worker、真实 HTTP 三层）。
- **前端：建议先做完 §5 的第 1–6 项再发。** 前 6 项加起来约 1 天，但收益很大——它把"这个版本修的 UI bug 下次会不会回来"从"没人知道"变成"有护栏"。

**一句话**：这轮工程质量的短板不在"写代码的人"，而在"**测试基础设施把整个前端排除在门禁之外**"。补上这个制度性缺口，比再写几十个测试更有价值。

**发版绿灯口径补充（务必写进发版说明）**：

- 在本机跑 `packages/core` 会看到 **1 例红**（`llm-markus-provider` 那条），**属环境依赖的假红**，已定位根因并给出修法（§2.5）——**不是本分支引入，也不是产品缺陷**。
- **发版验收请以 CI（干净环境）结果为准**；若必须在带凭据的机器上验收，用：
  ```bash
  env -u MARKUS_HUB_TOKEN -u MARKUS_HUB_URL -u MARKUS_MODELS_URL npx vitest run packages/core
  ```
- 已实测该口径下：`packages/core` 全量 = **2856 passed / 9 skipped / 0 failed**（199 文件，45s）。

---

## 7. 复现命令

```bash
cd <repo> && git checkout feat/ui-optimize-0917

# 变更规模
git log --oneline v0.9.9..HEAD | wc -l
git diff --stat v0.9.9..HEAD | tail -1

# 覆盖率配置（关键：exclude 里的 packages/web-ui/** 与 include 不含 .tsx）
cat vitest.config.ts

# 全量测试（注意：本机实测全量单跑约 13 分钟以上，建议分包跑）
npx vitest run --silent packages/core
npx vitest run --silent packages/org-manager packages/storage packages/shared \
                          packages/cli packages/a2a packages/comms packages/desktop packages/web-ui

# 已被 CI 单独成步的会话不变量（跨线程语义，单测覆盖不到）
npx vitest run packages/core/test/conversation-session-invariants.test.ts \
               packages/core/test/session-continuity-smoke.test.ts \
               packages/org-manager/test/session-continuity-http.test.ts

# 架构门禁 + 类型检查
node scripts/architecture-guard.mjs
pnpm typecheck
```

> **本机环境提示（实测踩坑）**：全量 `npx vitest run` 在本机（Node 25.6 / vitest 4.0.18）单跑一次超过 13 分钟，且输出尾部会出现来自 `packages/shared/src/utils/crash.ts:380` 的 `process.exit unexpectedly called with "1"` 堆栈。建议**分包运行**并显式 grep 汇总行；`--reporter=basic` 在 vitest 4 已移除（会报 `Failed to load custom Reporter from basic`），请用默认 reporter 或 `dot`。

---

*本报告为只读分析产出，未修改任何业务代码。唯一新增文件为本报告自身。*

