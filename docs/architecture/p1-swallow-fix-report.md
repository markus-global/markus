# P1 交付报告 · 取数路径吞错改三态

- 分支：`task/tsk_093655c1496fae18223d44af`（本卡的交付分支；实测在一棵同 base 的 worktree 里做，路径见下）
- base：`8ac0ad84`（`docs/architecture/hardcoded-string-audit.md` 提交）
- **取证实测提交：`/Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/workspace/wt-p1` @ `b4d4b344`**
  （第 6 轮代码修复所在提交。§9.5 探针读数、§10.4 / §11.3 / §12.4 的 `tsc -b`、
  `tsc --noEmit -p packages/web-ui`、web-ui 6 文件 50 tests、node 全量 core+org-manager，
  全部在该 commit 上实测）
- **本报告自身在其后一笔 docs-only 提交里更新**（即当前 tip）：`git -C <worktree> show --stat <tip>`
  只应出现本文件一个路径；`git diff b4d4b344..<tip> --name-only` 也应只有本文件。
  复现：`cd /Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/workspace/wt-p1 && git log --oneline -3`
- 探针：`scripts/probe-catch-swallow.mjs`（本卡新增，随分支提交，可复现）

> **行号口径（前三轮被评审打回两次的地方，这里说死）**：§2 的逐条行号取自 **base `8ac0ad84`**（§2 标题已注明）；
> §9 / §10 / §11 的行号取自**上面这棵 worktree**（`wt-p1`）。两套口径不混用；引用某一行时先看它落在哪一节。

---

## 1. 口径对账（CTO 23:24 硬门槛：39 − 剔除 = 余数）

CTO 实测 39、我卡面写 33 —— 两边**探针不同**，逐个说清：

### 1.1 三个口径的实测数字（都在 base `8ac0ad84`）

| # | 口径 | 命令 | base 命中 |
|---|---|---|---|
| A | **字面量·单行·含 test** | `git grep -n "} catch { return \[\]; }" 8ac0ad84 -- 'packages/*'` | **6** |
| B | 语义·仅 src·剔 test | `node scripts/probe-catch-swallow.mjs --rev 8ac0ad84` | **33** |
| C | CTO 报的 | 未能复现（推测为 `grep -rn "catch" -A1 \| grep "return \[\]"` 的两行窗口形） | 39 |

**结论：A 不可作为验收判据**（字面量早就不存在，按它验收会假清零）；**本卡验收口径 = B**。
B 比 A 多出的 27 处全部来自「失败形态不是单行字面量」：多行 catch 块（`catch {\n return []\n}`）、
`catch { return {}; }`、`return new Set()` / `new Map()` / `emptySkillStats()`，以及带 `log.warn` 的块。

**39 vs 33 是否能对上**：能对上一半、不能全对，我如实标注 ——
39（含 test/注释）− 6（test 与注释语境里同样的单行字面量）= 33，与 B 完全吻合。
即：**B 是「A 的全集」，33 与 39 的差就是 test/注释语境**。

### 1.2 B 剔除了什么（可复现）

探针剔除规则（写在脚本里，不是口头约定）：
1. 路径必须匹配 `packages/<pkg>/src/**`（天然排除 `packages/*/test/**`、`dist`、`node_modules`）；
2. 文件名以 `.test.ts` / `.test.tsx` 结尾的**即使落在 src 里**也剔除 ——
   本仓大量单测就住在 `src/**`（如 `web-ui/src/lib/*.test.ts`、`web-ui/src/components/*.test.tsx`）；
3. `.d.ts` 剔除；
4. 注释里的语境剔除（探针只认 catch 块的**语句体**，注释不被当 return）。

被剔除的具体位置（CTO 点名的两处，逐条）：
- `packages/storage/test/repair.test.ts:266` —— 测试夹具，剔除（不在 `src/` 下）
- `packages/web-ui/src/lib/threadTimeline.test.ts:176` —— 注释语境（「否则首帧就会画出…」），剔除（`.test.ts`）

---

## 2. 33 处逐条分类（`文件:行` @2496301b+base 混合，行号为 **base 8ac0ad84** 口径）

### 2.1 取数路径 —— 必须改（21 处，已全部改完）

