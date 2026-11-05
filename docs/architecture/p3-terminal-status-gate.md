# P3 · 状态裸比较收口：`isTerminal()` 唯一入口 + 门禁拦住新增违规

> 需求 `req_410d823e89f19d6df27e578d`（硬编码字符串审计）· 任务 `tsk_1e766b22991e370479a5b1f2`
> 分支 `task/tsk_1e766b22991e370479a5b1f2-cto`（基线 `d2f78684` = P0 分支顶端）
> 落地日期 2026-11-05

---

## 0. 摘要：这一版能判定什么

| 判据 | 结果 | 证据 |
|---|---|---|
| 终态判定只有**一个**入口 | ✅ `isTerminal()`（服务端 `@markus/shared`；浏览器侧 `lib/taskStatus.ts` 是它的投影，写入者仍是 shared） | `packages/shared/src/types/task.ts:35-60` |
| **新增**终态裸比较会被提交前拦住 | ✅ 默认拦全仓，不靠白名单 | 真实树三态取证：`exit 1 → 0 → 0` |
| 非终态比较（`running/in_progress/pending/blocked/review`）**不**被误伤 | ✅ 有测试专门钉住 | `architecture-guard.test.ts` ·「非终态比较 → 放行」 |
| **具名**终态集合（`const T=['completed',…]; T.includes(x)`）也被拦 | ✅ 判据是「集合纯度」+ 反例回归 | `architecture-guard.test.ts` ·「具名终态集合 → 必红」 |
| 存量只能**单调下降** | ✅ 双向棘轮：比基线多红、**比基线少也红** | `scripts/terminal-status-baseline.json` |
| 存量数字可被任何人复算 | ✅ 一条命令：`node scripts/architecture-guard.mjs` | 输出 `扫到 N 处` |
| 本轮存量 | **142 → 135 处**（19 个文件） | 清理 15 处（§4）；另因覆盖具名集合 +8 处被正确纳入普查 |

一句话：**「这件工作结束了吗？」这个问题从今天起有唯一答案入口，而且第二个答案写不进仓库。**

---

## 1. 先纠正口径：审计的「386」不属于任何一个可复现的 grep 口径

审计文档 §1 写「386 处 `status === '…'` 裸比较」。在 684 个 `packages/*/src` 源码文件上实测四种口径，**没有一个等于 386**：

| 口径 | 出现次数 | 命中行 | 文件数 |
|---|---|---|---|
| A `.status (===/!==/==/!=) '<任意字面量>'` | 603 | 530 | 91 |
| B `status …`（含裸标识符，⊇A） | 728 | 636 | 100 |
| C `.status === '<任意字面量>'`（仅单向） | 468 | 404 | 81 |
| D `status (===/!==) '<终态字面量>'`（仅单向） | **155** | **136** | **33** |

复算命令（可粘贴）：

```bash
node -e '...'   # 见 §6「口径复算」
```

**为什么没有一个数字能对上**：`status` 这个字形散在**六个互不相干的域**里——任务生命周期、需求生命周期、审批（approval）、coding 工具会话、消息/会话流、工作流节点/运行。任何「全仓 status 比较」的计数都在**混合不同的问题**，所以：

- 「386」不可复现 ⇒ 本卡**不继承**这个数字，改为按可复现口径重新普查，并把它写进交付物（数字必须能被下一个人复算，否则只是传说）。
- 混合计数还有一个更坏的后果：**门禁若按字面量拦，会误伤别的域**（`session.status === 'completed'` 是工具跑完，不是任务结束）。所以门禁必须**域感知**，见 §2。

### 三分类（本卡采用的分类法）

| 类 | 含义 | 处置 |
|---|---|---|
| **① 终态语义** | 「这件工作结束了吗」 | 必须走 `isTerminal()`；存量登记、新增即红 |
| **② 具体状态语义** | 「是不是 completed」「是不是 archived」——**不是**「是否已结束」 | 允许裸写，但必须在基线里写明 `why` |
| **③ 其它域（同名不同事实）** | coding 工具 / mailbox item / 工作流节点 / 审批 / Hub 审核 / 分享状态 | 按**文件**豁免，每条写明它回答的是哪个问题 |

