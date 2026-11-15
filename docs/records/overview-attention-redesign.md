# 概览「需要你的关注」重做方案

> 目标：**历史不丢、不打扰、新的东西一眼看到、按等待时长排队、每条有标题/优先级/可跳转**。
> 本文先给代码事实（带行号），再给设计与切片。所有结论都可在 `feat/ui-optimize-1108` 上复核。

## 0. 落地状态（2026-11-08）

Owner 拍板：① 徽标数字 = 要你动手 + 未读消息；② 未读消息进队列；③ 后端现在就补；④ UI 由我定。

| 片 | 状态 | 提交 |
|---|---|---|
| S5 后端 `status_changed_at`（列 + 幂等迁移 + 回填 + 唯一写入点 + 5 条单测） | ✅ 已落地 | `01d85979` |
| S1 `lib/attentionQueue.ts` 队列 builder（13 条单测） | ✅ 已落地 | `a900452b` |
| S2 卡片逐条重做（标题/优先级/等待时长/折叠/空态/`新` 标记） | ✅ 已落地 | `a900452b` |
| S3 跳转打通（`openTask` / `openRequirement` / `agentId + preferMain`） | ✅ 已落地 | `a900452b` |
| S4 历史（默认全部 / 记住 tab 与滚动位置 / 已处理显示「等了多久」） | ✅ 已落地 | `4e35056f` |
| 附：去掉「未开始任务」定时提醒 | ✅ 已落地 | `65b60be7` |
| 附：agent 报告落到该 agent 的**主会话** | ✅ 已落地 | `65b60be7` |
| 历史**标题搜索** | ⏸ 主动不做 —— tab 分段 + 15/页分页 + 200 行上限已够定位；再加一个筛选态会和「记住滚动位置」互相打架。需要时再加，10 行的事。 | — |

---

## 1. 现状：这块到底在算什么

### 1.1 数据结构（`Home.tsx:475-499`）

`attentionItems` 只有 **4 个聚合桶**，每桶一个数字：

| 桶 | 判据 | 手里有的字段 | 点击目标（`Home.tsx:646-655`） |
|---|---|---|---|
| `review` | `board['review']` 且 `reviewerType === 'human'` | 任务对象（含 id/title/priority/createdAt/updatedAt） | `WORK { statusFilter: 'review' }` |
| `approval` | `requirements.filter(r => r.status === 'pending')` | 只有计数，**没有需求对象** | `WORK`（**无任何参数**） |
| `blocked_abnormal` | `blocked` 且 `needsHumanDecision()` + 全部 `failed` | 任务对象 | `WORK { openTask: 第一条 }` |
| `blocked` | `blocked` 且 `!needsHumanDecision()`（= 等依赖） | 任务对象 | 同上 |

渲染（`Home.tsx:614-676`）每行 = 图标 + `N 条 X` + 可选 `N urgent` 徽章 + 一个按钮。
**列表里没有任何一条具体事项**。

### 1.2 三个"缺"

1. **缺类别**：`Home.tsx` 全文没有 `api.approvals`，也只用 `api.notifications.list(..., {limit:1})` 取了个未读数（`Home.tsx:517`）。
   于是 **agent 发起的审批请求（批准/拒绝）与提问（要你回答）根本不在这个卡片里**，未读消息/被 @ 也不在。
   这两类恰恰是最需要"一眼看到"的。
2. **缺标题**：用户看到「3 个任务需要你审查」，但不知道是哪 3 个 —— 必须点进去自己找。
3. **缺时间**：既没有"等了多久"，也不按等待时长排序（顺序是写死的桶顺序）。

### 1.3 跳转现状

平台本来有一份**权威分派表** `lib/notifyNavigate.ts:1-30`：
`open_chat` / `navigate` / `approval_request`（提问类直接打开回答弹窗）/ `task_*` / `requirement_*` / `direct_message` / `group_message` / `agent_report`……

