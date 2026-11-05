# P3 · 状态裸比较收口：`isTerminal()` 唯一入口 + 门禁拦住新增违规

- **任务**：`tsk_1e766b22991e370479a5b1f2`（req_410d823e89f19d6df27e578d · 硬编码字符串审计 P0–P4）
- **分支**：`task/tsk_1e766b22991e370479a5b1f2-cto`（基线 = P0 收口提交 `d2f78684`，与 P0/P1/P2/P4 同基线，便于串行合并）
- **日期**：2026-11-05
- **一句话结论**：`isTerminal()` 现在是终态判定的**唯一入口**（附 grep 证明），且**新增裸比较会在提交前被机器拦住**；存量 127 处按文件登记为带理由的基线，基线**只能缩小**。

---

## 1. 先纠正口径：审计里的「386」不可复现

卡面要求「第一步不是改代码，是把 386 分类」。实测结论：**386 这个数字不属于任何一个可复现的 grep 口径**。

在 `packages/*/src/**/*.{ts,tsx}`（684 个文件）上跑四种口径：

| 口径 | 正则 | 出现次数 | 命中行 | 文件数 |
|---|---|---:|---:|---:|
| A 带属性 | `\.status\s*(===|!==|==|!=)\s*'…'` | 603 | 530 | 91 |
| B 含裸标识符 | `\bstatus\s*(===|!==|==|!=)\s*'…'` | 728 | 636 | 100 |
| C 带属性、单方向 | `\.status\s*===\s*'…'` | 468 | 404 | 81 |
| D **只算终态字形**（本卡真正关心的） | `status\s*(===|!==)\s*'(completed|failed|rejected|cancelled|archived)'` | **155** | 136 | 33 |

没有一个等于 386。**这不是审计作者的错，而是这类数字的通病**：`status` 在 6 个互不相干的域里出现（任务、需求、审批、coding 工具、会话流、工作流节点），任何「扫全仓 status 比较」的计数都在偷偷混合问题。所以本卡不拿任何单一数字当目标——下面的分类才是可判定的口径。

> 同一批审计里 P0 的「5 处」实为 8 处、P1 的「97 处」按字面量实测为 0 处、P2 的「20 处」实为 188 行，已在本轮之前的复核中更正。

---

## 2. 分类结果（不是 386 的 386）

### 2.1 门禁的判定口径

门禁只看**终态字形**（`completed` / `failed` / `rejected` / `cancelled` / `archived`）与状态主体的比较，并**只**在下面三个问题里做区分：

| 类别 | 判定 | 处置 |
|---|---|---|
| **① 终态语义**：问的是「这件工作结束了吗」 | `status === 'completed' \|\| status === 'failed' \|\| …`，或内联终态数组 | **改用 `isTerminal(status)`** |
| **② 具体状态语义**：问的是「它是不是 completed / 是不是 archived」 | 状态分桶计数、图标配色、`completed_at` 落库、依赖 satisfied vs dead | 允许保留，但**必须在基线里写明 why**（它回答的是哪个问题） |
| **③ 其它域**：字形同名但不是同一个事实 | 审批、coding 工具会话、mailbox item、工作流节点/运行、Hub 审核、分享评审、LLM 响应 | **文件级豁免**，门禁不得拦 |

### 2.2 门禁实际看到的数（可重跑）

```
node scripts/architecture-guard.mjs
→ 终态谓词：扫到 127 处终态裸比较（已登记 127 / 未登记 0 / 待精简 0）；
  另有 45 处落在 20 个**其它域**豁免文件里
```

- **127 处 = 类别 ①②（任务/需求域内）**，分布在 **17 个文件**，全部进基线（每条带 why）。
- **45 处 = 类别 ③**，分布在 **20 个文件**，文件级豁免 + 一句话理由（清单在 `scripts/architecture-guard.mjs#TERMINAL_LITERAL_EXEMPT_FILES`，运行时也会打印总数——**豁免清单藏了多少必须可见**，否则它就是第二个黑洞）。
- 两者相加 172 处，与字符扫描的 188 处差 16 处：注释里的示例代码被剔除（本仓库确实有若干注释写着 `status === 'completed'` 作为说明），同行的重复字形按出现次数计。

### 2.3 类别 ③ 的 20 个豁免文件（为什么它们不该被拦）