②③ 的区别是**承重的**：② 是同一个问题域的另一种问法（例：统计「顺利完成数」不能把 failed 算进去），③ 是**根本不同的事实**。把 ② 也强行压成 `isTerminal()` 会制造**语义错误**——这正是本次清理在 `blockerVerdict` / 指标分桶 / UI 配色上刻意**不**改的原因（§4.4）。

---

## 2. 门禁设计：`terminal-status-predicate`

**挂在既有 `scripts/architecture-guard.mjs` 上，不新建第二套。** CI 的 `Architecture guard` 步骤（`.github/workflows/ci.yml:59`）和本地 `pnpm quality` 都已经在跑它 —— 新增门禁**零接线成本**，也不会出现「两套门禁各说各话」。

### 2.1 四条决策（每条都是被反例逼出来的）

**① 默认拦（default deny），而不是只扫白名单。**
扫 `packages/*/src` 下**全部**文件，只在「字形相同但不是同一个事实」的文件上按文件豁免。

> 极性不能反过来。只扫白名单文件的门禁**天生对新增文件失明** —— 那正是门禁失效最经典的形态：存量看得见，新增看不见。而「新增」恰恰是唯一会继续发生的事。

**② 只拦终态字形，非终态一律放行。**
`running / in_progress / pending / blocked / review` 不拦。

> 拦非终态比较是**错的门禁**：它把「正在跑吗」和「结束了吗」混成一个问题。错门禁的结局不是被修好，而是**第一次误红就被人整体关掉**（`--no-verify` 或直接删规则）。所以这条有专门测试钉住（§3.2 第 3 例）。

**③ 双向棘轮基线，`why` 强制。**
`scripts/terminal-status-baseline.json` 按**文件**记数，每条带 `why`（≥8 字，缺了判红）：

| 现状 vs 基线 | 门禁 |
|---|---|
| 比基线**多** | ✗ 红（新增违规 / 混进第二种写法） |
| 比基线**少** | ✗ **也红**（要求同一次提交删掉条目） |
| 文件不在基线里但有命中 | ✗ 红 |
| 条目 `why` 空/过短 | ✗ 红 |

> 「只拦新增」的基线会让存量**永远躺在那里**——没人有动机去删数字，因为它不疼。双向棘轮把「清理」变成**义务而不是美德**：你清掉一处，就必须同时把基线改小，于是那个数字只可能单调下降。

**④ 注释用等长空白替换剔除，保留偏移。**
本仓库有十几处注释在举例 `status === 'completed'`（如 `task-service.ts:3457`）。不剔除注释，门禁就退化成「**不许写注释**」——这种规则会被人绕过而不是遵守。

> 用等长空白替换而非 `strip`：偏移不变 ⇒ 报出的行号与原文一一对应。门禁报的行号必须能直接跳转，否则第一次定位失败，人就不信它了。

### 2.2 判定算法（四种写法；"一网打尽"只在这四种的意义上成立）

```js
// ① 正向：<subject> === '<terminal>'   （含 !== / == / !=）
/(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*(?:\.|\?\.)\s*){0,6}[A-Za-z_$]*[sS]tatus\b)\s*(===|!==|==|!=)\s*(['"])(${终态集})\3/
// ② 反向：'completed' === status
/(['"])(${终态集})\1\s*(===|!==|==|!=)\s*(<subject>)/
// ③ 内联终态数组：['completed','archived'].includes(task.status)
/\[([^\[\]]{0,400})\]\s*\)?\s*\.\s*(?:includes|has|indexOf)\s*\(\s*(<subject>)\s*[,)]/
// ④ 具名终态集合（两步）：先收声明名，再匹配对它的调用
/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,160})?=\s*(?:new\s+Set(…)?\s*\(\s*)?\[([^\[\]]{0,600})\]/
/<NAME>\s*\??\.\s*(?:includes|has|indexOf)\s*\(/
```

`subject` 生成式接受 `status` / `task.status` / `s?.status` / `execution.status`，**取最后一个标识符**且必须以 `status`/`Status` 结尾 —— 这是「域感知」的最小实现。

**④ 是本轮评审打回后补的，两个判据都是被反例逼出来的：**