但概览这块**没有用它**，而是手写了 4 个分支。后果：

- `approval` 行点了跳到 Work 首页 —— **等于没点**（这是明确的 bug，不是设计取舍）；
- `review` 行只到列表，不落到那一条（Work 支持 `openTask`，`Work.tsx:5591`）；
- 缺的两类（审批请求 / 未读消息）即使补进列表，也没有目标可跳。

### 1.4 计数口径（`lib/attentionCount.ts`）

单一发布点做得对：概览算完 → `publishAttentionCount()` → 侧栏/底栏订阅；读取时把「未读数」合并进来（`readAttentionCount = attention + unread`）。
**但输入是聚合桶的 `count` 求和**，桶错了整个数字就错了。

### 1.5 历史弹窗（`HistoryModal.tsx`）

- Tab：全部 / 审批结果 / 通知；`unreadOnly` **默认 true**（`:138`）—— 想回顾时反而先被过滤掉。
- 审批历史只放**已结束**的（`:250-255` 过滤 `status !== 'pending'`），排序键 `respondedAt ?? requestedAt`（`:290`）。
- 分页 15/页，DOM 上限 200 行。
- 待批审批在另一个 effect 里也读了一次（`:193-196`，只为把 `approval_request` 反解到实体）。
- 关闭即重置 tab 与滚动位置；已处理行只有「已批准/已拒绝 + 标题」，**没有"等了多久、你什么时候批的"**。

### 1.6 数据字段盘点（决定"等待多久"能不能算准）

| 对象 | 时间字段 | 优先级 | 备注 |
|---|---|---|---|
| `ApprovalInfo` (`api.ts:227-245`) | `requestedAt` / `respondedAt` | ❌ 无 | **等待时长可以精确算** |
| `TaskInfo` (`api.ts:1007-1037`) | `createdAt` / `updatedAt` / `startedAt` / `completedAt` | ✅ `priority` | **缺"进入 review/blocked 的时刻"**，`updatedAt` 会被任何编辑刷新 |
| `RequirementInfo` (`api.ts:1075-1089`) | `createdAt` / `updatedAt` / `approvedAt` | ✅ `priority` | 待审核用 `createdAt` 可接受 |
| `NotificationInfo` (`api.ts:288-301`) | `createdAt` | ✅ `priority` | 未读/被 @ 的排序依据 |

→ 结论：**只有任务类缺一个 `status_since`**。这是我要向你要的唯一一处后端改动。

---

## 2. 问题清单（按用户感受排序）

| # | 问题 | 用户的感受 | 证据 |
|---|---|---|---|
| P1 | 审批请求、提问、未读消息不在队列里 | 「明明有人等我，这里却说没什么事」 | `Home.tsx` 无 `api.approvals`；通知只取 `limit:1` |
| P2 | 只有计数没有标题 | 「3 个是哪 3 个？」→ 必须点进去找 | `Home.tsx:660-666` |
| P3 | 没有等待时长、不按时长排序 | 「哪个更急？我只能靠猜」 | `Home.tsx:475-499` 固定桶序 |
| P4 | 审批行跳转是死路 | 「点了没反应」 | `Home.tsx:649-650` |
| P5 | 「新的」看不出 | 「一直在闪，闪等于不闪」 | `Home.tsx:618` 常亮 pulse |
| P6 | 等依赖的阻塞混进来 | 「一堆红色，其实没我的事」 | `Home.tsx:495-497`（deps 桶） |
| P7 | 历史默认只看未读、关闭丢位置 | 「找上次那件事得重翻」 | `HistoryModal.tsx:138` |
| P8 | 「待审批」两个来源 | 数字与列表对不上 | Home 用 `requirements.pending`；历史/通知用 `approvals` 表 |

P8 是我最在意的结构性问题：**同一件事两个写者**，迟早对不上（这也是为什么 P1 会漏）。

---

## 3. 设计原则（硬约束）