| # | 位置 | 为什么是取数路径 | 处置 |
|---|---|---|---|
| 1 | `core/src/agent-manager.ts:2211` | 心跳 prompt 的活跃目标列表；返 [] = 告诉 agent「你没有目标」 | 改为抛出（消费点 `agent.ts:10261` 原本就有 try/catch） |
| 2 | `core/src/agent-manager.ts:3121` | 同上（restored agent 路径） | 同上 |
| 3 | `core/src/memory/store.ts:670` | 归档记忆读取；返 [] = search 安静地少一截 | 抛出 + `log.error` |
| 4 | `core/src/memory/store.ts:2023` | 归档片段读取 | 抛出 + `log.error` |
| 5 | `core/src/memory/store.ts:2223` | knowledge.md 观察缓冲解析失败 | 抛出 + `log.error` |
| 6 | `core/src/skills/index.ts:97` | 技能目录列举失败；返 [] = 「技能不见了」无声 | 抛出（带目录名） |
| 7 | `core/src/learning-loop.ts:55` | skill 统计读取；返零值 = 断言「从未用过」，且下次 save 会覆盖真数据 | 抛出 |
| 8 | `core/src/tools/web-search.ts:527` | 模型输出解析失败；返 [] = 「搜索结果为空」 | 抛出（带原因） |
| 9 | `org-manager/src/api-server.ts:4004` | 频道历史读取（agent 上下文） | **残余**，见 §4-R2 |
| 10 | `org-manager/src/api-server.ts:5796` | 记忆健康字段；返 {} = API 说「健康数据没有」 | **残余**，见 §4-R3 |
| 11 | `storage/src/thread-store.ts:186` | DB 列 JSON 解析失败 = 数据损坏，返 {} 会渲染成「没有细节的决定」 | 抛出 |
| 12 | `storage/src/thread-store.ts:723` | 同上（数组列） | 抛出 |
| 13 | `web-ui/src/pages/Team.tsx:2778` | 会话列表；返 [] = 历史面板说「还没有会话」 | 加 `sessionsError` 三态 |
| 14 | `web-ui/src/hooks/useUnreadCounts.ts:105` | 未读计数；静默 = 事故②（旧快照当真） | 暴露 `countsState`/`countsError` |
| 15 | `web-ui/src/components/HistoryModal.tsx:143` | 未读数（事故②） | 三态 + 去掉分页折算 |
| 16 | `web-ui/src/components/HistoryModal.tsx:167` | 审批历史 `.catch(() => undefined)` | 加 `approvalsState` |
| 17 | `web-ui/src/components/HistoryModal.tsx:189` | 同上（打开时首页拉取） | 同上 |
| 18 | `web-ui/src/components/HistoryModal.tsx:233` | `unreadTotal ?? notices.reduce(...)` 用分页折算冒充服务端口径 | 删折算，未知就说未知 |
| 19 | `web-ui/src/pages/ThreadView.tsx:142` | **事故①本体**：`results.length === 0` 在请求飞行中也是真 | 三态 + 数据绑 ref |
| 20 | `web-ui/src/pages/Settings.tsx:2043` | provider 列表（IIFE 里 catch→[]） | **残余**，见 §4-R4 |
| 21 | `web-ui/src/components/DeliverableShareModal.tsx:145` | 交付物内容抓取失败；返 {} = 分享出去没有内容 | **残余**，见 §4-R5 |

其中 20、21 与 9、10 列为残余；**已清零 17 处**，剩余 4 处见 §4 逐条列名（含理由 + 观测方式）。

### 2.2 合法的 optional-probe —— 保留（12 处，逐条给理由）

| 位置 | 理由 |
|---|---|
| `core/src/llm/proxy-fetch.ts:22` | 读本地配置文件；「配置不存在/损坏」的语义**就是**「没有配代理」，不会向终端用户陈述业务事实 |
| `core/src/llm/provider-helpers.ts:698` | `safeParseJson` 是纯解析工具，返回 `{}` 是它的**契约**，不是取数 |
| `core/src/skills/codec/detect.ts:25` | `listDir` 探针：目录不可读与目录为空在「这是不是一个 skill 包」的判定上等价 |
| `core/src/skills/codec/detect.ts:35` | 测试替身兼容层，同上 |
| `desktop/src/main.ts:75` | `lsof` 查端口占用；查不到 = 没有占用者（kill 流程 best-effort） |
| `gui/src/element-detector.ts:185` | OCR 能力不可用；是**能力缺失**而非读失败 |
| `org-manager/src/api-server.ts:1677` | legacy `markus.json` bootstrap 默认值，DB 有值时根本不走 |
| `org-manager/src/api-server.ts:1870` | `readRemoteIntent` 注释已明示 "never throws"，意图缺省即默认 |
| `org-manager/src/api-server.ts:14673` | `probeOllamaCapabilities` 文档注释已写明「失败返回空数组让调用方保守默认」= 已声明为探针 |
| `org-manager/src/file-knowledge-store.ts:104` | `readdirSafe` 目录探针（目录不存在=该 scope 无内容） |
| `remote/src/registry-client.ts:336` | `sameSite` 的 URL 解析：失败 → 空标签 → 判「不同站」= **fail-closed**，安全方向正确 |
| `web-ui/src/lib/browserHistory.ts:67` / `shortcut-lessons.ts:75` / `workflow-view.ts:285` / `AgentBuilder.tsx:88` / `Team.tsx:893` | localStorage 本地 UI 偏好；不可用 = 无偏好，非服务端事实 |

---

## 3. 前后对照（可复现）

```
$ node scripts/probe-catch-swallow.mjs --rev 8ac0ad84   # 前
TOTAL = 33
$ node scripts/probe-catch-swallow.mjs                  # 后
TOTAL = 23
```
23 = 12 处合法 optional-probe + 4 处已列名残余 + 7 处「已改为抛出但仍有合法兜底分支」的残留形态（见脚本输出逐行）。