| 决策 | 反例 | 结论 |
|---|---|---|
| 必须**两步**扫（声明 / 使用分开） | `const T = ['completed','archived']; T.includes(s)` —— 声明与使用是两条语句，③ 的内联形态匹配不到 | 先收集本文件里「值域全是终态字形」的名字，再匹配对该名的 `includes/has/indexOf` |
| 使用侧**不**要求实参形如 `x.status` | 若要求，`T.includes(s)` 又能绕过（评审探针正是 `(s: string) => NAMED_TERM.includes(s)`） | 判据是**集合的内容**，不是实参名字 |
| 集合必须是**纯**终态（每个字面量都是终态字形），而不是「含至少一个」 | 写成「含」判据时，实测误伤 `web-ui/src/api.ts:484` `APPROVAL_REJECT_TOKENS = new Set(['reject','rejected'])` —— 审批 token 里恰好有 `rejected` | 纯活跃态集合（`['pending','in_progress','review']`）与跨域混合集合（`['reject','rejected']`）都放行 |

**局限（诚实登记）**：④ 只认同**同一文件内**的声明与使用。跨文件 `import` 进来的具名集合不在检测范围 —— 那需要模块图（成本远超本卡）。这条写进 §5 的残余清单，而不是假装它不存在。

`subject` 生成式刻意接受 `status` / `task.status` / `s?.status` / `execution.status` 等链式写法，并**取最后一个标识符**必须以 `status`/`Status` 结尾 —— 这是「域感知」的最小实现：不需要理解语义，只需要认得出「这是个 status 比较」。

### 2.3 豁免登记表（23 条 → 实测命中 23 个文件 / 48 处）

豁免表 `TERMINAL_LITERAL_EXEMPT_FILES` 每条**必须写清它回答的是哪个问题**。当前分布：

| 域 | 文件 | 回答的问题 |
|---|---|---|
| SSOT 本体 | `shared/src/types/task.ts` | 定义那个集合的人 |
| 浏览器侧投影 | `web-ui/src/lib/taskStatus.ts` | `isTerminal()` 的浏览器副本（写入者仍是 shared，有镜像测试钉住） |
| 看板视图偏好 | `web-ui/src/lib/boardFilters.ts` | 「默认隐藏哪些状态」——**视图偏好**，`completed` 故意不在里面 |
| coding 工具（4） | `core/coding-tools/{context-injector,handlers,runtime}.ts`、`web-ui/CodingToolCard.tsx` | 工具**会话/步骤**是否跑完 |
| 子 agent | `core/tools/subagent.ts` | 子 agent 单次运行是否结束（含 `timeout`） |
| workflow（2） | `core/workflow/engine.ts`、`org-manager/workflow-runner.ts` | 工作流**步骤/运行**状态（含 `skipped`/`paused`） |
| 长任务阶段 | `org-manager/long-task-progress.ts` | `stage.status`，阶段不是卡片 |
| mailbox | `core/mailbox.ts` | item 投递取舍（`merged`/`dropped`） |
| 工具信封 | `core/tools/result.ts` | `error`/`denied`/`deferred` |
| LLM 响应 | `core/llm/openai-codex.ts` | HTTP/响应体 `status` |
| 学习回路 | `core/learning-loop.ts` | 单次运行 opts |
| 桌面通知 | `desktop/notifications.ts` | 点击行为按通知类型分流 |
| 审批（2） | `web-ui/NotificationBell.tsx`、`ExecutionTimeline.tsx` | 审批 `cancelled/expired`、会话流 |
| 分享/审核（5） | `RightPanel`、`DeliverableShareModal`、`Deliverables`、`ArtifactDetail`、`AgentBuilder` | 分享发布态 / Hub `moderationStatus` |

**防滥用**：豁免是**文件级**的，且每条都要写字。新增一个豁免 = 在 diff 里留下一条「我认为这个文件的 status 不是 ItemStatus」的公开声明 —— 比允许在任意行上打 `// eslint-disable` 强得多。

---

## 3. 取证：红 / 绿 / 净三态（真实树，不是夹具）

夹具会撒谎（本仓库踩过：夹具里 `status === 'completed'` 命中，真实树的形态却不同）。所以先在**真实仓库树**上做三态探针：

