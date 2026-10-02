# Agent 存活 / 自愈机制：审计结论与重新设计

> 日期：2026-09-25 · 作者：CTO（技术联合创始人）
> 起因：刘利（agt_4e6ddf338eef9077c6ad8e92）在数小时内产生 600+ 条「定时心跳签到」记录（每 2 分钟一次）。
> 本质：不是单个 bug，而是「存活/自愈机制」在演进中叠了一堆相互打架的补丁，缺少一个清晰的主线设计。
> **审计记录状态（2026-09-26）：重构 1–4 已全部完成并入库**。本文件作为审计记录保留；
> 现行设计已并入 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md)（§3.10 Agent 存活 / 自愈机制）。
> 旧独立模块（`agent-dirty.ts` / `agent-stall.ts` / `agent-dirty-reconciler.ts`）已于重构 4 删除，
> 判定原语内联进单一组件 `agent-conservator.ts`。

---

## 一、症状 → 病根

| 症状 | 病根 |
|---|---|
| 心跳每 2 分钟一次、600+ 条记录刷屏 | 脏态兜底器（Dirty Reconciler）反馈回路：stuck-working 的 agent 被周期性触发心跳，心跳 2 分钟宽限窗口一过又判脏 → 再触发 |
| agent 的 `last_heartbeat` 永远为空（600+ 次心跳都不写） | 状态回调（stateChangeCallback）根本没带 `lastHeartbeat` 字段 → 列存在但无人认领 |
| agent 状态卡死 `working` 不回归 idle | `setStatus('idle')` 散布在 ~25 处、各自用 `activeTasks.size === 0` 守卫，无双状态机、无收敛保证 |
| 重启后风暴复现 | 兜底机制与状态源分离：core 内存状态 / DB / org-manager live view 三方不一致 |

## 二、审计发现：6 个设计层面缺陷

1. **无单一存活事实源（Liveness SSOT）**。`agents.last_heartbeat` 列存在但无写入方；core 内存 `state.lastHeartbeat` 每轮心跳更新但从不持久化、不广播。所有「agent 死没死」的判断（dirty/stale/stall/UI）各自派生，必然打架。

2. **心跳被塞了三个互相冲突的职责**：①LLM 巡检（每天每 agent 是一次大模型调用！）②存活证明 ③自愈手段（被兜底器触发）。安全网应 O(1) 廉价，结果它是全场最贵的操作，且无总次数上限 → 一失配就烧 token。

3. **多个兜底观察者无仲裁、无协调**：Dirty Reconciler（30s 扫描，2min 宽限，5min 重试）、MCP release timer、stall detector、stale detector、deep-sleep、schedule_wakeup 各自为政，对「agent 是否被监督」没有统一裁决 → 出现反馈回路时没有任何一个机制能收敛。

4. **自愈动作无幂等、无终止条件**：`trigger-heartbeat` 会重复触发，而它并不解决根因（stuck status）；只有靠「宽限窗口」临时压制，窗口一过再犯 → 2 分钟风暴（已修复见 §四）。

5. **状态机靠补丁堆叠**：core 里 25+ 处 `setStatus('idle')` 守卫式调用、加上并发 worker 的分支（`attentionController`），多路径并发改状态存在竞态覆盖风险（task 完成置 idle vs 心跳置 working 的顺序不保证）。

6. **持久化通路缺字段**：`stateChangeCallback(id, state)` 的 state 类型漏了 `lastHeartbeat`，导致「想写但没有数据可写」。

## 三、目标设计（重新设计）

**一句话：单一存活事实源 + 一条有界安全网 + 收敛式状态机，其余全部去重。**

1. **Liveness SSOT**：`agents.last_heartbeat` 由 core 单向写入（每轮心跳完成/跳过时，含 skip），所有观察者统一读它（实时读 live-view，落列供跨进程/诊断）。心跳时间戳是唯一「活着」的证据。

2. **心跳语义收紧**：心跳 = 存活上报 + 低频巡检（默认 6h，配置落库）；**存活上报与 LLM 巡检解耦**——skip 路径不上报 LLM，只写时间戳；LLM 巡检只在有实际变化时发生。平台级硬速率下限（已有 clamp 5min）+ 任何触发心跳的路径（含兜底器）都必须走同一收口、受同一速率/总量限制。