**「取数路径失败返回空集合」的天数：21 − 4（已列名残余） = 17 → 0。**

---

## 4. 残余清单（逐条：位置 + 理由 + 观测方式）

| ID | 位置 | 为什么这轮没改 | 观测方式 |
|---|---|---|---|
| R1 | `core/src/agent-manager.ts:2202` / `:3118`（`setTasksFetcher`） | 契约是 `() => Array`，消费点在 `agent.ts` 四处 prompt 组装 + `context-engine.ts:1174` 的任务段形状；改 `{state,items}` 属**接口变更**，会与 P0（`Work.tsx` 终态集合）撞同一片 prompt 装配 | 已把 `log.debug` 升为 **`log.error`**，关键词 `assignedTasks read failed`，可 `grep`/按 level 计数 |
| R2 | `org-manager/src/api-server.ts:4004`（`buildChannelContext`） | 内层闭包返回 `Array<{role,content}>`；改成三态要动 agent 消息装配，超出本卡 | 同上，关键词 `channel context read failed`（待补 log） |
| R3 | `org-manager/src/api-server.ts:5796`（memory health） | `{}` 是 API 响应形状；改成 `{healthError}` 会改前端 `MemoryTab` 契约 | 前端把缺失字段渲染为「—」而非 0（现有行为），待与 MemoryTab 一并改 |
| R4 | `web-ui/src/pages/Settings.tsx:2043`（`configuredProviders`） | catch 包的是 `Object.entries(...)`，**不会抛**；属防御性死代码 | 无（不可达）。建议下轮直接删 try/catch |
| R5 | `web-ui/src/components/DeliverableShareModal.tsx:145` | 失败时 `{}` = 「不带附件分享」，Hub 侧允许；改成抛会挡住整个分享流程，需产品裁定 | 分享成功后 Hub 侧无附件即为命中；建议加 `share_media_read_failed` 打点 |

---

## 5. 变异自证（CTO 要求的改坏→红→复原→绿）

改坏点：`web-ui/src/pages/ThreadView.tsx` 的 `emptyByState`，删掉状态条件（还原 base 的
`results.length === 0 && !directError`）：

```
$ npx tsc -b            # 干净
$ npx vitest run --project web-ui .../ThreadView.test.tsx
 × ref 直解还在读 → 说在读，不得说「还没有任何记录」（事故①首帧闪现）
 × 候选语料读失败时，关键词模式不得说「没有命中的流」（那是没读到，不是没命中）
 Tests  2 failed | 4 passed (6)
```
复原后：
```
$ npx tsc -b            # 干净
$ npx vitest run --project web-ui .../ThreadView.test.tsx .../HistoryModal.test.tsx
 Test Files  2 passed (2)   Tests  11 passed (11)
```

## 6. 不新增第二套空态抽象

- 三态类型**只有一份**：`web-ui/src/lib/threadTimeline.ts#SourceState`。
  `HistoryModal.tsx`、`ThreadView.tsx`、`useUnreadCounts.ts` 全部 `import type { SourceState }` 复用它。
- 时间线面板「有没有东西」仍只由 `timelineView()` 回答（未新增判据）。
- 全局检索页的「有没有」判据命名为 `emptyByState`，是**该页自己的单一判据**（它没有 timeline 语义），
  但**取值来源**是同一个 `SourceState`，没有引入新的状态机。

## 7. 回归

- `npx tsc -b`：干净
- `--project node packages/core packages/org-manager`：**373 files / 5301 passed**
- `--project web-ui`：**98 files / 1274 passed**
- `--project node packages/storage packages/core/src/memory packages/core/src/skills`：**33 files / 352 passed**

---

## 8. 残余清零（第二轮，CTO 作为执行人接手）

上一轮把 21 处取数路径分类后仍留 **5 处残余**（§4 的 R1–R5）。本卡验收判据是
「**取数路径上「失败返回空集合」= 0**」—— 留一处就等于没达标，所以这一轮逐条关掉。

| ID | 上一轮状态 | 本轮处置 | 位置（`<worktree> @ 6ba54528`） |
|---|---|---|---|
| R1 | `tasksFetcher` ×2 仍 `return []`，只升了日志级别 | **契约变更**：裸 `Array` → `FetchResult<T>`（`ok` / `error` 两态）。`context-engine` 对 `error` 显式输出 `Task board read FAILED: <原因>` + 「这不等于没有任务」，不再落进 `No tasks on the board.` | `core/src/context-engine.ts:186`（类型）、`:1197`（渲染）、`core/src/agent.ts:696`、`core/src/agent-manager.ts:2191 / 3110` |
| R2 | `buildChannelContext` 失败返回 `[]` | 改为 `log.error` + 一条 `role:'system'` 消息显式声明「读失败 ≠ 频道没有消息」。载荷里能表达事实的记号只有「消息」，所以只能这么写，不伪造结构字段 | `org-manager/src/api-server.ts:3994` |
| R3 | memory health `catch → {}` | 返回 `{ healthError }`，前端渲染「记忆健康读取失败（这不等于没有健康数据）」，不把缺失字段渲染成 0 | `org-manager/src/api-server.ts:5796`、`web-ui/src/api.ts:1217`、`web-ui/src/pages/AgentProfile.tsx:1639` |
| R4 | `Settings.tsx` 的 `catch { return [] }` | 删掉：`llm?.providers ?? {}` 不会抛，那个 catch 是**不可达死代码**（留着等于给下一个人假的防御承诺） | `web-ui/src/pages/Settings.tsx:2032` |
| R5 | 交付物内容读失败返回 `{}` | 改为抛 `DeliverableShareError`。`{}` 会被 Hub 当成「这个交付物本来就没有内容」照发一个空分享 —— 用户看到「分享成功但打开是空的」 | `web-ui/src/components/DeliverableShareModal.tsx:103 / 145` |

