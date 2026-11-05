# R1 / R2 收口报告 · 取数路径三态 + 普查单一入口

- 需求：`req_410d823e89f19d6df27e578d`（判据 2 / 判据 6 的两条需求级残余）
- 任务：`tsk_cc4497ad553c036c0b227b86`
- 分支：`tsk_cc4497ad553c036c0b227b86-cto`，base `2069e13e`（`feat/thread-trigger-router`）
- 本报告行号口径：**代码状态 = `72c6b85d`**（第 5 轮：探针 fail-closed + 4 个站点级测试 +
  两处文案闸门）。其后的提交若为 docs-only，**不移动任何代码行**；评审按本节提交链里
  最后一笔**代码**提交复现。不是 base，也不是别的 worktree。
- 提交：`754ce195`（三态原语）→ `64e0d9dd`（R6）→ `c6ee1631`（搜索型 / 列表型）→ `01e6c085`（provider 目录）→ `1434d544`（探针分类 + census）→ `ea07ddfe`（本报告）→ `36ef2d3e`（修 web-ui 类型红，见 §5.1）→ `786d2bed`（docs 更正）→ `8fb3ba56`（error-raised 豁免改**可机检**，§5.6）→ `72c6b85d`（站点级测试 R8/R11/R16/R7 + 两处文案闸门）→ `34c3801b`（**R9/R10 接线收敛 + 站点测试**，§5.7）

---

## 1. 结论（先看这三行）

| 判据 | 之前 | 现在 |
|---|---|---|
| 2 · 取数 `catch` 不得用空集合冒充「确实没有」 | 🟡 R6–R16 共 11 处仍在 | ✅ **11 处全部改三态**；两个探针 `--classify` 输出「取数路径 = 0」 |
| 6 · 计数型验收引用同一份普查输出 | 🟡 四处拼装 | ✅ `node scripts/census.mjs` 一条命令给四类计数 + 各自 `文件:行`；同 commit 连跑两次 `diff` 为空（实测） |
| 类型 / 回归 | — | `npx tsc -b` exit 0；`npx tsc --noEmit -p packages/web-ui` exit 0（**第 2 轮复验发现上一轮这条是假读数，已在 `36ef2d3e` 修，见 §5.1**）；web-ui 全量 **1338 passed / 3 skipped / 0 failed**（113 文件；含本轮新增的 7 个站点级/接线测试，见 §5.7） |

**没有放宽任何断言来换绿**：三态判据的会咬人测试做了变异自证（§5.4）。

---

## 2. 做法：不是逐点打补丁，而是把「有没有东西」收敛成一个判据

### 2.1 病灶形状

同一个谎话在 11 个位置各写一遍：

```ts
try { setItems(await api.list()) } catch { setItems([]) }   // 读失败 = 空数组
```

`items.length === 0` 于是同时承载「确实没有」与「我们没读到」两种含义。**只有把一个值拆成两个字段，
这条谎话才在结构上无法表达**。

### 2.2 唯一原语：`packages/web-ui/src/lib/resourceState.ts`

| 导出 | 作用 | 行 |
|---|---|---|
| `SourceState` | `'loading' \| 'ok' \| 'error'` —— **唯一定义**（`threadTimeline.ts` 只 re-export） | 19 |
| `Resource<T>` | `{ state, items, error }`：状态与内容分离，`items` 只在 `state==='ok'` 时是事实 | 26 |
| `readList()` | 取数失败**不抛出**，落成 `state:'error'`；`keep` 让刷新失败保留陈旧内容而不是清空 | 88 |
| `listView()` | **唯一**「有没有东西」判据：`empty = !loading && !error && rows.length===0` | 100 |
| `combineSources()` | 多腿取数聚合（时间线视图与模板库**共用**同一实现） | 129 |

`lib/threadTimeline.ts` 的 `timelineView()` 已改为委托 `combineSources + listView`
（原先它自己写了一遍 `!loading && failures.length===0 && rows.length===0`），
`threadTimeline.test.ts` 16 例回归绿 —— 这是「不新增平行机制」的证据，不是声明。

### 2.3 实际存在的唯一物：`ReadErrorNotice`（错误条）+ `listView()`（判据）

