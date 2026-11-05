# Thread：对象与视角的边界

> **一句话**：Thread 是**对象层已有的实体**（`threads` 表 + `UNIQUE(ref)`），
> 「来龙去脉」是它的**视角**（一层派生读取 + 一处渲染）。
> 本文件说明这个边界为什么成立、入口在哪、哪些东西**刻意不做**。
>
> 对应契约：`docs/design/superagent/DESIGN-CONTRACT.md` §7 任务七（B4）、§2 Q2 / Q4、§1 H3；
> 台账 §9.1 第 3 行（Thread）与第 12 行（Panel）。

---

## 1. Thread 是对象，不是「新建的东西」

| 问题 | 答案 | 证据 |
|---|---|---|
| 流是什么？ | 一个**实体 id**（`tsk_…` / `tkt_…` / `agent:…` / `gh:owner/repo`…），不是新造的类型 | `packages/shared/src/types/thread.ts` `ThreadRef` = string 命名空间键；`threadRefOf()` 是唯一归一化入口 |
| 谁产出流键？ | **只有** `resolveThreadRef()` | `packages/core/src/thread-resolver.ts:33`（六轴顺序：explicit → task → requirement → channel → session → agent） |
| 一条 ref 能有几条流？ | **恰好一条** | `threads` 表 `UNIQUE(ref)`（I1，未改动） |
| 「在等谁」是谁算的？ | **只有** `deriveStage()` | `packages/shared/src/types/thread.ts`；HTTP 侧唯一调用点 `withStage()`（`packages/org-manager/src/event-routes.ts`） |
| 时间线数据从哪来？ | `triggers` 表**派生**（没有 `thread_events` 表） | 见 `CONCEPT-CLARITY-2026-11-03.md` §8（提交 `63241250`） |

**所以本卡不改存储模型**：没有新表、没有新列、没有 `ThreadKind`。
判据（契约 §3 奥卡姆）：如果这里需要新增一个对象/枚举，说明我们又在用「新机制」解决呈现问题。

---

## 2. 「来龙去脉」是视角：三个部分，各只有一处实现

```
        ┌────────────── 读取面 ──────────────┐
ref ──▶ │ GET /api/threads/one?ref=          │  头部事实（标题 / stage / 任务状态）
        │ GET /api/threads/:ref/events       │  真实发生过的事（triggers 派生）
        │ GET /api/threads/:ref/dispositions │  系统做过的判断（唯一审计事实）
        └────────────────┬───────────────────┘
                         ▼
        ┌────────── 渲染面（唯一实现）──────────┐
        │ components/threadTimelineNodes.tsx    │  事件 / 决定 / 当前状态三种节点
        │ lib/threadTimeline.ts mergeTimeline() │  只按 createdAt 合流；同刻事件在前
        │ components/ThreadTimeline.tsx         │  只给 ref 就能渲染的容器
        └───────────────────────────────────────┘
```

三条纪律：

1. **当前状态不是事件**：`threads` 是派生快照、没有时间戳，固定在末尾并显式标注
   「这不是一条历史事件」。把派生状态伪造成带时间戳的节点，等于拿今天的推断回填过去。
2. **两段历史分开取**：事件读失败 ≠ 没有事件；决定读失败 ≠ 没有决定。合成一个请求就分不清是哪一种。
3. **只并排呈现，不改写正文**（H3）：`summary` / `reason` 原样输出，不做合并、不做摘要。

---

## 3. 入口倒置：三处「就地打开」

主入口长在**被看的那个对象**上，而不是一个全局目录页。三处接线（同一组件、只给 ref）：

| 入口 | 文件:行 | ref |
|---|---|---|
| 任务详情 →「来龙去脉」页签 | `packages/web-ui/src/pages/Work.tsx:2324`（页签）/ `:2344`（渲染 `<ThreadTimeline refId={task.id} />`） | `tsk_…` |
| 任务详情 →「票据」列表 → 票详情 | `packages/web-ui/src/pages/Work.tsx:2308`（`<TicketDetailPanel />`）/ `packages/web-ui/src/components/TicketDetailPanel.tsx:87` | `tkt_…` |
| agent 详情 →「来龙去脉」按钮（浮层） | `packages/web-ui/src/pages/AgentProfile.tsx:175`（按钮）/ `:212`（渲染 `<ThreadTimeline refId={`agent:${agentId}`} />`） | `agent:agt_…` |

> 票据的详情面是本卡**补出来的**：C1 建了票表与 HTTP 面，但 web-ui 零消费点，
> 「从 ticket 详情打开流」在物理上做不到。它被做成任务详情里的就地展开，
> 而不是新路由 —— 票挂在这张卡上，人真正遇到票的地方就是这里；新路由今天没有入口指向它（死页面）。

**为什么任务/票据之外还保留一个全局页**：有些场景人手里只有一个 ref（复制来的、
别人贴的），这时需要一个「粘贴就能打开」的地方。它因此是**检索**而不是目录（见 §4）。

---

## 4. 全局页 = 检索，不是主视图

`packages/web-ui/src/pages/ThreadView.tsx`

- 首屏文案：「搜索一条流」；空查询**不列任何流**（检索面的定义）。
- 输入 ref（`tsk_…` / `tkt_…` / `agent:…` / `gh:o/r`）→ **直接解析**（`lib/threadSearch.ts` `looksLikeRef()`），
  即使这条流不在任何候选列表里；列表只是检索语料，不是权限边界。
- 输入关键词 → 在候选流里按标题 / ref 过滤（`matchesThreadQuery()`）。
- 删掉了「需要你处理 / 进行中 / 空闲」三桶目录分组：那是**行动台（Inbox）**的职责，
  在这里再算一遍就是同一事实的第二个度量（R6「在等我」被拆成三处 的老毛病）。

两条会被测试咬住的判据：

| 判据 | 测试 |
|---|---|
| 组件只给 ref 就能渲染时间线，**不碰全局列表** | `components/ThreadTimeline.test.tsx`：把 `fetchThreads` mock 成**抛错**，改回列表路线立刻红 |
| 全局页文案/行为是检索语义（不含「全部流 / 目录」） | `pages/ThreadView.test.tsx`：断言首屏标题、空查询零行、关键词命中、ref 直解 |

---

## 5. 刻意不做（以及重评条件）

| 不做 | 理由 | 重评条件 |
|---|---|---|
| 新建 `thread_*` 展示表 / 物化视图 | 同一事实的第二个写者；时间线已能从 `triggers` 派生 | 导数查询在真实数据（>10 万条 trigger）上 P95 超过 200ms |
| 给「视角」加自己的状态（已读/折叠/排序偏好持久化） | 视角不该有状态机；偏好属于用户，不属于流 | 出现真实诉求（多人共用同一视图且需要不同排序） |
| 票据独立路由 `/tickets/:id` | 今天没有任何入口指向它 → 死页面 | 票需要**脱离任务**被直接打开（例如外部来源直接开票） |
| 时间线里合并/摘要正文 | 违反 H3（平台不改写语义） | 不重评：要摘要请由 agent 产出新的 Trigger |
| 在全局页做「全部流」列表 | 目录不会赚回注意力；主入口已倒置 | 出现「需要全局扫一遍才能发现的事」（当前：无） |

---

## 6. 编译重启

本卡只改 web-ui 与 org-manager 的读取面，**无迁移、无缓存清理**。
构建与重启步骤见交付报告 §5（同一份命令，Owner 直接复制执行）。
