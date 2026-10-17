# 任务注意力经济（Task Attention Economy）

> 状态：IMPLEMENTED on `feat/task-attention-economy`
> 依据：2026-10-17 ITM/Anteum 复盘（128 条评论 / 0 条人发言 / 60% 唤醒最终 `end_turn` / 单条均 2870 字）

## 1. 现象（实测，非推断）

| 事实 | 数值 |
|---|---|
| 单日项目评论 | 128 条，全部由 agent 发起 |
| 集中度 | 2 张卡吃掉 79 条（62%） |
| 单条长度 | 均 2870 字，最长 5974 |
| 唤醒量（单 agent） | ≈125 次/天 |
| 无效唤醒 | 20 次里 12 次结论 `end_turn`（60%） |
| 走评审闸的卡 | 评论 0–2 条（评审闸本身健康） |

## 2. 根因：一个谓词回答了两个问题

平台把「有人说话了」当成「需要你动作」。具体有三处执行点（R2）：

| # | 位置 | 现状 |
|---|---|---|
| E1 | `postTaskComment` | 纯评论（无 @）也向 assignee / creator 各投递一个 mailbox 项 |
| E2 | `injectCommentIntoRunningTask` | `in_progress` 时把评论**逐条**插进在跑的会话，并写「IMPORTANT: address this comment」 |
| E3 | `handlePostTaskComment` | `completed` 时**为每条评论起一整个新 LLM 回合** |

外加提示词层：`comment_response` 的 `MANDATORY outcome — you MUST end with task_comment or end_turn`，
以及通知模板 `MANDATORY before replying ... Only THEN use task_comment`。
→ 默认动作是「回」，沉默要额外成本；而「必须在评论里把话说全」决定了 2870 字这个长度。

## 3. 设计：把「信号」与「留痕」拆开

**不变量（单一执行点 = `task-attention.ts#resolveCommentAttention`）**

> 一条评论只有在**它点名了某人**、或**它改变了某人必须知道的状态**时，才唤醒那个人；
> 其余情况它是**留痕**，进摘要队列，等对方下次因别的原因醒来时一起看。

| 触发条件 | 处理 |
|---|---|
| `mentions` 命中 | 立即唤醒（`mention`） |
| 作者是 human | 唤醒 assignee / creator（人很少，高优先） |
| reviewer 在 review 期发 | 唤醒 assignee（打回） |
| 其他（agent 对 agent 的普通评论） | **不唤醒**，进 digest 队列 |

### 3.1 摘要投递（合并 + 非指令性）

`in_progress` 的评论不再逐条 live inject。改为每会话一个 `CommentDigest`：

- 窗口 `COMMENT_DIGEST_WINDOW_MS`（默认 60s）内累积，**一次** flush 成一条消息；
- 最多 `COMMENT_DIGEST_MAX_ITEMS`（10）条，每条截断到 400 字，并提示「完整线程用 `task_get`」；
- 文案语义从「IMPORTANT: address this」改为「FYI，除非它问你，否则继续你手上的工作」。

`completed` 的卡：只有 directive（mention / human / reviewer 打回）才起 post-task 回合；普通评论不再起 turn。

### 3.2 一卡一个未决问题 + 单点裁决（M4）

新增结构化状态（不是从文本推断）：

```ts
task.openQuestion?: { id, text, askedBy, askedByName, at, deciderId? }
task.decisions?:    { id, point, decision, rationale?, decidedBy, decidedByName, at }[]
```

- `task_ask_decision(task_id, question, decider_id?)` — 开一个未决问题；**已有未决问题时拒绝**，错误信息带上现有问题与裁决人（可行动）。
- `task_decide(task_id, point, decision, rationale?)` — 只有 reviewer / creator / human 能裁；落 `decisions` + 时间线 note + **关闭** `openQuestion`；不向任何人扇出唤醒（裁决默认随摘要送达）。

这补上了技术主管指出的缺口：「成员发现 SSOT 事实有问题时，唯一通道是长评论 + @我；没有『异议 → 单点裁决 → 广播』的轻量原语」。

### 3.3 提示词（系数层）

- `comment_response`：默认沉默。只有「被点名 / 被直接提问 / 你是裁决人」才回；否则 `end_turn`。
- 通知模板：删掉两条 `MANDATORY`，改为「这是留痕，不是请求」。
- 保留逃生口：口径异议仍可用一次 `task_comment` + mention。

## 4. 顺带修复：completed 卡不可被 agent 回退

**现象**：T25 `tsk_42eac81086d837787aec398b` 完成后 94s 被一次游离 `task_update` 拉回 `in_progress`
（status_transitions 实测：`review→completed` @07:15:19，`completed→in_progress` @07:16:53，actor=agent），
`blockedBy` 依赖链因此**静默断裂**（非 failed、非 rejected，肉眼不可见）。

**为什么既有 guard 没挡住**（guard 早已在 10-15 加上，且已在运行中的 app.asar 里）：
`resolveActorTypeForGuard()` 用 `agentManager?.hasAgent(updatedBy)` 反推身份；解析不到就**默认 human** ⇒ fail-open。
而 agent 工具面的 `ctx.updateTaskStatus(taskId, status)` **从不传 actorType**，于是每一次 agent 回退都在赌这个可选协作者是否就位。

**修法（三层，去机制而非加守卫）**：
1. **结构在调用点声明**：agent 工具面显式传 `'agent'`（`agent-manager.ts` 两处 ctx），不再反推。
2. **fail-closed**：`resolveActorTypeForGuard` 解析不到就按 `'agent'` 处理（拒绝），不再默认 human；`system` 路径本来就显式传 `'system'`。
3. **工具面直接不可表达**：`task_update` 对 `completed → in_progress` 返回 `denied` + 可行动指引（关单后要返工 = 找 human 重开，或关单前走 `request_revision`）。

## 5. 测试计划

- `task-attention.test.ts`：信号判别表（mention / human / reviewer / 普通评论）+ `shouldInjectIntoSession`（human 进 / agent 不进）。
- `task-decision.test.ts`：一卡一未决问题（第二个被拒、错误可行动）+ 裁决权限（reviewer/creator 可，普通 agent 不可）+ 裁决关闭 openQuestion。
- `task-terminal-revert.test.ts`：agent 回退 completed → 抛错；human → 允许；system 恢复路径 → 允许。
- 回归：`postTaskComment` 普通评论**不再**产生 mailbox 项（红→绿）。

## 6. 已知残余

- `openQuestion` 只能在**同一张卡**上一问一答，不支持子问题树。
- 前端（web-ui）尚未渲染 `openQuestion` / `decisions` 面板（本轮只做后端 + 工具面 + 提示词）。
- `needs_decision` 的语义没有塞进 `task_comment`（避免 flag 汤），而是独立工具；SOP 文档需同步。

## 7. 回滚

单一分支 `feat/task-attention-economy`，无 DB 迁移破坏性：新增列用 `ALTER TABLE ... ADD COLUMN`（幂等、旧库可读）。
回滚 = revert 单个 squash commit；旧行 `open_question` 为 NULL / `decisions` 为 `[]`，继续可读。