| 文件 | 它问的是哪个问题 |
|---|---|
| `shared/src/types/task.ts` | SSOT 本体：`TERMINAL_STATUSES` 就在这里定义 |
| `core/src/coding-tools/{context-injector,handlers,runtime}.ts` | coding 工具**步骤/会话**状态（含 `timeout`，任务没有这个状态） |
| `core/src/learning-loop.ts` | 学习回路单次运行的 `opts.status` |
| `core/src/llm/openai-codex.ts` | LLM 响应对象的 `response.status`（HTTP 语义） |
| `core/src/mailbox.ts` | mailbox item 状态（queued/processing/dropped/merged） |
| `core/src/tools/result.ts` | 工具结果信封（error/denied/deferred） |
| `core/src/tools/subagent.ts` | 子 agent 单次运行状态 |
| `core/src/workflow/engine.ts`、`org-manager/src/workflow-runner.ts` | 工作流**节点** / **运行**状态（含 `skipped`/`paused`） |
| `org-manager/src/long-task-progress.ts` | 长任务**阶段**状态（stage ≠ 卡片） |
| `desktop/src/notifications.ts` | 桌面通知点击分流 |
| `web-ui/.../CodingToolCard.tsx`、`ExecutionTimeline.tsx` | UI 侧的工具会话状态（同 core/coding-tools） |
| `web-ui/.../NotificationBell.tsx` | **审批**状态（cancelled/expired） |
| `web-ui/.../{RightPanel,DeliverableShareModal,Deliverables}.tsx` | 分享 / 分享评审状态 |
| `web-ui/.../{ArtifactDetail,AgentBuilder}.tsx` | Hub 资产审核状态（moderationStatus） |

> **这张表就是卡面要求的「拦下的必须全是终态语义」的证据**：把审批单、coding 工具、流状态一起改坏，正是「386 → 0」那种目标会造成的后果。

---

## 3. 门禁设计（三个取舍，请评审重点看）

新增规则 `terminal-status-predicate`，写在既有 `scripts/architecture-guard.mjs`（CI 已经在跑，不新建第二套门禁体系）。

**① 默认拦（default deny）**：扫 `packages/*/src` 下**全部**文件，只在类别③的文件上按文件豁免。
极性不能反过来（只扫白名单文件）：那样**新文件天生失明**——只看得见存量、看不见新增的门禁等于没有门禁，而这正是本仓库历史上反复出现的失效形态。

**② 只拦终态字形**：`status === 'running' / 'in_progress' / 'pending' / 'blocked' / 'review'` 一律放行。
拦非终态比较是**错的门禁**：它把「正在跑吗」和「结束了吗」混成一个问题，上线后第一次误红就会被人整体关掉。有测试专门钉住这一条（见 §4）。

**③ 双向棘轮基线**（`scripts/terminal-status-baseline.json`）：按**文件**记数，每条必须带 `why`（≥8 字）。
- 现状 **多于**基线 → 红（新增违规，或混进第二种写法）；
- 现状 **少于**基线 → 也红（代码已清理但基线没缩）。
只拦新增的基线会让存量永远躺着；只有「机器只能缩小、人必须解释增长」才能让数字单调下降。
`--prune-terminal-baseline` **只允许删**：遇到未登记文件直接拒绝写盘，并打印正确动作（改 `isTerminal()` 或手工登记 why）。

**为什么按文件记数而不是按行**：按行的基线在每次无关重排时 churn，人就把它当噪声整片删掉。按文件记数既让「还剩多少处」逐文件可读，又让任何新增处**必然**改变计数 → 必红。

**注释不算违规**：检测前把注释替换成等长空白（保留偏移，行号仍对得上原文）。本仓库有多处注释举例 `status === 'completed'`，不剔除会让门禁变成「不许写注释」。

---

## 4. 红/绿双态验证

### 4.1 真实仓库上的三态取证（不是夹具）