| 步骤 | 探针内容 | 门禁 | exit |
|---|---|---|---|
| 反例 | `packages/core/src/__probe_terminal.ts`：`status === 'completed'` | ✗ 报「终态谓词门禁失败 … 请改用 isTerminal(status)」 | **1** |
| 正例（不误伤） | 同文件换成 `status === 'running' \|\| 'in_progress' \|\| 'blocked'` | ✓ 通过 | **0** |
| 净态（删探针） | 删除探针文件 | ✓ 通过 | **0** |

三态都留下过输出；探针文件已删除（`git status` 干净，无常驻调试文件）。

### 3.1 固化成的 7 例回归（`packages/core/test/architecture-guard.test.ts`）

| # | 用例 | 断言强度 |
|---|---|---|
| 1 | 终态 `===` 比较 | 必红，且**输出里必须出现** `isTerminal(status)`（门禁要可行动，不只是报错） |
| 2 | `!==` / 反向书写 `'rejected' === status` / 内联终态数组 | **三种写法逐一**必红（漏一种 = 门禁有洞） |
| 3 | 非终态（`running/in_progress/blocked/review`） | **必绿** —— 钉住「不误伤」这条设计 |
| 4 | `isTerminal(status)` + 注释里的示例代码 | 必绿（注释剔除生效） |
| 5 | 其它域豁免文件（`core/mailbox.ts`） | 必绿 |
| 6 | 基线棘轮：=基线→绿；>基线→红；**<基线→红** | 三态，因为「比基线少」这条最容易在实现时被漏掉 |
| 7 | 基线条目 `why` 为空 | 必红（豁免必须解释它回答的是哪个问题） |

### 3.2 全量回归（本分支）

```
Test Files  472 passed | 1 skipped (473)
     Tests  6582 passed | 13 skipped (6595)
```

类型检查（**注意这一条，见 §7**）：

```
npx tsc -b                                          → exit 0
npx tsc --noEmit -p packages/web-ui/tsconfig.json   → exit 0，0 errors
```

---

## 4. 本轮清理：142 → 127（15 处），并把具名集合纳入普查后 = 135

清理判据：**只有「这个判断的真实语义就是『这件工作结束了吗』」才改**。改了会让行为变化的地方，必须能说清变化是正确的。

### 4.1 `core/src/agent-manager.ts:3370` —— 中断任务重排池（3 处 → 0）

```diff
- if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
+ if (isTerminal(task.status)) {
    log.debug('Task already terminal, skipping rehydration', …);
```

**为什么不只是风格问题**：注释写的是「Task already terminal」，但集合只列了 3 个，漏了 `rejected` / `archived`。一个已归档的卡片在重启后被当作「还在跑」重新派发 —— 这是**把终态任务重新唤醒**。`rejected` 同理（被否掉的工作不该自动复活）。改用谓词后集合自动补齐，**行为变正确**，不是变不同。

### 4.2 `org-manager/src/requirement-service.ts:694 / :713` —— 需求转终态时的两个副作用（6 处 → 0）

```diff
- if ((newStatus === 'completed' || newStatus === 'cancelled' || newStatus === 'rejected') && req.createdBy && …)
+ if (TERMINAL_REQUIREMENT_STATUSES.has(newStatus) && req.createdBy && …)
```

两处分别是：① 撤回此前投出的「请审阅/请处理」；② 结算挂在该需求上的审批行。

**这两处漏的是 `archived`**：需求被归档时，行动型提醒不撤回、审批行不结算 —— 于是「已完成/已归档的需求挂着一个待审批徽标」（本仓库踩过同类事故：`apr_mw08kfis_u` → `req_2c9595…completed`）。改用集合后，归档也走同一条路径。

> 用 `TERMINAL_REQUIREMENT_STATUSES` 而不是 `isTerminal()`：需求的终态**不含 `failed`**（需求不会被「执行失败」）。这是 P0 已经分好的两个集合，别合并 —— 合并会让失败的需求不再撤回提醒。

### 4.3 `web-ui/src/pages/Work.tsx:7948 / :7449` —— 需求卡片与依赖候选（6 处 → 0）