> **更正（第 5 轮，评审 C 项）**：上一版把 `components/ListState.tsx` 说成「唯一渲染出口」，
> 与树不符 —— `grep -rn "<ListState" packages/web-ui/src` 只命中它自己的测试。11 个生产站点
> 真正共用的是下面两件，加一个取数落点：

- `ReadErrorNotice({ subject, error, notEquals, onRetry, hint })`：**唯一错误表达**，文案模板只有一处；
  **`notEquals` 是必填的** —— 它存在的理由就是说出「不能由这次失败推断出的那个结论」。
- `listView()`（`lib/resourceState.ts:100`）：**唯一「有没有东西」判据**，
  `empty = !loading && !error && rows.length === 0`；站点不得自己数长度。
- `readList()`（`:88`）：**失败的唯一落点** —— 不抛出、落成 `state:'error'`，
  所以「把失败折成空集」在结构上无法表达。
- `ListState` 是把上面两件组合起来的封装，**目前无生产调用点**；保留/移除条件见 §6 残留 6。

### 2.4 三类取数形态 → 三类处置（每类一种 error 表达）

| 形态 | 站点 | 处置 |
|---|---|---|
| 列表型 | R6 会话消息、R10 记忆会话消息、R11 Hub 浏览、R12/R13 模板库、R14/R15 模型目录、R16 provider 列表 | `Resource<T>` + `ReadErrorNotice`；空态文案只在 `view.empty` 时出现（= 没在读、没失败、确实 0 条） |
| 搜索型 | R7 消息搜索、R8 交付物搜索、R9 交付物搜索 | 同上，但文案是「搜索失败 ≠ 无命中」，重试走同一查询口 |
| 可选探测型 | 探针里剩余的 16 处（`localStorage` 偏好、配置探测、`lsof` 端口探测…） | **保留空集合**，但必须在 `scripts/read-path-exemptions.json` 登记 class + 理由，否则算取数路径（fail-closed） |

---

## 3. R1 逐条（11 处，全部已改）

行号取自本分支 HEAD。`证据` 列指向把该处钉死的实现/测试位置。

| # | 位置 | 改前用户看到 | 改后 | 证据 |
|---|---|---|---|---|
| R6 | `hooks/useConversationBuffers.ts:144` | 失败 = 空 transcript | `ConvPhase='error'` + `failLoad()`（`lib/ConversationBufferManager.ts:193`）；`loadAndDisplay` 返回 `{count,error}`（`:119`）；Team `sessionError` 可见条（`pages/Team.tsx:5737`）+ `isEmptyChat` 增 `!sessionError` | `pages/TeamSessionError.test.tsx`（2 例） |
| R7 | `pages/Team.tsx:3915` catch | 失败 = 「无命中」 | `findServerError` + `ChatHistorySearch.serverError/onServerRetry` | `pages/TeamR7SearchError.test.tsx`（2 例，站点级） |
| R8 | `pages/Deliverables.tsx:320` catch | 失败 = 「0 个交付物」 | `loadError` + `listView` 门控 empty（`:337`）+ 错误条 | `pages/Deliverables.r8.test.tsx`（2 例，站点级） |
| R9 | `pages/AgentProfile.tsx` `DeliverablesTab`（旧 `:3261` catch） | 同上（第二份实现） | 接线走 `useReadResource`（`hooks/useProfileReads.ts`）；empty 由 `listView` 判；计数行闸门读**同一个派生视图** `view.error`（`AgentProfile.tsx` `DeliverablesTab` 内） | `pages/AgentProfile.r9.test.tsx`（2 例，站点级；含「不渲染 0 deliverable(s) 计数行」） |
| R10 | `pages/AgentProfile.tsx` `MemoryTab`（旧 `:1742` catch） | 展开会话 = 空消息列表 | 接线同上；展开体抽成 `MemorySessionBody`（`view.error` 分支先行），删分支即红 | `pages/AgentProfile.r10.test.tsx`（4 例：接线 reject / 接线反向守卫 / 渲染错误态 / 渲染反向守卫） |
| R11 | `pages/StoreDiscovery.tsx:120` | 失败 = 「没有可安装资产」 | `readList` → `Resource<HubItem>` + 顶部错误条；`EmptyHint` 改由 `view.empty` 门控（`:212`） | `pages/StoreDiscovery.r11.test.tsx`（2 例，站点级）+ `lib/resourceState.test.ts` |
| R12 | `hooks/useStoreCatalog.ts:68/80`（TeamsStore 消费） | 失败 = 空列表 | 两条腿各自成态 + 聚合失败条 + empty 门控 | `hooks/useStoreCatalog.test.ts`（3 例） |
| R13 | 同上（TemplateMarketplace 消费） | 同上（**拷贝实现**） | **已删除拷贝**，两页共用同一 hook | 同上 |
| R14 | `pages/Settings.tsx:772` catch | 失败 = 「该 provider 没有模型」 | `addProviderCatalogError` + 行内错误条 | `lib/providerCatalogRead.test.ts` |
| R15 | `pages/Settings.tsx:3392` | 同上（第二处调用） | 与 R14 共用 `readProviderCatalog()` | 同上 |
| R16 | `components/ChatModelMenu.tsx:170` catch | 失败 = provider 列表为空 | `loadError` + 菜单内错误条 + 重试；空态文案 `!loadError` 门控 | `components/ChatModelMenu.r16.test.tsx`（2 例，站点级） |

