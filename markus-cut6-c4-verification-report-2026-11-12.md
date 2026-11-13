# 第六刀 C4 验证报告：全量回归、真实实例探针、重新 build 与文档收口

- 日期：2026-11-12
- 卡片：第六刀 C4（收口卡）
- 角色：本报告只记录**本人实跑读数**；未取证的项显式标注「未取证」，不做推断性结论。
- 配套文档：`markus-cut6-mailbox-address-design-2026-11-10.md`（执行文档，本卡在末尾追加 §7.9 指针，不复制第二份事实）

---

## 1. 环境与基线

| 项 | 读数 |
|---|---|
| worktree | `/Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/workspace/wt-cut6-c4` |
| 分支 | `task/tsk_cdb4bd3554-cut6-c4` |
| HEAD | `bb2c101f`（= 第六刀 C1 + C2 + C3 全部落地、且本卡 C4 的提交已落地后；`65ac4cc0` 是提交前值，已作废） |
| 类型检查（全仓） | `npx tsc -b` → 退出码 **0** |
| 类型检查（web-ui 单独） | `npx tsc --noEmit -p packages/web-ui` → 退出码 **0**（web-ui 不在根 `references` 里，必须单独校验） |
| 架构守卫 | `node scripts/architecture-guard.mjs` → 退出码 **0** |

---

## 2. 全仓回归（`npx vitest run`）

```
Test Files  5 failed | 636 passed | 1 skipped (642)
     Tests  5 failed | 8343 passed | 13 skipped (8361)
```

耗时约 **92s**。

即：**8361 例中 5 红**，全部逐条定性见 §3。**没有一红被含糊放过**：2 红是本刀引入的真实漂移（已修），3 红有基线对照或隔离复跑证据支撑为环境性 / 既有 flaky。

### 2.1 C5 收口改动后的复跑读数（2026-11-12 15:5x，本节由 C5 追加）

C5 改动了原因闭集 / 校验错误类型 / 终态投影 / 观测事件名 / 一条既有断言（见执行文档 §7.10），因此**整套门禁必须重跑**，不能沿用 C4 的读数：

| 门禁 | 读数 |
|---|---|
| `npx tsc -b` | 退出码 **0** |
| `npx tsc --noEmit -p packages/web-ui` | 退出码 **0** |
| `node scripts/architecture-guard.mjs` | 退出码 **0**（`34 处命中全部在已登记白名单内；契约不变量 11/11 满足`） |
| `npx vitest run`（全仓） | `Test Files 1 failed | 641 passed | 1 skipped (643)`；`Tests 1 failed | 8352 passed | 13 skipped (8366)` |