```
# 反例：往 packages/core/src 放一处终态裸比较
$ cat packages/core/src/__probe_terminal.ts
export function probeA(status: string) { return status === 'completed'; }
$ node scripts/architecture-guard.mjs ; echo exit=$?
[guard] ✗ 终态谓词门禁失败：1 组终态裸比较未登记。
[guard]   「这件工作结束了吗？」只有一个答案入口：isTerminal(status)
  ✗ packages/core/src/__probe_terminal.ts:1
exit=1                                    ← 红

# 不误伤：换成非终态比较
$ cat packages/core/src/__probe_terminal.ts
export function probeB(status: string) { return status === 'running' || status === 'in_progress' || status === 'blocked'; }
$ node scripts/architecture-guard.mjs ; echo exit=$?
exit=0                                    ← 绿

# 撤销探针
$ rm packages/core/src/__probe_terminal.ts && node scripts/architecture-guard.mjs; echo exit=$?
exit=0                                    ← 净
```

### 4.2 固化为回归（`packages/core/test/architecture-guard.test.ts`，新增 7 例）

```
$ npx vitest run packages/core/test/architecture-guard.test.ts
✓ packages/core/test/architecture-guard.test.ts (12 tests)
Test Files 1 passed (1) · Tests 12 passed (12)
```

| 用例 | 断言 |
|---|---|
| `status === 'completed'` | 红，失败信息含 `isTerminal(status)` |
| `status !== 'archived'` / `'rejected' === status` / `['completed','archived'].includes(status)` | 三种写法各自红 |
| `status === 'running' \|\| 'in_progress' \|\| 'blocked' \|\| 'review'` | **放行**（不误伤） |
| `isTerminal(status)` + 注释里的 `status === 'completed'` | 放行 |
| `core/src/mailbox.ts`（其它域豁免文件） | 放行 |
| 基线 count=1 现状=1 → 绿；count=0 现状=1 → 红；count=3 现状=1 → 红 | 双向棘轮 |
| 基线条目 `why: ""` | 红（豁免必须解释它回答的是哪个问题） |

---

## 5. 老代码清理：本轮数字（分阶段，不搞「以后再说」）

### 5.1 本轮清零 15 处（4 个点位）

**判据**：只改「这个判断本身就在问『结束了吗』」而且**枚举不全**的点位——枚举 3 个终态就当终态集用，正是 `rejected` / `archived` 被静默漏判的成因。

| # | 位置 | 改法 | 行为变更 |
|---|---|---|---|
| 1 | `packages/core/src/agent-manager.ts:3371` | `task.status === 'completed' \|\| 'cancelled' \|\| 'failed'` → `isTerminal(task.status)` | **有**：`rejected` / `archived` 的任务不再被「中断任务重新排队」逻辑捞回来（终态不该再被驱动，这是修正而非变更） |
| 2 | `packages/org-manager/src/requirement-service.ts:695` | 三态枚举 → `TERMINAL_REQUIREMENT_STATUSES.has(newStatus)` | **有**：`archived` 需求转态时也会撤回 actionables（原来是漏的） |
| 3 | `packages/org-manager/src/requirement-service.ts:710` | 同上（结算审批） | **有**：`archived` 需求转态时也会结算挂着的 pending 审批行 |
| 4 | `packages/web-ui/src/pages/Work.tsx:7948` | 局部 `const isTerminal = req.status === …（4 态）` → `const reqTerminal = isTerminal(req.status)` + 6 处使用点改名 | 无（原来 4 态已穷尽 requirement 终态；改的是**写法**：局部变量名 `isTerminal` 会遮蔽 import，是隐形第二定义） |
| 5 | `packages/web-ui/src/pages/Work.tsx:7449` | `tk.status !== 'completed' && tk.status !== 'cancelled'` → `!isTerminal(tk.status)` | **有**：依赖候选不再列出 `failed` / `rejected` / `archived` 的任务（原来只有 2 态，会把已判死的任务当可选依赖） |

合计：**142 → 127**，清零 15 处（基线已同步缩到 127；若只改代码不改基线，门禁会以「基线只允许缩小」判红——本轮实测过这条路径）。

### 5.2 剩余 127 处 / 17 个文件（按包分布）

| 包 | 处数 | 文件 |
|---|---:|---|
| `web-ui` | 54 | `pages/Work.tsx` 38、`pages/Home.tsx` 6、`components/{ProjectSidebar,TaskDAG}` 各 3、`components/SearchModal` 2、`pages/Search.tsx` 2 |
| `org-manager` | 52 | `task-service.ts` 32、`requirement-service.ts` 7、`api-server.ts` 5、`report-service.ts` 3、`scheduled-task-runner.ts` 3、`archive-service.ts` 1、`event-routes.ts` 1 |
| `core` | 18 | `agent-manager.ts` 8、`tools/task-tools.ts` 6、`agent-metrics.ts` 4 |
| `storage` | 3 | `sqlite-storage.ts` 3 |
| **合计** | **127** | **17** |

