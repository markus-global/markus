# Agent 停止后仍会被启动/唤醒的路径审计与修复方案

> Owner 2026-11-08 的要求：**停止之后，除非人类手动启动、或 Agent 自己发了审批等人回答，否则不得自行启动或被任何事件唤醒。**
> 本文逐条核对代码事实（带 `文件:行号`），给根因、修复方案和验收判据。审计基线：`feat/ui-optimize-1108`。

---

## 0. 结论（先看这段）

**规则在 3 条路径上被违反，全部是「Agent 侧」的路径；另有 3 条「人类侧」路径会顺带复活被停掉的 Agent。**

| 严重度 | 场景 | 谁能发起 |
|---|---|---|
| 🔴 P0 | Agent A 给已停止的 Agent B 发消息并带 `wake_recipient: true` → B 被拉起 | **Agent** |
| 🔴 P0 | Agent 调用 `agent_start` 工具启动同团队里被人类停掉的 Agent | **Agent** |
| 🟠 P1 | 「全部恢复」(resume-all) 把**每一个 offline 的 Agent** 拉起来，包括人类单独停掉的 | 人类一次误操作 |
| 🟠 P1 | 「启动团队」顺手复活团队里**被人单独停掉**的成员 | 人类 |
| 🟡 P2 | 以上两条还会把持久化的 `disabled` 标记**清成 0** —— 之后连「开机恢复」也认不出这是人类停的 | 副作用 |

**根因不是漏了几个 `if`，是「是否被人停止」这个事实有两个写者**：运行时 `status === 'offline'`（会随崩溃、未启动、停止而变）与持久意图 `agents.disabled`（人按按钮才写）。**只有开机恢复读了后者**，其余 11 条路径都只看前者 —— 于是「人停的」与「还没起来的」在代码里长得一模一样。

---

## 1. 按下停止按钮，究竟发生了什么

`POST /api/agents/:id/stop`（`packages/org-manager/src/api-server.ts:4461`）→ `AgentManager.stopAgent()`（`agent-manager.ts:3304`）：

```ts
async stopAgent(agentId: string) {
  const agent = this.getAgent(agentId);
  await agent.stop();                        // ① 清定时器 + status → offline
  this.cancelMcpRelease(agentId);            // ② 回收 MCP / 浏览器 / 终端
  this.browserSessionManager.cleanupAgent(agentId);
  this.terminalSessionManager.cleanupAgent(agentId);
  await this.mcpManager.removeAllForScope(agentId);
  this.disabledChangeHandler?.(agentId, true);  // ③ 持久化「人停的」意图
}
```

`agent.stop()`（`agent.ts:1339-1368`）清理得相当干净：`cancelActiveStream`、`attentionController.stop()`（**注意力循环停掉 → 邮箱不再被消费**）、`heartbeat.stop()`、`wakeupTimer`（`schedule_wakeup` 扫描）、`_bgCompletionUnsub` / `_heartbeatUnsub`、notebook 定时器、记忆整合定时器 → `transitionStatus({ to: 'offline' })`。

`disabledChangeHandler`（`cli/src/commands/start.ts:2205-2209`）→ `storage.agentRepo.setDisabled(id, true)` → `agents.disabled = 1`（`packages/storage/src/sqlite-storage.ts:1489`）。

**所以：运行时该停的都停了，意图也持久化了。问题出在「谁尊重这个意图」。**

---

## 2. 全路径审计：谁能把已停止的 Agent 拉起来

| # | 触发 | 代码位置 | 是否检查 `disabled` | 判定 |
|---|---|---|---|---|
| 1 | 人类点「启动 / 恢复」 | `api-server.ts:4456`（start）、`:4476`（resume 别名） | — | ✅ 允许 |
| 2 | **服务重启后自动恢复** | `org-service.ts:966`：`if (disabled) { skipped++; continue }` | ✅ **是** | ✅ 正确 |
| 3 | 「全部恢复」`resume-all` | `agent-manager.ts:3919 startAllAgents()`：只判 `status === 'offline'` | ❌ **否** | 🟠 连人停的也拉起来，并写 `disabled=false` |
| 4 | 「启动团队」 | `org-service.ts:587 startTeamAgents()` → `agent-manager.ts:3862 startAgentsByIds()`（无 disabled 判定，逐个 `startAgent`） | ❌ **否** | 🟠 人类发起，但会复活被人单独停掉的成员 |
| 5 | **A2A 消息带 `wake_recipient: true`** | `tools/a2a.ts:104-106`：`if (wakeRecipient && recipientStopped && ctx.wakeAgent) await ctx.wakeAgent(targetId)` | ❌ 只判断「是否 stopped」 | 🔴 **违反规则（Agent 发起）** |
| 6 | **`agent_start` 工具**（manager 专用） | `tools/manager.ts:511-531` → `ctx.startAgent(agentId)` | ❌ **否** | 🔴 **违反规则（Agent 发起）** |
| 7 | 新建 Agent 后自动启动 | `api-server.ts:6894` | — | ✅ 合理（新建即上线） |
| 8 | 定时任务到点触发 | `scheduled-task-runner.ts:159-173`：显式跳过 offline 的 assignee，**"will retry on agent online"** | ✅ 是 | ✅ 正确 |
| 9 | 人类给它发消息 | `api-server.ts:4081 agent.sendMessage()` → 邮箱入队；注意力循环已停 → 无人消费 | — | ✅ 不会启动（但**静默堆积**，见 S6） |
| 10 | 分配任务 | 任务创建/分配路径中**没有** `startAgent` | — | ✅ 正确 |
| 11 | 心跳 / `schedule_wakeup` / 记忆整合 | 均在 `stop()` 里清掉，且 `startRestoredAgentsInBackground` 之外无重建 | ✅ | ✅ 正确 |
| 12 | 人类回答它发出的审批 / 提问 | 阻塞回合在同一运行时恢复 | — | ✅ **正是 Owner 允许的例外** |

