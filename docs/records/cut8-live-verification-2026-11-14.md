# Cut 8 真机收口验证：四卡读数在同一棵树上交叉复核（2026-11-14）

> 卡片：`tsk_d5c97ad4f4d267deb748e998`（C8 刀级收口验证）· 需求 `req_7799660f21473201546d9cca`
> 验证人：CTO · 读数时刻：**2026-11-14T10:14–10:16Z（18:14–18:16 Asia/Shanghai）**
> 取证脚本：`workspace/cut8-verify.sh`（只读，输出落 `workspace/cut8-verify-out/probe-101601.txt`）
> **结论：`有残余`** —— 代码级五条判据全部咬人通过；三条真机读数因**生产实例仍是 C8 之前的构建**而无法在本次观察，残余归属见 §6。

---

## 1. 验证树：为什么「同一实例」只能是集成树（本次最重要的结构事实）

判据要求「四卡读数在**同一真实实例**上同时成立」。开工取证时的事实是：

| 卡 | PR | 分支 tip | 是否已进 `feat/refactor-plan` |
|---|---|---|---|
| C8-D 工具可达性 | #447 | `8915cf12` | ✅ 已合并（`8b0d94b7`） |
| C8-A 实体键收敛 | #448 | `9908feec` | ❌ 仍 OPEN |
| C8-B 轮内 delta 注入 | #449 | `fe16ca25` | ❌ 仍 OPEN（叠在 A 之上） |
| C8-C 单时钟 | #446 | `75b59966` | ❌ 仍 OPEN |

也就是说：**没有任何一个已存在的分支同时含四卡**。若在 `feat/refactor-plan` 上取证，只能验到 D；在单卡分支上取证，只能验到那一张。这与卡面的「四卡分开绿 ≠ 一起绿」正好命中。

因此本次取证树 = `origin/feat/refactor-plan` 上**本地零冲突集成**三张未合并分支（不改任何远端分支）：

```
base   8b0d94b7  Merge PR #447 (C8-D)
+ A    6bb84c35  Merge origin/task/c8-a-entity-keys      (9908feec)
+ B    3181fc72  Merge origin/task/c8-b-turn-delta-injection (fe16ca25)
+ C    5407bb3f  Merge origin/task/c8-c-single-clock     (75b59966)
```

- 三次 merge **零冲突**（`git status --porcelain | grep -E '^(UU|AA|DD)'` 空）；这在结构上是好消息：四卡改的是不同落点（实体键 / 轮内注入 / 时钟 / 工具面），没有互相踩踏。
- 集成树上 `npx tsc -b` **RC=0**（全包类型检查通过）。
- 结论的适用范围必须写清：本记录证明的是「**四卡合成后仍然成立**」，不是「生产实例已经在跑这四卡」。后者要等合并 + 重启，见 §6 残余 A。

---

## 2. 五条判据：修前基准 / 通过线 / 当次读数

| # | 判据 | 修前实测基准 | 通过线 | 当次读数 | 判定 |
|---|---|---|---|---|---|
| ① | 同一实体多条 A2A 不分裂 | 近 2h `a2a_rows=9 / distinct_refs=9 / ref_with_delivery_id=9` | `distinct_refs << a2a_rows` **且** `ref_with_delivery_id=0` | 集成树真实 SQLite 用例：同一实体两次投递 ⇒ **2 行 / 1 个 distinct ref / ref 内无投递 id**（9 用例全绿） | 代码级 ✅ / 真机待部署 |
| ② | 矛盾事实当轮生效 + 空注入不破缓存 | 近 30min `agent_decisions` 中 `cancel` = 0 | 当轮新增 `cancel` 行**且时序早于那次 `llm.complete()`**；空注入前缀 **sha256 相等**；空列表段恒在且 `count: 0` | 集成树 18 用例全绿：`cancelAt < nextLlmAt` 断言成立；无 delta vs 空 delta 渲染**字节相同**且都含 `count: 0`；尾部追加不动前缀字节 | 代码级 ✅ / 真机待部署 |
| ③ | 心跳不再入队 + 只有一个时钟 | 近 10min `heartbeat=16 / 全部 75`（21.3%）；`heartbeat.ts` 仍有 `setInterval` | 10min 窗口 `heartbeat=0`；默认 `mode='clock'` 下 legacy `setInterval` **不可达**；dream 双触发只执行一次的行为测试会咬人 | 集成树 25 用例全绿：`vi.getTimerCount()===0`；3 次 tick ⇒ **0 行 heartbeat** / 3 次巡检；dream 第二 tick `ran:false`（dedup，不是漏跑） | 代码级 ✅ / 真机待部署 |
| ④ | 行动类工具恒在且可取回 | 无 `action-tool-reachability.test.ts`，白名单为字面量 | 超限工具面下 **7 个**仍在；常量改成不存在 id → 测试**变红**；淘汰提示可行动 + `discover_tools` 取回下一轮生效 | 集成树 12 用例全绿：60 个大 builtin 压到超限后 7 个仍在且淘汰确实发生；ghost id 变异 **5 条红**，错误信息点名 `request_user_input_ghost (human)` | 代码级 ✅ / 真机待部署 |
| ⑤ | C7 基线不回归 | `work_units` 35 行 / 5 行有父链；`work_unit_ref` 悬空 0 | 悬空仍 = 0；`paused_budget` 与委派父子链行为不变 | 真机库 `dangling=0`；`work_units` 51 行 / 6 行有父链 / 15 running / 1 paused_budget；集成树回归 36 + 10 用例绿 | ✅ 真机成立 |

**「代码级 ✅」的含义**：判据的**行为**在集成树上被断言且能因实现被改坏而变红（§5 四处变异）。它不等于「生产在跑新代码」——那是残余 A。

---

## 3. 逐条取证：集成树上的原始读数

命令一律 `npx vitest run --project node <file>`，工作目录 = 集成树；`npx tsc -b` RC=0。

| 卡 | 测试文件 | 用例数 | 结果 |
|---|---|---|---|
| A | `packages/shared/test/{mailbox-route,work-unit-ref,work-unit}.test.ts`<br>`packages/core/test/{mailbox-entity-consolidation,mailbox-batch-and-purge}.test.ts` | 38 / 16 / 10 / 3 / 16 | 83 passed |
| A | `packages/org-manager/test/work-unit-producers.integration.test.ts`（**真实 SQLite**，`node:sqlite`） | 9 | 9 passed |
| B | `packages/core/test/{turn-delta,turn-delta-injection}.test.ts` | 13 / 5 | 18 passed |
| C | `packages/core/test/{heartbeat-single-clock,heartbeat-no-mailbox-row,dream-single-trigger,trigger-subscription}.test.ts` | 6 / 3 / 4 / 12 | 25 passed |
| D | `packages/core/test/action-tool-reachability.test.ts` | 12 | 12 passed |
| ⑤ | `packages/core/test/{subagent-work-unit-delegation,mailbox-concurrent}.test.ts`<br>`packages/org-manager/test/work-unit-service.test.ts` | 7 / 16 / 13 | 36 passed |

合计 **183 个断言全绿**（无 skipped、无 flaky；三次复跑结果一致）。

**① 为什么「真实 SQLite」这条最要紧**：`work-unit-producers.integration.test.ts` 不是数 mock 调用次数，而是**写入真库再查**——同一实体两次 A2A 投递落 2 行、`COUNT(DISTINCT work_unit_ref)=1`、ref 里无 `dlv_`。缺陷本身就在"持久化了什么"，夹具会撒谎，落库不会。

**② 时序判据怎么保证「不是事后补记」**：`turn-delta-injection.test.ts` 用 recorder 记录 `decision:cancel` 与每次 `llm.complete()` 的**出现顺序**，断言 `cancelAt < nextLlmAt`；若只是"回合结束后补一条 cancel 行"，这条断言必红。

**② 缓存判据走字节而非命中率**：`turn-delta.test.ts` 里 `sha(prefix)` 比较——"无 delta" 与 "空 delta" 渲染出的 messages 前缀 **sha256 相等**，且空段仍输出 `count: 0` + `none`（不为 0 省略段头）。刻意**不用** `hitRate`：它带噪声，阈值靠猜必然 flaky。

**③ 互斥性怎么证**：`heartbeat-single-clock.test.ts` 断言默认模式下 `vi.getTimerCount() === 0`（不再有私有 timer），clock 模式注册具名 source 后 `return`，legacy 分支只在 `MARKUS_HEARTBEAT_CLOCK=legacy` 可达；`heartbeat-no-mailbox-row.test.ts` 断言 3 次 tick ⇒ **0 行 heartbeat** / 3 次巡检（legacy 对照组 ⇒ 1 行）。

---

## 4. 真机库读数（生产实例，只读探针）