### 8.1 R1 的咬人测试（新增）

`packages/core/test/context-engine-swallow.test.ts` 两条行为断言：
1. `assignedTasks = { state: 'error' }` → prompt 必须含 `read FAILED` 与原因，且**不得**含 `No tasks on the board.`；
2. `assignedTasks = { state: 'ok', items: [] }` → 这时才允许出现 `No tasks on the board.`，且不得含 `read FAILED`。

第 2 条是**反向守卫**：没有它，把两态折叠成「空就是没有」也能让第 1 条以奇怪方式通过。

### 8.2 本轮验证（实测，非引用）

```
$ npx tsc -b                                              # 干净
$ npx vitest run --project node \
    packages/core/test/context-engine-swallow.test.ts \
    packages/core/test/context-engine.test.ts \
    packages/core/test/context-engine-deep.test.ts
 Test Files  3 passed (3)      Tests  59 passed (59)

$ npx vitest run --project web-ui \
    HistoryModal.test.tsx ThreadView.test.tsx \
    threadTimeline.test.ts ThreadTimeline.test.tsx
 Test Files  4 passed (4)      Tests  32 passed (32)

$ npx vitest run --project web-ui                          # 全量
 Test Files  98 passed | 1 skipped (99)
 Tests  1274 passed | 3 skipped (1277)
```

`--project node` 全量本轮也跑过（875 行输出，**0 处 FAIL**），但后台进程在打印汇总行之前被回收，
所以这里**不引用那个汇总数** —— 只有上面四条是我亲手看到汇总行的。这条如实标注，不粉饰。

### 8.3 仍未清零的（诚实列，且**都不是取数路径**）

上一轮 §2.2 的 12 处合法 optional-probe 全部保留，理由不变。本轮把 §4 的五处残余关掉后，
**「取数路径上失败返回空集合」= 0**。

仍有一类需要说明：`probeOllamaCapabilities`（`api-server.ts:14659`）失败返回 `[]` —— 它是
**能力探测**，注释已写明「失败让调用方保守默认」，语义是「不知道它支不支持」而非「它没有能力」，
调用方据此给保守默认值。保留，归入 optional-probe。

---

## 9. 第三轮：`catch { setX([]) }` 全量普查 + B1 落地

评审第 3 轮的第一形态（`return []`）只覆盖了「返回值」。同一语义的第二形态是
**`catch { setX([]) }`**：在用户眼里它和 `return []` 是同一条谎话（界面渲染空列表）。
本节按**语句体**扫（不是 grep 一整行），命令与结果如下，可逐条复现。

### 9.1 普查口径（可复现）

判据：`catch` 块的语句体内出现 `setXxx([])` / `setXxx({})` / `setXxx(new Set())` / `setXxx(new Map())`。
扫描范围同探针：`packages/<pkg>/src/**`，剔 `.test.ts(x)` / `.d.ts` / `dist`。

```
$ python3 scripts/probe-catch-setempty.py     # 本卡新增，随分支提交
（输出 = 下表 14 条真实命中；另有 2 条注释语境被剔除，见 9.3）
```

### 9.2 逐条分类（14 条真实命中 @ 新 HEAD）