**判据 2 的机读证据**（本分支 HEAD 实测）：

```
$ node scripts/probe-catch-swallow.mjs --classify   → 取数路径（必须为 0）= 0；已登记豁免 = 16
$ python3 scripts/probe-catch-setempty.py --classify → 取数路径（必须为 0）= 0；已登记豁免 = 7
```

23 条豁免逐处带 `文件:行` + class + 理由（`scripts/read-path-exemptions.json`；
探针输出里逐条打印）。分布是 **`optional-probe` 16 + `error-raised` 6 + `write-fallback` 1**
（setempty 探针 TOTAL 7 = 后两类之和）。

> **25 → 23 是结构上消失，不是放宽口径**（第 7 轮，`34c3801b`）：R9 / R10 两条 `error-raised`
> 登记被**删除** —— 那两个页面里已经没有 `catch { setX([]) }` 可以命中（取数失败改由
> `useReadResource` → `readList()` 落成 `state:'error'`，这条通路在类型上就不存在「失败 = 空集」）。
> 台账里留了 `_retired` 记录这层因果；错误态是否真的升起改由 `.r9` / `.r10` 的行为测试咬。
> 这意味着「error-raised」从 8 条降到 6 条 —— 如果将来有人把这两个站点改回页内裸 catch，
> 探针会因为**未登记命中**直接红，不会静默。

**`error-raised` 必须可机检**（第 5 轮修）：台账每一条都带 `raises` 字面量，两个探针在
**同一条命中 catch 体**里 grep 它，缺失即计回「取数路径」；缺字段则单独报「台账不可自证」。
否则这条豁免就是自证条 —— 实测把 `Deliverables` / `ChatModelMenu` 的 `setLoadError(...)` 删掉，
门禁仍全绿（§5.6 有修前 / 修后对照）。

---

## 4. R2 交付：`scripts/census.mjs`

**只读薄封装**，四类全部调用既有实现，自己不实现任何检测规则：

```
① 终态裸比较      ← architecture-guard.mjs 规则 terminal-status-predicate + scripts/terminal-status-baseline.json
② 缓存键/指纹时钟  ← 同一 guard 规则 key-constructor-no-clock
③ 取数吞错        ← probe-catch-swallow.mjs + probe-catch-setempty.py（--classify）
④ in-band 标记    ← packages/shared/src/types/in-band-markers.ts 登记表 + isInBandMarkerSet 读取点
```

本分支实测（`node scripts/census.mjs`）：

```
① 135 处（未登记 0 组 / 基线待精简 0 组，19 个文件）
② 0 处未登记（已登记豁免 1 处：org-manager/src/thread-ensure.ts:77）
③ 取数路径 0（已登记豁免 23）
④ 6 个登记项（actionRequired / directMention / stream / throttled / triggerExecution / waitForReply）+ 20 处读取点
```

判据「同 commit 连跑两次输出 diff 为空」——实测：

```
$ node scripts/census.mjs > /tmp/c1.txt; node scripts/census.mjs > /tmp/c2.txt; diff -q /tmp/c1.txt /tmp/c2.txt
（无输出 = 逐字节相同）
```