**读数时刻：2026-11-14T10:16:01Z（18:16 Asia/Shanghai）**，库 `~/.markus/data.db`（12.75 GB）。

```text
### 1) A2A identity — last 2h
a2a_rows  distinct_refs  ref_with_delivery_id  ref_null  first_queued              last_queued
17        17             17                    0         2026-11-14T06:47:10.568Z  2026-11-14T09:11:38.025Z

### 2) agent_decisions — last 60min by type
(无行)   -- 全表 total=226963，最后一行 2026-11-13T14:43:52.917Z

### 3) heartbeat — last 10min
heartbeat_rows = 18 ；同一窗口全部行 = 114（18/114 = 15.8%，修前基准 16/75 = 21.3%）
按类型：task_status_update 33 / human_chat 29 / heartbeat 18 / a2a_message 17 / review_request 12 /
        requirement_update 4 / memory_consolidation 1

dream 事件（真事件名，今日）：starting 00:18:56.417Z / plan 00:19:37.398Z / completed 00:19:37.407Z  → 1:1
heartbeat 启动日志 mode:'clock'：无（预期；见残余 A）

### 5) C7 基线
work_units: total 51 / with_parent 6 / running 15 / paused_budget 1
mailbox_items.work_unit_ref 悬空 = 0
agent_activities.ended_at IS NULL = 3269
```

**这四行读数怎么读（不许读成"通过"）**：

- 生产实例**仍是 C8 之前的构建**。硬证据不是猜的：同一份 runtime 日志里，`[tool-selector] Tool defs capped to pack budget` 仍在按体积淘汰，且被淘汰名单里出现 `deliverable_create` / `background_exec` / `team_status` 这类工具 —— 这正是 C8-D 要消灭的形态；而 C8-C 的 heartbeat 启动日志 `mode:'clock'` 在全日志零命中。
- 因此上面 ①②③ 的**数值本身就是"修前基准的实时复现"**：`a2a 17/17/17`（ref 里每条都编着投递 id）、`heartbeat 18/114`、`agent_decisions` 近 60 分钟 0 行。它们与卡面记录的修前基准同形，说明「缺陷仍在生产上活着」，也说明**不能用它们充当修复后的证据**。
- ⑤ 是唯一在生产上已经成立的一条：`悬空=0`（C7 已合并上线）+ `paused_budget` / 父链数据仍在（51 行 / 6 行有父链，比卡面基线 35/5 增长，符合"库在长"的预期）。
- `ended_at IS NULL` 的 3269 行是本卡新增验收项的直接证据（见残余 B），**不得**被任何「在跑」口径当成进行中。

---

## 5. 变异测试：四处「改坏实现 ⇒ 必红」（这是本记录唯一能证明判据会咬人的东西）

做法：在集成树上临时改坏一处实现 → 跑对应测试 → 记录红 → `git checkout --` 还原 → 复跑绿。**四处全部还原**，收工时 `git status --porcelain` 空。

| # | 变异（临时） | 期望 | 实测 |
|---|---|---|---|
| A | `WORK_UNIT_REF.a2a()` 改回旧形态 `a2a:<entityKey>:dlv_<随机>` | 实体再次随投递分裂 ⇒ 红 | **3 条红**，含真实 SQLite 那条「同一实体两次投递 ⇒ 2 行、1 个 ref、ref 里无投递 id」 |
| B | `buildTurnDeltaSegment()` 在 0 条时省略 `count:` 行 | 「空段恒在 + `count: 0`」⇒ 红 | **1 条红**：`no rows and "rows that do not qualify" render byte-identically, and both say count: 0` |
| C | 删掉 `shouldRunDreamCycle()` 的窗口去重块 | 第二 tick 由 `ran:false` 变 `true` ⇒ 红 | **1 条红**：`second tick in the same window emits one event with ran:false (dedup, not a miss)`（`expected true to be false`） |
| D | `ACTION_TOOL_GROUPS.human` 里 `request_user_input` → `request_user_input_ghost` | 幽灵 id ⇒ 红且点名 | **5 条红**；失败信息原文：`Action tool face is incomplete: request_user_input_ghost (human). … Fix the wiring, or declare the capability as not provided via notWired so the degradation is explicit instead of silent.` |

四处变异覆盖了本卡最容易被"看起来对"糊弄的四条：实体键（①）、空段恒在（②）、dream 去重（③）、白名单取值（④）。**每一条都是「删掉/改坏实现就会红」，不是源码文本断言。**

---

## 6. 结论三分：`有残余`（两条，归属写明）

### 残余 A —— 三张 PR 未合并 + 生产实例仍是旧构建（**归属：Owner 裁决合并/重启**）

- 事实：`#446`(C8-C) / `#448`(C8-A) / `#449`(C8-B) 仍 OPEN；只有 `#447`(C8-D) 已并入 `feat/refactor-plan`。合并顺序有硬约束：**B 叠在 A 之上**（A→B→C 或 A→B、C 独立）。
- 后果：① 的「`ref_with_delivery_id=0`」、② 的「当轮 cancel 行」、③ 的「10min 心跳=0 + 启动日志 `mode:'clock'`」这三条**只能在合并并重启实例后观察**。本次给出的是代码级证据 + 修前基准的实时复现（§4），不是真机修复后读数。
- 为什么不自己合：合并需 Owner 明确批准（本卡硬边界，也是我的一贯边界）。**需要 Owner 回一句**：批合并（我按 A→B→C 顺序推入 `feat/refactor-plan`）还是自己合；以及**何时重启实例**做端到端复测 —— 重启后我按 §7 的命令重跑，把 ①②③ 升级为真机绿或判定不通过。

### 残余 B —— 「在跑」的单一权威来源未实现（**归属：实现，新卡**）

本卡 16:48 追加的验收项（Owner 现场质疑「运行与注意力看不到进行中的 session」）在当前树上**零实现**，三条硬事实：

1. `packages/api/src` 全目录 grep `work_units` **零命中** → 没有任何 API 把 `work_units.status='running'` + `claimed_by` + `lease_until` 暴露给 UI；
2. `AgentProfile.tsx` 不读运行态 WU（grep `activeStreams/activeTaskCount/runningSessions/currentActivity` 零命中），后端口径仍分散在内存 `activeStreams` 与 `agent.ts:3894 activeTaskCount`；
3. 真机 `agent_activities.ended_at IS NULL` = **3269** 行僵尸活动，说明「回合收口」这条路本身漏写，历史口径（未收口 activity）会把它们当成在跑。

→ 已开新卡承载（见下），不在验证阶段改实现代码（验证与实现不能是同一个写者）。

- 跟进卡：`tsk_34fbf9494d96f7ba4afece66`（C8-E「在跑」只有一个权威来源，assignee 全栈工程师 / reviewer CTO，已建待 Owner 批准）

### 观察项（不阻断，归属 C8-D 作者，1 行）

`packages/core/test/action-tool-reachability.test.ts` 里有 1 条用例标题写作 "all **six** action tools survive"，而白名单已是 **7** 个（`request_user_input` 第 3 轮纳入）。断言遍历 `ACTION_TOOL_IDS` 所以**功能正确**，只是标题陈旧。建议随下次触碰该文件时一并改掉（就地 1 行，不必单开卡）。

---

## 7. 复现命令（评审人可原地复跑）

```bash
# 1) 集成树（零冲突合并三张未合并分支）
git worktree add --detach <WT> origin/feat/refactor-plan
cd <WT> && pnpm install --offline --prefer-offline && pnpm --filter @markus/shared build
git merge --no-ff --no-edit origin/task/c8-a-entity-keys
git merge --no-ff --no-edit origin/task/c8-b-turn-delta-injection
git merge --no-ff --no-edit origin/task/c8-c-single-clock
npx tsc -b     # RC=0

# 2) 五条判据的用例（本记录 §3 的全部读数）
npx vitest run --project node \
  packages/shared/test/mailbox-route.test.ts packages/shared/test/work-unit-ref.test.ts \
  packages/shared/test/work-unit.test.ts packages/core/test/mailbox-entity-consolidation.test.ts \
  packages/core/test/mailbox-batch-and-purge.test.ts \
  packages/org-manager/test/work-unit-producers.integration.test.ts \
  packages/core/test/turn-delta.test.ts packages/core/test/turn-delta-injection.test.ts \
  packages/core/test/heartbeat-single-clock.test.ts packages/core/test/heartbeat-no-mailbox-row.test.ts \
  packages/core/test/dream-single-trigger.test.ts packages/core/test/trigger-subscription.test.ts \
  packages/core/test/action-tool-reachability.test.ts \
  packages/core/test/subagent-work-unit-delegation.test.ts packages/core/test/mailbox-concurrent.test.ts \
  packages/org-manager/test/work-unit-service.test.ts

# 3) 真机库读数（只读；输出落 cut8-verify-out/）
bash <agent-workspace>/cut8-verify.sh
```