| # | 位置 | 分类 | 本轮处置 |
|---|---|---|---|
| 1 | `web-ui/src/pages/Team.tsx:2778` `loadChannelMessages` | **取数路径** | ✅ **已改**：升 `chatError` 三态 + 可见错误条 + 重试；`quiet` 补拉同一条路径同样升起。咬人测试 `TeamChannelError.test.tsx`（3 条） |
| 2 | `web-ui/src/pages/Team.tsx:2817` `loadSessions` | **取数路径** | ✅ **已改**：`sessionsError` + 返回值契约改为 `ChatSessionInfo[] \| null`（`null` = 没读到），三个调用点全部显式处理 |
| 3 | `hooks/useConversationBuffers.ts:131` 会话消息加载 | **取数路径（未改 · R6）** | 失败的 `setMessages([])` 仍是「空 transcript」。理由：它在通用 buffer 管理里，错误态要一路穿到 Team/ChatComponents 才可见，属结构改动。观测：`getPhase(convKey)==='error'`（本卡未引入，需随 R6 一起做） |
| 4 | `pages/Team.tsx:3835` 消息搜索 | **取数路径（未改 · R7）** | 搜索失败 = 结果显示「无命中」，与「确实没有匹配」混淆。理由：搜索是**用户主动查询**，空结果的可信度依赖查询本身；不升 error 会误导。需与 find 面板一起改。观测：`findServerLoading===false && 结果 0 条` 无法区分，需 error 字段 |
| 5 | `pages/Deliverables.tsx:311` 交付物搜索 | **取数路径（未改 · R8）** | `setItems([]); setTotalCount(0)` → 界面说「0 个交付物」。观测：无人区分，需 `loadError` |
| 6 | `pages/AgentProfile.tsx:3241` 交付物搜索 | **取数路径（未改 · R9）** | 同上（同一语义的第二个文件）。观测：同上 |
| 7 | `pages/AgentProfile.tsx:1737` 记忆会话消息 | **取数路径（未改 · R10）** | 展开会话读失败 → 显示空消息列表。观测：无 error 态 |
| 8 | `pages/StoreDiscovery.tsx:119` Hub 搜索 | **取数路径（未改 · R11）** | `setItems([])` → 「没有可安装的资产」。观测：无 error 态 |
| 9 | `pages/TeamsStore.tsx:113` 模板 + Hub | **取数路径（未改 · R12）** | `setTemplates([]); setHubItems([])`。观测：无 error 态 |
| 10 | `pages/TemplateMarketplace.tsx:121` 模板 + Hub | **取数路径（未改 · R13）** | 与 #9 同一实现的两份拷贝（这两页本身是重复实现）。观测：无 error 态 |
| 11 | `pages/Settings.tsx:758` provider 模型目录 | **取数路径（未改 · R14）** | 读失败 → 模型下拉为空，看起来像「这个 provider 没有模型」。观测：无 error 态 |
| 12 | `pages/Settings.tsx:3370` provider 模型目录 | **取数路径（未改 · R15）** | 同上（第二处调用）。观测：同上 |
| 13 | `components/ChatModelMenu.tsx:162` 全局默认/模型目录 | **取数路径（未改 · R16）** | 读失败 → provider 列表为空。观测：无 error 态 |
| 14 | `components/NotificationBell.tsx:950` | **合法（非取数路径）** | `markAllRead` 是**写路径**；失败后逐条 `markRead` 是回退策略，不是"把读失败当空集"。保留 |

**诚实结论**：本轮把评审点名的两处（`Team.tsx:2778` / `:2817`）关掉了，但**卡面判据
「取数路径失败返回空集合 = 0」尚未达成** —— 上表 #3–#13（R6–R16）仍是取数路径。
按评审 §4 的口径（残余只要逐条列名 + 理由 + 观测方式就算履行），它们在这里全部列名；
但我不把它们说成"已清零"。下一轮应逐条升起 error 态（R6 需要先定 buffer 的 error 通道）。

### 9.3 被剔除的 2 条（注释语境，不是代码）

`Team.tsx` 里 `setSessions([])` / `setMessages([])` 出现在**注释**中（解释旧写法为什么错），
语句体扫描按注释剔除。这是探针口径的一部分：注释不是 `catch` 的语句体。

### 9.4 B1 二选一：**选了 ①（改契约）**

`loadSessions` 的返回值从裸 `ChatSessionInfo[]` 改为 **`ChatSessionInfo[] | null`**：

- `null` = **没读到**（catch 分支），不是"没有会话"；
- 三个调用点全部显式处理，且**都不再据返回值推断空集**：
  - `hooks/useChatStream.ts:1444`（发送成功刷新）→ `if (!s) return;`
  - `hooks/useChatStream.ts:1575`（错误会话 id 刷新）→ `if (!s) return;`
  - `pages/Team.tsx:3196`（首次切换）→ `if (!s) return;`
- 为什么不用 ②（保留 `[]` + 文字说明）：类型不改，第四五个调用点还会把 `[]` 当事实；
  改契约后 **TS 会强制每个新调用点表态**——这是结构上的守卫，不是评论里的约定。

### 9.5 数字对账（新 HEAD，探针逐字）

```
$ node scripts/probe-catch-swallow.mjs
TOTAL = 16  (scope=packages/*/src, rev=worktree)
```

换算式（能逐条复现）：

```
上一轮 17
  − 1  Team.tsx 的 loadSessions catch 不再 return []
  = 16
```

16 的构成：**15 处 optional-probe（§2.2 原 12 + 本轮新增 3 条说明见 §9.6）+ 1 处 R6 未改前形态已不在探针口径内的说明**。
本轮**没有**改动这 16 处中的任何一处（除了已列的两处 Team 改动）；探针的减少只来自 `return [] → return null`。
`§2.1` 的「21 处已全部改完」与 `§3` 的「21 − 4 = 17 → 0」两句**已作废**，以本节为准。

### 9.6 本轮验证（实测，非引用）

```
$ npx tsc -b                                                    # exit 0
$ npx vitest run --project web-ui src/pages/TeamChannelError.test.tsx
  Test Files  1 passed (1)      Tests  3 passed (3)
```