1. **历史不丢**：归档 + 分页 + 永不删除（只有渲染上限）；归档行要能回答「等了多久、谁批的、什么时候」。
2. **不打扰**：不弹窗、不自动跳页、不播放声音；新东西只表现为**数字 + 一个「新」点**。
3. **一眼看到**：每一行自带 标题 + 类型 + 优先级 + 等待时长 + 一个主行动。

---

## 4. 新设计

### 4.1 数据层：一个队列 builder（唯一写者）

新增 `lib/attentionQueue.ts` —— 纯函数，无 React：

```ts
export type AttentionKind =
  | 'approval_request'      // agent 要你批准/拒绝（含提问类）
  | 'requirement_approval'  // 需求待你审核
  | 'task_review'           // 任务待你验收
  | 'blocked_hold'          // 有人主动挂起，等你决定
  | 'task_failed'           // 执行失败，要你处置
  | 'unread_message';       // 未读消息 / 被 @（可关）

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;              // 具体标题，不是计数
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  waitingSince: string;       // ISO
  waitingBasis: 'requested' | 'created' | 'status' | 'approximate';
  /** 跳转参数，直接喂给 navBus（见 4.4） */
  target: { page: 'WORK' | 'TEAM'; params: Record<string, string> };
  isNew: boolean;             // since last visit
  meta?: string;              // 来自哪个 agent / 团队
}
```

排序（唯一实现）：

1. `waitingSince` 升序 —— **等最久的在最上面**；
2. 同刻按 `priority`（urgent > high > medium > low > none）；
3. 再按 `kind` 固定序（保住稳定排序，避免每秒跳动）。

计数只此一处：`attentionTotal = items.filter(i => i.kind !== 'unread_message').length`（口径见 §7 待拍板）。

### 4.2 卡片（目标态）

```
┌────────────────────────────────────────────────────────────────────┐
│ ● 需要你的关注  5       2 条新的            全部 12 条 →   历史 → │
├────────────────────────────────────────────────────────────────────┤
│ ▍⛔ 修复支付回调重复扣款        urgent · 审批请求 · 等了 2天4小时    │
│     由 支付 Agent 发起                                    [去批准] │
│ ▍📋 知识库切片重构 v2           high  · 需求待审 · 等了 1天2小时     │
│     由 智库主任 提交                                       [去审核] │
│  ✅ 回归测试补齐（task_9f…）    medium · 待你验收 · 等了 6小时       │
│                                                          [去验收]  │
│  ⏸ 数据迁移脚本（task_3a…）     low   · 已挂起 · 等了 22分钟         │
│                                                          [去解阻]  │
│  ＋ 还有 1 条…                                                     │
└────────────────────────────────────────────────────────────────────┘
```

- 行首 `▍` 竖条 = **新**（since last visit），不是动画；
- 标题一行截断，第二行元信息（类型 · 优先级 · **等待时长** · 来源）；
- 右侧一个主行动按钮，**动词随类型变**（去批准 / 去审核 / 去验收 / 去解阻 / 去回答 / 去沟通）；
- 默认最多 5 条，超出折成「还有 N 条」→ 打开完整队列；
- 零待办：`一切正常`（保持现有 `attention.allClear`）+「历史」入口。
- 「等依赖」**不进这张卡**（它不需要人，进「等待中」计数即可）。

### 4.3 等待时长：诚实标注口径

- 审批请求 → `requestedAt`（精确）；
- 需求待审 → `createdAt`；
- 任务待验收/挂起 → 现在只有 `updatedAt`（会被编辑刷新）→ 显示为「约 6 小时」；后端补 `status_since` 后转为精确（§7 决策 3）。
- 文案：`< 1 分钟`、`12 分钟`、`3 小时`、`2 天 4 小时`、`> 30 天`；每 **60 秒**刷新一次（不是每秒重渲染）。

### 4.4 跳转契约（复用权威分派表，不再手写分支）