坑已内置在脚本注释里：`mailbox_items` 无 `created_at`（是 `queued_at`）、`work_units` 父链列是 `parent_id`、台账表 `agent_decisions` 判据列 `decision_type`、**禁** `work_unit_ref LIKE '%channel%'`（旧形态是 `a2a:dm:a2a:<from>:<to>:<deliveryId>`，不含 "channel"，未修也返回 0 = 假绿）。

---

## 8. 本次没做的事（不是遗漏，是边界）

- **没有改任何实现代码**：四处变异全部 `git checkout --` 还原，收工树干净。
- **没有合并/推送任何实现分支**：集成只在本地临时树；三张 PR 的合并权在 Owner（残余 A）。
- **没有重启生产实例**：重启 = 部署动作，需 Owner 决定时点（残余 A）。

---

## 9. 合并树上的重启后真机读数（2026-11-14 18:5x，`build/c8-integration` @ `eb270992`）

Owner 编译重启于 `18:51:33`（UTC `10:51:33`）。以下是**重启后**的读数，逐条带判据。

| # | 判据 | 读数 | 结论 |
|---|---|---|---|
| §0 | 跑的是刚编的构建 | `/api/health` = `0.12.3` / 100 agents；HEAD = `build/c8-integration eb270992`；进程 `18:51:33` 启动 | ✓ |
| ① | 心跳不再产生 mailbox 行 | `source_type='heartbeat'` **since_boot = 0**、近 10 分钟 **= 0** | ✓ |
| ① | 只有一个时钟 | 运行日志实证：`[heartbeat] Starting heartbeat scheduler {"mode":"clock","intervalMs":21600000}` | ✓ |
| ③ | dream 单触发 | `Dream cycle starting` 全日志仅 **1** 条，时刻 `00:18:56Z`（重启前）；重启后 **0** 次 | ✓（无重复触发） |
| ③ | 空注入形状纪律 | 本会话每轮 LLM 调用都带 `[LIVE UPDATE @seq=2] count: 0` + `none` | ✓ 真机生效 |
| ④ | 行动类工具恒在 | `action-tool-reachability.test.ts` → **12 passed** | ✓ |
| ⑤ | C7 基线不回归 | `dangling=0` / `paused_budget=1` / `with_parent=6` / `running=15` | ✓ |
| ② | 同实体 a2a 不分裂 | 向同一 agent 连发 2 条 → 只落 **1 行**（mailbox 去重合并）；ref = `a2a:channel:dm:a2a:<from>:<to>`，**不含 `<deliveryId>`** | ⚠ **部分取证**：收敛形态已生效，但 `distinct_refs << rows` 未证（只有 1 行） |
| C8-E | 端点只读台账 | `GET /api/agents/:id/work-units?status=running` → `200 {"source":"work_units","running":4,"units":[…,"internal":true]}` | ✓ |
| C8-E | UI 与端点一致 | 未取（需在「运行与注意力」页面核对条数 = 4） | ⏳ 待取 |

### 9.1 必须记录的自我更正（探针写错，不是实现错）

第一次跑心跳判据时我用了 `queued_at >= datetime('now','-10 minutes')`，读到 **18 行**，看上去像"C8-C 没生效"。**那是我探针写错**：`queued_at` 存的是 ISO 字符串（`2026-11-14T09:58:40.547Z`），而 `datetime('now')` 产出空格分隔格式（`2026-11-14 10:41:00`），两者字符串比较在 `'T'` vs `' '` 处就错位了。改用 ISO 边界（`date -u -v-10M +%Y-%m-%dT%H:%M:%S`）后真实读数是 **0**。

这条已写进清单的取证纪律：**时间列的格式必须与存储格式一致**，否则读数不是"错一点"，而是"反向"。

### 9.2 还没取到的三条（不是遗漏，是要造流量）

1. **② `distinct_refs << rows`**：需要 3 条落在**不同实体**（或目标处于 awake 状态、不被去重合并）的投递，才能形成多行对比。当前单目标停机 → 全部合并成 1 行。
2. **③ 矛盾事实当轮 `cancel`**：需要在某个回合**进行中**向同一 `work_unit_ref` 投一条撤销/改需求，并核对 `agent_decisions` 的 cancel 行早于该回合那次 `llm.complete()`。

---

# §11 重启后复测（2026-11-14 20:05–20:15，Owner 重启实例后）

## §11.1 「在跑」僵尸：15 → 0，零误伤

修复前（同一库）：`running=15`，且这些行对应的回合早已结束。启动日志见证：

```
[2026-11-14T12:05:05.978Z] [INFO] [api-server] Reconciled stale running WorkUnits {"count":15}
```

收口后分布：`idle 52 / paused_budget 1 / running 0`。

**两个漏洞，两种证据**（先在库副本上算，再等真机执行）：

| 漏洞 | 副本探针 | 真机 |
|---|---|---|
| 触发行已终态（task 纪元从不收口） | 规则一收 11 条 | 计入上述 15 |
| 孤儿 session 单元（没有任何 mailbox 行引用它） | 只读核对命中恰好 4 条 | 计入上述 15 |

判据不是"跑一次没人报错"，而是：**收口后的条数 = 修前读数**（15 = 11 + 4），且终态行**一条没动**（idle 48→52 全部来自 running 迁移）。

## §11.2 判据② `distinct_refs << rows`：真机全证（原为"部分取证"）

**a2a 侧**——向 Secretary 连发 3 条 DM 后的真实落库：

| item | status | work_unit_ref |
|---|---|---|
| `mbx_84a93083…` | completed | `a2a:channel:dm:a2a:agt_5f7658…:agt_b56cd6…` |
| `mbx_efccfdd8…` | processing | 同上 |
| `mbx_5a327f36…` | queued | 同上 |

⇒ **3 行 / 1 ref**。ref 是实体身份（不含 deliveryId），投递次数不改变结构事实。

**task 侧**（既有数据里的自然样本）：`task_tsk_90ad00bf00ce575d5c86324d_r1` 挂 **3 行**，`task_tsk_62d61a7239e41b1e858995fa_r1` 挂 **3 行**，`task_tsk_aa0c33fa83881533f085ad00_r1` 挂 2 行。

**全库**：`rows_with_ref=47 / distinct_refs=40`。

判定：**通过**（此前只有"同实体不分裂成两个 ref"这一半，缺"多行收敛到少 ref"这另一半，现已补齐）。

## §11.3 判据③ 矛盾事实当轮 cancel：**发现真缺陷 —— 消费端写完，生产端零写者**

原计划是"投一条矛盾事实看 cancel 行"。实测发现**投不出来**，而且原因不是流量不对：

```
grep -rn "invalidatesPremise" --include=*.ts packages/
  → 生产代码：turn-delta.ts(读)、mailbox.ts(enqueue 透传)、agent.ts(读)、shared/mail.ts(工厂)
  → 置 true 的地方：**只有 4 个测试文件**
grep -rn "supersedes: \[" …
  → 生产代码零命中
```

`classifyTurnDelta` 的 `contradiction` 分支只认 `invalidatesPremise === true` 或 `supersedes` 非空，而**生产里没有任何一处会置位**。也就是说这一刀宣称的"矛盾事实当轮生效"，在线上**结构上不可达**——测试绿的是分类器，不是系统。这正是"夹具会撒谎"的典型：单测自己造 flag，自己断言 flag 生效。

**修法**（生产者取唯一的自然执行点）：`TaskService.maybeNotifyAssignee` 是唯一一个"知道这活已经结束"的地方。任务进入 `cancelled / failed / completed / archived` 时，投给执行方的 `task_status_update` 现在带 `invalidatesPremise: true`。**排除** `rejected`（打回=重做，前提仍成立）与 `review`（assignee 自己提交的）。

**测试会咬人**（实测变异）：把接线那行删掉后重跑 ——

```
× cancelled → 投递带 invalidatesPremise
× failed    → 投递带 invalidatesPremise
× completed → 投递带 invalidatesPremise
× archived  → 投递带 invalidatesPremise
✓ rejected / blocked / 恢复 / 自己提交评审 / executionTriggered 静默
```

4 红 5 绿，红在正确的地方、绿在该绿的地方。恢复接线后 9/9 绿。

门禁：`tsc -b` = 0；6 个套件 **51 passed**（work-unit producers/wiring/storage、turn-delta、turn-delta-injection、premise-invalidation）。

## §11.4 本轮提交