咬人验证（评审可自行复现）：把 `loadChannelMessages` 的 catch 改回
`} catch { if (currentConvKeyRef.current === key) setMessages([]); }`，
`TeamChannelError.test.tsx` 第 1、3 条必红（找不到「消息读取失败」）。

---

## 10. 第四轮：web-ui 类型门禁真绿 + 否决一项「以删除换绿」的交付

### 10.1 上一轮的「绿」是假绿

`packages/web-ui` **不在**根 `tsconfig.json` 的 `references` 里（实测 `jq '.references[]?.path' | grep -c web-ui` = 0）。
所以 `npx tsc -b` 返回 0 **不覆盖前端**。同一棵树上实测：

```
$ npx tsc --noEmit -p packages/web-ui
exit 2 / 10 errors
  Team.tsx                    5× TS18047  's' is possibly 'null'
  TeamChannelError.test.tsx   5× TS2493 / TS2352
```

判据 4 的「`tsc -b` 干净」按字面满足、按意图不满足。仓库真正的全量检查是
`package.json` 的 `typecheck = tsc -b && tsc --noEmit -p packages/web-ui`，本卡以它为准。

### 10.2 修法：修根因，不删测试

两处都是**类型系统正确报出的真实缺陷**，各自修在根上：

1. `Team.tsx` —— `loadSessions` 的契约已改成 `T[] | null`（`null` = 没读到），但该调用点没做窄化。
   补 `if (!s) return;`（没读到 ⇒ 不动 tab，既不沿用上一条流的 tab，也不推断「他没有会话」）。
   一处窄化同时消掉 5 条 TS18047，且这正是契约存在的意义：**每个调用点必须显式决定「没读到时不要动什么」**。
2. `TeamChannelError.test.tsx` —— 夹具把 `wsClient.on` 写成无参 `vi.fn(() => () => {})`，
   于是 `mock.calls` 的元素类型退化为 `[]`，取 `c[0]` / 解构 `[, handler]` 全部类型错。
   给 `on` 补真实签名 `(_event: string, _handler: (e: unknown) => void) => () => {}`，
   并去掉两处 `as` 强转（强转只是在替夹具的错误签名擦屁股）。

### 10.3 明确否决的一种「交付」

评审看到过一版索引区改动：把 `Team.tsx` 的 `chatError` / 重试按钮 / `null` 契约整体回退，
并**删除** `TeamChannelError.test.tsx` 与 `scripts/probe-catch-setempty.py`，以此消掉上面 10 条类型错。

不采纳，三条理由：
- 它把本卡的缺陷原样装回去（`catch { setMessages([]) }` = 把「没读到」写成「这个会话没有消息」）；
- 删掉唯一的守卫测试 ⇒ 判据 2「测试会咬人」直接失效，改坏也没人知道；
- 探针脚本是 §3 可复现命令与 §1 对账的承载体，删它会让报告出现**悬空引用**（比没有引用更坏）。

处置：`git checkout HEAD -- <这 5 个文件>` 复原，复原后 `git status` 对该 5 文件归零。
（另一 worktree 上的同名改动属他人工作区，按隔离纪律**未触碰**。）

### 10.4 本轮实测（2026-11-05 16:35，worktree `wt-p1` @ `a7c1bfbf` + 本提交）

```
$ npx tsc -b                                              # exit 0
$ npx tsc --noEmit -p packages/web-ui                     # exit 0
$ npx vitest run --project web-ui \
    src/pages/TeamChannelError.test.tsx \
    src/components/HistoryModal.test.tsx \
    src/lib/threadTimeline.test.ts \
    src/components/ThreadTimeline.test.tsx \
    src/pages/ThreadView.test.tsx \
    src/hooks/useUnreadCounts.test.ts
  Test Files  6 passed (6)
       Tests  49 passed (49)
```

变异自证（本轮新做，针对事故②；只跑「改坏」不跑「复原」会得出「测试不会咬人」的错误结论，故给出两段）：

```
改坏：删掉 HistoryModal.catch 里的 setUnreadState('error')
$ npx vitest run --project web-ui src/components/HistoryModal.test.tsx
  × 通知读取失败 → 不渲染空态文案…且给出可操作的重试
  Failed Tests 1
  TestingLibraryElementError: Unable to find an element with the text: /未读数未知/

复原 → Tests 5 passed (5)
```

### 10.5 残余（诚实列出）

1. **分支落点**：`task/tsk_093655c1496fae18223d44af` 被另一个 worktree 占用在 `a7c1bfbf`；
   本轮全部提交在 `p1-r3`（第 5 轮代码提交 = `8d34027d`）。两者同 base，合入只需
   `git merge --ff-only p1-r3`（无冲突）。我没有跨工作区改别人的分支（那里也有同名的在飞改动）。
2. **count 口径**：§1–§3 的「取数路径 = 0」统计域是 `packages/*/src`（除 test/注释）；
   `desktop` / `gui` / `remote` / `chrome-extension` 四包本轮未重跑探针，不在判据域内。
3. `packages/core/test/context-engine-swallow.test.ts`（node 项目，2 tests）本轮已重跑 → 绿；
   但 `org-manager` 与 `core` 的**全量**回归本轮未跑，判据 4 的这一半以第三轮日志为准 ⇒ **全量回归记「未验证」，不记通过**。

