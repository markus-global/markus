# C7 真机验收：四轮修复后的完整读数（2026-11-14）

> 环境：本机桌面实例（`Markus.app`，API `:8056`，`~/.markus/data.db`），Owner 逐轮重启验证。
> 操作方式：Owner 授权，以他的身份在浏览器内走真实入口（`POST /api/message` 等 UI 同源调用）。

## 1. 四个真机缺陷与修复顺序（全部已修）

| # | 现场症状 | 根因 | 修复提交 |
|---|---|---|---|
| 1 | `work_units` 表在、**0 行**、无任何报错 | `APIServer.workUnits` getter 把「storage 尚未接入时的 null」缓存成永久答案；且首次读取发生在 `setStorage()` 之前 | `1d036ad3` |
| 2 | 同上，桌面端尤其 | C7 装配写在 `cli/commands/start.ts`，而桌面端走 `cli/backend.ts#startBackend` → 装配从未执行；`work_status` 因此**运行时不存在** | `8ecffddd` |
| 3 | 子 WU 落 `delegation:root:…`，`parent_id` 为 NULL | chat 的 WU 在**入队后异步回填**，agent 可能已开始处理 → `item.workUnitRef` 为空 → 委派无父 ref | `82bc9e21` |

## 2. 最终验收矩阵（全部通过）

| 项 | 读数 |
|---|---|
| chat 链路 | `session:cs_…:r318` 在回合**进行中**即为 `running`（此前只有收口后才有 `idle` 行）；收口后迁 `idle`，`reason=chat_turn_settled` ×4 |
| a2a 链路 | `a2a:dm:a2a:…:dlv_…`（`idle`，`reason=a2a_delivery_enqueued` ×2） |
| 委派父子链 | 新子 WU 均为 `delegation:session:cs_…:r<N>#…`，`parent_id` **非空**且可 JOIN 回父行 |
| 预算记账 | `budget=1 / used=1`（子 agent 跑 1 轮迭代后记录） |
| 预算到线 | `delegation:…:r186#sub_…` → `status=paused_budget`，`status_transitions` 留痕 `reason=subagent_budget_exhausted`；子 agent 自报 `status=budget_exhausted, budgetHit=own, iterations=1` |
| 自省工具 | `work_status()` 返回真实台账（`{count, units:[{ref,status,parentId,budget,used}]}`）；未接线时回 `unavailable` 而不是不存在 |
| 零悬空 | `mailbox_items LEFT JOIN work_units` = **0** |
| 历史行 | 修复前的 `delegation:root:` 行保持 NULL，**不回填**（历史只读） |

## 3. 可复用判据（这轮学到的）

1. **「暂时没有」不是事实**：惰性依赖的缺席不得被缓存成永久属性（负缓存）。
2. **装配必须锚在「所有启动路径都必须经过」的那一个点**（这里是 `setStorage()`），写在某个启动文件里就必然有第二条路径漏掉。
3. **身份先于消息**：属于某条消息的实体必须在**入队前**存在并随消息落地，不能在入队后异步回填 —— 否则就是竞态，而竞态的表现永远是"有时对、有时错"。
4. **工具不该因装配顺序而消失**：不存在的工具会让 agent 把「没接线」误读成「我没这个能力」；接线缺失应回答 `unavailable`。
5. 排查口诀：**表在、无数据、无日志** → 先查装配接线，别先查业务逻辑。