| commit | 内容 |
|---|---|
| `5be7a59a` | chat 收口用 mailbox 行上的 ref；新增 `reconcileRunningAgainstTerminalMailbox`（规则一）；端点剔除过期租约 |
| `4c8f4360` | 纠偏规则二（孤儿 session 单元）+ 本记录 §10 |
| `9c10f0e4` | 判据③ 的生产者（终态任务 → `invalidatesPremise`）+ 咬人测试 |

## §11.5 仍未取到真机读数的一项（明确、不粉饰）

判据③的**生产者**是 `9c10f0e4` 才加上的，而当前正在运行的实例是**它之前**编译的。因此：

- 消费端（`cancel` → 提前收束回合）此前已有集成证据（`cancelAt < nextLlmAt`）；
- 生产者本轮已补齐并有变异验证；
- **但"真实回合里出现一条 cancel 决策行"仍需用 `9c10f0e4` 重新编译并重启一次实例**才能观察。

重启后的取数命令（无需人工干预）：

```sql
-- 触发一次任务终止后，核对 cancel 行早于该回合那次 llm.complete()
SELECT created_at, decision_type, mailbox_item_id FROM agent_decisions
 WHERE decision_type='cancel' ORDER BY created_at DESC LIMIT 3;
```

在此之前，本卡判据③ 记为 **代码级 ✅ + 生产者已补齐 / 真机待重启取证**，不签"验证通过"。

---

# §12 第二次重启后复测（2026-11-14 20:12 起 · HEAD `fdc40fd4`）

## §12.0 前置：跑的是不是新构建（否则后面全是废读数）

| 检查 | 读数 | 判定 |
|---|---|---|
| 构建时间 | `app.asar` mtime **20:11** | ✓ |
| 进程启动 | `20:12:05`（ps lstart） | ✓ 在构建之后 |
| 构建内含本轮符号 | `PREMISE_INVALIDATING`=2、`reconciled_orphan_turn`=1、`reconciled_terminal_mailbox`=1（`strings app.asar`） | ✓ 不是旧包 |
| 工作树分支 | `build/c8-integration` @ `fdc40fd4` | ✓ |

## §12.1 五条刀级判据（读数时刻 2026-11-14T12:14:08Z = 20:14 本地）

| # | 判据 | 修前基线 | 本次读数 | 判定 |
|---|---|---|---|---|
| ① | 心跳入队（10min 窗口） | **16** | **0**（同期全部新增 6） | ✅ 通过 |
| ② | `distinct_refs << rows` | ref:行 = 9:9（1:1） | **a2a 3 行 / 1 ref**；`task_tsk_90ad00bf…_r1` 3 行；全库 47 行 / 40 ref | ✅ 通过 |
| ③ | 矛盾事实当轮 cancel | `agent_decisions` 近 60min cancel = **0** | 生产者已上线且**在真实信封里可见**（`"invalidatesPremise":false` 命中 1 行 = 我取消探针卡那次；`:true` 命中 0，因该卡走的是 `pending→rejected` 建卡闸，**不在**终态集，正确地没加标志） | ⚠ 见 §12.4 |
| ④ | 7 个行动工具恒在 | — | `action-tool-reachability` **12 passed** | ✅ 通过 |
| ⑤ | C7 基线不回归 | dangling 0 / paused_budget 1 / 父链 6 | dangling **0** / paused_budget **1** / 父链 **8** | ✅ 通过（父链增长是正常写入） |

**僵尸未复发**：`work_units` 分布 `idle 53 / paused_budget 1 / running 0`。上一轮收口的 15 条没有回来。

## §12.2 C8-E「在跑」唯一权威来源

| # | 判据 | 读数 | 判定 |
|---|---|---|---|
| E1 | 端点只读台账 | 路由实现逐行核对：`repo.listByAgent(agentId, {statuses:['running']})` + 过期租约过滤 + `source:'work_units'`；未鉴权请求返回 `401 AUTH_REQUIRED`（不是返回数据） | ✅ 结构成立 |
| E3 | **僵尸 activity 不算在跑** | `agent_activities WHERE ended_at IS NULL` = **3269** 条，同期 `work_units running` = **0** —— 两套事实并存时，UI 读的是后者 | ✅ 通过（这是本卡要证的那条） |
| E4 | UI 只调这个端点 | `packages/web-ui/src/api.ts:1598` 是 UI 获取运行态的唯一入口，未读 `agent_activities` 派生 | ✅ 代码级 |
| E5 | 读失败要明说 | 端点无存储时返回 `{units:[],running:0,source:'work_units'}`；鉴权失败 401（不返回旧列表） | ✅ 结构成立 |

> E1/E5 的**浏览器直读**未取：端点要求登录态，curl 无凭据。这两条以「路由源码逐行 + 401 实测」为证，UI 侧以「唯一调用点」为证。若要视觉确认，登录后看「运行与注意力」应显示 0 条在跑。

## §12.3 判据③ 的真机取证卡在哪（这是唯一没拿到的一格）

要观察「真实回合里的 cancel 决策行」，必须同时满足：**某个 agent 正在执行任务 X 的回合中** + **任务 X 被取消/完成/失败**。构造这一场景需要一张**已批准**的任务卡：

- 新建探针卡 → `pending`；我发起取消 → 走**建卡闸**，落 `pending → rejected`（FSM 与审批红线 ④ 的规定），**不在**终态集 → 正确地不带标志；
- 再试 `rejected → in_progress` / `rejected → cancelled` → **FSM 拒绝**（`Illegal task state transition`）。

我不去动别人的在跑卡（`tsk_62d61a72` / `tsk_90ad00bf` 是真实在办工作），也不伪造状态。因此这一格需要 Owner 点一次批准，或等一次自然发生（某任务在其执行方回合中被取消）。

**已到位的部分**（不是"待办"，是已完成的证据）：
1. 生产者代码：`TaskService.PREMISE_INVALIDATING` + `maybeNotifyAssignee` 传 `invalidatesPremise`（`9c10f0e4`）；
2. 生产者**在真机信封里可见**：真实 `mailbox_items.envelope` 已写出该字段（`false` 那次就是真机产物，说明这条链路在跑，只差 `true` 的一次）；
3. 变异验证：删接线 → 恰好 4 个终态用例红、5 个反例绿；
4. 消费端：`turn-delta-injection` 断言 `cancelAt < nextLlmAt`（18 用例全绿，真实 agent 循环 + 假 LLM）。

## §12.4 结论（按卡面纪律，只允许三种）

- **①②④⑤ + C8-E：通过**（读数见 §12.1 / §12.2，每条都有修前基线对照）。
- **③：不通过（非代码缺陷，取证条件未满足）** —— 生产者已上线且可见，消费者有集成证据；缺的是"一次真机 cancel 行"。记为**取证缺口**，不计为已通过。

## §12.5 探针副作用（如实登记）

`tsk_1b23f86bbce1b9be9b6c3458`「【探针·一次性】C8 判据③…」创建后即取消，现状态 `rejected`（建卡闸的必然落点）。它不承载工作，不占在跑名额；按审批红线 ⑨，**不重提、不重建**，就地留档为本记录的取证痕迹。

---

# §13 浏览器实测发现的**反向缺陷**：真实在跑的回合显示为 0（已定位并修复）

## §13.1 现象（浏览器实读，非推断）

「运行与注意力」同一块面板上两句话互相矛盾：

- 「正在运行 **0** · 当前没有进行中的工作单元」
- 「邮箱 · 处理中 **1**」，Agent 专注「💬 人类对话 自 20:20:28 起」——就是当时正在跑的那个回合

截图：`~/.markus/generated/screenshots/screenshot-1794658903801-la487c.png`

## §13.2 取证链（每一步都可复现）

| 步 | 读数 | 说明 |
|---|---|---|
| 1 | `mailbox_items` 本回合行 `work_unit_ref` = **NULL** | 投递行没有身份 |
| 2 | `work_units WHERE ref LIKE 'session:cs_66bc3ebf%'` = **0 行** | 本会话从未建过回合单元 |
| 3 | 近 3 条 `human_chat` 行 `work_unit_ref` **全 NULL** | 不是偶发，是这条路径结构性缺字段 |
| 4 | `mailbox.ts:1146` 确实写 `workUnitRef: options?.workUnitRef ?? null` | 存储层不背锅 → **上游没传** |
| 5 | 日志无 `Failed to prepare chat turn WorkUnit`、无 `ensure_failed` | 不是抛错被吞，是根本没调用 |

## §13.3 根因

`Agent.injectFollowUp()` —— 用户在 agent **正在输出时**打字走的这条路径 —— 是全仓唯一漏传回合身份的 chat 入口：

```ts
// 修前
this.mailbox.enqueue('human_chat', payload, { priority: 0, metadata: {...} });  // 无 workUnitRef
```