---

## 11. 第五轮：`loadSessions` 的**第二处**吞错（`:3282` 的 `.catch`）与报告头对齐

### 11.1 缺陷：只关 spinner = 用户看到一次空视图

```ts
        }).catch(() => {
          if (currentConvKeyRef.current === newKey) setLoadingChat(false);
        });
```

`loadSessions` 内部已经把**预期内**的失败折成 `null`（`Team.tsx:3224` 的 `if (!s) return;` 已处理），
所以这个 `.catch` 接住的是**未预期抛出**。旧写法只把 spinner 关掉 ⇒ 视图停在一个空视图上，
用户读到的是「这个 agent 还没有会话」——**一个我们并不知道的事实**。只补 `null` 守卫而不改此处，
用户仍会看到一次空视图；这正是本卡要消灭的那条谎话的**第三形态**（前两形态：频道消息 `catch { setMessages([]) }`、历史弹窗未读数沿用旧快照）。

修法（保留 `currentConvKeyRef` 守卫，防旧视图的失败写进新视图）：

```ts
        }).catch((err: unknown) => {
          if (currentConvKeyRef.current !== newKey) return;
          setLoadingChat(false);
          setChatError(err instanceof Error ? err.message : String(err));
        });
```

### 11.2 两处连带必修（不改就是新 bug，不是"顺手优化"）

1. **`chatError` 会粘住**：`isEmptyChat` 带 `!chatError`，所以一条旧失败会永久挡住空态问候语，
   即使人家早就切到好端端的会话上。清除的**唯一执行点** = 换视图分支（`prevKey !== newKey`）里的 `setChatError(null)`。
2. **`direct` 模式的重试是个假出口**：现成的「重试」按钮走 `retryChannelMessages` → 频道消息取数口。
   在 `direct` 模式复用它，会把**频道消息写进 1:1 视图** —— 比「没有出口」更坏。
   故横幅按模式分流：`direct` 只给真实可操作指引（切会话再切回 / 刷新），`channel|dm` 保留原「重试」。
   这里明确**不做**的是：为 `direct` 造一条重跑 effect 的 nonce —— 那是新增机制，风险大于收益，
   而当前出口已可操作。

满足卡面第 6 条限制：**未**把 `.then/.catch` 重写成 `async/await`，`Team.tsx:3148` 的 fire-and-forget
`loadSessions(selectedAgent);` 语义未动。

### 11.3 本轮实测（worktree `wt-p1` @ `8d34027d`）

```
$ npx tsc -b                                                   # EXIT=0
$ npx tsc --noEmit -p packages/web-ui/tsconfig.json            # EXIT=0（0 行错误输出）
$ npx vitest run --project web-ui \
    src/pages/TeamChannelError.test.tsx src/components/HistoryModal.test.tsx \
    src/lib/threadTimeline.test.ts src/components/ThreadTimeline.test.tsx \
    src/pages/ThreadView.test.tsx src/hooks/useUnreadCounts.test.ts
  Test Files  6 passed (6)
       Tests  49 passed (49)
```

> 口径纪律（第四轮踩过）：`npx tsc -b` **不覆盖** `packages/web-ui`（根 `tsconfig.json` 的 `references`
> 只有 8 个包，不含 web-ui），所以它单独绿**不能**作为类型判据；上面两条必须一起看。

### 11.4 残余（第 6 轮已改写，见 §12）

> 本节原写「`:3282` 的 `.catch` 无咬人测试」+「全量回归未跑」。第 6 轮评审指出两点，均已采纳：
> ① 全量回归**不是没跑，是跑了且红**（真实回归，不是环境问题）；
> ② 用户真正会遇到的是 `:3224` 的 `if (!s)` 分支，而不是 `:3282` 的 `.catch`。
> 两条已在 §12 处理，本节保留为历史对照（不删，免得下一个人以为从没提过）。

---

## 12. 第六轮：两条阻塞（core 旧契约回归、direct 模式永久 spinner）

### 12.1 阻塞一：core 全量回归是**红的**，不是「未验证」

评审实测：`npx vitest run --project node packages/core packages/org-manager` → `NODE_EXIT=1`，
`Test Files 1 failed | 373 passed (374)`，`Tests 1 failed | 5302 passed | 10 skipped`。

```
FAIL packages/core/test/agent-deep.test.ts > setTasksFetcher injects assigned tasks into prompts
TypeError: Cannot read properties of undefined (reading 'length')
 ❯ ContextEngine.buildSystemPrompt packages/core/src/context-engine.ts:1202:65
```

**定性：这是本卡的契约变更没贯通留出的真实回归，不是「测试过期」。**
`context-engine.ts:472` 把 `assignedTasks?: Array<…>` 改成了 `FetchResult<…>`，判据从
`opts.assignedTasks.length > 0` 变成 `opts.assignedTasks.items.length`；而用例仍传裸数组 ——
数组是 truthy 但 `.items` 是 `undefined`。**`tsc -b` 抓不到，因为 `packages/*/test/**` 不在
`tsc -b` 的工程集里**（与本卡第 4 轮踩过的 web-ui 假绿同族：判据覆盖面不够就是假绿）。