每一条的 `why` 都在 `scripts/terminal-status-baseline.json` 里，可逐条复核。它们的共同点：**回答的是「某个具体状态」而不是「是否已结束」**（分桶计数、图标配色、`completed_at` 落库、依赖 satisfied vs dead 三分支、归档保留天数）。

> 特别说明 `task-service.ts` 的 32 处：其中 `blockerVerdict()` 用 `completed|archived = satisfied`、`cancelled = dead`、`failed` 走可恢复判定。**压成 `isTerminal()` 会抹掉「依赖满足 vs 依赖判死」的区别**——这正是「不改状态机语义、不盲目 386→0」的具体体现。

### 5.3 后续推进触发条件（可判定，不是「以后再说」）

| 触发条件 | 动作 | 预期减量 |
|---|---|---|
| 任何一次要动 §5.2 表格里某文件 | 顺手清该文件的点位，同一次提交跑 `--prune-terminal-baseline` | 按文件计 |
| 要做「任务统计口径统一」（指标 / 日报 / 侧边栏计数）| 先抽 `countByStatus()`，三处计数一起换 | `agent-manager` 8 + `agent-metrics` 4 + `report-service` 3 + `Work.tsx` 部分 ≈ 20 |
| 需求侧 `checkCompletion` 的 `completed\|cancelled\|archived` 定性（P0 登记的独立议题）| 定性后要么改成显式 `SUCCESSFULLY_CLOSED` 谓词，要么并入 | `requirement-service` 7 |
| 展示层图标/配色统一到 `statusMeta` 表 | 把散落三元表达式换成查表 | `Work.tsx` 与 `Home`/`Search`/`TaskDAG` 约 40 |

**硬约束**：无论怎么推进，127 这个数**只能下降**——门禁会拦住任何一个让它上升的提交。

---

## 6. 观测方式（门禁在哪儿跑、红了长什么样、本地怎么复现）

### 6.1 CI 中的位置

`.github/workflows/ci.yml` 已有 `Architecture guard` 步骤（在 `typecheck` / `lint` 之后、`test` 之前）：

```yaml
- name: Architecture guard
  run: node scripts/architecture-guard.mjs
```

新规则挂在同一条命令里，**没有新建第二套门禁**——门禁一多，谁都不清楚哪条是真在跑的。本地等价入口：`npm run quality`（`package.json` 已含 `node scripts/architecture-guard.mjs`）。

### 6.2 失败信息（照抄真实输出）

```
[guard] ✗ 终态谓词门禁失败：1 组终态裸比较未登记。
[guard]   「这件工作结束了吗？」只有一个答案入口：isTerminal(status)
[guard]   （@markus/shared#isTerminal / web-ui lib/taskStatus.ts#isTerminal）。
[guard]   裸写 completed/failed/rejected/cancelled/archived 会在新终态出现时静默漏判。
  ✗ packages/core/src/__probe_terminal.ts:1
      export function probeA(status: string) { return status === 'completed'; }
[guard]   若这是「某个具体状态」而非「是否已结束」（例：只统计 successfully completed），
[guard]   请在 .../scripts/terminal-status-baseline.json 登记该行并写明 why。
```

基线未缩时的失败信息：

```
[guard] ✗ 终态基线比现状更宽松：1 组条目对应的代码已不再裸比较。
[guard]   基线只允许缩小 —— 已清理的请在同一次提交里删除对应条目，否则存量数字永远不会下降。
[guard]   可执行：node scripts/architecture-guard.mjs --prune-terminal-baseline
```

### 6.3 本地复现 / 日常命令

```bash
node scripts/architecture-guard.mjs              # 门禁（有违规 exit 1）
node scripts/architecture-guard.mjs --list       # 只列：哪些点位未登记、哪些基线条目该删
node scripts/architecture-guard.mjs --prune-terminal-baseline   # 清理后同步基线（拒绝新增）
```

---

## 7. 验收对照