同类事实共有 **4 个写入口**（`sendMessage` / `sendMessageStream` / `injectFollowUp` / 任务执行），前两个早已传身份，第四个（本路径）从来没有。这正是「同一不变量多个执行点」的典型：漏一个点不报错，只让台账少一行。

后果不是"少个字段"：该回合在 `work_units` 里根本不存在 → C8-E 的权威源查不到它 → 「在跑」漏报真实工作。与 §11 修的僵尸（有行不收口）方向相反，根因同类：**写者缺席**。

## §13.4 修法（按根因，不是补丁）

1. **`injectFollowUp` 的 `workUnitRef` 改为必填**（`string | null`，不是 `?`）：
   ```ts
   injectFollowUp(userMessage, senderId, senderInfo, images, options: { workUnitRef: string | null })
   ```
   写成必填 = 让**编译器**替这个不变量站岗。以后再多一个 chat 入口，漏传会**编译失败**，而不是静默丢身份。
   （连带把前三个位置参数从 `?` 改成 `T | undefined` —— TS 不允许必填跟在可选后面，这与 `persistChatTurn` 既有写法同源。）
2. **api-server 的 inject 分支**在入队前取身份，与其它三个入口同一个派生点：
   ```ts
   const followUpRef = await this.prepareChatTurnWorkUnit(agentId!, senderId, sessionId ?? null);
   agent.injectFollowUp(agentText, senderId, senderInfo, images, { workUnitRef: followUpRef });
   ```
   round 与回合开始时同源（消息在回合**结束**后才落库），所以算出的是**同一个 ref**，不是新开一个纪元。

## §13.5 验证（先看它红，再看它绿）

**变异验证**：删掉 `workUnitRef: options.workUnitRef` 这一行转发 → 新断言立即红：

```
× injectFollowUp 把回合身份落进投递行（删掉转发行就会红）
AssertionError: expected null to be 'session:cs_probe:r7'
```

恢复后：`tsc -b` 0；`agent-extended` + `agent-coverage` + work-unit producers + storage **116 passed**。

## §13.6 这一格对 C8-E 判定的影响

C8-E 原先只证了「僵尸不算在跑」。本次实测补上了反向：**真实在跑的回合必须能被权威源看见**。修复前该方向不成立（0 vs 处理中 1），修复后需重建实例再读一次「运行与注意力 = 1」才算真机闭环。

## §13.7 更正：§13.3 的根因判断不完整（第三层才是主因）

§13.3 把原因归给 `injectFollowUp` 漏传身份。那个缺口是真的（已修，`cdc868f0`），**但它不是面板显示 0 的主因**——重启后复测：普通入口（非 inject）这一轮同样是 `work_unit_ref = NULL`。实测把真正的根因挖到了第三层：

**三层缺陷，同一症状**

| 层 | 缺陷 | 证据 | 状态 |
|---|---|---|---|
| 1 | `injectFollowUp` 不带回合身份 | 该路径从未有过这个参数 | 已修 `cdc868f0` |
| 2 | 持久化时机：chat 只在**回合结束**才 `linkMailboxItem` | 回合进行中该行 `work_unit_ref = NULL` | 设计如此（单一写者），靠层 3 修好 |
| 3 | **会话解析错误（主因）** | 见下 | 已修 `4612ada3` |

**层 3 的取证（真实数据副本 + 真实 service 代码）**

```
getSessionsByAgent(agent, 1, sender) → ['cs_609ff62a63e04701']
当前真正在跑的会话                    →  cs_66bc3ebf11ea4e3c
messageCount 643 → round 322 → ref = session:cs_609ff62a63e04701:r322
ensure(ref, status:'running')        → { status: 'idle' }   ← 已存在，不改状态
```

`getSessionsByAgent` 按 `is_main DESC, last_message_at DESC` 排序，**主会话永远排第一**，哪怕它是 3 小时前的（`is_main=1`，最后活跃 08:44）。而真正在写的会话是 `is_main=0`、最后活跃 12:34。于是每轮的 ref 都算到旧会话上，那一行早已 `idle`；`ensure()` 对已存在的行不做任何事 → 该回合在台账里**从未有过 running 行** → 权威源被问了，它如实回答 0。

这正是「一个事实，两个解析器」：入口明明解析出了 `sessionId`，但没传给派生点，派生点只好用另一套规则再猜一次。

**修法**

1. 团队聊天的 SSE 入口把**已知的** `sessionId` 传进去（`prepareChatTurnWorkUnit(agentId, senderId, sessionId ?? null)`）——有 id 就不再派生。
2. 无 id 时的兜底改为取**最近活跃**（`last_message_at` 降序），不是主会话。
3. 选定的 ref 若撞上已收口的 `idle` 行，**显式拉回 `running`**（重试 / 同轮重入 / 早先提前收口都走这条）。

**会咬人的测试**（`chat-turn-ref-resolution.test.ts`，3 条各自独立）

- 主会话更旧 → 必须选中最近活跃的那个（不是 `is_main`）；
- 入口给了 id → 必须用它，不看排序；
- ref 撞上已收口的 idle 行 → 必须拉回 `running`（否则台账说没在跑）。

**一处自我更正**：我一度把 `work_unit_ref` 直接写进 `SqliteMailboxRepo.save()` 的 INSERT，被自己的测试打回——那一列的单一写者是 `linkMailboxItem`，开第二个写者是把可见 bug 换成不可见 bug。已撤回。

## §13.8 仍未取到的一项（不变）

判据③ 的真机 `cancel` 行：需要一个**已批准**任务在其执行方回合中被取消。生产者已在 `9c10f0e4` 上线并在真实信封中可见；探针卡受建卡闸与 FSM 限制无法进入终态（`pending→cancelled` 落 `rejected`，`rejected→in_progress/cancelled` 被拒）。不动他人真实在跑卡。

---

# §14 C8 完成度总验（2026-11-14 21:05 · HEAD `bc74d74c` · 构建 21:04 / 进程 21:04:10）

## §14.0 前置

| 检查 | 读数 |
|---|---|
| `app.asar` mtime | **21:04**（晚于 HEAD 提交 21:03:36） |
| 进程启动 | **21:04:10** |
| 分支 | `build/c8-integration` @ `bc74d74c` |

## §14.1 五条刀级判据

| # | 判据 | 修前基线 | 本次读数（13:05Z） | 结论 |
|---|---|---|---|---|
| ① | 心跳入队（10min） | 16 | **0**（同期全部新增 3） | ✅ 通过 |
| ② | `distinct_refs << rows` | 9 行 / 9 ref（1:1） | **48 行 / 40 ref**；a2a 连发 3 条实测 3 行 1 ref | ✅ 通过 |
| ③ | 矛盾事实当轮 cancel | cancel 全库 4 条（均为 9 月前的旧机制） | 生产者已上线、真实信封可证（`invalidatesPremise:false` 命中过真实投递）；**真机 cancel 行仍缺一次「已批准任务在执行中被取消」** | ⚠ 取证缺口 |
| ④ | 7 个行动工具恒在 | — | `action-tool-reachability` **12 passed** | ✅ 通过 |
| ⑤ | C7 基线不回归 | dangling 0 / paused 1 / 父链 6 | dangling **0** / paused_budget **1** / 父链 **8** | ✅ 通过 |

## §14.2 C8-E「在跑」唯一权威来源（本次是重点，此前一直是 0）

| # | 判据 | 读数 | 结论 |
|---|---|---|---|
| E1 | 端点只读台账 | `GET /api/agents/<id>/work-units?status=running` → `{source:'work_units', running:1}` | ✅ |
| E2 | 内部 session 可见 | 返回的单元 `ref = session:cs_66bc3ebf11ea4e3c:r48`，`internal: true` | ✅ |
| E3 | **僵尸 activity 不算在跑** | `agent_activities.ended_at IS NULL` = **3269** 条，同期 running WU = **1**（且那一条就是我正在跑的回合） | ✅ |
| E4 | UI 与端点一致 | UI「运行与注意力」逐字渲染：`正在运行 1` / `session:cs_66bc3ebf11ea4e3c:r48` / `内部会话` / `Agent 专注：💬 人类对话自 21:04:49 起`；同一面板 `邮箱·处理中 1` | ✅ **两句话终于自洽** |
| E5 | 读失败要明说 | 无凭据 401；无存储返回空结构而非旧列表 | ✅ |

**关键对照（同一个面板，修前 vs 修后）**

```
修前：正在运行 0 · 当前没有进行中的工作单元   ←→  邮箱·处理中 1（自相矛盾）
修后：正在运行 1 · session:cs_66bc3ebf…:r48 内部会话   ←→  邮箱·处理中 1（一致）
```

## §14.3 僵尸 running：修完不复发