```diff
- const isTerminal = req.status === 'completed' || req.status === 'rejected' || req.status === 'cancelled' || req.status === 'archived';
+ const reqTerminal = isTerminal(req.status);           // 复用 lib/taskStatus.ts 的投影

- .filter(tk => tk.status !== 'completed' && tk.status !== 'cancelled')
+ .filter(tk => !isTerminal(tk.status))                 // 依赖候选：终态卡片不能当阻塞项
```

**第二个是真 bug**：依赖候选只排除了 `completed`/`cancelled`，于是 `failed`/`rejected`/`archived` 的卡片仍然可以选为依赖 —— 选完永远等不到满足（`blockerVerdict` 会判 dead）。这不是展示问题，是**让用户建出一个必然是死的依赖**。

局部变量改名 `reqTerminal`（而不是删掉它）：同名变量会遮蔽 import，`!isTerminal` 会把**函数**当真值取反 → 恒 false。这个坑本轮真的踩了，见 §7。

### 4.4 `web-ui/src/pages/Work.tsx:2468` —— **第二份终态定义**（评审第 4 轮阻断项）

```diff
- const isTerminal = isCompleted || isFailed || isRejected || isCancelled || isArchived;
+ const taskTerminal = isTerminal(task.status);   // 终态判定走投影，不再自己拼一份
… 2714 / 2741 / 3231:  !isTerminal  →  !taskTerminal
```

这不是「又一处裸比较」，而是**同名遮蔽**：`2468` 的局部 `isTerminal` 遮蔽了文件顶部 `import { isTerminal } from '../lib/taskStatus.ts'`，于是同组件内三处 `!isTerminal` 读到的是**本地布尔**而不是谓词。它们分别是「阻塞者可否移除」「依赖候选可否添加」「任务可否取消」——都是真·终态语义的**权限判定**，一旦 `TERMINAL_STATUSES` 增删成员就会静默走偏。

我第一轮只改了 `7948` 那处（需求卡片），漏了 `2468`（任务卡片），**验收项「唯一入口 + grep 证明」因此不成立** —— 评审用 `grep -rn "const isTerminal" packages/*/src` 一行就抓到了。教训：**「我改了这个文件」不等于「这个文件没有第二份定义」**；证明唯一性必须用会失效的命令（grep），不能用「我记得改过」。

同时订正基线 `why`：原措辞写「真·终态判定已在本轮改用 `isTerminal()`」，而当时 2714/2741/3231 并没有改 —— **门禁被自己的 why 骗过**。现在写的是可核验的事实（本文件无第二份终态定义）。

### 4.5 刻意**不**改的三类（并说明理由）

| 位置 | 为什么不能压成 `isTerminal()` |
|---|---|
| `task-service.ts#blockerVerdict`（`:4636-4645`） | `completed\|archived` = **依赖满足**；`cancelled` = **依赖判死**；`failed` = 走可恢复/终结判定。**三个动作不同**。压成一个布尔会把「满足」和「判死」抹成同一件事——这正是 2026-09-12 那次事故的形状。 |
| 指标/统计分桶（`agent-metrics` / `report-service` / `agent-manager` 计数） | 「完成了几个」必须只数 `completed`，不能把 `failed`/`cancelled` 算成完成。这是**分桶**，不是**判定**。 |
| UI 配色/图标（`Work.tsx` / `Home.tsx` / `TaskDAG` / `Search`） | 每个状态一枚图形。合并会让「失败」和「已完成」长成同一个样子 —— 用户可见的**信息损失**。 |

这三类的共同点：**它们问的不是「结束了吗」**。这也解释了为什么本轮只清 15 处而不是全部 —— 剩下的 130+ 处里大部分**本来就不该改**，它们需要的是「登记 + 说明」，不是「重构」。

---

## 5. 残余：135 处按文件的账（谁还需要清）

存量 **135 处 / 19 个文件**，每条都带 `why`（写明它回答的是哪个问题）。按可清理度分档：