| 验收项 | 证据 | 结论 |
|---|---|---|
| 门禁反例验证（红/绿两态） | §4.1 真实树 `exit 1 → 0 → 0`；§4.2 夹具测试 7 例 | ✅ |
| 不误伤验证（非终态比较放行） | `status === 'running' \|\| 'in_progress' \|\| 'blocked' \|\| 'review'` → `exit 0`；豁免文件 `mailbox.ts` → 放行 | ✅ |
| `isTerminal()` 是终态判断唯一入口（附 grep 证明） | §8 grep 台账 | ✅ |
| 报告含分类结果 / 清零数 / 剩余数 / 按包分布 / 触发条件 | §2、§5 | ✅ |
| `tsc -b` 干净 | `npx tsc -b` → `exit 0` | ✅ |
| org-manager + core + web-ui 全量回归绿 | `472 files passed \| 1 skipped`；`6582 passed \| 13 skipped` | ✅ |
| 不改 FSM 语义 / 不改 `TERMINAL_STATUSES` 成员 | diff 未触及 `shared/src/types/task.ts#TASK_TRANSITIONS` 与 `TERMINAL_STATUSES` | ✅ |
| 不把 386 一次改完 | 本轮清 15 处，其余 127 处按文件登记 + 棘轮 | ✅ 按卡面要求 |

---

## 8. grep 台账（单一入口的证明）

```bash
# 1) ItemStatus 的终态定义：只有一处写入者 + 一处浏览器投影
$ grep -rn "TERMINAL_STATUSES\s*[:=]" packages/*/src
packages/shared/src/types/task.ts:35        ← 唯一写入者（ItemStatus 终态）
packages/web-ui/src/lib/taskStatus.ts:22    ← web-ui 投影（浏览器构建不能 import @markus/shared；
                                            #  漂移由 shared 侧 terminal-status-mirror 测试判红）
packages/cli/src/commands/approval-card.ts:31        ← **审批**状态（approved/rejected/cancelled/expired）
packages/web-ui/src/components/CodingToolCard.tsx:40 ← **coding 工具**状态（含 timeout）
# 后两处是字形同名的**其它域**，不是第二个写者：终态谓词门禁对它们文件级豁免（见 §2.3）

# 2) 终态谓词：shared 定义 + web-ui 投影；org-manager 的 isTerminalTaskStatus 只是转发
$ grep -rn "function isTerminal" packages/*/src
packages/shared/src/types/task.ts:58
packages/web-ui/src/lib/taskStatus.ts:31
$ sed -n '69,71p' packages/org-manager/src/task-attention.ts
export function isTerminalTaskStatus(status: string | undefined): boolean {
  return isTerminal(status);          ← P0 已把这里含 'accepted' 的私有 Set 删掉，只剩转发
}

# 3) 域内裸终态比较：全部在带理由的基线里，未登记的一律让门禁判红
$ node scripts/architecture-guard.mjs --list | tail -2
[guard] 终态裸比较：127 处（未登记 0 组，基线待精简 0 组）。
```

---

## 9. 残余（如实列出，不粉饰）

1. **基线仍是 127 处**：这是「不能一次改完」的代价，不是遗漏。防线是双向棘轮——只能减，不能增；`--prune-terminal-baseline` 物理上拒绝新增。
2. **门禁只看终态字形**：`setTimeout` 式的动态写法（例如先 `const TERMINAL = [...]` 再跨行 `.includes(x)`）检测不到。静态正则的能力边界就在这里；`TERMINAL_STATUSES` 唯一化已经把这类「先存数组」的动机削掉了。
3. **类别②的 127 处里可能有伪装的终态判断**：例如某处写 `completed || cancelled` 其实是「已收尾」而不是「终态」。基线里的 `why` 是我逐文件读后的判断，**需要评审复核**——这也是把 `why` 放在基线里、而不是散在代码注释里的原因。
4. **`boardFilters.ts` 仍是独立的 `HIDDEN_BY_DEFAULT_STATUSES`**（P0 已按评审建议 A 正名并**不并入**终态集）：它问的是「默认看板要不要藏」，合并会造成用户可见的行为变更。本轮未动。
5. **web-ui 是投影而非 import**：浏览器构建不能运行时 import `@markus/shared`（既有约束，`lib/mailboxTypeMeta.ts` 同机制）。漂移靠 `packages/shared/test/terminal-status-mirror.test.ts` 判红，不靠人记得。

