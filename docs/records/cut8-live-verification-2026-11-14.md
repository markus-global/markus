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