确定性来自三条纪律：所有清单 `sort()`、不打印时间戳/绝对路径/耗时、
① 的存量条目只给「文件 + 基线处数」（基线本身不含行号，本命令不凭空造行号；
未登记命中才带 `file:line`，而那些必须为 0）。

---

## 5. 验证（全部在本分支 HEAD 实测）

### 5.1 类型门禁（两条命令，缺一即假绿）

```
$ npx tsc -b                                  → exit 0
$ npx tsc --noEmit -p packages/web-ui         → exit 0
```

> **更正（第 2 轮复验，2026-11-05 18:05）**：上一轮这里写「两条都 exit 0」**不成立** ——
> 在同一棵树的 `ea07ddfe` 上重跑该命令实测 **exit 2**：
> `src/hooks/useStoreCatalog.test.ts(24,30): error TS2554: Expected 0 arguments, but got 1.`
> 成因是测试夹具 `vi.fn(async () => …)` 被推断成零参，而取数口实际接受搜索词。
> 已按真实契约补签名（`async (_search?: string) => …`，不用 `as` 擦掉），
> 修后在本 HEAD 实测 exit 0。
>
> 这条记在报告里而不是悄悄改数字，因为它是本卡自己的教训：**「跑过了」与「跑的是
> 最后一版代码」是两件事**，引用的退出码必须带 commit，且复验必须重跑而不是抄上一轮。

根 `tsconfig.json` 的 `references` **不含 `packages/web-ui`**，只跑 `tsc -b` 覆盖不到前端
（本仓已实测的假绿坑）。本卡两条都跑。

### 5.2 回归

```
$ npx vitest run --project web-ui
  Test Files  113 passed | 1 skipped (114)
       Tests  1338 passed | 3 skipped (1341)      Duration 8.92s
```

（本读数取代码状态 `34c3801b`。§5.5 / §5.6 里的 1324 / 1332 是各自轮次的历史读数，不回填 ——
每轮都带自己的 commit，避免「下一次改动后旧数字看起来像新的」。）

（上两轮是 107 文件 / 1324 例；本轮新增 4 个站点级测试文件 → 111 / 1332。）

### 5.3 新增测试（会咬人的那一类）

| 文件 | 例数 | 咬什么 |
|---|---|---|
| `src/lib/resourceState.test.ts` | 13 | `readList` 把失败折成 `okResource([])` → 红；`listView.empty` 丢掉 `!error` → 红 |
| `src/components/ListState.test.tsx` | 7 | error 态渲染出空态文案 → 红；失败时清空陈旧列表 → 红 |
| `src/pages/TeamSessionError.test.tsx` | 2 | R6：`sessions.getMessages` reject → 无错误条 / 出现空态问候语 → 红；反向守卫（真 0 条不得报错） |
| `src/hooks/useStoreCatalog.test.ts` | 3 | R12/R13：一条腿失败把另一条腿一起清空 → 红 |
| `src/lib/providerCatalogRead.test.ts` | 3 | R14/R15：失败被当成「0 个模型」→ 红 |

### 5.4 变异自证（改坏 → 红 → 复原 → 绿）

```
改坏：lib/resourceState.ts:100  empty: !loading && !error && …   →  empty: !loading && …
$ npx vitest run --project web-ui src/lib/resourceState.test.ts src/components/ListState.test.tsx
  × 读失败 + 0 条 ≠ 空：empty 必须为 false
  × reject → state=error + 人话原因；且此时 empty 必为 false
  Tests  2 failed | 18 passed
复原（同一行改回）→ Tests 20 passed (20)
```

说明：本卡全部改动在 web-ui，vitest 经 `@markus/*` 解析到 `packages/*/dist`；本卡未改
`packages/*` 的源码，故「改 src 不重建 = 假绿」那条坑对本次变异不适用 ——
但 §5.1 的 `tsc -b` 仍然照跑（它是仓库的基线门禁）。

### 5.5 第 4 轮独立复验（2026-11-05 18:19–18:21，HEAD `786d2bed`，逐条现跑）

第 3 轮的读数是另一分身在同一 commit 上测的；本轮**不引用**它们，全部重跑：