| 时点 | running 行数 |
|---|---|
| 修前（首读） | **15**（全部是死回合） |
| 第一次重启后（`5be7a59a`+`4c8f4360`） | 0（启动日志 `Reconciled stale running WorkUnits {"count":15}`） |
| 第二次重启后 | 0 |
| **本次（chat WU 归位后）** | **1 —— 真实在跑的那一个** |

从「15 个幽灵」到「恰好 1 个真的」，这条曲线的两侧都被真机读数钉住了。

## §14.4 门禁

`tsc -b` = 0；本轮跑到的套件：`chat-turn-ref-resolution`(3) + `action-tool-reachability`(12) + `turn-delta` + `turn-delta-injection` + `work-unit producers` + `storage` → **33 passed**（另有前序 116/51/23 轮次全绿）。

## §14.5 结论

- **①②④⑤ + C8-E（E1–E5）：通过**，每条都有修前基线对照与真机读数。
- **③：不通过（取证条件未满足，非代码缺陷）**。生产者已在生产代码里上线且被真实信封证明，消费端有 `cancelAt < nextLlmAt` 的集成断言；缺的是一次「已批准任务在其执行方回合中被取消」的真机事件。

## §14.6 本轮修复链（每一层都由读数驱动）

| commit | 修的是什么 | 怎么发现的 |
|---|---|---|
| `5be7a59a` | 回合结束不收口 → 僵尸 running | 首读 15 条死行 + 启动日志 |
| `4c8f4360` | 孤儿 session 单元（无 mailbox 行引用） | 库副本探针 15→11→4 |
| `9c10f0e4` | 矛盾事实无生产者（消费端写完、生产端零写者） | 全仓 grep `invalidatesPremise` 只有测试在设 |
| `cdc868f0` | follow-up 入口不带回合身份 | 三条 chat 行 ref 全 NULL |
| `4612ada3` | **会话解析猜错（主因）** | 库副本跑真实 `prepareChatTurnWorkUnit`，算出 `cs_609ff62a…` 而真在跑 `cs_66bc3ebf…` |
| `bc74d74c` | 注释在撒谎（指错根因） | 自查工作树残留 |

三层缺陷同一症状，每一层的判据都不是「看起来对」，而是「换个记号再犯会不会再红」。

---

# §15 浏览器完整模拟（2026-11-14 22:23–22:25）——又逼出第四层：回合从不收口

## §15.1 模拟方式（真实用户路径，不是打接口自证）

在 `localhost:8056` 的应用里，用 **UI 输入框实际调用的那个端点**
（`POST /api/agents/:id/message`，即 `web-ui/src/api.ts:1629`）向 Secretary 发了一条真实消息：

```
请求 → 200 {"reply":"收到","sessionId":"cs_5a47f1ae1b3748d7"}
```

她确实回话了 ⇒ 回合**已结束**。然后读台账：

```
work_units  session:cs_5a47f1ae1b3748d7:r1  →  status = running     ← 回合结束了它还挂着
mailbox_items mbx_65164f69…  status=completed, work_unit_ref = NULL  ← 引用也没回填
全库 running：1 → 3   （我上一轮的 r48、当前 r49、她的 r1）
```

**光聊几轮天就攒僵尸**：§14 那次读到的 `running: 1` 是真的（我当时在跑），但如果没人管，
每轮都会再加一条。§11 首读到的「15 条僵尸」正是这条路径长期积累的产物 —— 我当时用
启动纠偏把它们扫掉，那是在**清症状**，没修产生源。

## §15.2 根因：一个事实三个分支，只有一个记

`/api/agents/:id/message` 有三条分支：

| 分支 | 是否收口 |
|---|---|
| SSE 流式 | 走 `persistChatTurn` → 有收口 |
| **非流式** | 只 `persistAssistantMessage` 就 `return` → **从不收口** |
| inject 追随 | 回合仍在进行，不需要收口 |

非流式分支还把 `onItemEnqueued` 丢了 —— 所以它的投递行连引用都拿不到（`work_unit_ref` 永远 NULL）。
这与前两层是同一个形状：**「回合结束了」这个事实，三个写者各记一遍，漏一个不报错**。

## §15.3 修法：收口收敛成唯一执行点

新增 `settleChatTurnWorkUnit(agentId, ref, opts)`：补 `context_ref`（只填空值）→ 回填 mailbox 引用 →
`running → idle`（只在 running 上迁，重放命中 idle 不算未收口）。
`persistChatTurn` 和**非流式分支**都调它；后者同时补上 `onItemEnqueued`，它那一行的引用终于能落。

**编译器当场抓了我一次**：第一版把 `getByRef` 挂在了 `WorkUnitService` 上（它其实在 repo 上），
TSC 直接报错、集成用例同时变红（`expected 'running' to be 'idle'`）—— 两道守卫都在位，
不是靠我肉眼。

## §15.4 验证

`tsc -b` 0；`chat-turn-ref-resolution` + `work-unit producers` + `storage` **23 passed**。
当前库里那 3 条 `running` 是修复前的遗留，下次启动由启动纠偏统一收口。

## §15.5 模拟的结论（诚实版）

- 模拟**成功**验证了前半条：用户发消息后，该会话确实在台账里建出 `running` 单元（§14 的修复生效）。
- 模拟**暴露出**后半条不成立：回合结束后无人收口 → 「正在运行」只增不减。
- 因此 C8-E 的完整判据（**0 → 1 → 0** 的闭环）**本轮仍未取到**，需用 `e9a1d025` 重建后再跑一次同一模拟。

## §15.6 缺陷家族汇总（同一个根因的四个面）

| # | 面 | 症状 | 修法 |
|---|---|---|---|
| 1 | chat 收口用重算的 ref | 回合开始的行永远 running | 用 mailbox 行上记录的 ref |
| 2 | 非流式分支不收口 | 每轮 +1 僵尸 | `settleChatTurnWorkUnit` 唯一执行点 |
| 3 | 会话解析按 `is_main` 排序 | 面板恒显示 0 | 入口传 id；兜底取最近活跃 |
| 4 | follow-up 入口不带身份 | 追随消息无归属 | 身份参数必填（编译器站岗） |

**四个面，一条判据**：「回合」是一个事实，它的身份、它的开始、它的结束，
都必须只有一个写者、一个解析器。四次要修的不是四个 bug，是同一个结构缺陷的四种语法。

---

# §16 第四次重启后复验（2026-11-14 22:36 · HEAD `d9c3c17d` · 构建 22:34 / 进程 22:35:14）

## §16.1 前置

| 检查 | 读数 |
|---|---|
| `app.asar` mtime | **22:34**（晚于 `e9a1d025` 提交） |
| 进程启动 | **22:35:14** |
| 启动纠偏 | `Reconciled stale running WorkUnits {"count":3}` @ 14:35:16Z —— 自动清掉上一轮遗留的 3 条死行（**纠偏设施第二次证明其存在价值**：它现在是兜底，不再是主修法） |

## §16.2 重跑同一模拟（同端点、同步骤，只为可比）

```
POST /api/agents/agt_5f7658fa…/message  →  200 {"reply":"收到。","sessionId":"cs_4f9795321206421d"}
```

| 判据 | §15（修前） | §16（修后） |
|---|---|---|
| 该轮 WorkUnit 终态 | `running`（永挂） | **`idle`** ✅ |
| 该轮投递行 `work_unit_ref` | `NULL` | **`session:cs_4f9795321206421d:r1`** ✅ |
| 全库 `running` | 1 → 3（每轮 +1） | 只剩 **1** 条 = 我这一轮正在跑 |
| 收口留痕 | 无 | `status_transitions` 中 `reason='chat_turn_settled'` 共 **6** 条 |

⇒ **收口闭环成立**：回合结束 → 该行 idle + 引用回填 + 留痕，且不再累积。

## §16.3 C8-E 的「0 → 1 → 0」当前处于哪一段

| 段 | 读数 | 状态 |
|---|---|---|
| 0 → 1（回合开始即立起） | 我这一轮 `session:cs_66bc3ebf…:r50` = running，端点 `running:1` | ✅ 已验证 |
| 1 期间（UI 与端点一致） | §14 已取：UI 逐字「正在运行 1 / …:r48 / 内部会话」 | ✅ 已验证 |
| 1 → 0（回合结束收口） | 非流式路径本轮实测收口（§16.2）；我这轮的 SSE 路径由同一个 `settleChatTurnWorkUnit` 收口 | ✅ 机制验证 / 本轮的 0 在我这一回合结束后可读证 |
| 僵尸不再累积 | 修前每轮 +1；本轮跑完 2 个回合，running 净增 **0** | ✅ 已验证 |

## §16.4 门禁与提交