**唯一红项的定性（环境性，非本刀）**：`packages/cli/test/commands-start-integration.test.ts > auto-runs quickInit when config is missing`

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:8056
Error: Test timed out in 60000ms.
```

- 证据：`lsof -nP -iTCP:8056 -sTCP:LISTEN` → `Markus  16927  liuqian  83u  IPv4  TCP *:8056 (LISTEN)` —— **真实桌面实例占着 8056**，测试想绑同一端口。与 C4 §3.5 记录的同一家族（`quickInit` / `version` 环境性 flaky），文件与本刀改动的 mailbox / 退信 / 校验链无交集。
- **不默认放行的旁证**：同一次复跑中先出现 3 红 —— ①`packages/shared/test/mailbox-transitions.test.ts`（**本刀真实漂移**：断言「可产生原因恰好五类」，已随原因闭集更新为六类并补 `payload_invalid` 可写库断言）；②`agent-concurrent-cancel-isolation`（§3.4 已基线对照的既有 flaky）；③ 本条。**修掉 ①后复跑，②③ 均自行消失**（同一份代码两轮读数不同 ⇒ 非确定性），再单跑 ③ 精确复现 `EADDRINUSE` 并定位到 PID 16927。三条红全部有归因，无一被含糊放过。

---

## 3. 五个红项的定性

### 3.1 `packages/web-ui/test/toolCategories.test.ts` —「every registered core tool name is placed in a category」

- **现象**
  ```
  expected [ 'bind_address', 'address_revoke', 'address_list', 'message_route', 'catch_all' ] to deeply equal []
  ```
- **归因**：**本刀 C1 / C3 新增的 5 个工具未登记进分类表**。`bind_address` / `address_revoke` / `address_list` 来自 C1（地址绑定工具面），`message_route` / `catch_all` 来自 C3（路由与 catch-all 只读工具）。分类表是「工具名 → UI 分组」的唯一映射，漏登记会让这些工具在 UI 上落进「其他」——这条守卫正是为此存在，红得正确。
- **处理**：已在 `packages/web-ui/src/lib/toolCategories.ts` 的 `mailbox` 分组补入这 5 个名字（附中文注释说明归属：读面都是 mailbox，与投递域同一处分组）。
- **复验**：`npx vitest run packages/web-ui/test/toolCategories.test.ts` → **2 passed**（本卡提交前再次复跑仍为 2 passed）。

### 3.2 `packages/org-manager/test/api-server.test.ts` —「POST /api/agents/:id/mailbox/recover-stale」

- **现象**
  ```
  AssertionError: expected 'undefined' to be 'number'
  ```
- **归因**：**本刀 C3 的改名没有跟到断言**。C3 把 recover-stale 的结局从 `dropped` 改为 `bounced(lease_expired)`，`api-server.ts`（recover-stale 路由，约 5900 行；实际 `this.json(res, 200, { bounced })` 写出在第 5907 行）的响应字段随之从 `{ dropped }` 改名为 `{ bounced }`，web-ui `api.ts:1466` 已同步为 `{ bounced: number }`，但该断言仍在读旧字段 `dropped` → `undefined`。
- **处理**：断言已改为 `res.json.bounced`，并加注释说明改名理由（与 web-ui `api.ts` 的 `{ bounced: number }` 同名，两处描述同一事实）。
- **复验**：`npx vitest run packages/org-manager/test/api-server.test.ts -t "recover-stale"` → **1 passed（292 tests | 291 skipped）**（本卡提交前再次复跑同一读数）。

> 3.1 与 3.2 是「两处回归红项的三同步修复」：**分类表 / API 响应字段 / 断言**三者对齐同一事实（工具名归属、终态改名）。修的是**下游契约的下游读者**，不是把断言改松——两处修复后断言的强度都未降低（`typeof … === 'number'` 与「名字必须在分类表内」都仍然咬人）。

### 3.3 `packages/core/test/shell-session-tools.test.ts` —「persists shell state across commands in same session」

- **现象**：全仓并发跑时为**超时红**。
- **归因**：隔离单跑 **1 file passed** → **环境性 flaky**（并发负载下的超时），非本刀引入；该文件与 mailbox / 信封 / 投递状态机无交集。
- **处理**：不修（无缺陷可修），记录为环境性 flaky。

### 3.4 `packages/core/test/agent-concurrent-cancel-isolation.test.ts` —「两侧状态收敛」

- **现象**：全仓并发跑时 1 红（超时）。
- **归因**：在**基线 `79a8421e` 的干净工作树**（`/tmp/cut6c4/wt-base`，`npx tsc -b` 退出码 **0**，即基线本身是健康的）上复跑**同样 1 红（12.1s 超时）** → **既有 flaky，与本刀无关**。属 `inactivity-backstop` 家族，历史多次记录（§7.8 亦记录 C2/C3 期间同一条）。
- **对照证据**：同批该文件另 3 例在基线上通过 —— 说明不是整个文件坏，而是单例在负载下超时。
- **处理**：不修（基线同样红，非本刀引入），记录为既有 flaky。

### 3.5 `packages/cli/test/commands-start-integration.test.ts` —「auto-runs quickInit when config is missing」

- **现象**：基线跑时环境报 `EADDRINUSE 0.0.0.0:8056`。
- **归因**：**真实桌面实例占用了 8056**，属已知的环境性 flaky 家族（记忆中有 quickInit / version 同类记录）——测试想绑的端口被一个在跑的实例占着，与代码语义无关。
- **处理**：不修，记录为环境性 flaky。生产/默认端口未被改动。

---

## 4. 真实实例探针（**同提交构建产物**）

### 4.1 起实例

| 项 | 值 |
|---|---|
| `HOME` | `/tmp/cut6c4/home` |
| `MARKUS_HOME` | `/tmp/cut6c4/home/.markus` |
| 端口 | `8071` |
| 启动命令 | `node packages/cli/dist/index.js start` |
| `/api/health` | `{"status":"ok","version":"0.12.3-rc.0","agents":3}` |

探针打的是**同一提交的 `dist` 产物**，不是 `src` 里的推理。

### 4.2 三条链路真实落库（DB：`/tmp/cut6c4/home/.markus/data.db`）

| 链路 | 落库读数 | 信封内容 |
|---|---|---|
| **human_chat** | **6 行**，全部 `envelope IS NOT NULL` | `from = {kind:'platform', address:'noreply@markus.global', local:'noreply'}`、`to = {kind:'agent', agentId:…}`、`messageId` 齐全。其中**一次真实 chat 得到 LLM 回复**，且该回复内容提到它自己查了 `chat_sessions` / `chat_messages` 的落库情况 → 说明这条链路是真的走通了（不是 mock 回显） |
| **a2a_message** | **1 行** | `from = {kind:'agent', agentId:'agt_c58379e2854365b22f65cd11'}`、`to = {kind:'agent', agentId:'agt_7d54876e6adfb10a063d18dd'}`、`messageId = dlv_mwd52awu_2` |
| **task_status_update** | **1 行**，`envelope IS NOT NULL` | 任务 `tsk_65507b9f5c50ec9a7b98a145` 经 `/api/tasks/:id/approve` 进入 `in_progress` 后投递 |

### 4.3 计数读数

| 指标 | 读数 |
|---|---|
| `dropped` | **0** |
| `bounced` | **0** |
| `catch_all` | **1** |
| `completed` | **6** |
| `work_unit_ref 非 NULL` | **0** |
| 信封覆盖 | `{"total":7,"with_env":7}`（**7/7**） |

### 4.4 必须如实记录的观察项：那 1 行 `catch_all`

- **`dropped` 增量 0 成立** ✅：探针期间没有任何一行被静默丢弃。
- 但 **`catch_all = 1` 这一行的来源是探针自身的报文体缺陷**：chat 报文体必须用 `text` 字段，当时误用 `message`，导致 agent 侧 `TypeError: Cannot read properties of undefined (reading 'trim')`，随后该行以 `catch_all` + `drop_reason='stale_signal'`、事件名 `mailbox.duplicate_delivery_dropped` 收口。
- **结论一（本刀要证的事成立）**：**无静默丢弃 —— V4 语义成立**。出错的报文没有消失，它进了 catch-all，可查、可认领、有原因字段。
- **结论二（C4 时的状态：如实记录、未修；C5 已修）**：**退信原因与事件名当时对不上真实原因**。真实原因是「报文缺字段致处理异常」，落到台账上却写成 `stale_signal`，事件名又写着 `duplicate_delivery_dropped`。这是**既有 C3 状态机口径问题**（当时五类 `bounced` 原因闭集里没有「入参不合格」这一档，最近的一档被就近使用了），C4 不属其范围、如实记为观察项，**本卡未修**。
- **C5 收口卡的处理（2026-11-12）**：已按真实原因投影修复 —— 原因闭集补 `payload_invalid`、`turnContentOf()` 的校验错误结构化（`SignalPayloadInvalidError`）、失败族终态按 `bounceReasonOfError()` 投影、`bounceSignal()` 的事件名改为 `mailbox.signal_bounced`；并有会咬人的行为测试（`packages/core/test/mailbox-bounce-reason-projection.test.ts`，实现前 2 红、实现后 9 文件 158 绿）。明细见执行文档 §7.10，本节只留指针。
- 列为：**「待 Owner 裁决的观察项」**。要么在原因闭集里补一档（如 `payload_invalid`），要么在文档里明确「异常收口复用 `stale_signal`」的口径；两条都需要 Owner 决定，不能由收口卡自行改生产代码。

### 4.5 真实实例上遇到的闸门（记录口径，不是缺陷）

`task` 链路首次被需求闸门拒绝：

```json
{"error":"Task creation blocked: top-level tasks must reference an approved requirement","code":"requirement_required"}
```

补建 **项目 `proj_396ada4bc8ccb2e80593f57f` → 需求 `req_c63f9e7764d768950f86e00c` → 任务**后成立。这证明闸门在真实实例上是**有效咬人**的，不是摆设。

---

## 5. 重新 build 复验（V7）

- 命令：`pnpm --filter @markus/web-ui build && pnpm --filter @markus/desktop build:electron`
- 在同一 worktree 上**成功**，输出含 `Done → dist/main.js + dist/preload.js`，chrome 扩展 zip 打包完成。
- **横幅归属 `16a28403` 的 DOM 级复验（C5 状态，如实记录：仍未取证）**。原因：需要重启运行包或起真实浏览器会话，而**重启运行包会杀掉本 Agent 自身的运行时**。

### 5.1 C5 追加：独立实例已起，但 DOM 证据本轮**未取到**（不声称已验证）

- 已做到的部分（可复现）：独立实例用**同一提交构建产物**起在 `:8071`（`HOME=/tmp/cut6c4/home`、`MARKUS_HOME=/tmp/cut6c4/home/.markus`，端口取自 `markus.json → server.apiPort`；CLI **没有** `--port` 参数），`/api/health` = `{"status":"ok","version":"0.12.3-rc.0","agents":3}`；`packages/web-ui/dist`（14:04 构建）含 `16a28403` 的 `deriveReviewSessions(opts.reviewerName)` 与 `Work.tsx` 的 `agents.find(a => a.id === task.reviewerId)?.name` 接线。
- 未做到的部分：**没有取到横幅的 DOM 片段/文本**。两个具体原因：① 探针库注入的 `review` 态任务（`tsk_c02bdb05bc0e59715c898cb5`）直写 SQLite 后**未被 API 反映**（服务端缓存任务对象，DB 直写不生效；实测 `API status: in_progress` 而 DB 已是 `review`）；② 本卡本轮执行预算耗尽，未再重启实例复验。
- **因此该项不是「已验证」，也不接受「用单元测试替代」的口径**：`packages/web-ui/src/lib/taskReview.test.ts` 的归属用例只证明纯函数行为，不构成 DOM 证据。下一轮须重开此项：用真实 `task_submit_review` 把任务推进到 `review`（而不是直写 DB），再取横幅 DOM。
- 这一条按「零残余」纪律**必须由复核人看到**：已在提审的 `known_issues` 中明列，不藏在正文里。
- **探针实例已关闭（2026-11-12 16:05）**：`kill 48004` 后 `lsof -nP -iTCP:8071 -sTCP:LISTEN` **无输出**、`pgrep -fl cut6c4/home` 无残留进程。`/tmp/cut6c4/home` 数据库**原样保留未删**（符合「不删数据」硬边界）。
- 已在**代码与构建产物层面**确认：修复提交 `16a28403`（`fix(web-ui): 评审会话/横幅归属改用指定 reviewer，而非提交者`）在本次 build 之内。
- 因此该项状态是「**未取证（DOM 级），原因已写明**」，不是「已验证通过」。

---

## 6. Definition of Done 逐条勾销

| # | 条目 | 状态 | 依据 |
|---|---|---|---|
| ① | 静态门禁与全仓回归 | ✅ | §1 三道门禁退出码全 0；§2 全仓 8361 例 / 5 红**全部定性**：2 红为本刀真实漂移**已修**（§3.1、§3.2），3 红为环境性 / 既有 flaky **并有基线对照或隔离复跑证据**（§3.3–§3.5） |
| ② | 三条链路真实带信封记录 | ✅ | §4.2：human_chat 6 + a2a_message 1 + task_status_update 1，信封覆盖 `7/7` |
| ③ | `dropped` 增量 0 且 `catch_all` 可查 | ✅ | §4.3：`dropped = 0`；`catch_all = 1` 且带 `drop_reason`，可查（来源与口径瑕疵见 §4.4，作为观察项上报，不影响「无静默丢弃」成立） |
| ④ | `work_unit_ref` 列存在且写入数 0 | ✅ | 列在（`sqlite-storage.ts` 迁移只加列、不写值，注释写明 C7 才有唯一写者）；真实实例读数 `work_unit_ref 非 NULL = 0` |
| ⑤ | 五张卡各一次提交 + 本卡文档同步 | ✅ | 见 §7；本卡（C4）一次提交含两处修复 + 本报告 + 执行文档 §7.9 指针 |

---

## 7. 每卡回滚方式（各一次提交，可单独 `git revert`）

| 卡 | 提交 | 回滚 |
|---|---|---|
| **C0** | **无提交**（仅证据与文档） | 无需回滚；C0 的证据与文档收口落在后续卡的文档提交里 |
| **C1** | `ea65e620` `feat(mail): cut6 C1 address bindings — columns, global unique index, view, tool surface, write-side guards` | `git revert ea65e620` |
| **C2** | `e94caa54` `feat(mail): cut6 C2 delivery envelope — mailbox columns, single envelope assembly, three delivery points` | `git revert e94caa54` |
| **C3** | `65ac4cc0`（含三轮返工：`43d35f84` 主体 → `882911c4` 读归一 → `b430c797` 文档 → `65ac4cc0` 第 5 轮收敛 14 处旁路） | `git revert 65ac4cc0` |
| **C4** | `bb2c101f` `test(mail): cut6 C4 — full regression, real-instance probes, rebuild and doc close-out`（两处回归修复 + 本报告 + §7.9 指针） | `git revert bb2c101f` |

回滚粒度说明：每卡是**一个可独立回滚的提交**（C3 的返工在本卡之前已各自提交，如需整体回到 C3 之前，从 `65ac4cc0` 逐轮回退即可）。**未 merge、未 rebase**。

---

## 8. 已知边界（不做的，明确写清）

- 未接 **DNS / MX / SPF / DKIM / DMARC**：本刀只做站内地址与投递语义，不做真实邮件域验证。
- **不发信、不收信**：没有 SMTP 客户端/服务端。
- 未接**外部来源适配器**（留给 **C10**）：`dsn_bounce` 在原因闭集里只预留、拒绝写入。
- **不写 `work_unit_ref` 的值**（留给 **C7**）：列已建、值为空，避免「先建引用后建实体」。
- **未 merge main**、**未发版 / 未打 tag**：等 Owner 明确批准。
- 横幅归属 `16a28403` 的 **DOM 级复验仍未取证**（§5.1 写明了卡在哪、下一轮怎么补）。**未取证就是未验证，不得当作已验。**
- §4.4 的「退信原因与事件名对不上真实原因」已由 **C5 收口卡修复**（原因 `payload_invalid` + 事件 `mailbox.signal_bounced`），明细见执行文档 §7.10。

---

## 附：本卡改动的文件（4 个，均在提交内）

| 文件 | 改动 |
|---|---|
| `packages/web-ui/src/lib/toolCategories.ts` | `mailbox` 分组补入 C1/C3 新增的 5 个工具名（附中文注释） |
| `packages/org-manager/test/api-server.test.ts` | recover-stale 断言 `dropped` → `bounced`（附改名理由注释） |
| `markus-cut6-c4-verification-report-2026-11-12.md` | 本报告（新增） |
| `markus-cut6-mailbox-address-design-2026-11-10.md` | 末尾追加 §7.9（指针，不复制事实） |

**未改动任何生产逻辑代码**：两处代码改动分别是「分类表常量补登记」与「测试断言跟随字段改名」，都不改变运行时行为。