```
$ npx tsc -b                                  → exit 0
$ npx tsc --noEmit -p packages/web-ui         → exit 0
$ node scripts/architecture-guard.mjs         → ✓ 35 处命中全部在白名单内；契约不变量 17/17
$ node scripts/check-design-ledger.mjs        → ✓ 台账自洽
$ npx vitest run --project web-ui             → 107 passed | 1 skipped files
                                                 1324 passed | 3 skipped tests, 0 failed
$ node scripts/probe-catch-swallow.mjs --classify   → TOTAL = 16；取数路径（必须为 0）= 0
$ python3 scripts/probe-catch-setempty.py --classify → TOTAL = 9；取数路径（必须为 0）= 0
$ node scripts/census.mjs ×2 → diff 为空（逐字节一致）
  ① 135（未登记 0）② 0（豁免 1）③ 取数路径 0（豁免 25）④ 6 登记项 / 20 读取点
```

变异自证本轮重做（§5.4 的两条红不是抄第 3 轮）：

```
改坏 lib/resourceState.ts 的 listView.empty（删 `!error`）
$ npx vitest run --project web-ui src/lib/resourceState.test.ts src/components/ListState.test.tsx
  Test Files  1 failed | 1 passed (2)      Tests  2 failed | 18 passed
改回 → git status 为空（复原是逐字一致，不是"差不多"）→ Tests 36 passed (36)
```

`git status` 在提交前为空；本报告这次更正在**新的一笔 docs-only 提交**里，
`git diff --name-only 786d2bed..<tip>` 只应出现本文件。

### 5.6 第 5 轮：门禁从「自证」变成「可机检」（评审阻断项 1 / 2 的修法）

**病灶**：`error-raised` 豁免只有 `probe|file|nth|class|reason` 五个字段，探针只按
`probe+file+nth` 匹配、**从不进入 catch 体**。于是「R8 已修」在门禁上等价于「JSON 里写了一句 R8 已修」。

**修法**（`8fb3ba56`）：台账 `error-raised` 条目新增**必需**字段 `raises`（字面量）；两个探针把命中的
**完整 catch 体**归一化保留并在体内 grep 它 —— 缺失 ⇒ 计回「取数路径」；台账缺字段 ⇒ 单独报
「台账不可自证」；条目匹配不上代码 ⇒ 仍旧报「失效登记项」。三者任一即 `exit 1`。

**变异自证（本轮实跑，同一棵树、修前 / 修后对照）**：

```
① 删 pages/Deliverables.tsx:322 的 setLoadError(errorMessage(err));
   修前：取数路径 = 0，exit 0（全绿假象）
   修后：取数路径 = 1，exit 1
         ✗ Deliverables.tsx:320 [error-raised 命中体内找不到 'setLoadError(errorMessage(err))'（升起语句已消失）]
② 删 components/ChatModelMenu.tsx:170 的 setLoadError(errorMessage(err));
   修前：取数路径 = 0，exit 0
   修后：取数路径 = 1，exit 1
③ 两处复原 → 取数路径 = 0，exit 0（swallow 16 / setempty 9 豁免不变）
```

**站点级测试（`72c6b85d`，每处三条断言：error 可见 / 空态文案不存在 / 反向守卫）**：

| 站点 | 文件 | 改坏实现会怎么红 |
|---|---|---|
| R8 | `pages/Deliverables.r8.test.tsx` | 删 `setLoadError` → 错误条找不到（兼：探针 exit 1） |
| R16 | `components/ChatModelMenu.r16.test.tsx` | 删 `setLoadError` → 错误条找不到；空态文案反而出现 |
| R11 | `pages/StoreDiscovery.r11.test.tsx` | `EmptyHint` 不按 error 门控 → 失败条与「生态正在成长中」同屏 |
| R7 | `pages/TeamR7SearchError.test.tsx` | 删 `setFindServerError` → 「历史消息搜索读取失败」找不到 |

R11 这条是**先看到红才改代码**的：测试先在 `StoreDiscovery.tsx:212` 上跑到红
（`expected <div>…The ecosystem is growing</div> to be null`），再把 `EmptyHint` 改为
`view.empty` 门控（`72c6b85d` 同时修掉），然后转绿 —— 不是先改代码再写一条迁就它的断言。

### 5.7 第 6 轮：四个站点逐个改坏 → 两个判定器分别观察（全部现跑）

上一节是第 5 轮的读数。第 6 轮**重新**把四处改坏，在同一棵树上（`b1513367`）逐个跑，
跑完逐字复原。每行都是「改坏 → 跑探针 + 跑该站自己的测试 → 复原 → 再跑」：