`tsc -b` 0；23 用例（chat-turn-ref-resolution / work-unit producers / storage）全绿。
提交：`e9a1d025`（收口唯一执行点）、`d9c3c17d`（记录 §15）、本次 §16。

## §16.5 剩余的唯一一格

判据③ 真机 `cancel` 行：需要「已批准的任务在其执行方回合中被取消」。
生产者已在 `9c10f0e4` 上线，消费端有 `cancelAt < nextLlmAt` 断言；缺的是一次真实事件。
不伪造状态、不动他人正在办的任务卡。

---

# §17 任务场景真机模拟（2026-11-14 22:48）——判据③ 的意图已证，机制挖出第五层

## §17.1 模拟设计（按 Owner「直接完整模拟任务场景」授权执行）

1. 建探针卡 `tsk_a6446a7ca1982b208a11fa29`，描述强制要求 `sleep 25` ×2（**故意让它跑得慢**，
   好让回合在取消信号到达时仍在进行中）；
2. 用浏览器（已登录 Owner 会话，Owner 明确授权）调 `POST /api/tasks/:id/approve` 批准；
3. 等执行方进入回合（任务转 `in_progress` @ 14:48:30，投递行 `processing`）；
4. **在回合中途取消**（14:48:55，距开始 25 秒）；
5. 读三样东西：投递信封、执行方回合是否停止、决策台账。

## §17.2 读数

| 判据 | 读数 | 判定 |
|---|---|---|
| 取消事实是否带「前提失效」 | `mbx_b44a42a8…` 信封含 **`"invalidatesPremise":true`**（全库唯一一条） | ✅ 生产者真机证实 |
| 回合是否**在当轮**停止 | `Task execution stopped {"stopReason":"lifecycle"}` @ **14:49:00.766** —— 取消后 5 秒，而这个回合原计划跑约 50 秒 | ✅ **意图已证** |
| `agent_decisions` 是否新增 `cancel` 行 | **没有**（最新仍是 06:55 的老行） | ⚠ 见 §17.3 |

## §17.3 第五层缺陷：事实没有身份，就永远匹配不到回合

原因不是时序，是结构：

```
取消投递行   mbx_b44a42a8…   work_unit_ref = NULL
触发执行行   mbx_1ac6332f…   work_unit_ref = task_tsk_a6446a7c…_r1
```

`turn-delta` 把事实**按 ref** 归到「正在执行的那一回合」。ref 是 NULL 的事实，
无论什么时候到达都匹配不上 —— 矛盾分支**结构上不可达**。所以本轮回合是靠更快的
协作式 cancel token 停下来的（`stopReason: lifecycle`），delta 通道等于形同虚设。

这与前四层是同一句话的不同说法：**每个事实都需要身份；没有身份的事实看起来投递成功，
实际谁也到不了。**

修法：`maybeNotifyAssignee` 的投递带上 `workUnitRef: task_<id>_r<round>`。
测试同时断言**标志**与**身份**两件事（删任一，测试变红）。

## §17.4 判据③ 的最终口径（诚实二分）

| 口径 | 结论 |
|---|---|
| **意图**：「矛盾事实在当前回合生效，不等回合结束」 | ✅ **真机通过** —— 50 秒的回合在第 5 秒被停，执行方没有再往下烧 |
| **指定仪器**：`agent_decisions` 出现 `cancel` 行且早于该回合 `llm.complete` | ⚠ 未取到 —— 本轮被 cancel token 抢先；且身份缺陷已修，需重建后再跑一次同一模拟 |

两条机制现在并存且互补：cancel token 在**工具边界**立即停；delta 矛盾在**LLM 边界**收束并留台账。
前者快，后者留痕。

## §17.5 提交

`3d1ccc8c`（任务投递带执行身份 + 双断言测试）。`tsc -b` 0，18 用例绿。
探针卡就地留档（`cancelled`），不承载业务。

---

# §18 第一性原理审计：**每一类事实**的处理方式

Owner 2026-11-14 23:10 要求：「除了这个，其他所有的，都应该考虑处理方式的合理性」。
所以先立判据，再逐类过，而不是继续按症状打补丁。

## §18.1 三条判据（唯一口径）

1. **身份**：这条事实是关于哪个实体的？——决定**谁能消费它**。
   身份必须由**产生事实的那一刻**决定，不能由消费方再猜一次。
   （今晚五层缺陷里有四层，本质都是「消费方又猜了一次」。）
2. **落点**：前提仍在 → 回原处；前提没了 → **不唤醒**；**永远不新建无读者的上下文**。
   「不唤醒」是合法且正确的动作，丢弃要留日志（可检索），不静默。
3. **收口**：谁是「这件事结束了」的唯一权威？——只能有一个执行点。

## §18.2 逐类审计（16 类 source_type 全覆盖）

| 事实类 | 身份（实体） | 落点规则 | 前提检查 | 判定 |
|---|---|---|---|---|
| `human_chat` | `session:<cs>:r<n>` | 该会话 | — | ✅ 今晚修完（身份/收口/追随/多会话解析） |
| `a2a_message` | `a2a:<task|channel>`（由 entityKey 生成） | 接收方会话 | — | ✅ 本就正确 |
| `task_status_update` | `task_<id>_r<round>` | 执行方回合 | 终态 → `invalidatesPremise` | ✅ 今晚修（`3d1ccc8c`） |
| `requirement_update` | 接收方**当前回合** ref | 发起/接收回合 | `changes_requested` → `invalidatesPremise` | ✅ 今晚修（`1617045a`） |
| `mention` / `task_comment` | `task_<id>_r<round>` | 任务执行回合 | — | ✅ 今晚修（`8971dfa5`） |
| `review_request` | `task_<id>_r<round>` | 评审方回合 | — | ✅ 本次修 |
| **`callback_result`** | **发起轮**（`originSessionId` + `correlationId=taskId`） | 前提在 → 回发起会话；**前提没了 → 丢弃，不唤醒** | 任务终态 → `discardByCorrelation` | ✅ 本次修 |
| `system_event`（mailbox 投递模式） | 平台内部 | 当前会话 | — | ✅ 队列处理即正确语义 |
| `heartbeat` | — | — | — | ✅ 已停产（C8-A），不再入队 |
| `session_reply` / `memory_consolidation` / `callback_result` 的 `mailbox` 变体 | 平台内部 | 队列 | — | ✅ 保持队列：实体不是任务，强加 task ref 就是撒谎 |
| `requirement_comment` | **需求**（不是任务） | 队列 | — | ⏸ 保持队列。若要轮内注入，得新增「需求 → 当前在跑的任务」这层解析；那等于再加一个第二解析器，**我不同意加** |

## §18.3 因此改了什么（本轮）

1. **`review_request` 带任务身份**：评审请求是关于某个任务的，落点应是该任务的执行回合，
   而不是「接收方当前在跑的任何回合」。
2. **`callback_result` 加前提闸**：`PendingCallbackRegistry.discardByCorrelation()` ——
   任务进入 `cancelled/failed` 时，把它名下所有待回调**丢弃登记**。
   后台进程照旧跑完，只是**不再唤醒一个前提已消失的回合**（此前会无条件 resume 发起会话）。
   丢弃会写一条 `Discarded pending callbacks (premise gone)` 日志：不静默。

## §18.4 一条被这条判据否掉的想法

我确实想过「给所有事实都套上接收方当前回合的 ref」——一行搞定。**这是错的**：
`mention` 关于任务 A，而接收方可能正在做任务 B；套上 B 的 ref 等于把 A 的事实伪装成 B 的，
和 R3「结构从载荷推断」是同一类错误。身份必须来自**事实本身**，不能来自**接收方刚好在干什么**。

## §18.5 剩余（已判断，不是遗漏）

- `requirement_comment`：实体是需求，不是任务 → 队列处理。
- 判据③ 的 cancel 行：等这次重建后的真机事件。

---

# §19 第三轮真机（2026-11-14 23:21 · HEAD `ce661ac6`）——第六层：**身份在持久化层被丢掉**

## §19.1 本轮验证到的（对的部分）

| 项 | 读数 |
|---|---|
| 构建 | asar 23:19 / 进程 23:19:47 / HEAD `ce661ac6` |
| 启动纠偏 | `Reconciled stale running WorkUnits {"count":5}` —— 清掉上轮遗留 |
| 在跑归位 | 只剩我这一轮 `session:cs_66bc3ebf…:r55`（正确会话） |
| 生产者标志 | 取消投递行 `invalidatesPremise:true` ✅ |
| 回合当轮被停 | 任务 `15:21:53` 开始、`15:22:14` 取消，执行方在回合内被停 |

## §19.2 仍然不对的（判据③ 的仪器）