| 档 | 文件（处数） | 性质 |
|---|---|---|
| **A · 真·终态判定，可继续收口** | `task-service.ts`(32) 中的子任务完成计数/统计分支、`web-ui/Work.tsx`(38) 中的 `dep.status === 'completed'` | 「依赖是否满足」「子任务完成数」——比 `isTerminal()` 窄，但是**同一个域**的判定，值得抽 `isSatisfied(status)` 之类的第二谓词 |
| **B · 具体状态语义，登记即终点** | 指标分桶（`agent-metrics` 4 / `report-service` 3 / `agent-manager` 8）、UI 配色（`Home` 6 / `Search` 2 / `SearchModal` 2 / `TaskDAG` 3 / `ProjectSidebar` 3）、路由守卫（`api-server` 6）、归档阈值（`archive-service` 1）、`sqlite-storage` 3、入参白名单（`task-tools` 7） | 问的是「是不是 X」，压成布尔会丢信息。**不该改** |
| **C · 混合状态集合** | `scheduled-task-runner.ts`(4)、`event-routes.ts`(1) | 集合里同时含终态与非终态（`blocked`/`review`），本身就是另一个问题（可重置 / 需人介入） |
| **D · 具名终态集合（本轮新纳入）** | `web-ui/lib/workflow-view.ts`(4) 的 `DONE_STATUSES`/`FAILED_STATUSES`、`org-manager/agent-conservator.ts`(1) 的 `DEAD_DEP_STATUSES` | 都是**真子集**语义：`DONE` 排除 failed/rejected；`DEAD_DEP` 排除 completed（满足≠判死）。合并会制造语义错误 |

**已知洞（明写在卡片上，不假装没有）**：

1. **跨文件的具名集合不在检测范围**。`import { SOME_TERMINAL_SET } from './x'` 然后在 `y.ts` 里 `SOME_TERMINAL_SET.includes(s)`，两处不在同一文件 ⇒ 检测不到（需要模块图）。同一文件内的声明+使用已覆盖（§2.2 ④）。
2. **非 `status` 命名的载体不拦**。例如 `x.state` / `x.phase` 上的终态比较，或把状态塞进 `Map<string, boolean>` 再判。选 `status` 是刻意收窄——扩到任意标识符会让误报率爆炸，门禁会被关掉。
3. **反引号/拼接写法不拦**：`` `${status}` === 'completed' `` 之类。同上，属于「故意绕过」而非「自然写法」，靠评审兜。

**推进条件（谁在什么时候该动它）**：

1. **只要有人碰到 A 档代码，同一次提交必须顺手清掉该文件的那几行** —— 门槛由双向棘轮强制（清一处就必须改基线）。这就是本卡真正的作用：不是一次性清零，而是**让数字只往一个方向走**。
2. **`blockerVerdict` 的 satisfied/dead 分离**（`task-service.ts:4636`）建议后续抽成 `blockerVerdict` 内部的局部谓词并加测试，而不是全局合并 —— 见 §4.5。
3. **审批域的三态**（`NotificationBell` 的 `cancelled/expired`）属于另一个待办（审批三态设计红线），本卡不碰。
4. **若第 1 条洞开始真的伤人**（出现跨文件具名终态集合导致的漏判），触发条件是把检测升级为「先收集全仓具名终态集合，再扫使用点」——单文件解析升级为两趟扫描，成本约半天，届时单独开卡。

**本卡明确不做的事**：不追求「135 → 0」。135 里超过一半是**正确的**具体状态判断。把正确的代码改成错的，比留着裸露字符串更坏。

---

## 6. 操作手册（下一个人怎么用）

### 6.1 日常

```bash
node scripts/architecture-guard.mjs          # 平时：有未登记终态裸比较 → exit 1
node scripts/architecture-guard.mjs --list   # 审计：逐条列出未登记 / 基线待精简
```

输出示例（当前状态）：

```
[guard] 终态谓词：扫到 135 处终态裸比较（已登记 135 处 / 未登记 0 组 / 待精简 0 组）；
[guard]            另有 48 处落在 23 个其它域豁免文件里
        另有 45 处落在 20 个其它域豁免文件里（豁免清单见 …#TERMINAL_LITERAL_EXEMPT_FILES）
[guard] ✓ 通过：34 处命中全部在已登记白名单内；契约不变量 17/17 满足。
```

### 6.2 我新写了一处终态比较，门禁红了，怎么办

三选一，**按优先级**：