| 站点 | 改坏方式 | 探针（取数路径） | 该站测试 | 复原后 |
|---|---|---|---|---|
| R8 `Deliverables.tsx` | 删 catch 里的 `setLoadError(errorMessage(err))` | 0 → **1**，exit 1 | `Deliverables.r8.test.tsx` **1 failed / 1 passed** | 0 / 全绿 |
| R16 `ChatModelMenu.tsx` | 同上 | 0 → **1**，exit 1 | `ChatModelMenu.r16.test.tsx` **1 failed / 1 passed** | 0 / 全绿 |
| R7 `Team.tsx:3915` | 删 `setFindServerError(errorMessage(err))` | 0 → **1**，exit 1 | `TeamR7SearchError.test.tsx` **1 failed / 1 passed** | 0 / 全绿 |
| R11 `StoreDiscovery.tsx:212` | 把 `view.empty ? <EmptyHint/> : null` 退回 `: <EmptyHint/>` | 不适用（文案闸门不在 catch 体内） | `StoreDiscovery.r11.test.tsx` **1 failed / 1 passed** | 全绿 |

两条结论是这轮实测出来的，不是推断：
- **两个判定器覆盖集不重叠**（评审第 4 轮的原话是对的）：R8/R16/R7 上探针与站点测试同时红；
  R11 上只有站点测试红 —— 它的病灶是「错误条与空态文案同屏」，catch 体本身没写错，
  所以探针（只看 catch 体）天然看不见它。
- **复原是逐字回到 clean**：四次变异后 `git status --short` 为空；复原后全量
  **111 files / 1332 passed / 3 skipped / 0 failed**；两探针 0/0（豁免 16 + 9）；
  `census.mjs` 连跑两次逐字节一致（① 135 ② 0 ③ 0 ④ 6 登记项 / 20 读取点）；
  `architecture-guard` ✓（35 处白名单 / 契约 17/17）；`check-design-ledger` ✓。

---

### 5.7 第 7 轮：R9 / R10 的**接线**与**渲染**各自有判定器（2026-11-05 18:45–18:52，代码状态 `34c3801b`）

评审第 7 轮的**唯一**阻断项：R9 / R10 至今 0 条行为测试，且实测可复现「原始缺陷复活 + 全部门禁绿灯」——
把计数行闸门从 `{!loadError && (` 改成 `{true && (`，探针 0/0 exit 0、`vitest` 1332 passed。

修法不是补一条「差不多」的测试，而是先把两个站点挪到**能被测试到达的位置**：
`hooks/useProfileReads.ts` 的 `useReadResource()`（取数口由调用方注入，内部仍只走
`readList()` + `listView()`，三态判据不新增第二份），以及 `export MemorySessionBody`
（三态分支从 `MemoryTab` 的闭包搬到组件里）。R9 的计数行闸门同时改读**同一个派生视图**
`view.error`，不再保留裸 `loadError` 这第二个事实源。

三个变异各自变红、复原即绿（本轮实跑，同一棵树）：

| 改坏方式 | 结果 |
|---|---|
| R9 计数行闸门 `{!view.error && (` → `{true && (` | `AgentProfile.r9.test.tsx` **1 failed | 1 passed**（「0 deliverable(s)」泄漏到错误屏） |
| 删 `MemorySessionBody` 的 `view.error` 分支 | `AgentProfile.r10.test.tsx` **1 failed | 3 passed**（空会话文案冒充结论） |
| `useReadResource` 把失败折回 `okResource([])`（旧缺陷形态） | `.r9` + `.r10` **2 failed | 4 passed**（两条接线测试同时咬；反向守卫仍绿） |

三次复原后 `git status --short` 为空。注意第二、三条的**覆盖集不重叠**：静态探针看不见
JSX 分支，渲染测试也看不见「取数层把失败折成空集」—— 这就是为什么两个都要。

门禁读数（本机现跑，代码状态 `34c3801b`）：