**已确认「安全」的路径**：2、8、9、10、11，以及 12 这个例外 —— 说明平台在多数地方已经做对了，问题集中在**启动闸门不统一**。

---

## 3. 三个具体事故脚本（都能复现）

**A. Agent 互相唤醒（P0，纯自主，人类不参与）**
> Manager Agent 想催办事 → `agent_send_message(agent_id=B, wake_recipient: true)` → `a2a.ts:104` 看到 B `stopped` → `wakeAgent` → `startAgent` → B 上线，开始跑心跳和任务。**人类按过的停止按钮等于没按。**

**B. Agent 自行启动同类（P0）**
> Manager Agent 调 `agent_start(B)`（`manager.ts:531`，仅校验「B 在我的团队里」）→ B 上线。人类停掉的理由（省钱 / 它在闯祸 / 正在改它的 ROLE）完全不被考虑。

**C. 人类的一次「全部恢复」抹掉所有个别决定（P1）**
> 人类停掉 5 个 Agent（各自有理由），某天点了「全部恢复」想让 2 个上线的回来 → **5 个全上线**，且 `disabled` 被逐个写成 0 → 之后重启服务，连开机恢复也不会再跳过它们。**人类的意图被一次副作用永久删除**，且没有任何提示。

---

## 4. 根因

| 编号 | 根因 | 证据 |
|---|---|---|
| **R1** | 同一个事实（「是否被人类停止」）有两个写者：运行时 `status` 与持久 `disabled` | `agent-manager.ts:3922` 只看 status；`org-service.ts:966` 只看 disabled |
| **R2** | 不变量「人停的不得自动启动」没有唯一执行点 —— 它被指望由 12 条路径各自记得 | 12 条路径中只有 1 条（boot）真正执行 |
| **R3** | 设计冲突未裁决：`wake_recipient` / `agent_start` 是为了避免「消息进邮箱变死信」而**故意**设计成能唤醒的 | `a2a.ts:96-113` 注释明写「a stopped agent has no schedule, so without a wake the message would sit indefinitely」 |

R3 决定了修复方向不该是「在 a2a 里 `return` 掉就完了」：**死信问题必须仍然被解决**，只是换成「可见地告诉人类」，而不是「悄悄把人停的东西拉起来」。

---

## 5. 修复方案

设计原则：**闸门收到唯一入口**，并且给「人类停的」这件事一个**有名字的意图**。改动净增很少，删掉的分散判断比新增的多。

### S1（核心）`startAgent` 成为唯一闸门 —— 引入启动原因

```ts
export type StartCause =
  | 'human'            // 人类点按钮
  | 'boot'             // 服务重启恢复（已按 disabled 过滤）
  | 'creation'         // 新建 agent
  | 'agent-a2a'        // agent_send_message + wake_recipient
  | 'agent-tool'       // agent_start 工具
  | 'system-resume-all'// 「全部恢复」
  | 'team-start';      // 「启动团队」

async startAgent(agentId, opts: { cause: StartCause; force?: boolean; ... }) {
  if (this.isStoppedByHuman(agentId) && !HUMAN_EQUIVALENT.has(opts.cause) && !opts.force) {
    throw new AgentStoppedByHumanError(agentId); // 带可行动提示，见 S2
  }
  ...
}
const HUMAN_EQUIVALENT = new Set<StartCause>(['human', 'creation', 'boot']);
```

改动点：所有调用点显式传 `cause`（12 处，编译器会替我们找齐 —— 参数必填）。**未登记 cause 的新调用点会直接编译失败**，这类 bug 从此在结构上无法表达。

### S2 A2A：不再唤醒，改为「可见的死信」

`wake_recipient: true` 且目标 `disabled` → **不唤醒**，返回结构化结果（不是错误，是事实）：

```json
{ "status": "stopped_by_human", "delivered": "queued",
  "notice": "B was stopped by the human. The message is queued and will be processed only after a human starts it. If you need it running, ask the human with request_user_input." }
```

死信问题仍然被解决 —— 发信方拿到明确事实和下一步，而不是被平台偷偷替代人类做决定。

### S3 `agent_start` 工具：保留能力，加上同一闸门