3. **单一安全网仲裁器（暂名 Conservator）**：把 dirty/stale/stall 的判定收敛为一个组件，输出唯一动作序列：
   `idle ✓ → 不动作`
   `可疑（working 无任务）→ 查 lastHeartbeat 新鲜度 → 短窗口观察`
   `→ 触发一次廉价唤醒（非 LLM 巡检）→ 仍无进展 → reconcile-idle → human-review`
   每步带**指数退避 + 总次数上限 + 收敛证明**（要求动作导致状态迁移，否则不得进入下一轮），从机制上排除「每 2 分钟一次」这类周期解。

4. **收敛式状态机**：散布的 setStatus 收敛为单一 `setStatus()` + 唯一派生函数（由 activeTasks / focus / worker count / currentActivity 计算期望状态），串行化状态迁移，杜绝竞态覆盖。

5. **持久化通路补全**：状态 payload 带上全部权威字段（status/lastHeartbeat/activeTaskIds/currentActivity/lastError），一次回调写全，不再丢字段。

## 四、本次已修复（代码已改、测试已绿，待构建生效）

| 修复 | 文件 | 验证 |
|---|---|---|
| A. 兜底器重试释放条件 + 连续触发升级（切断 2 分钟风暴） | `packages/org-manager/src/agent-dirty-reconciler.ts` | 17 测试绿 + 新增风暴回归测试 + tsc |
| B. `lastHeartbeat` 落库（状态 payload 补字段 + 3 处心跳落点上报 + repo 写入） | `core/src/agent.ts`、`core/src/agent-manager.ts`、`storage/src/sqlite-storage.ts`、`cli/src/commands/start.ts` | 30 个心跳测试绿 + 全包 tsc 通过 |

## 五、待执行的重构（建议排期，按风险从低到高）

1. **Conservator 统一仲裁**（**✅ 2026-09-25 已完成**，`packages/org-manager/src/agent-conservator.ts`）——dirty/stale/stall 收敛为单一组件：
   - `evaluateConservator`（纯函数）：融合 dirty 判据 + stall 判据 + 心跳/活动新鲜度，输出唯一动作阶梯 `ok → observe → wake → reconcile → human-review`；
   - `AgentConservator`（仲裁引擎）：指数退避（base·2^(n−1)，封顶 8h）+ 单 episode 总次数上限 + 收敛证明（未脱离 processing-like 不复位 episode；human-review 每 episode 通知一次）；
   - Fix A 合流：连续 3 次 trigger-heartbeat 无果 → 升级 human-review（`CONSERVATOR_MAX_WAKE_ATTEMPTS=3`）；
   - 接线：`api-server.ts` 从 `AgentDirtyReconciler` 切换为 `AgentConservator`；display path 改用 `evaluateConservator`（`runtime.stall`/`runtime.dirty` 形状兼容不变）；
   - 回归测试：`test/agent-conservator.test.ts` 19 用例（stuck-working 心跳风暴 + 心跳宽限 + 指数退避 + 上限收敛 + degraded/dead-dependency）；olde dirty-reconciler 测试保留（重构 4 删除旧模块时再移除）。
2. **Liveness 解耦心跳**（**✅ 2026-09-26 已完成**，`packages/core/src/agent.ts` + `packages/core/src/heartbeat.ts`）——skip 路径降为纯时间戳，LLM 巡检仅在状态实际变化时发生：
   - **skip 路径收口**：新增 `recordHeartbeatSkip()` 为心跳 skip 的唯一出口（human-chat defer / idle / deep-sleep 三分支统一走它）——活动记录 + `state.lastHeartbeat` 落库（notifyStateChange → Fix B 链路）+ 指标 + 可选 deep-sleep 间隔延长。「skip=纯时间戳、永不调用 LLM」成为结构性事实；
   - **巡检指纹升级**：`heartbeatStateFingerprint()`（纯函数，可单测）——指纹从旧「队列深度 `q:N`」升级为「队列内容（sourceType+id 签名）+ 活跃任务 id 集合」。仅当状态**实际变化**（新邮件/任务增减）才巡检一次；同一邮件卡在队列（stuck）指纹不变 → 不空转 LLM；
   - **残留逻辑依赖清零**：`shouldEnterDeepSleep` 的 `hasActiveTasks: false` / `hasPendingReviews: false` 硬编码改为实时状态（`activeTasks.size > 0` + queued `review_request`），有活跃任务/待审邮件绝不深睡翻倍间隔；
   - **收口确认**：所有触发心跳路径（HeartbeatScheduler.tick/trigger、Agent.triggerHeartbeat、agent-manager/api-server 侧 triggerAgentHeartbeat → Conservator recover）都只 emit `heartbeat:trigger` → `agent.ts` 唯一 handler → `mailbox.enqueue('heartbeat')` → 单条折叠处理；邮箱邮件由 mailbox worker 独立消费，心跳不重复巡检邮件；
   - **回归测试**：`core/test/heartbeat-liveness.test.ts` 新增 9 用例（指纹纯函数 5 例：stuck 邮件不变/新邮件变/心跳自排除/任务增减；skip 纯时间戳：连续心跳仅首次巡检 + lastHeartbeat 刷新；stuck-working 宽限多触发不增 LLM；邮件独立消费后仍 skip；Conservator triggerHeartbeat 收口不产生多余巡检），core 全量相关 156 用例 + 全包 tsc 绿。