```
$ npx tsc -b                                  → exit 0
$ npx tsc --noEmit -p packages/web-ui         → exit 0
$ npx vitest run --project web-ui             → 113 passed | 1 skipped files
                                                 1338 passed | 3 skipped tests, 0 failed
$ node scripts/probe-catch-swallow.mjs --classify    → TOTAL 16；取数路径 = 0
$ python3 scripts/probe-catch-setempty.py --classify → TOTAL  7；取数路径 = 0
$ node scripts/architecture-guard.mjs         → ✓ 35 处白名单 / 契约 17/17
$ node scripts/check-design-ledger.mjs        → ✓ 台账自洽
$ node scripts/census.mjs ×2 → diff 为空：① 135 ② 0 ③ 取数路径 0（豁免 23）④ 6 项 / 20 点
```

---

## 6. 诚实残留（条件 + 触发阈值 + 观测方式）

| # | 残留 | 触发条件 | 观测方式 |
|---|---|---|---|
| 1 | **11 处取数路径现在每一处都有判定器**（不再有「只有 `raises` 机检、无测试」的站点）。分层：**站点级 render / 接线测试 7 处** = R6/R7/R8/R9/R10/R11/R16；**共享取数层测试 2 组** = R12/R13（`useStoreCatalog.test.ts`）、R14/R15（`providerCatalogRead.test.ts`）；R9/R10 的取数接线另有 `.r9` / `.r10` 里的 reject 断言（§5.7 第三条变异） | 有人把某站点改回「读失败 = 空集」，或删掉 error / empty 的闸门，或删掉计数器闸门 | 站点级测试逐个咬（§5.7 有三条实证：改坏即红、复原即绿）；对**仍在页内直接升 error** 的 6 条，探针的 `raises` 机检继续生效 |
| 2 | `census.mjs --rev` 只对 ①③ 生效（guard 与 in-band 读取点不支持按 commit 扫） | 需要跨 commit 对比计数 | `census.mjs --rev` 已在 ③ 生效；①② 需 checkout 后再跑（脚本注释已写明） |
| 3 | 审计文档里提到的 `scripts/probe-catch-setempty.mjs` **不存在**（实现一直是 `.py`） | 有人按文档去找该脚本 | 本条已在 §7 指向：口径以 `.py` 为唯一实现，报告与 README 均应引用 `.py` |
| 4 | 需求级 R3/R4/R5 未动（135 处终态裸比较存量 / 553 处非键 `Date.now()` / 814 处 actor 字面量） | 触碰即改；新增违规门禁直接红 | `node scripts/census.mjs`（① 每次现算） |
| 5 | 审计文档 §8.3 / §8.4 的「🟡 判据 2 / 判据 6」需在**整合线上**改为 ✅ | 本卡合并进整合线之前 | 本节 §7 已写明改法，避免「文档说部分完成、代码已清零」的第二事实源 |
| 6 | `components/ListState.tsx` 目前**无生产调用点**（11 个站点直接用 `ReadErrorNotice` + `listView`） | 本卡合并进整合线时仍无调用点 | **移除条件（已定，不留悬空）**：合并时若 `grep -rn "<ListState" packages/web-ui/src` 仍只命中它自己的注释与 `ListState.test.tsx`，则**连同它的 7 例组件测试一起删除**，§2.3 只留 `ReadErrorNotice` + `listView` 两件唯一物。零调用点的通用组件是死代码，留着的唯一效果是让下一个人以为有人在用 |
| 7 | 探针统计域是 `packages/*/src`；`desktop/gui/remote/chrome-extension` 四包在域内但本轮未逐包复验；node 四包全量本轮未跑 | 有人在这四个包里新增吞错，或 `packages/*` 源码被本卡以外的改动触及 | 探针已覆盖域内所有包（不按包白名单）；node 全量在卡面要求的复验清单里不属于本卡（改动全在 web-ui + scripts） |

---

## 7. 合并后要做的两件事（留给评审/合并者）

1. `docs/architecture/hardcoded-string-audit.md` §8.3 两行改 ✅：
   - 判据 2 → ✅，锚点加 `docs/architecture/r1-r2-read-path-closure.md` + 两个探针的 `--classify`；
   - 判据 6 → ✅，锚点 `scripts/census.mjs`（同 commit 两次运行 diff 为空）。
2. §8.4 删除 R1 / R2 两行（R3–R5 保留）；§8.5 增加一句：**四类计数一律引用 `census.mjs`
   的同一份输出**，且引用时带探针名（避免「35 处命中」与「135 处终态裸比较」再次被混用）。