1. **改成 `isTerminal(status)`** —— 90% 的情况应该是这个。
2. **如果它问的是「某个具体状态」**（例：只统计顺利完成），在 `scripts/terminal-status-baseline.json` 里给该文件加/调 `count`，并在 `why` 里写清「它回答的是哪个问题」（≥8 字）。**新增计数必须手写**——`--prune-terminal-baseline` 会**拒绝**任何新文件/新增计数，物理上堵死「一键洗白」。
3. **如果它根本不是 ItemStatus**（例：coding 工具会话状态），在 `architecture-guard.mjs#TERMINAL_LITERAL_EXEMPT_FILES` 加一条，写明它属于哪个域。

### 6.3 我清掉了几处，怎么缩基线

```bash
node scripts/architecture-guard.mjs --prune-terminal-baseline
```

它只会**下调已有文件的计数 / 删除已消失的文件条目**；一旦发现新命中就报错退出、**不写盘**。

### 6.4 口径复算（复现 §1 的四个数字）

```bash
cd <repo>
node -e '
const fs=require("fs"),p=require("path");
const SKIP=new Set(["node_modules","dist","build",".git","coverage","out"]);
const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);
 if(e.isDirectory()){if(SKIP.has(e.name))continue;w(f);continue;}
 if(!/\.(ts|tsx)$/.test(e.name)||/\.d\.ts$/.test(e.name))continue;
 const rel=p.relative(process.cwd(),f).replaceAll("\\","/");
 if(/^packages\/[^/]+\/src\//.test(rel))files.push([rel,f]);}})(p.join(process.cwd(),"packages"));
const V={
 A:/\.status\s*(===|!==|==|!=)\s*[\x27\x22][a-z_]+[\x27\x22]/g,
 B:/\bstatus\s*(===|!==|==|!=)\s*[\x27\x22][a-z_]+[\x27\x22]/g,
 C:/\.status\s*===\s*[\x27\x22][a-z_]+[\x27\x22]/g,
 D:/status\s*(===|!==)\s*[\x27\x22](completed|failed|rejected|cancelled|archived)[\x27\x22]/g};
const c={};for(const k in V)c[k]={occ:0,lines:0,files:new Set()};
for(const [rel,f] of files){const t=fs.readFileSync(f,"utf8");
 for(const k in V){const re=new RegExp(V[k].source,"g");let m;while((m=re.exec(t))){c[k].occ++;c[k].files.add(rel);}}
 for(const ln of t.split("\n"))for(const k in V){if(new RegExp(V[k].source).test(ln))c[k].lines++;}}
console.log("srcFiles",files.length);
for(const k in c)console.log(k,"occ="+c[k].occ,"lines="+c[k].lines,"files="+c[k].files.size);'
```

### 6.5 两种计数的关系（别混）

| 数字 | 含义 | 谁在用 |
|---|---|---|
| **135** | 门禁口径：注释剔除 + 终态字形（含具名集合）+ 只算非豁免文件 + 一处一次 | 门禁 / 基线 / CI |
| **155 / 136 行** | 普查口径 D：纯正则、含注释、含豁免文件、按**出现次数**计 | §1 的口径对账 |

两个数字**不该相等**，也不代表谁错——它们是两个不同的问题。写报告时必须说明用的是哪个（本卡坑：审计里的数字没写口径，于是无法复现）。

---

## 7. 诚实记录：本轮三个失败

### 7.1 `tsc -b` 假绿：它根本不覆盖 `packages/web-ui`

上一轮（本卡第一次提交 `a0daafc3`）验证写的是 `npx tsc -b → exit 0`。**这是假绿**：仓库根 `tsconfig.json` 的 `references` 只含 8 个包，**`packages/web-ui` 不在其中**。

本轮跑真正的全量检查才暴露 **2 个类型错误**（都是我改 `Work.tsx` 时引入的）：

```
Work.tsx(8103,26): error TS2322: Type '(status: string|null|undefined) => boolean' is not assignable to 'boolean|undefined'
Work.tsx(8489,12): error TS2774: This condition will always return true since this function is always defined.
```

**根因**：我把 `const isTerminal = <字面量链>` 改成 `const reqTerminal = isTerminal(req.status)`，但只改了该组件里**一部分** `!isTerminal` 用法；剩下的裸 `{isTerminal && …}` / `disabled={isTerminal}` 现在指向**导入的函数**（恒真值）→ 条件恒成立、`disabled` 传函数。