| kind | 目标 | 现有能力 | 要补 |
|---|---|---|---|
| `approval_request` | 打开该审批；提问类直接开回答弹窗 | `navigateForApproval()`（`notifyNavigate.ts:68-`） | 概览要拿到 `approvals` 上下文 |
| `requirement_approval` | `WORK { openRequirement: id }` | 已有（`Work.tsx:5611`） | 详情内自动展开「审批」面板 |
| `task_review` | `WORK { openTask: id }` | 已有（`Work.tsx:5591`） | 落地后滚到「通过/打回」按钮 |
| `blocked_hold` / `task_failed` | `WORK { openTask: id }` | 已有 | 同上 |
| `unread_message` | `TEAM { agentId, sessionId, mailboxId }` | 已有（`navigateForNotification`） | 概览要拿到未读通知的 metadata |

统一出口：`openAttention(item)` → 走 `notifyNavigate`，**一处维护**。

### 4.5 「新的」怎么算（不打扰的可见性）

- `localStorage: markus_attention_last_seen`（ISO）。渲染时 `waitingSince > last_seen` ⇒ `isNew`。
- 打开概览 ≥ 3 秒后写回 last_seen（避免刚进页面就把"新"全部吃掉）。
- 「未读消息」类用服务端 `read` 标记，不靠本地时间。
- 侧栏徽标：**新增时脉冲一次（1.2s）后静止**，替换现在的常亮 `animate-pulse`。

### 4.6 历史（保留形态，补内容）

- 默认 tab 改为 **全部**（不再默认只看未读），未读做成独立 tab 并带计数；
- 记住上次 tab + 滚动位置（关闭再开不迷路）；
- 已处理行补：`你于 11-05 14:22 批准 · 等了 2 天 4 小时`；
- 加筛选（类型 / 结果）与搜索（标题）；
- 分页与 200 行 DOM 上限保持不变 —— **历史只增不删**。

---

## 5. 实施切片（每片可独立验收）

| 片 | 内容 | 验收 |
|---|---|---|
| **S1** | `lib/attentionQueue.ts` + 单测（排序、优先级、isNew、口径） | 新增 ≥10 条断言；同刻不同优先级顺序正确；`waitingBasis` 正确 |
| **S2** | 卡片 UI 重做（逐条 / 折叠 / 空态 / 移动端两行） | 截图对比；键盘可走；无 `animate-pulse` |
| **S3** | 跳转打通（`openAttention` 走 notifyNavigate；需求详情展开审批面板） | 每条 kind 点到正确位置（手工逐条验） |
| **S4** | 历史补内容 + 「新」标记 + 徽标脉冲 | 关闭再开回到原位；新条目有竖条；徽标不常亮 |
| **S5** | 后端 `status_since` + 回填（可后置，S1 先用近似并标注） | 迁移脚本幂等；旧行保持"约" |

---

## 6. 风险与回滚

- **徽标数字会变大**（补进审批请求与未读）→ 用户可能觉得"怎么突然多了"。建议一期先把「未读消息」做成可关开关，默认只算"要你动手"的。
- **排序口径变化**：最上面那条会变（从"类型优先"变成"等最久优先"）——这正是你要的，但要提前说明。
- **`status_since` 迁移**：只加列+回填 `updated_at`，不改 FSM；不写新值也不影响旧行（显示为"约"）。
- 回滚：四个切片互不依赖新表；S5 前全部是前端改动，`git revert` 单片即可。

---

## 7. 需要你拍板（4 件）

1. **徽标数字**：只算「要你动手」（推荐），还是把未读消息也并进去（现状是并进去的）？
2. **是否把「未读消息/被 @」放进这张卡**？我建议放，但排在审批/验收之后（它不阻塞别人）。
3. **后端补 `status_since`**：现在就做（精准"等了多久"），还是先用「约」上线？
4. **历史形态**：保留弹窗（成本低，改内容 + 记忆位置），还是做成独立页/右侧抽屉？