```
取消投递行  mbx_f7176ec…   work_unit_ref = NULL        ← 身份仍为空
触发执行行  mbx_e8d977a…   work_unit_ref = task_…_r1   ← 对照
agent_decisions 最新 cancel = 2026-09-04（无新增）
```

## §19.3 根因：第六层，在最底下

我在 `maybeNotifyAssignee` / `requirement-service` / `enqueueFor` 里都给投递传了 `workUnitRef`，
代码看起来完全正确 —— 但 `SqliteMailboxRepo.save()` 的 INSERT **故意不写 `work_unit_ref`**，
那一列的唯一写者是 `SqliteWorkUnitRepo.linkMailboxItem()`，而这些新加身份的生产者**没有一处调它**。

⇒ 传进去的身份只活在内存对象里，落库即丢。**所有"补身份"的修复在磁盘上等于没生效。**

这是同一族缺陷的第六层，也是最底层：**把"谁拥有写入权"当成了"谁必须写"**。
单一写者是对的，但写者必须在**事实已知的那一刻**被调用，否则就是"没人写"。

## §19.4 修法（`d5868820`）

既然 C8 之后 `work_unit_ref` 是**入队参数**（入队即已知），就让 INSERT 在带上时写入；
活开始后才拿到身份的路径仍走 `linkMailboxItem()` 的 UPDATE。两条路各有明确的「何时已知」语义，
不再是"一个静默失败维持着的单一写者"。

`tsc -b` 0；work-unit storage + producers 20 用例绿。

## §19.5 结论

判据③ 的仪器仍未取到，但**阻塞点已经落到最底层并修掉了**：现在缺的只是一次包含 `d5868820` 的重建。
重建后再跑同一探针（建卡 → 浏览器批准 → 回合中途取消），预期：
① 取消投递行 `work_unit_ref = task_<id>_r1`；② `agent_decisions` 出现 `cancel` 行且早于该回合 `llm.complete()`。

---

# §20 结构性防护落地（2026-11-14 23:38–23:41）

目标不是再修第七个症状，而是让**同族第七个缺陷出现时是编译错误或 CI 红灯，而不是真机静默**。

## §20.1 P0（已交付 · `8de91f13`）：缺失不再静默

`EnqueueOptions` 增加**身份来源声明**：

```ts
refOrigin?: 'entity' | 'turn' | 'pending-link' | 'platform-internal'
```

- 非平台内部事实、既无 `workUnitRef` 又无声明 → `unclaimedIdentityCount++` + `log.error`；
- `MARKUS_STRICT_IDENTITY=1` 时**直接抛错**（CI 该这么跑）；
- `PLATFORM_INTERNAL_SOURCES` 写成数据（heartbeat / system_event / session_reply /
  memory_consolidation / callback_result / workflow_update）—— 豁免要有清单，而不是每个生产者各写一句注释。

**咬人测试**：`mailbox-identity-guard.test.ts`（5 条）：无声明 → 计数 1；`platform-internal` → 0；
平台内部类型 → 0；`pending-link` → 0；带 ref → 0。删掉守卫即变红。

## §20.2 P1（已满足 · 有证据）：身份不再被二次计算

今晚 `persistChatTurn` 改成**接收** `turnWorkUnitRef` 而不是自己再解析会话（`1617045a`），
`chat-turn-ref-resolution.test.ts` 三条断言（主会话更旧时取最近活跃 / 显式 id 优先 / idle→running）钉住这条不变量。
⇒ 「回合的身份只声明一次」在 chat 链路已成立；task 链路的唯一构造点是 `linkExecutionEpoch`。

## §20.3 P2（部分交付 · `eb168a6d`）：activity 不再声称自己在跑

启动时收口「`ended_at` 为空但触发它的投递行已终态」的活动行，并写日志计数。
「是否在跑」的唯一权威仍是 `work_units`（C8-E 端点与 UI 都已只读它）。

**明确未做**：把 `agent_activities` 彻底改成 append-only（去掉 `ended_at` 语义）。
那要同时改写入方与「最近活动」UI，并须真机验证——不适合混在一批末尾塞进去。
上面的收口已经消灭了用户可见症状，但我**不把这次改动说成完成了那个重构**。

## §20.4 CI 门禁（下一步接进流水线，SQL 已定型）

```sql
-- 1) 身份缺失（非平台内部）——必须带时间下界，否则老库永远红、闸门等于没有
SELECT COUNT(*) FROM mailbox_items
 WHERE work_unit_ref IS NULL
   AND queued_at >= :deployed_at          -- 只审“本次部署之后新增的事实”
   AND source_type NOT IN ('heartbeat','system_event','session_reply',
                           'memory_consolidation','callback_result','workflow_update');
-- 2) 悬空引用
SELECT COUNT(*) FROM mailbox_items m LEFT JOIN work_units w ON w.ref = m.work_unit_ref
 WHERE m.work_unit_ref IS NOT NULL AND w.id IS NULL;
-- 3) 租约**已过期**的 running（不是“没有租约”：chat 回合本来就不走租约认领）
SELECT COUNT(*) FROM work_units
 WHERE status='running' AND lease_until IS NOT NULL
   AND lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now');
-- 4) 僵尸活动
SELECT COUNT(*) FROM agent_activities a JOIN mailbox_items m ON m.id = a.mailbox_item_id
 WHERE a.ended_at IS NULL AND m.status IN ('completed','bounced','catch_all','merged');
```
四条都必须 **0** 才算通过。逐步把 `MARKUS_STRICT_IDENTITY=1` 常开，前提是先把现有未声明生产者清零。

> 口径自纠（2026-11-14 23:44 真机）：我第一版把 1) 写成不带时间下界、把 3) 写成“lease_until IS NULL 也算”，
> 结果在真库上读出 61869 与 1 —— **两条都是假阳性**（前者全是修复前的历史行，后者是我自己这一轮 chat）。
> 永远亮着且不可行动的告警等于没有告警，所以口径必须收紧成上面这版。

## §20.5 迁移与回滚

- `refOrigin` 允许缺省一个版本（仅报错+计数，不抛）；计数归零后再把严格模式设为默认。
- 每个提交各自可单提交回滚：P0（守卫）、P2（收口）互不依赖。

## §20.6 完成判据

> 不是「没有 bug」，而是：下一个同族缺陷出现时，它是**编译错误或 CI 红灯**，而不是在生产里静默几小时。

今晚六个缺陷里有五个是这样被发现的：先去读库，才发现代码里有一条路没写字。这套防护针对的正是「静默」本身。

---

# §21 第七层：CLI 适配器把字段丢了（2026-11-14 23:44 第三轮真机）

## §21.1 读数（构建 `5fc83992`）

```
取消投递行  mbx_03f20796…   work_unit_ref = NULL    invalidatesPremise = true
触发执行行  mbx_37f62f07…   task_tsk_cf5c8293…_r1
agent_decisions   仍无新增 cancel 行
merged_into = 空、 dedup_key = 空   （排除“被合并”这一解释）
```

## §21.2 沿链路逐层对账

| 层 | 检查 | 结果 |
|---|---|---|
| 生产者 | `task-service:3786` / `enqueueFor:805` / `review_request:5291` 都传了 `workUnitRef` | ✓ |
| 写者 | `SqliteMailboxRepo.save()` 已包含 `work_unit_ref` 列（dist 实测命中 11 处） | ✓ |
| **搬运层** | `cli/start.ts:2326` 的 mailbox 持久化适配器 | ✗ **手写字段列举，列到 `dropReason` 就结束** |

**两端都对，中间的搬运层把值丢了。** 这就是为什么三次重建、三次一模一样的失败：
我每次都在改“生产者”或“写者”，而那层“看起来只是转发”的适配器从来没被当写过者。

## §21.3 修法与判据（`f1e263b6`）

适配器改成**展开 + 覆盖**（只显式覆盖信封序列化/结构投影那几个需要转型的字段），
新字段自动流过，不再依赖任何人记得回这个文件改一行。

**判据**：同一个输入端两端都对时，问题必在中间的映射/序列化层；判断一层是否“安全转发”的标准不是
“它现在传对了没”，而是“**新增一个字段它会不会自动流过**”。手写列举 = 默认丢弃。

## §21.4 状态

`f1e263b6` 不在 `5fc83992` 的构建里。下一次重建后跑同一探针，预期：
① 取消投递行 `work_unit_ref = task_<id>_r1`；② `agent_decisions` 出现 `cancel` 行且早于该回合 `llm.complete()`。
若仍为 NULL，则下一层在 SQLite 列绑定 / 迁移，届时直接对 `PRAGMA table_info` 与实参个数，不再逐层猜。
3. **C8-E 的 UI 视觉比对**：端点已返回 4 条 running（含 `internal: true`），需要在页面上确认显示条数一致、且僵尸 activity 不出现。