3. **状态机收敛**（**✅ 2026-09-26 已完成**，`packages/core/src/agent.ts`）——setStatus 单一化、消除竞态覆盖：
   - 27 处散落 `setStatus` 调用点全部收敛为意图化 `transitionStatus` + 落地 `applyStatus`（L953-1015 区域）：错误粘性（error 后 idle 不覆盖）+ 聚合状态守卫（activeTasks>0 / 并发 worker 忙碌 → idle 被拒）+ force 强制兜底 + reset 清错 + offline 无条件；
   - 心跳巡检 / 保守仲裁（reconcileToIdle→reset）/ Normal 转换（error→working 清 lastError）统一走单一派生函数；
   - 回归测试：`core/test/agent-status-machine.test.ts` 15 用例（生命周期/error 粘性/并行 error/idle 不覆盖/working 中 idle 被拒/并发 worker 聚合/force/reset/reconcileToIdle）；core 全量 3041 用例 0 failed + 全包 tsc 绿。
4. **收尾：删除旧 dirty/stall 独立模块，文档并入 ARCHITECTURE**（**✅ 2026-09-26 已完成**）——本重构项：
   - 删除旧独立模块 `agent-dirty.ts`（evaluateDirtyState）/ `agent-stall.ts`（evaluateStall）/ `agent-dirty-reconciler.ts`（AgentDirtyReconciler）及其 3 个旧单测（`agent-dirty.test.ts` / `agent-stall.test.ts` / `agent-dirty-reconciler.test.ts`）；
   - 判定原语内联进单一组件 `agent-conservator.ts`（组件彻底自包含，对外仅暴露 Conservator 系列符号）；`api-server.ts` 中旧日志字符串同步清理；
   - 保留 `test/agent-stall-api.test.ts`（API 展示契约测试：`runtime.stall` 形状经 evaluateConservator 展示路径透出，不依赖旧模块）；
   - 回归覆盖：旧单测场景（stuck-working 心跳风暴/心跳宽限/degraded/dead-dependency/disabled）已被 `agent-conservator.test.ts` 19 用例吸收；
   - 验证：org-manager 全量测试绿（含 19 conservator + 5 stall-api）+ 全包 `tsc -b` exit 0；本文档并入 `docs/ARCHITECTURE.md` §3.10，本文件保留为审计记录。

## 六、生效条件

- 本次修复（A/B）代码需**重新构建并重启桌面应用**才生效。
- 重启后验证：刘利 `last_heartbeat` 应开始写入；stuck-working 的 agent 在连续 3 次触发无果后升级人工介入，不再出现高频心跳。

## 七、2026-09-25 补充：心跳能力模型调整（Owner 指令）

产品级决定：**心跳会话的能力与普通 session 一致**，不再用小工具包（reflex）锁死。

- `scenarioToPack('heartbeat')`：reflex → **converse**（`capability-packs.ts`）。
- 移除 `agent.ts` 心跳路径的 `HEARTBEAT_ALLOWED_TOOLS=getReflexAllowlist()` 白名单传参；提示词重写为「范围由 HEARTBEAT.md 定义、成本由心跳间隔承担、不做深度工作」的纪律声明。
- 间隔调整：Agent 需**先征询人类**（`request_user_input` / `notify_user`），获同意后才调用 `set_heartbeat_interval`（clamp 5min–24h）。
- 硬性护栏仅保留：工具迭代上限（单次心跳）、心跳间隔 clamp（成本）、HEARTBEAT.md（行为范围）——不再有硬编码工具子集。