工具保留（管理器确有「把崩溃/未启动的成员拉起来」的正当需求），但**人停的不能由 agent 启动**：返回 `stopped_by_human` + 建议走 `request_user_input`。（若你更想彻底删掉这个工具，见 §6 的裁决点。）

### S4 「全部恢复」/「启动团队」不再顺带抹掉人类决定

- 跳过 `disabled === true` 的成员，**返回 `skipped` 列表**（id + name + 原因）。
- UI 提示：「已启动 2 个；跳过 5 个（你之前手动停止的）」。
- **绝不**把跳过的成员 `disabled` 写成 0。要「连人停的也启动」必须是独立动作：`force: true` + UI 二次确认（措辞：「这会启动你曾手动停止的 5 个 Agent」）。

### S5 `resume-all` 语义改正

从「启动所有 offline」改为「恢复被系统暂停的（emergency / pause-all）」。个别停掉的不是它的管辖范围。

### S6 人类发消息给已停止的 Agent：不启动，但必须说话

当前消息静默入队（审计表 #9）。改为：接口返回 `agentStopped: true`，UI 在气泡旁提示「该 Agent 已停止，消息已排队；启动后才会处理」，并给一个「启动它」的按钮（人类的显式动作）。

### S7 意图可见

- `GET /api/agents` 增加 `stoppedByHuman`（来自 `disabled`），与运行时 `status` 分开表达。
- 停止按钮 tooltip：「停止后不会自动启动；只有你手动启动、或回答它的审批/提问才会恢复」。

### S8 测试（先红后绿）

对审计表 12 条各写一条行为测试，断言矩阵：

| 场景 | `disabled=1` 期望 |
|---|---|
| human start | 启动 ✅ |
| boot restore | 跳过 ✅（已有，补测试固化） |
| resume-all | 跳过 + 出现在 `skipped` 里，`disabled` 保持 1 |
| team-start | 同上 |
| a2a `wake_recipient` | **不启动**，返回 `stopped_by_human` |
| `agent_start` 工具 | **不启动**，返回 `stopped_by_human` |
| 定时任务到点 | 跳过（已实现，补测试） |
| 人类发消息 | 不启动，返回 `agentStopped` |
| 人类回答审批 | **恢复**（允许的例外，必须测，防止矫枉过正） |

---

## 6. 需要你拍板的一点（我只列事实与我的倾向）

`wake_recipient` 与 `agent_start` 本质是「Agent 能否越过人类重启同类」。两条路：

- **(A) 加闸门（我的倾向）**：保留能力，只禁止越过人类。Agent 仍可唤醒**崩溃/未启动**的成员（那是恢复，不是推翻决定），但不能唤醒**人类停掉的**。改动小、不留能力空洞。
- **(B) 彻底删除**这两个能力：更彻底、代码更少，但「成员崩了、管理器想把它拉回来」也会一起失去，只能靠人类点。

我已按 (A) 写方案。如果你选 (B)，S2/S3 变成删代码，S1/S4/S5 不变。

---

## 7. 我已决定的实现细节（不需要你确认）

- `disabled` 作为「人类意图」的唯一存储，不新增表/字段；`stoppedByHuman` 是它的读穿，不产生第二份真相。
- 闸门放在 `AgentManager.startAgent`，**不放**在各个调用点 —— 放调用点就是 R2 复发。
- 「开机恢复跳过 disabled」这条**已有**的正确行为要保留并补测试固化，落地时不要动它（`org-service.ts:966`）。
- 新增错误类型 `AgentStoppedByHumanError`，返回给 Agent 时带可行动提示（符合「越界时拒绝 + 给可行动提示，不悄悄改写」）。

---

## 8. 影响面与风险

| 项 | 评估 |
|---|---|
| 改动文件 | `agent-manager.ts`（闸门 + cause）、`a2a.ts`、`tools/manager.ts`、`org-service.ts`（team/resume）、`api-server.ts`（路由传 cause + 提示字段）、web-ui（提示文案） |
| 破坏性 | 低：所有变更都是「拒绝」而非「改变已有正确行为」；唯二语义变化是 resume-all / team-start 的跳过（这正是要修的） |
| 回归风险 | 中：`startAgent` 签名变更会波及 12 个调用点，编译器全覆盖；需跑全量 core + org-manager 测试 |
| 回滚 | 单一提交可回滚；`force: true` 保留人工逃生口 |

---

## 9. 验收判据（可判定）

1. `disabled=1` 的 Agent，在 `a2a(wake_recipient)`、`agent_start`、`resume-all`、`team-start`、定时任务、人类发消息六条路径下**都不进入 `start()`**（测试断言 `agent.start` 未被调用，且状态保持 `offline`）。
2. 「全部恢复」的响应体含 `skipped[]`，且这些 Agent 的 `disabled` 仍为 1。
3. 人类回答审批 / 提问时，被阻塞的回合**确实恢复**（例外不能被打死）。
4. 重启服务后，`disabled=1` 的 Agent 不被启动（现有行为，测试固化）。
5. 全量测试通过；无路径依赖 `status === 'offline'` 作为「可以启动」的唯一依据（grep 守卫：`startAgent` 的调用必须带 `cause`，参数必填使其编译期不可漏）。