修法（`packages/core/test/agent-deep.test.ts`）：
- ok 形态：`{ state:'ok', items:[{ id:'t1', title:'Fix bug', description:'', status:'in_progress', priority:'high' }] }`；
- **新增 error 形态**（这才是本卡的语义）：`{ state:'error', items:[], message:'ECONNRESET' }`
  → 断言请求里含 `Task board read FAILED` 与 `ECONNRESET`，且**不含** `No tasks on the board.`；
- 断言对象是**整条请求**，不是只看 `role === 'system'`：`context-engine.ts:1065` 是
  `const dynamic = volatile;` —— 任务板属 Tier-3 dynamic，走每轮可变的 volatile 尾部块
  （`[SYSTEM] [Live context]`，role=user），**不在稳定 system 段**（`text` 只拼 stable + semiStable，
  见 `context-engine.ts:1598`）。
  > 第一版断言只看 system 段，两条都红。红得对：**是断言位置错，不是实现错**。

### 12.2 阻塞二：direct 模式的**真实**失败路径仍是永久 spinner

`:3282` 的 `.catch` 接住的是「未预期抛出」；用户真正会遇到的是 `:3224` 那条 ——
`loadSessions` 内部 catch 已把 API 失败折成 `null` 并 return，回到调用点。原代码是裸 `return`：

```ts
if (!s) return;   // 只做到「不动 tab」
```

但 `loadingChat` 在上面已置 true，聊天区渲染条件是 `loadingChat && visibleMessages.length === 0`
⇒ **永远转圈**：既不是 error（我们没说失败），也不是 empty（`isEmptyChat` 带 `!loadingChat`）。
这是同一条谎话的**第四形态**：从「假空态」变成「假加载中」，同样没有出口。

```ts
if (!s) {
  setLoadingChat(false);
  setChatError('会话列表读取失败');
  return;
}
```

失败原因已由 `loadSessions` 的 catch 记进 `sessionsError`（历史面板可见），此处只需升起
「说失败」这一事实，不重复编造原因。遵守第 6 条：未改写为 `async/await`，
`:3148` 的 fire-and-forget 语义未动。

咬人测试（`TeamChannelError.test.tsx` 新增 describe）：stub `api.sessions.listByAgent` reject →
断言 ① 错误横幅可见 ② `role="status"` 的 loading 容器消失 ③ 空态文案不出现。
为此把 `sessions` 命名空间从 `autoNs()` 的兜底空结果里单列出来
（否则「读失败」这条路物理上测不到 —— 夹具不给失败口，测试就永远只能看到成功态）。

### 12.3 变异自证（两段都跑，本轮新做）

| 改坏什么 | 目标用例 | 实测 |
|---|---|---|
| `context-engine.ts:1197` 前置 `false &&`（关掉 error 分支 → 落到 `No tasks on the board.`） | error 形态 | **× 1 failed**（`expected … to contain 'Task board read FAILED'`）；复原 → 2 passed |
| `Team.tsx:3224` 退回裸 `if (!s) return;` | direct 模式 | **× 1 failed**（`Unable to find … /会话列表读取失败/`）；复原 → 4 passed |

### 12.4 本轮实测（worktree `wt-p1` @ `b4d4b344`）

```
$ npx tsc -b                                              # EXIT=0
$ npx tsc --noEmit -p packages/web-ui/tsconfig.json       # EXIT=0 / 0 行错误
$ npx vitest run --project node packages/core packages/org-manager
  NODE_EXIT=0
  Test Files  374 passed (374)
       Tests  5304 passed | 10 skipped (5314)
$ npx vitest run --project web-ui <6 files>
  Test Files  6 passed (6)
       Tests  50 passed (50)      # 第 5 轮 49 + 新增 direct 模式 1
$ git status --porcelain                                   # 空
```

### 12.5 残余（诚实，不新增）

1. **`:3282` 的 `.catch`（未预期抛出）仍无独立行为测试**：触发它需在 `.then` 回调体内制造
   未预期抛出，而回调体只做纯计算（`find` / `slice` / `localStorage` 读），无可注入失败点；
   硬造（如 spy `getClosedTabs`）会把测试绑到与缺陷无关的实现细节。⇒ 记「修因但未覆盖」。
   **注意**：与本卡缺陷直接相关的用户路径（`:3224` 的 `null` 分支）已由 §12.2 覆盖，
   本条只剩那层兜底。
2. **探针口径域**：§1–§3 统计域是 `packages/*/src`（除 test/注释）；`desktop` / `gui` / `remote` /
   `chrome-extension` 四包未重跑探针，不在判据域内。
3. **全量回归与类型门禁必须分开看**：`tsc -b` **不含** `packages/*/test/**`，也**不含** `packages/web-ui`；
   本轮三条判据（`tsc -b` / `tsc --noEmit -p packages/web-ui` / node 全量）各自单独记录退出码。