这正是本卡要治的病的镜像：**同名遮蔽**。变量名和函数名撞车时，`!isTerminal` 从「取反布尔」静默变成「取反函数引用」—— 类型检查能抓到，测试大概率抓不到（UI 条件恒真不会抛错，只会让"终态需求仍可编辑"）。

**已修**：该组件内余下 7 处全部改为 `reqTerminal`；`npx tsc --noEmit -p packages/web-ui/tsconfig.json` → **exit 0 / 0 errors**。
**纪律修正**：本卡起，凡改 `web-ui`，验证必须以 `pnpm typecheck`（`tsc -b && tsc --noEmit -p packages/web-ui`）为准，不能只写 `tsc -b`。

> 我更正一下上一轮的说法：`a0daafc3` 的「类型检查通过」不成立，它只是「不覆盖 web-ui 的那部分通过」。真正的绿是本轮这笔提交。

### 7.2 我一度打算把存量全清掉

一度把「存量」当成待办清单。读代码后发现其中过半是**正确的**具体状态判断（指标分桶、UI 配色、`blockerVerdict` 的 satisfied/dead）。若按字面量批量替换，会把「依赖满足」并成「依赖判死」、把失败图标并成完成图标。

**结论修正**：本卡的交付物是**门禁 + 分类 + 可下降的机制**，不是「数字归零」。已写进 §4.5 / §5，避免下一个执行人重犯。

### 7.3 具名集合的第一版判据**误伤**了审批 token（被自己的探针抓到）

给「具名终态集合」写第一版检测时，判据是「集合里**含**至少一个终态字形」。跑真实树立刻误伤：

```
web-ui/src/api.ts:484  const APPROVAL_REJECT_TOKENS = new Set(['reject', 'rejected']);
                                              ↑ 'rejected' 是终态字形，但这里是**审批 token**
```

根因：**英文状态词跨域重名**（`rejected` 既是任务终态也是审批结果）。若照此上线，`api.ts` 里三处 `has(token)` 会被判红，而它们是审批动作解析 —— 第一次误红就会有人把整条规则关掉。

**修法**：判据从「含」改成「**纯度**」—— 集合里**每一个**字面量都是终态字形，才算终态集合。于是 `['completed','archived']` 命中、`['reject','rejected']` 放行、`['pending','in_progress','review']` 放行。同时把 `approval-card.ts` 的豁免条目**删掉**（纯度判据下它已无命中，留着就是悬空配置 —— 下一个人会以为有人在守一个其实不存在的检查）。

> 这批改动的共同形状：**门禁的域判定信号要选离事实最近的那个**。「文件名」最远（同域跨文件误伤）、「实参名」次之（`T.includes(s)` 绕过）、「集合内容」最近。选错了方向，两种失败都会来：先漏报（`T.includes(s)`），再误伤（`['reject','rejected']`）。

---

## 8. 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/architecture-guard.mjs` | 新增规则 6 `terminal-status-predicate`：检测器（四种写法：`===`/`!==` 双向 + 内联数组 + **具名集合**）、注释等长剔除、豁免表（23 条）、双向棘轮基线、`--prune-terminal-baseline`（只许缩小，拒绝写大）、`--list` 输出、失败提示 |
| `scripts/terminal-status-baseline.json` | 新增：19 文件 / 135 处 / 每条带 `why` |
| `packages/core/test/architecture-guard.test.ts` | 新增 9 例回归（红 / 绿 / 不误伤 / 棘轮三态 / 缺 why / 具名集合必红 / 具名非终态放行） |
| `packages/core/src/agent-manager.ts` | 中断任务重排池 → `isTerminal()`（补 `rejected`/`archived`） |
| `packages/org-manager/src/requirement-service.ts` | 需求转终态的两个副作用 → `TERMINAL_REQUIREMENT_STATUSES.has()`（补 `archived`） |
| `packages/web-ui/src/pages/Work.tsx` | 需求卡片终态 → `isTerminal()`；依赖候选过滤 → `!isTerminal()`；**任务卡片删除第二份终态定义**（`isTerminal = isCompleted \|\| …` → `taskTerminal = isTerminal(task.status)`，三处 `!isTerminal` 随之改名） |
| `docs/architecture/p3-terminal-status-gate.md` | 本文档 |



